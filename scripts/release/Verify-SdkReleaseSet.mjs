#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function expectedNames(version) {
  return [
    `node/slybrowser-${version}.tgz`,
    `python/slybrowser-${version}-py3-none-any.whl`,
    `python/slybrowser-${version}.tar.gz`,
    `java/slybrowser-${version}.jar`,
    `java/slybrowser-${version}-sources.jar`,
    `java/slybrowser-${version}-javadoc.jar`,
    `java/slybrowser-${version}.pom`,
    `dotnet/SlyBrowser.${version}.nupkg`,
  ];
}

function canonicalPayload(document) {
  return {
    schema: "slybrowser-sdk-release-set/v1",
    version: document.version,
    artifacts: [...document.artifacts]
      .map(({ name, size, sha256 }) => ({ name, size, sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function computeSdkSetId(document) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalPayload(document))).digest("hex")}`;
}

async function filesBelow(root, directory = root) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`SDK release directory contains a symbolic link: ${entry.name}`);
    if (metadata.isDirectory()) output.push(...await filesBelow(root, path));
    else if (metadata.isFile()) output.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`SDK release directory contains an unsupported entry: ${entry.name}`);
  }
  return output.sort();
}

export async function verifySdkReleaseSet(document, artifactRoot) {
  if (document?.schemaVersion !== 1 || !versionPattern.test(document?.version ?? "")) {
    throw new Error("SDK release set identity is invalid");
  }
  if (!Array.isArray(document.artifacts)) throw new Error("SDK release set artifacts are invalid");
  const expected = expectedNames(document.version);
  const names = document.artifacts.map((artifact) => artifact?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected.sort())) {
    throw new Error("SDK release set must contain exactly the eight canonical artifacts");
  }
  if (document.sdkSetId !== computeSdkSetId(document)) throw new Error("SDK release set digest is invalid");
  const root = resolve(artifactRoot);
  const actualNames = await filesBelow(root);
  for (const name of actualNames) {
    if (!names.includes(name)) throw new Error(`SDK release directory contains an unexpected file: ${name}`);
  }
  for (const name of names) {
    if (!actualNames.includes(name)) throw new Error(`SDK release directory is missing ${name}`);
  }
  const artifacts = [];
  for (const artifact of [...document.artifacts].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || !digestPattern.test(artifact.sha256 ?? "")) {
      throw new Error(`SDK release identity is invalid for ${artifact.name}`);
    }
    const bytes = await readFile(resolve(root, ...artifact.name.split("/")));
    if (bytes.length !== artifact.size) throw new Error(`SDK release size mismatch for ${artifact.name}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) throw new Error(`SDK release SHA-256 mismatch for ${artifact.name}`);
    artifacts.push({ ...artifact });
  }
  return { status: "VERIFIED", sdkSetId: document.sdkSetId, version: document.version, artifacts };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Expected --release-set, --artifact-root and optional --output");
    values[name.slice(2)] = value;
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options["release-set"] || !options["artifact-root"]) throw new Error("--release-set and --artifact-root are required");
  const document = JSON.parse(await readFile(resolve(options["release-set"]), "utf8"));
  const result = await verifySdkReleaseSet(document, options["artifact-root"]);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(resolve(options.output), output);
  }
  process.stdout.write(output);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`SDK release set: blocked (${error.message})\n`);
    process.exitCode = 1;
  });
}
