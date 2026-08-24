import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import { canonicalJson, decodeBase64Url } from "./canonical.js";
import { ArtifactError, ManifestError } from "./errors.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ReleaseArtifact {
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  url: string;
  sha256: string;
  size: number;
  archiveFormat: "zip";
  browserExecutable: string;
  driverExecutable: string;
  browserSha256: string;
  driverSha256: string;
  privateModules: ReleasePrivateModule[];
  resources: ReleaseResourceFile[];
  codeSignature?: ReleaseCodeSignature;
}

export interface ReleasePrivateModule {
  path: string;
  sha256: string;
  size: number;
  abi: string;
}

export interface ReleaseResourceFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ReleaseCodeSignature {
  scheme: "authenticode" | "apple-developer-id" | "x509-code-signing";
  subject: string;
  certificateSha256: string;
  timestampRequired: boolean;
}

export interface ReleaseEvidenceArtifact {
  url: string;
  sha256: string;
  size: number;
  mediaType: "application/vnd.cyclonedx+json" | "application/vnd.in-toto+json" |
    "application/vnd.slybrowser.chromium-patch-inventory+json";
}

export interface ReleaseEvidence {
  sbom: ReleaseEvidenceArtifact;
  provenance: ReleaseEvidenceArtifact;
  chromiumPatchInventory: ReleaseEvidenceArtifact;
  sourceBoundary: {
    sdk: "open-source";
    chromiumPatches: "inventory-and-approved-patches";
    proprietaryCore: "private";
  };
}

export interface ReleaseManifest {
  schemaVersion: 1;
  browserVersion: string;
  sdkCompatibility: string;
  status: "available" | "revoked";
  artifacts: ReleaseArtifact[];
  evidence?: ReleaseEvidence;
  signature: { algorithm: "ed25519"; keyId: string; value: string };
}

function fail(message: string, code: string): never {
  throw new ManifestError(message, code);
}

function numericVersion(value: string): number[] {
  if (!/^\d+(\.\d+){0,7}$/.test(value)) fail("SDK version is invalid", "sdk_version_invalid");
  return value.split(".").map(Number);
}

function compareNumericVersions(left: string, right: string): number {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function isSdkCompatible(range: string, version: string): boolean {
  numericVersion(version);
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) fail("Manifest SDK compatibility is invalid", "manifest_invalid");
  return tokens.every((token) => {
    if (token.startsWith("^")) return isCaretCompatible(token.slice(1), version);
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,7})$/.exec(token);
    if (!match) fail("Manifest SDK compatibility is invalid", "manifest_invalid");
    const comparison = compareNumericVersions(version, match[2]!);
    switch (match[1] ?? "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      default: return comparison === 0;
    }
  });
}

function isCaretCompatible(base: string, version: string): boolean {
  const parts = numericVersion(base);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  const upper = major > 0
    ? `${major + 1}.0.0`
    : minor > 0
      ? `0.${minor + 1}.0`
      : `0.0.${patch + 1}`;
  return compareNumericVersions(version, base) >= 0 && compareNumericVersions(version, upper) < 0;
}

