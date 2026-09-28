#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha256Pattern = /^[a-f0-9]{64}$/;
const sourceTreePattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function expectedArtifactNames(version) {
  if (!versionPattern.test(version)) throw new Error("SDK version must be stable semantic version x.y.z");
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

export function computeSdkSetId(document) {
  const payload = {
    schemaVersion: document.schemaVersion,
    version: document.version,
    sourceTree: document.sourceTree,
    artifacts: [...document.artifacts].sort((left, right) => left.name.localeCompare(right.name)),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex")}`;
}

async function filesBelow(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(relative(root, path).replaceAll("\\", "/"));
      else throw new Error(`SDK release directory contains a non-file entry: ${entry.name}`);
    }
  }
  await visit(root);
  return found.sort();
}

function artifactPath(root, name, flatArtifacts) {
  return flatArtifacts ? resolve(root, basename(name)) : resolve(root, ...name.split("/"));
}

export async function createSdkReleaseSet({ version, sourceTree, artifactRoot, flatArtifacts = false }) {
  if (!sourceTreePattern.test(sourceTree)) throw new Error("source tree must be a 40-character lowercase Git tree SHA");
  const artifacts = [];
  for (const name of expectedArtifactNames(version)) {
    const path = artifactPath(resolve(artifactRoot), name, flatArtifacts);
    const bytes = await readFile(path);
    artifacts.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const document = { schemaVersion: 1, version, sourceTree, artifacts };
  return { ...document, sdkSetId: computeSdkSetId(document) };
}

export async function verifySdkReleaseSet(document, artifactRoot, options = {}) {
  if (document?.schemaVersion !== 1) throw new Error("SDK release set schemaVersion must be 1");
  if (!versionPattern.test(document?.version ?? "")) throw new Error("SDK release set version must be stable semantic version x.y.z");
  if (!sourceTreePattern.test(document?.sourceTree ?? "")) throw new Error("SDK release set source tree is invalid");
  if (!Array.isArray(document?.artifacts)) throw new Error("SDK release set artifacts must be an array");
  if (options.expectedSourceTree && document.sourceTree !== options.expectedSourceTree) throw new Error("SDK release set source tree mismatch");
  if (options.expectedSdkSetId && document.sdkSetId !== options.expectedSdkSetId) throw new Error("SDK release set ID mismatch");
  if (document.sdkSetId !== computeSdkSetId(document)) throw new Error("SDK release set digest is invalid");

  const expected = expectedArtifactNames(document.version).sort();
  const names = document.artifacts.map((artifact) => artifact?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error("SDK release set must contain exactly the eight canonical artifacts");
  if (new Set(names.map((name) => basename(name))).size !== names.length) throw new Error("SDK release set artifact basenames must be unique");

  const root = resolve(artifactRoot);
  const actual = await filesBelow(root);
  const allowed = options.flatArtifacts ? expected.map((name) => basename(name)).sort() : expected;
  for (const name of actual) if (!allowed.includes(name)) throw new Error(`SDK release directory contains an unexpected file: ${name}`);
  for (const name of allowed) if (!actual.includes(name)) throw new Error(`SDK release directory is missing ${name}`);

  for (const artifact of document.artifacts) {
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 1 || !sha256Pattern.test(artifact.sha256 ?? "")) {
      throw new Error(`SDK release identity is invalid for ${artifact.name}`);
    }
    const bytes = await readFile(artifactPath(root, artifact.name, options.flatArtifacts));
    if (bytes.length !== artifact.size) throw new Error(`SDK release size mismatch for ${artifact.name}`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) throw new Error(`SDK release SHA-256 mismatch for ${artifact.name}`);
  }
  return { status: "VERIFIED", sdkSetId: document.sdkSetId, version: document.version, sourceTree: document.sourceTree, artifacts: document.artifacts };
}

function parseArgs(argv) {
  const flags = new Set(["flat-artifacts", "create"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]?.replace(/^--/, "");
    if (!name) throw new Error("Arguments must use --name syntax");
    if (flags.has(name)) values[name] = true;
    else {
      const value = argv[++index];
      if (!value) throw new Error(`--${name} requires a value`);
      values[name] = value;
    }
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options["artifact-root"]) throw new Error("--artifact-root is required");
  if (options.create) {
    if (!options.version || !options["source-tree"] || !options.output) throw new Error("--create requires --version, --source-tree and --output");
    const document = await createSdkReleaseSet({
      version: options.version,
      sourceTree: options["source-tree"],
      artifactRoot: options["artifact-root"],
      flatArtifacts: Boolean(options["flat-artifacts"]),
    });
    await writeFile(resolve(options.output), `${JSON.stringify(document, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }
  if (!options["release-set"]) throw new Error("--release-set is required");
  const document = JSON.parse(await readFile(resolve(options["release-set"]), "utf8"));
  const result = await verifySdkReleaseSet(document, options["artifact-root"], {
    flatArtifacts: Boolean(options["flat-artifacts"]),
    expectedSdkSetId: options["expected-sdk-set-id"],
    expectedSourceTree: options["expected-source-tree"],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`SDK release set: blocked (${error.message})\n`);
    process.exitCode = 1;
  });
}
