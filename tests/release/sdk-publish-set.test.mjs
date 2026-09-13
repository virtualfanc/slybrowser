import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeSdkSetId, verifySdkReleaseSet } from "../../scripts/release/Verify-SdkReleaseSet.mjs";

const execFileAsync = promisify(execFile);

const version = "0.1.0";
const names = [
  `node/slybrowser-${version}.tgz`,
  `python/slybrowser-${version}-py3-none-any.whl`,
  `python/slybrowser-${version}.tar.gz`,
  `java/slybrowser-${version}.jar`,
  `java/slybrowser-${version}-sources.jar`,
  `java/slybrowser-${version}-javadoc.jar`,
  `java/slybrowser-${version}.pom`,
  `dotnet/SlyBrowser.${version}.nupkg`,
];

async function fixture(root) {
  const artifacts = [];
  for (const name of names) {
    const bytes = Buffer.from(`exact:${name}`);
    const path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    artifacts.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const document = { schemaVersion: 1, version, artifacts };
  return { ...document, sdkSetId: computeSdkSetId(document) };
}

async function sdkDocument(root) {
  const artifacts = [];
  for (const name of names) {
    const path = join(root, ...name.split("/"));
    const bytes = await readFile(path);
    const info = await stat(path);
    artifacts.push({ name, size: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const document = { schemaVersion: 1, version, artifacts };
  return { ...document, sdkSetId: computeSdkSetId(document) };
}

async function createZip(source, destination) {
  const script = `${destination}.create.ps1`;
  await writeFile(script, "param([string]$Source,[string]$Destination)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Destination)\n");
  try {
    await execFileAsync("pwsh.exe", ["-NoProfile", "-File", script, "-Source", source, "-Destination", destination]);
  } finally {
    await rm(script, { force: true });
  }
}

async function publishFixture(base) {
  const root = join(base, "artifacts");
  await mkdir(root);
  await fixture(root);
  const unsignedRoot = join(base, "nuget-unsigned");
  await mkdir(join(unsignedRoot, "lib", "net8.0"), { recursive: true });
  await writeFile(join(unsignedRoot, "SlyBrowser.nuspec"), `<package><metadata><id>SlyBrowser</id><version>${version}</version></metadata></package>`);
  await writeFile(join(unsignedRoot, "lib", "net8.0", "SlyBrowser.dll"), "exact-dotnet-payload");
  const nupkg = join(root, "dotnet", `SlyBrowser.${version}.nupkg`);
  await rm(nupkg, { force: true });
  await createZip(unsignedRoot, nupkg);
  const signedRoot = join(base, "nuget-signed");
  await cp(unsignedRoot, signedRoot, { recursive: true });
  await writeFile(join(signedRoot, ".signature.p7s"), "repository-signature");
  const signedNupkg = join(base, `SlyBrowser.${version}.signed.nupkg`);
  await createZip(signedRoot, signedNupkg);
  return { root, signedNupkg, document: await sdkDocument(root) };
}

async function fakeCommands(base) {
  const directory = join(base, "commands");
  await mkdir(directory);
  const adapter = join(directory, "adapter.mjs");
  await writeFile(adapter, `
import { appendFileSync, writeFileSync } from "node:fs";
const [tool, ...args] = process.argv.slice(2);
const log = (value) => appendFileSync(process.env.TEST_PUBLISH_LOG, value + "\\n");
if (tool === "npm") {
  const registry = args[args.indexOf("--registry") + 1];
  if (!args.includes("--registry") || registry !== process.env.TEST_NPM_REGISTRY) process.exit(8);
  if (args[0] === "whoami") process.stdout.write("fixture-user\\n");
  else if (args[0] === "publish") { log("write:npm"); if (process.env.TEST_FAIL_TARGET === "npm") process.exit(9); }
  else if (args[0] === "view") process.stdout.write(process.env.TEST_NPM_URL + "\\n");
} else if (tool === "python") {
  if (args.includes("--version")) {
    if (process.env.TEST_FAIL_TWINE_PREFLIGHT === "1") process.exit(7);
    process.stdout.write("twine version fixture\\n");
  } else {
    log("write:python"); if (process.env.TEST_FAIL_TARGET === "python") process.exit(9);
  }
} else if (tool === "gpg") {
  if (args.includes("--list-secret-keys")) {
    process.stdout.write("sec:u:2048:1:fixture:0:0:::::scESC::::::23:\\n");
    process.stdout.write("fpr:::::::::" + process.env.SLY_MAVEN_GPG_FINGERPRINT + ":\\n");
  } else if (args.includes("--detach-sign")) {
    const output = args[args.indexOf("--output") + 1];
    writeFileSync(output, "fixture-signature");
  }
} else if (tool === "dotnet") {
  if (args[1] === "push") { log("write:dotnet"); if (process.env.TEST_FAIL_TARGET === "dotnet") process.exit(9); }
}
`);
  const node = process.execPath;
  for (const tool of ["npm", "python", "gpg", "dotnet"]) {
    await writeFile(join(directory, `${tool}.cmd`), `@echo off\r\n"${node}" "${adapter}" ${tool} %*\r\n`);
  }
  return directory;
}

async function registryServer(base, fixtureData, { driftNpm = false } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(`${request.method}:${request.url}`);
    const sendFile = async (path, status = 200) => {
      const bytes = await readFile(path);
      response.writeHead(status, { "content-length": bytes.length });
      response.end(bytes);
    };
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === "/npm.tgz") {
      if (driftNpm) { response.end("drift"); return; }
      await sendFile(join(fixtureData.root, "node", `slybrowser-${version}.tgz`)); return;
    }
    if (request.url === `/pypi/slybrowser/${version}/json`) {
      const files = [
        `slybrowser-${version}-py3-none-any.whl`,
        `slybrowser-${version}.tar.gz`,
      ];
      const urls = [];
      for (const filename of files) {
        const path = join(fixtureData.root, "python", filename);
        urls.push({ filename, digests: { sha256: createHash("sha256").update(await readFile(path)).digest("hex") }, url: `${origin}/python/${filename}` });
      }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ urls })); return;
    }
    if (request.url?.startsWith("/python/")) { await sendFile(join(fixtureData.root, "python", request.url.slice("/python/".length))); return; }
    if (request.url?.startsWith("/central/upload")) { response.end("11111111-1111-1111-1111-111111111111"); return; }
    if (request.url?.startsWith("/central/status")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ deploymentState: "PUBLISHED" })); return; }
    if (request.url?.startsWith(`/maven/com/slybrowser/slybrowser/${version}/`)) { await sendFile(join(fixtureData.root, "java", request.url.split("/").at(-1))); return; }
    if (request.url === `/nuget/slybrowser/${version}/slybrowser.${version}.nupkg`) { await sendFile(fixtureData.signedNupkg); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = join(base, "registries.json");
  await writeFile(config, JSON.stringify({
    npm: `${origin}/npm-registry`, pypiMetadata: `${origin}/pypi`, central: `${origin}/central`, maven: `${origin}/maven`,
    nugetSource: `${origin}/nuget-source`, nugetFlat: `${origin}/nuget`,
  }));
  return { server, origin, config, requests };
}

