import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeSdkSetId, expectedArtifactNames, verifySdkReleaseSet } from "../../scripts/release/Verify-SdkReleaseSet.mjs";

const version = "0.2.0";

async function makeReleaseSet(root) {
  const artifacts = [];
  for (const name of expectedArtifactNames(version)) {
    const bytes = Buffer.from(`slybrowser:${name}`);
    const path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    artifacts.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const unsigned = { schemaVersion: 1, version, sourceTree: "a".repeat(40), artifacts };
  return { ...unsigned, sdkSetId: computeSdkSetId(unsigned) };
}

test("0.2.0 release set contains exactly the eight canonical artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "slybrowser-sdk-020-"));
  try {
    const releaseSet = await makeReleaseSet(root);
    const result = await verifySdkReleaseSet(releaseSet, root, {
      expectedSdkSetId: releaseSet.sdkSetId,
      expectedSourceTree: releaseSet.sourceTree,
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.artifacts.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-set verification rejects drift, extras and source mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "slybrowser-sdk-020-negative-"));
  try {
    const releaseSet = await makeReleaseSet(root);
    await writeFile(join(root, "unexpected.txt"), "unexpected");
    await assert.rejects(() => verifySdkReleaseSet(releaseSet, root), /unexpected file/i);
    await rm(join(root, "unexpected.txt"));
    await writeFile(join(root, "node", `slybrowser-${version}.tgz`), "drift");
    await assert.rejects(() => verifySdkReleaseSet(releaseSet, root), /size|SHA-256/i);
    await assert.rejects(
      () => verifySdkReleaseSet(releaseSet, root, { expectedSourceTree: "b".repeat(40) }),
      /source tree/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry publication is local-only and consumes the exact frozen release set", async () => {
  for (const workflow of ["npm", "pypi", "maven", "nuget"]) {
    await assert.rejects(access(`.github/workflows/sdk-publish-${workflow}.yml`), /ENOENT/);
  }
  const publisher = await readFile("scripts/release/Publish-FrozenSdkPackages.ps1", "utf8");
  assert.match(publisher, /Verify-SdkReleaseSet\.mjs/);
  assert.match(publisher, /CredentialPreflight/);
  assert.match(publisher, /TWINE_USERNAME/);
  assert.match(publisher, /CENTRAL_TOKEN_USERNAME/);
  assert.match(publisher, /CENTRAL_TOKEN_PASSWORD/);
  assert.match(publisher, /SLY_MAVEN_GPG_FINGERPRINT/);
  assert.match(publisher, /NUGET_API_KEY/);
  assert.match(publisher, /npm[^\n]+publish/);
  assert.match(publisher, /twine[^\n]+upload/);
  assert.match(publisher, /publishingType=AUTOMATIC/);
  assert.match(publisher, /nuget[^\n]+push/);
  assert.match(publisher, /Write-Receipt/);
  assert.match(publisher, /repositorySignature = 'verified'/);
  assert.doesNotMatch(publisher, /MAVEN_GPG_PRIVATE_KEY|MAVEN_GPG_PASSPHRASE/);
});

test("publisher rejects coupled registry publication before reading release inputs", () => {
  const result = spawnSync("pwsh", [
    "-NoProfile", "-File", "scripts/release/Publish-FrozenSdkPackages.ps1",
    "-ReleaseSet", "missing-release-set.json", "-ArtifactRoot", "missing-artifacts",
    "-Publish", "-Package", "all", "-ReceiptDirectory", "missing-receipts",
  ], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /one registry target per publication/i);
  assert.doesNotMatch(result.stderr, /missing-release-set|missing-artifacts/i);
});

test("one target can pass preflight while another lacks credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "slybrowser-sdk-target-preflight-"));
  try {
    const artifactRoot = join(root, "artifacts");
    await mkdir(artifactRoot);
    const releaseSet = await makeReleaseSet(artifactRoot);
    const releaseSetPath = join(root, "release-set.json");
    await writeFile(releaseSetPath, JSON.stringify(releaseSet));
    await writeFile(join(root, "npm.cmd"), "@echo off\r\nexit /b 0\r\n");
    const env = { ...process.env, PATH: `${root};${process.env.PATH}`, TWINE_USERNAME: "", TWINE_PASSWORD: "" };
    const run = (target) => spawnSync("pwsh", [
      "-NoProfile", "-File", "scripts/release/Publish-FrozenSdkPackages.ps1",
      "-ReleaseSet", releaseSetPath, "-ArtifactRoot", artifactRoot,
      "-CredentialPreflight", "-Package", target,
    ], { encoding: "utf8", timeout: 15000, env });
    const node = run("node");
    assert.equal(node.status, 0, node.stderr);
    assert.equal(JSON.parse(node.stdout).status, "READY");
    const python = run("python");
    assert.equal(python.status, 1);
    assert.match(python.stderr, /TWINE_USERNAME is required/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected authorization receipt rejects a substituted candidate or SDK set", async () => {
  const { verifySdkReleaseAuthorization } = await import("../../scripts/release/Verify-SdkReleaseAuthorization.mjs");
  const receipt = {
    schemaVersion: 1,
    candidateId: `sha256:${"1".repeat(64)}`,
    releaseTag: "sdk-v0.2.0",
    version,
    sourceTree: "a".repeat(40),
    sdkSetId: `sha256:${"2".repeat(64)}`,
  };
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const expectedSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.deepEqual(verifySdkReleaseAuthorization(bytes, { expectedSha256, releaseTag: receipt.releaseTag }), receipt);

  const substituted = Buffer.from(`${JSON.stringify({ ...receipt, sdkSetId: `sha256:${"3".repeat(64)}` })}\n`);
  assert.throws(
    () => verifySdkReleaseAuthorization(substituted, { expectedSha256, releaseTag: receipt.releaseTag }),
    /authorization digest mismatch/i,
  );
  assert.throws(
    () => verifySdkReleaseAuthorization(bytes, { expectedSha256, releaseTag: "sdk-v0.2.1" }),
    /release tag mismatch/i,
  );
});

test("native four-SDK E2E supports isolated canary trust roots", async () => {
  const files = [
    "scripts/browser/Test-NativeHumanizeSdkMatrix.ps1",
    "tests/integration/native-humanize-node-sdk.mjs",
    "tests/integration/native_humanize_python_sdk.py",
    "packages/java/src/test/java/com/slybrowser/NativeHumanizeRuntimeTest.java",
    "packages/dotnet/tests/SlyBrowser.Tests/NativeHumanizeRuntimeTests.cs",
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  for (const expected of [
    "CanaryLicenseKeyId",
    "CanaryLicensePublicKeyHex",
    "CanaryReleaseKeyId",
    "CanaryReleasePublicKeyBase64url",
  ]) {
    assert.match(combined, new RegExp(expected, "i"));
  }
  const dotnet = await readFile("packages/dotnet/tests/SlyBrowser.Tests/NativeHumanizeRuntimeTests.cs", "utf8");
  assert.match(dotnet, /RequestUri\?\.IsLoopback == true/);
  assert.match(dotnet, /SLYBROWSER_INTEGRATION_CANARY_TLS_THUMBPRINT/);
});

test("public documentation exposes all four 0.2.0 installation entry points", async () => {
  const files = [
    "README.md",
    "docs/user-api.md",
    "docs/wiki/Installation-and-SDKs.md",
    "packages/node/README.md",
    "packages/python/README.md",
    "packages/java/README.md",
    "packages/dotnet/README.md",
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  for (const expected of [
    "npm install slybrowser@0.2.0",
    "pip install slybrowser==0.2.0",
    "com.slybrowser:slybrowser:0.2.0",
    "dotnet add package SlyBrowser --version 0.2.0",
  ]) {
    assert.match(combined, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the public workspace has no source-tree registry publication command", async () => {
  const workspace = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(Object.hasOwn(workspace.scripts, "sdk:publish"), false);
  const sourcePublisher = await readFile("scripts/release/Publish-SdkPackages.ps1", "utf8");
  assert.match(sourcePublisher, /Source-tree publication is disabled/);
  assert.match(sourcePublisher, /Publish-FrozenSdkPackages\.ps1/);
});

test("NuGet packaging does not inherit a stale local Git commit", async () => {
  const builder = await readFile("scripts/release/Build-SdkReleaseSet.ps1", "utf8");
  assert.match(builder, /EnableSourceControlManagerQueries=false/);
});
