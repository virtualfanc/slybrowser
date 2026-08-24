#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const REQUIRED_LEGAL_RESOURCE_PATHS = [
  "BINARY-LICENSE.txt",
  "LICENSE-SCOPE.txt",
  "THIRD_PARTY_NOTICES.txt",
  "CREDITS.html",
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function options(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
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
function assertVersion(name, value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){1,7}$/.test(value)) {
    throw new Error(`${name} must be a dotted browser version string`);
  }
}
function assertHttpsUrl(name, value) {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    throw new Error(`${name} must use HTTPS`);
  }
}
function assertIdentity(name, actual, expected) {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`${name} hash or size does not match the signed manifest`);
}
function readZipEntryNames(content) {
  const eocdSignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const searchStart = Math.max(0, content.length - 65_557);
  let eocdOffset = -1;
  for (let offset = content.length - 22; offset >= searchStart; offset -= 1) {
    if (content.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return [];
  const centralDirectorySize = content.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = content.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset <= 0 ||
      centralDirectorySize <= 0 ||
      centralDirectoryOffset + centralDirectorySize > content.length) {
    return [];
  }
  const names = [];
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset + 46 <= end) {
    if (content.readUInt32LE(offset) !== centralDirectorySignature) return [];
    const fileNameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > end) return [];
    names.push(content.subarray(nameStart, nameEnd).toString("utf8").replaceAll("\\", "/"));
    offset = nameEnd + extraLength + commentLength;
  }
  return offset === end ? names : [];
}

function assertPublicArtifactSafety(content) {
  const zipEntryNames = readZipEntryNames(content);
  const text = zipEntryNames.length > 0 ? zipEntryNames.join("\n") : content.toString("latin1");
  const checks = [
    [/\.(?:pdb|dSYM|debug|sym|map)(?:\0|$|[^\w-])/i, "raw PDB or symbol files"],
    [/\.(?:pem|pfx|p12|key)(?:\0|$|[^\w-])/i, "key or certificate containers"],
    [/-----BEGIN (?:RSA |EC |OPENSSH |PRIVATE )?PRIVATE KEY-----/i, "private key material"],
    [/(?:[A-Z]:\\(?:chrome|multilogin|Users\\Administrator)|\/root\/|\/home\/[^/\0]+\/)/i, "internal build paths"],
  ];
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) {
      throw new Error(`Release artifact must not contain ${label}`);
    }
  }
}
function assertRequiredLegalResources(artifact, archiveContent) {
  const archiveIndex = archiveContent.toString("latin1").replaceAll("\\", "/");
  const resourcePaths = new Set(artifact.resources.map((item) => item.path));
  for (const requiredPath of REQUIRED_LEGAL_RESOURCE_PATHS) {
    if (!resourcePaths.has(requiredPath)) {
      throw new Error(`Release manifest must include required legal resource ${requiredPath}`);
    }
    if (!archiveIndex.includes(requiredPath)) {
      throw new Error(`Release archive must contain required legal file ${requiredPath}`);
    }
  }
}

const manifestPath = resolve(required("--manifest"));
const keyPath = resolve(required("--public-key"));
const expectedKeyId = required("--key-id");
const manifestFile = await identity(manifestPath);
const document = JSON.parse(manifestFile.content.toString("utf8").replace(/^\uFEFF/, ""));
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