export function verifyReleaseManifest(
  value: string | Buffer | Record<string, unknown>,
  trustedKeys: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): ReleaseManifest {
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = typeof value === "object" && !Buffer.isBuffer(value)
      ? value
      : JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    document = { ...(parsed as Record<string, unknown>) };
  } catch {
    fail("Manifest is not valid JSON", "manifest_invalid");
  }
  const signature = document.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    fail("Manifest signature block is invalid", "manifest_invalid_signature");
  }
  const signatureDocument = signature as Record<string, unknown>;
  if (Object.keys(signatureDocument).sort().join(",") !== "algorithm,keyId,value") {
    fail("Manifest signature block is invalid", "manifest_invalid_signature");
  }
  if (signatureDocument.algorithm !== "ed25519") {
    fail("Manifest signature algorithm is unsupported", "manifest_algorithm_unsupported");
  }
  const keyId = signatureDocument.keyId;
  if (typeof keyId !== "string") fail("Manifest signing key is unknown", "manifest_key_unknown");
  const keySource = trustedKeys instanceof Map
    ? trustedKeys.get(keyId)
    : (trustedKeys as Record<string, Uint8Array>)[keyId];
  if (!keySource || keySource.length !== 32) fail("Manifest signing key is unknown", "manifest_key_unknown");
  let signatureBytes: Buffer;
  try {
    signatureBytes = decodeBase64Url(signatureDocument.value, 64);
  } catch {
    fail("Manifest signature encoding is invalid", "manifest_invalid_signature");
  }
  const payload = { ...document };
  delete payload.signature;
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(keySource)]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(null, canonicalJson(payload), publicKey, signatureBytes)) {
    fail("Manifest signature is invalid", "manifest_invalid_signature");
  }
  if (document.schemaVersion !== 1) fail("Manifest schema is unsupported", "manifest_schema_unsupported");
  if (typeof document.browserVersion !== "string" || !document.browserVersion) {
    fail("Manifest browser version is invalid", "manifest_invalid");
  }
  if (typeof document.sdkCompatibility !== "string" || !document.sdkCompatibility) {
    fail("Manifest SDK compatibility is invalid", "manifest_invalid");
  }
  if (document.status !== "available" && document.status !== "revoked") {
    fail("Manifest release status is invalid", "manifest_invalid");
  }
  if (!Array.isArray(document.artifacts) || document.artifacts.length === 0) {
    fail("Manifest artifacts are invalid", "manifest_invalid");
  }
  const artifacts = document.artifacts.map(parseArtifact);
  const identities = artifacts.map((item) => `${item.platform}/${item.arch}`);
  if (new Set(identities).size !== identities.length) {
    fail("Manifest has duplicate platform artifacts", "manifest_duplicate_artifact");
  }
  const evidence = document.evidence === undefined ? undefined : parseEvidence(document.evidence);
  return { ...(document as unknown as ReleaseManifest), artifacts, ...(evidence === undefined ? {} : { evidence }) };
}

function parseEvidenceArtifact(value: unknown, mediaType: ReleaseEvidenceArtifact["mediaType"]): ReleaseEvidenceArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Release evidence is invalid", "manifest_evidence_invalid");
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "mediaType,sha256,size,url" ||
      typeof document.url !== "string" || !document.url.startsWith("https://") ||
      typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.sha256) ||
      !Number.isSafeInteger(document.size) || (document.size as number) <= 0 || document.mediaType !== mediaType) {
    fail("Release evidence is invalid", "manifest_evidence_invalid");
  }
  return document as unknown as ReleaseEvidenceArtifact;
}

function parseEvidence(value: unknown): ReleaseEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Release evidence is missing", "manifest_evidence_missing");
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "chromiumPatchInventory,provenance,sbom,sourceBoundary") {
    fail("Release evidence fields are invalid", "manifest_evidence_invalid");
  }
  const boundary = document.sourceBoundary;
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) fail("Source boundary is invalid", "manifest_evidence_invalid");
  const sourceBoundary = boundary as Record<string, unknown>;
  if (Object.keys(sourceBoundary).sort().join(",") !== "chromiumPatches,proprietaryCore,sdk" ||
      sourceBoundary.sdk !== "open-source" || sourceBoundary.chromiumPatches !== "inventory-and-approved-patches" ||
      sourceBoundary.proprietaryCore !== "private") {
    fail("Source boundary is invalid", "manifest_evidence_invalid");
  }
  return {
    sbom: parseEvidenceArtifact(document.sbom, "application/vnd.cyclonedx+json"),
    provenance: parseEvidenceArtifact(document.provenance, "application/vnd.in-toto+json"),
    chromiumPatchInventory: parseEvidenceArtifact(
      document.chromiumPatchInventory,
      "application/vnd.slybrowser.chromium-patch-inventory+json",
    ),
    sourceBoundary: sourceBoundary as unknown as ReleaseEvidence["sourceBoundary"],
  };
}

