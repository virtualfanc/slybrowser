#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function digest(path) {
  const content = await readFile(path);
  return { sha256: createHash("sha256").update(content).digest("hex"), size: content.length };
}

async function patchFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Patch inventory cannot contain symlinks: ${path}`);
    if (entry.isDirectory()) result.push(...await patchFiles(root, path));
    else if (entry.isFile() && (entry.name.endsWith(".patch") || entry.name === "args.gn")) {
      const identity = await digest(path);
      result.push({ path: relative(root, path).replaceAll("\\", "/"), ...identity });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function uuidFromHash(hash) {
  return `urn:uuid:${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const artifact = resolve(required("--artifact"));
const browser = resolve(required("--browser"));
const driver = resolve(required("--driver"));
const patchRoot = resolve(required("--patch-root"));
const outputDirectory = resolve(required("--output-dir"));
const browserVersion = required("--browser-version");
const chromiumCommit = required("--chromium-commit");
const repository = required("--repository");
if (!/^\d+(?:\.\d+){1,7}$/.test(browserVersion)) throw new Error("--browser-version is invalid");
if (!/^[a-f0-9]{7,64}$/i.test(chromiumCommit)) throw new Error("--chromium-commit is invalid");
if (!repository.startsWith("https://")) throw new Error("--repository must use HTTPS");
if (!(await stat(patchRoot)).isDirectory()) throw new Error("--patch-root must be a directory");

const [artifactIdentity, browserIdentity, driverIdentity, patches] = await Promise.all([
  digest(artifact), digest(browser), digest(driver), patchFiles(patchRoot),
]);
if (patches.length === 0) throw new Error("Patch inventory must contain at least one .patch or args.gn file");
const created = new Date().toISOString();
const serialHash = createHash("sha256").update(`${browserVersion}:${artifactIdentity.sha256}`).digest("hex");
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: uuidFromHash(serialHash),
  version: 1,
  metadata: { timestamp: created, component: { type: "application", name: "SlyBrowser", version: browserVersion } },
  components: [
    { type: "file", name: basename(artifact), hashes: [{ alg: "SHA-256", content: artifactIdentity.sha256 }] },
    { type: "file", name: basename(browser), hashes: [{ alg: "SHA-256", content: browserIdentity.sha256 }] },
    { type: "file", name: basename(driver), hashes: [{ alg: "SHA-256", content: driverIdentity.sha256 }] },
  ],
};
const provenance = {
  _type: "https://in-toto.io/Statement/v1",
  subject: [{ name: basename(artifact), digest: { sha256: artifactIdentity.sha256 } }],
  predicateType: "https://slsa.dev/provenance/v1",
  predicate: {
    buildDefinition: {
      buildType: "https://slybrowser.com/build-types/chromium-release/v1",
      externalParameters: { browserVersion, chromiumCommit },
      resolvedDependencies: [{ uri: repository, digest: { gitCommit: chromiumCommit.toLowerCase() } }],
    },
    runDetails: { builder: { id: "https://slybrowser.com/builders/release" }, metadata: { invocationId: serialHash } },
  },
};
const patchInventory = {
  schemaVersion: 1,
  browserVersion,
  chromiumCommit: chromiumCommit.toLowerCase(),
  sourceBoundary: "inventory-and-approved-patches",
  generatedAt: created,
  files: patches,
};

await mkdir(outputDirectory, { recursive: true });
const outputs = {
  sbom: join(outputDirectory, "slybrowser.cdx.json"),
  provenance: join(outputDirectory, "slybrowser.provenance.json"),
  chromiumPatchInventory: join(outputDirectory, "slybrowser.chromium-patches.json"),
};
await Promise.all([
  writeFile(outputs.sbom, `${JSON.stringify(sbom, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
  writeFile(outputs.provenance, `${JSON.stringify(provenance, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
  writeFile(outputs.chromiumPatchInventory, `${JSON.stringify(patchInventory, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
]);
console.log(JSON.stringify(outputs));