async function runPublisher(base, fixtureData, registry, extra = {}) {
  const releaseSet = join(base, "release-set.json");
  const receipts = join(base, "receipts");
  const log = join(base, "publish.log");
  await writeFile(releaseSet, JSON.stringify(fixtureData.document));
  await writeFile(log, "");
  const commands = await fakeCommands(base);
  const registryConfig = JSON.parse(await readFile(registry.config, "utf8"));
  registryConfig.commandRoot = commands;
  await writeFile(registry.config, JSON.stringify(registryConfig));
  const env = {
    ...process.env,
    Path: `${commands};${process.env.Path}`,
    SLY_SDK_PUBLISH_TEST_MODE: "1",
    TEST_PUBLISH_LOG: log,
    TEST_NPM_URL: `${registry.origin}/npm.tgz`,
    TEST_NPM_REGISTRY: `${registry.origin}/npm-registry`,
    TWINE_USERNAME: "fixture",
    TWINE_PASSWORD: "fixture",
    CENTRAL_TOKEN_USERNAME: "fixture",
    CENTRAL_TOKEN_PASSWORD: "fixture",
    SLY_MAVEN_GPG_FINGERPRINT: "A".repeat(40),
    NUGET_API_KEY: "fixture",
    ...extra.env,
  };
  const args = [
    "-NoProfile", "-File", "scripts/release/Publish-FrozenSdkPackages.ps1",
    "-ReleaseSet", releaseSet, "-ArtifactRoot", fixtureData.root,
    "-Publish", "-ReceiptDirectory", receipts, "-RegistryTimeoutSeconds", "2",
    "-TestRegistryConfig", registry.config,
  ];
  if (extra.package) args.push("-Package", extra.package);
  return { releaseSet, receipts, log, env, args };
}

