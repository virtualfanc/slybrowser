#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  throw new TypeError("Document cannot be canonicalized");
}
async function identity(path) {
  const content = await readFile(path);
  return { content, size: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}
function assertIdentity(name, actual, expected) {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`${name} hash or size does not match the signed manifest`);
}

const manifestPath = resolve(required("--manifest"));
const keyPath = resolve(required("--public-key"));
const expectedKeyId = required("--key-id");
const document = JSON.parse((await readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""));
const { signature, ...payload } = document;
if (signature?.algorithm !== "ed25519" || signature.keyId !== expectedKeyId || typeof signature.value !== "string") {
  throw new Error("Manifest signature identity is invalid");
}
const publicKey = createPublicKey(await readFile(keyPath));
if (publicKey.asymmetricKeyType !== "ed25519" || !verify(
  null,
  Buffer.from(JSON.stringify(normalize(payload))),
  publicKey,
  Buffer.from(signature.value, "base64url"),
)) throw new Error("Manifest signature verification failed");

if (!Array.isArray(document.artifacts) || document.artifacts.length !== 1) throw new Error("Bundle qualification requires exactly one platform artifact");
const artifact = document.artifacts[0];
const evidence = document.evidence;
if (!evidence?.sbom || !evidence?.provenance || !evidence?.chromiumPatchInventory) throw new Error("Supply-chain evidence is missing");
const [archiveFile, browserFile, driverFile, sbomFile, provenanceFile, patchesFile] = await Promise.all([
  identity(resolve(required("--artifact"))), identity(resolve(required("--browser"))), identity(resolve(required("--driver"))),
  identity(resolve(required("--sbom"))), identity(resolve(required("--provenance"))), identity(resolve(required("--patch-inventory"))),
]);
assertIdentity("artifact", archiveFile, artifact);
if (browserFile.sha256 !== artifact.browserSha256) throw new Error("Browser binary hash does not match the signed manifest");
if (driverFile.sha256 !== artifact.driverSha256) throw new Error("WebDriver binary hash does not match the signed manifest");
assertIdentity("SBOM", sbomFile, evidence.sbom);
assertIdentity("provenance", provenanceFile, evidence.provenance);
assertIdentity("Chromium patch inventory", patchesFile, evidence.chromiumPatchInventory);
const sbom = JSON.parse(sbomFile.content);
const provenance = JSON.parse(provenanceFile.content);
const patches = JSON.parse(patchesFile.content);
if (sbom.bomFormat !== "CycloneDX" || provenance._type !== "https://in-toto.io/Statement/v1" ||
    patches.schemaVersion !== 1 || !Array.isArray(patches.files) || patches.files.length === 0) {
  throw new Error("Supply-chain evidence content is invalid");
}
console.log(JSON.stringify({ status: "QUALIFIED", browserVersion: document.browserVersion, keyId: expectedKeyId }));