function parseArtifact(value: unknown): ReleaseArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Artifact is invalid", "manifest_invalid");
  const document = value as Record<string, unknown>;
  const keys = Object.keys(document);
  const requiredKeys = [
    "arch", "archiveFormat", "browserExecutable", "browserSha256", "driverExecutable",
    "driverSha256", "platform", "privateModules", "resources", "sha256", "size", "url",
  ];
  const allowedKeys = new Set([...requiredKeys, "codeSignature"]);
  if (requiredKeys.some((key) => !keys.includes(key)) || keys.some((key) => !allowedKeys.has(key))) {
    fail("Artifact fields are invalid", "manifest_invalid");
  }
  if (!new Set(["windows", "linux", "macos"]).has(document.platform as string)) {
    fail("Artifact platform is invalid", "manifest_invalid");
  }
  if (!new Set(["x64", "arm64"]).has(document.arch as string)) {
    fail("Artifact architecture is invalid", "manifest_invalid");
  }
  if (typeof document.url !== "string" || !document.url.startsWith("https://")) {
    fail("Artifact URL must use HTTPS", "manifest_invalid");
  }
  if (typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.sha256)) {
    fail("Artifact SHA-256 is invalid", "manifest_invalid");
  }
  if (!Number.isSafeInteger(document.size) || (document.size as number) <= 0) {
    fail("Artifact size is invalid", "manifest_invalid");
  }
  if (document.archiveFormat !== "zip" ||
      typeof document.browserExecutable !== "string" || !safeRelativePath(document.browserExecutable) ||
      typeof document.driverExecutable !== "string" || !safeRelativePath(document.driverExecutable) ||
      typeof document.browserSha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.browserSha256) ||
      typeof document.driverSha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.driverSha256)) {
    fail("Artifact runtime metadata is invalid", "manifest_invalid");
  }
  const privateModules = parsePrivateModules(document.privateModules);
  const resources = parseResources(document.resources);
  const codeSignature = Object.hasOwn(document, "codeSignature")
    ? parseCodeSignature(document.codeSignature)
    : undefined;
  return {
    ...(document as unknown as ReleaseArtifact),
    privateModules,
    resources,
    ...(codeSignature === undefined ? {} : { codeSignature }),
  };
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) && !value.replaceAll("\\", "/").split("/").includes("..");
}

function parsePrivateModules(value: unknown): ReleasePrivateModule[] {
  if (!Array.isArray(value) || value.length === 0) fail("Artifact private module metadata is invalid", "manifest_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("Artifact private module metadata is invalid", "manifest_invalid");
    const document = item as Record<string, unknown>;
    if (Object.keys(document).sort().join(",") !== "abi,path,sha256,size" ||
        typeof document.path !== "string" || !safeRelativePath(document.path) ||
        typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.sha256) ||
        !Number.isSafeInteger(document.size) || (document.size as number) <= 0 ||
        typeof document.abi !== "string" || document.abi.length === 0 || document.abi.length > 128) {
      fail("Artifact private module metadata is invalid", "manifest_invalid");
    }
    return document as unknown as ReleasePrivateModule;
  });
}

function parseResources(value: unknown): ReleaseResourceFile[] {
  if (!Array.isArray(value) || value.length === 0) fail("Artifact resource metadata is invalid", "manifest_invalid");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("Artifact resource metadata is invalid", "manifest_invalid");
    const document = item as Record<string, unknown>;
    if (Object.keys(document).sort().join(",") !== "path,sha256,size" ||
        typeof document.path !== "string" || !safeRelativePath(document.path) ||
        typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.sha256) ||
        !Number.isSafeInteger(document.size) || (document.size as number) <= 0) {
      fail("Artifact resource metadata is invalid", "manifest_invalid");
    }
    return document as unknown as ReleaseResourceFile;
  });
}

function parseCodeSignature(value: unknown): ReleaseCodeSignature {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Artifact code signature metadata is invalid", "manifest_invalid");
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "certificateSha256,scheme,subject,timestampRequired" ||
      !new Set(["authenticode", "apple-developer-id", "x509-code-signing"]).has(document.scheme as string) ||
      typeof document.subject !== "string" || document.subject.length === 0 || document.subject.length > 512 ||
      typeof document.certificateSha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.certificateSha256) ||
      typeof document.timestampRequired !== "boolean") {
    fail("Artifact code signature metadata is invalid", "manifest_invalid");
  }
  return document as unknown as ReleaseCodeSignature;
}

export function selectArtifact(manifest: ReleaseManifest, platform: string, arch: string): ReleaseArtifact {
  const matches = manifest.artifacts.filter((item) => item.platform === platform && item.arch === arch);
  if (matches.length !== 1) {
    const available = manifest.artifacts.map((item) => `${item.platform}/${item.arch}`).sort().join(", ");
    fail(`No signed artifact supports ${platform}/${arch}; available targets: ${available}`, "artifact_not_found");
  }
  return matches[0]!;
}

export async function verifyArtifact(path: string, artifact: ReleaseArtifact): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ArtifactError("Browser artifact is missing", "artifact_missing");
  }
  if (!info.isFile()) throw new ArtifactError("Browser artifact is missing", "artifact_missing");
  if (info.size !== artifact.size) throw new ArtifactError("Browser artifact size does not match", "artifact_size_mismatch");
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  if (digest.digest("hex") !== artifact.sha256) {
    throw new ArtifactError("Browser artifact checksum does not match", "artifact_hash_mismatch");
  }
}