assertVersion("Manifest browserVersion", document.browserVersion);
if (typeof document.sdkCompatibility !== "string" || document.sdkCompatibility.length === 0) {
  throw new Error("Manifest sdkCompatibility is required");
}
if (document.publishedAt !== undefined && Number.isNaN(Date.parse(document.publishedAt))) {
  throw new Error("Manifest publishedAt must be a valid date-time");
}
if (!Array.isArray(document.artifacts) || document.artifacts.length !== 1) throw new Error("Bundle qualification requires exactly one platform artifact");
if (document.status !== "available") throw new Error("Bundle qualification requires an available release manifest");
const artifact = document.artifacts[0];
assertHttpsUrl("Artifact URL", artifact.url);
if (!Array.isArray(artifact.privateModules) || artifact.privateModules.length === 0 ||
    !Array.isArray(artifact.resources) || artifact.resources.length === 0) {
  throw new Error("Artifact module/resource metadata is missing");
}
if (Object.hasOwn(artifact, "codeSignature")) {
  if (!artifact.codeSignature || typeof artifact.codeSignature !== "object" ||
      !["authenticode", "apple-developer-id", "x509-code-signing"].includes(artifact.codeSignature.scheme) ||
      typeof artifact.codeSignature.subject !== "string" || artifact.codeSignature.subject.length === 0 ||
      !/^[a-f0-9]{64}$/.test(artifact.codeSignature.certificateSha256) ||
      typeof artifact.codeSignature.timestampRequired !== "boolean") {
    throw new Error("Artifact code-signature metadata is invalid");
  }
}
const evidence = document.evidence;
if (evidence !== undefined && (!evidence?.sbom || !evidence?.provenance || !evidence?.chromiumPatchInventory)) {
  throw new Error("Supply-chain evidence is invalid");
}
const privateModulePaths = options("--private-module");
const resourcePaths = options("--resource");
if (privateModulePaths.length !== artifact.privateModules.length) throw new Error("Private module file count does not match the signed manifest");
if (resourcePaths.length !== artifact.resources.length) throw new Error("Resource file count does not match the signed manifest");
const [archiveFile, browserFile, driverFile] = await Promise.all([
  identity(resolve(required("--artifact"))), identity(resolve(required("--browser"))), identity(resolve(required("--driver"))),
]);
const privateModuleFiles = await Promise.all(privateModulePaths.map((path) => identity(resolve(path))));
const resourceFiles = await Promise.all(resourcePaths.map((path) => identity(resolve(path))));
assertPublicArtifactSafety(archiveFile.content);
assertIdentity("artifact", archiveFile, artifact);
if (browserFile.sha256 !== artifact.browserSha256) throw new Error("Browser binary hash does not match the signed manifest");
if (driverFile.sha256 !== artifact.driverSha256) throw new Error("WebDriver binary hash does not match the signed manifest");
for (let index = 0; index < artifact.privateModules.length; index += 1) {
  assertIdentity(`private module ${artifact.privateModules[index].path}`, privateModuleFiles[index], artifact.privateModules[index]);
}
for (let index = 0; index < artifact.resources.length; index += 1) {
  assertIdentity(`resource ${artifact.resources[index].path}`, resourceFiles[index], artifact.resources[index]);
}
assertRequiredLegalResources(artifact, archiveFile.content);
if (evidence !== undefined) {
  const [sbomFile, provenanceFile, patchesFile] = await Promise.all([
    identity(resolve(required("--sbom"))),
    identity(resolve(required("--provenance"))),
    identity(resolve(required("--patch-inventory"))),
  ]);
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
}
console.log(JSON.stringify({
  status: "QUALIFIED",
  browserVersion: document.browserVersion,
  driverVersion: typeof document.driverVersion === "string" ? document.driverVersion : null,
  sdkCompatibility: document.sdkCompatibility,
  publishedAt: typeof document.publishedAt === "string" ? document.publishedAt : null,
  keyId: expectedKeyId,
  platform: artifact.platform,
  arch: artifact.arch,
  artifactSha256: artifact.sha256,
  browserSha256: artifact.browserSha256,
  driverSha256: artifact.driverSha256,
  manifest: {
    file: basename(manifestPath),
    sizeBytes: manifestFile.size,
    sha256: manifestFile.sha256,
  },
  artifact: {
    platform: artifact.platform,
    arch: artifact.arch,
    url: artifact.url,
    sha256: artifact.sha256,
    sizeBytes: artifact.size,
    archiveFormat: artifact.archiveFormat,
    browserExecutable: artifact.browserExecutable,
    driverExecutable: artifact.driverExecutable,
    browserSha256: artifact.browserSha256,
    driverSha256: artifact.driverSha256,
    privateModuleCount: artifact.privateModules.length,
    resourceCount: artifact.resources.length,
    requiredLegalResources: REQUIRED_LEGAL_RESOURCE_PATHS,
    codeSignature: artifact.codeSignature ? {
      scheme: artifact.codeSignature.scheme,
      subject: artifact.codeSignature.subject,
      certificateSha256: artifact.codeSignature.certificateSha256,
      timestampRequired: artifact.codeSignature.timestampRequired,
    } : null,
  },
  supplyChainEvidence: evidence === undefined ? "not-provided" : "verified",
}));