test("SDK release set binds the exact complete publication directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-sdk-set-"));
  try {
    const document = await fixture(root);
    const result = await verifySdkReleaseSet(document, root);
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.artifacts.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK release set rejects drift and extra files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-sdk-set-"));
  try {
    const document = await fixture(root);
    await writeFile(join(root, "java", `slybrowser-${version}-javadoc.jar`), "drift");
    await assert.rejects(() => verifySdkReleaseSet(document, root), /SHA-256|size/i);
    await writeFile(join(root, "java", `slybrowser-${version}-javadoc.jar`), `exact:java/slybrowser-${version}-javadoc.jar`);
    await writeFile(join(root, "python", "unexpected.whl"), "extra");
    await assert.rejects(() => verifySdkReleaseSet(document, root), /unexpected file/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frozen SDK publisher dry-run consumes the exact release set", async (context) => {
  if (process.platform !== "win32") {
    context.skip("PowerShell publication orchestration is Windows-specific");
    return;
  }
  const base = await mkdtemp(join(tmpdir(), "sly-sdk-publish-"));
  const root = join(base, "artifacts");
  try {
    await mkdir(root);
    const document = await fixture(root);
    const releaseSet = join(base, "release-set.json");
    await writeFile(releaseSet, JSON.stringify(document));
    const result = JSON.parse(execFileSync("pwsh.exe", [
      "-NoProfile", "-File", "scripts/release/Publish-FrozenSdkPackages.ps1",
      "-ReleaseSet", releaseSet,
      "-ArtifactRoot", root,
      "-DryRun",
    ], { encoding: "utf8" }));
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.sdkSetId, document.sdkSetId);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("source-tree SDK publication fails closed", (context) => {
  if (process.platform !== "win32") {
    context.skip("PowerShell publication orchestration is Windows-specific");
    return;
  }
  assert.throws(() => execFileSync("powershell.exe", [
    "-NoProfile", "-File", "scripts/release/Publish-SdkPackages.ps1",
    "-Package", "node", "-Version", version, "-Publish",
  ], { encoding: "utf8" }), /Source-tree publication is disabled/);
});

test("publisher validates every credential before the first registry write", async (context) => {
  if (process.platform !== "win32") { context.skip("PowerShell publication orchestration is Windows-specific"); return; }
  const base = await mkdtemp(join(tmpdir(), "sly-sdk-preflight-"));
  let registry;
  try {
    const fixtureData = await publishFixture(base);
    registry = await registryServer(base, fixtureData);
    const run = await runPublisher(base, fixtureData, registry);
    delete run.env.NUGET_API_KEY;
    await assert.rejects(() => execFileAsync("pwsh.exe", run.args, { cwd: process.cwd(), env: run.env }), /NUGET_API_KEY is required/);
    assert.equal(await readFile(run.log, "utf8"), "");
    assert.deepEqual(registry.requests, []);
  } finally {
    registry?.server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("publisher exercises all registries and records signed NuGet payload identity", async (context) => {
  if (process.platform !== "win32") { context.skip("PowerShell publication orchestration is Windows-specific"); return; }
  const base = await mkdtemp(join(tmpdir(), "sly-sdk-registries-"));
  let registry;
  try {
    const fixtureData = await publishFixture(base);
    registry = await registryServer(base, fixtureData);
    const run = await runPublisher(base, fixtureData, registry);
    const { stdout } = await execFileAsync("pwsh.exe", run.args, { cwd: process.cwd(), env: run.env });
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.status, "SIMULATED");
    assert.equal(result.mode, "test");
    assert.equal(result.sdkSetId, fixtureData.document.sdkSetId);
    assert.deepEqual((await readdir(run.receipts)).sort(), ["dotnet.json", "java.json", "node.json", "python.json"]);
    const nuget = JSON.parse(await readFile(join(run.receipts, "dotnet.json"), "utf8"));
    assert.equal(nuget.status, "SIMULATED");
    assert.equal(nuget.mode, "test");
    assert.equal(nuget.artifacts[0].repositorySignature, "verified");
    assert.equal(nuget.artifacts[0].uploadedSha256, fixtureData.document.artifacts.find(({ name }) => name.startsWith("dotnet/"))?.sha256);
    assert.notEqual(nuget.artifacts[0].downloadedSha256, nuget.artifacts[0].uploadedSha256);
    assert.match(nuget.artifacts[0].payloadSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual((await readFile(run.log, "utf8")).trim().split(/\r?\n/), ["write:npm", "write:python", "write:dotnet"]);
    assert.ok(registry.requests.some((value) => value.startsWith("POST:/central/upload")));
    assert.ok(registry.requests.some((value) => value.startsWith("GET:/nuget/")));
  } finally {
    registry?.server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("publisher checks Twine before the first registry write", async (context) => {
  if (process.platform !== "win32") { context.skip("PowerShell publication orchestration is Windows-specific"); return; }
  const base = await mkdtemp(join(tmpdir(), "sly-sdk-twine-preflight-"));
  let registry;
  try {
    const fixtureData = await publishFixture(base);
    registry = await registryServer(base, fixtureData);
    const run = await runPublisher(base, fixtureData, registry, { env: { TEST_FAIL_TWINE_PREFLIGHT: "1" } });
    await assert.rejects(() => execFileAsync("pwsh.exe", run.args, { cwd: process.cwd(), env: run.env }), /Command failed with exit code 7/);
    assert.equal(await readFile(run.log, "utf8"), "");
    assert.deepEqual(registry.requests, []);
  } finally {
    registry?.server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("publisher stops after the first registry write failure", async (context) => {
  if (process.platform !== "win32") { context.skip("PowerShell publication orchestration is Windows-specific"); return; }
  const base = await mkdtemp(join(tmpdir(), "sly-sdk-fail-stop-"));
  let registry;
  try {
    const fixtureData = await publishFixture(base);
    registry = await registryServer(base, fixtureData);
    const run = await runPublisher(base, fixtureData, registry, { env: { TEST_FAIL_TARGET: "npm" } });
    await assert.rejects(() => execFileAsync("pwsh.exe", run.args, { cwd: process.cwd(), env: run.env }), /Command failed with exit code 9/);
    assert.equal((await readFile(run.log, "utf8")).trim(), "write:npm");
    assert.deepEqual(registry.requests, []);
  } finally {
    registry?.server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("publisher fails closed when registry readback differs and writes no receipt", async (context) => {
  if (process.platform !== "win32") { context.skip("PowerShell publication orchestration is Windows-specific"); return; }
  const base = await mkdtemp(join(tmpdir(), "sly-sdk-readback-"));
  let registry;
  try {
    const fixtureData = await publishFixture(base);
    registry = await registryServer(base, fixtureData, { driftNpm: true });
    const run = await runPublisher(base, fixtureData, registry, { package: "node" });
    await assert.rejects(() => execFileAsync("pwsh.exe", run.args, { cwd: process.cwd(), env: run.env }), /SHA-256 mismatch/);
    assert.equal((await readFile(run.log, "utf8")).trim(), "write:npm");
    assert.deepEqual(await readdir(run.receipts), []);
  } finally {
    registry?.server.close();
    await rm(base, { recursive: true, force: true });
  }
});
