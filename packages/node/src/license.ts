import { createPublicKey, verify as verifySignature } from "node:crypto";

import { decodeBase64Url } from "./canonical.js";
import { LicenseError } from "./errors.js";

const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface LicenseClaims {
  schemaVersion: 1 | 2;
  licenseId: string;
  audience: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  browserVersion?: string;
  browserMin: string;
  browserMax: string;
  planId?: string;
  concurrencyLimit?: number;
  paidThrough?: number | null;
  licenseStatus?: "active" | "hold" | "revoked";
  artifactSha256?: string;
  browserSha256?: string;
  driverSha256?: string;
  artifact?: LicenseArtifactClaims;
  leaseGeneration?: number;
  features: string[];
  sessionId: string;
  nonce: string;
  deviceHash?: string;
}

export interface LicensePrivateModuleClaims {
  path: string;
  sha256: string;
  size: number;
  abi: string;
}

export interface LicenseResourceClaims {
  path: string;
  sha256: string;
  size: number;
}

export interface LicenseCodeSignatureClaims {
  scheme: "authenticode" | "apple-developer-id" | "x509-code-signing";
  subject: string;
  certificateSha256: string;
  timestampRequired: boolean;
}

export interface LicenseArtifactClaims {
  sha256: string;
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  archiveFormat: "zip";
  browserExecutable: string;
  driverExecutable: string;
  browserSha256: string;
  driverSha256: string;
  privateModules: LicensePrivateModuleClaims[];
  resources: LicenseResourceClaims[];
  codeSignature?: LicenseCodeSignatureClaims;
}

export interface LicenseEnvelope {
  algorithm: "Ed25519";
  keyId: string;
  payload: string;
  signature: string;
}

export interface LicenseVerificationOptions {
  browserVersion: string;
  audience?: string;
  requiredFeatures?: Iterable<string>;
  deviceHash?: string;
}

function fail(code: string, message: string): never {
  throw new LicenseError(message, code);
}

function requiredString(document: Record<string, unknown>, name: string): string {
  const value = document[name];
  if (typeof value !== "string" || !value || value.length > 512) {
    fail("license_invalid_claims", `Claim ${name} is invalid`);
  }
  return value;
}

function requiredInteger(document: Record<string, unknown>, name: string): number {
  const value = document[name];
  if (!Number.isSafeInteger(value)) fail("license_invalid_claims", `Claim ${name} is invalid`);
  return value as number;
}

function parseVersion(value: string): number[] {
  if (!/^\d+(\.\d+){0,7}$/.test(value)) fail("license_invalid_claims", "Browser version is invalid");
  return value.split(".").map(Number);
}

function compareVersions(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function optionalArtifactClaims(document: Record<string, unknown>, schemaVersion: 1 | 2): LicenseArtifactClaims | undefined {
  const value = document.artifact;
  if (value === undefined) {
    if (schemaVersion === 2) fail("license_invalid_claims", "Claim artifact is invalid");
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("license_invalid_claims", "Claim artifact is invalid");
  }
  const artifact = value as Record<string, unknown>;
  const platform = requiredString(artifact, "platform") as LicenseArtifactClaims["platform"];
  const arch = requiredString(artifact, "arch") as LicenseArtifactClaims["arch"];
  const archiveFormat = requiredString(artifact, "archiveFormat") as LicenseArtifactClaims["archiveFormat"];
  if (!["windows", "linux", "macos"].includes(platform) ||
      !["x64", "arm64"].includes(arch) ||
      archiveFormat !== "zip") {
    fail("license_invalid_claims", "Claim artifact is invalid");
  }
  const modules = artifact.privateModules;
  const resources = artifact.resources;
  if (!Array.isArray(modules) || !Array.isArray(resources)) {
    fail("license_invalid_claims", "Claim artifact is invalid");
  }
  const privateModules = modules.map((module) => {
    if (!module || typeof module !== "object" || Array.isArray(module)) fail("license_invalid_claims", "Claim artifact is invalid");
    const item = module as Record<string, unknown>;
    const path = requiredString(item, "path");
    const sha256 = requiredString(item, "sha256");
    const size = requiredInteger(item, "size");
    const abi = requiredString(item, "abi");
    if (!isSha256(sha256) || size < 0) fail("license_invalid_claims", "Claim artifact is invalid");
    return { path, sha256, size, abi };
  });
  const resourceClaims = resources.map((resource) => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) fail("license_invalid_claims", "Claim artifact is invalid");
    const item = resource as Record<string, unknown>;
    const path = requiredString(item, "path");
    const sha256 = requiredString(item, "sha256");
    const size = requiredInteger(item, "size");
    if (!isSha256(sha256) || size < 0) fail("license_invalid_claims", "Claim artifact is invalid");
    return { path, sha256, size };
  });
  let codeSignature: LicenseCodeSignatureClaims | undefined;
  if (Object.hasOwn(artifact, "codeSignature")) {
    const signature = artifact.codeSignature;
    if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
      fail("license_invalid_claims", "Claim artifact is invalid");
    }
    const signatureDocument = signature as Record<string, unknown>;
    const scheme = requiredString(signatureDocument, "scheme") as LicenseCodeSignatureClaims["scheme"];
    const certificateSha256 = requiredString(signatureDocument, "certificateSha256");
    const timestampRequired = signatureDocument.timestampRequired;
    if (!["authenticode", "apple-developer-id", "x509-code-signing"].includes(scheme) ||
        !isSha256(certificateSha256) ||
        typeof timestampRequired !== "boolean") {
      fail("license_invalid_claims", "Claim artifact is invalid");
    }
    codeSignature = {
      scheme,
      subject: requiredString(signatureDocument, "subject"),
      certificateSha256,
      timestampRequired,
    };
  }
  const sha256 = requiredString(artifact, "sha256");
  const browserSha256 = requiredString(artifact, "browserSha256");
  const driverSha256 = requiredString(artifact, "driverSha256");
  if (!isSha256(sha256) || !isSha256(browserSha256) || !isSha256(driverSha256)) {
    fail("license_invalid_claims", "Claim artifact is invalid");
  }
  return {
    sha256,
    platform,
    arch,
    archiveFormat,
    browserExecutable: requiredString(artifact, "browserExecutable"),
    driverExecutable: requiredString(artifact, "driverExecutable"),
    browserSha256,
    driverSha256,
    privateModules,
    resources: resourceClaims,
    ...(codeSignature === undefined ? {} : { codeSignature }),
  };
}

function parseEnvelope(value: string | Buffer | LicenseEnvelope): Record<string, unknown> {
  if (typeof value === "object" && !Buffer.isBuffer(value)) return { ...value };
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (raw.length > MAX_ENVELOPE_BYTES) fail("license_invalid_envelope", "License envelope is too large");
  try {
    const result: unknown = JSON.parse(raw.toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError();
    return result as Record<string, unknown>;
  } catch {
    fail("license_invalid_envelope", "License envelope is not valid JSON");
  }
}

export class LicenseVerifier {
  readonly #trustedKeys: ReadonlyMap<string, Buffer>;
  readonly #now: () => number;
  readonly #clockSkewSeconds: number;
  readonly #maxLifetimeSeconds: number;

  constructor(
    trustedKeys: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
    options: { now?: () => number; clockSkewSeconds?: number; maxLifetimeSeconds?: number } = {},
  ) {
    const entries = trustedKeys instanceof Map ? trustedKeys.entries() : Object.entries(trustedKeys);
    this.#trustedKeys = new Map([...entries].map(([key, value]) => [key, Buffer.from(value)]));
    if ([...this.#trustedKeys.values()].some((key) => key.length !== 32)) {
      throw new TypeError("Ed25519 public keys must contain exactly 32 bytes");
    }
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#clockSkewSeconds = options.clockSkewSeconds ?? 30;
    this.#maxLifetimeSeconds = options.maxLifetimeSeconds ?? 24 * 60 * 60;
  }

  verify(value: string | Buffer | LicenseEnvelope, options: LicenseVerificationOptions): LicenseClaims {
    const envelope = parseEnvelope(value);
    const fields = Object.keys(envelope).sort().join(",");
    if (fields !== "algorithm,keyId,payload,signature") {
      fail("license_invalid_envelope", "License envelope fields are invalid");
    }
    if (envelope.algorithm !== "Ed25519") {
      fail("license_algorithm_unsupported", "License algorithm is not allowed");
    }
    const keyId = requiredString(envelope, "keyId");
    const publicKey = this.#trustedKeys.get(keyId);
    if (!publicKey) fail("license_key_unknown", "License signing key is not trusted");

    let payload: Buffer;
    let signature: Buffer;
    try {
      payload = decodeBase64Url(envelope.payload, MAX_PAYLOAD_BYTES);
      signature = decodeBase64Url(envelope.signature, 64);
    } catch {
      fail("license_invalid_envelope", "License encoding is invalid");
    }
    if (signature.length !== 64) fail("license_invalid_signature", "License signature length is invalid");
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, payload, key, signature)) {
      fail("license_invalid_signature", "License signature is invalid");
    }

    let document: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
      document = parsed as Record<string, unknown>;
    } catch {
      fail("license_invalid_claims", "License payload is not valid JSON");
    }
    return this.#validateClaims(document, options);
  }

  #validateClaims(document: Record<string, unknown>, options: LicenseVerificationOptions): LicenseClaims {
    const schemaVersion = requiredInteger(document, "schemaVersion");
    if (schemaVersion !== 1 && schemaVersion !== 2) {
      fail("license_schema_unsupported", "License schema is not supported");
    }
    const audience = requiredString(document, "audience");
    if (audience !== (options.audience ?? "slybrowser")) {
      fail("license_wrong_audience", "License audience does not match");
    }
    const issuedAt = requiredInteger(document, "issuedAt");
    const notBefore = requiredInteger(document, "notBefore");
    const expiresAt = requiredInteger(document, "expiresAt");
    if (notBefore < issuedAt || expiresAt <= notBefore) {
      fail("license_invalid_time", "License time range is invalid");
    }
    if (expiresAt - issuedAt > this.#maxLifetimeSeconds) {
      fail("license_lifetime_exceeded", "License lifetime exceeds policy");
    }
    const now = Math.floor(this.#now());
    if (issuedAt > now + this.#clockSkewSeconds || notBefore > now + this.#clockSkewSeconds) {
      fail("license_not_yet_valid", "License is not yet valid");
    }
    if (expiresAt <= now - this.#clockSkewSeconds) fail("license_expired", "License has expired");

    const browserMin = requiredString(document, "browserMin");
    const browserMax = requiredString(document, "browserMax");
    const browserVersion = parseVersion(options.browserVersion);
    const claimBrowserVersion = document.browserVersion === undefined ? undefined : requiredString(document, "browserVersion");
    if (schemaVersion === 2 && claimBrowserVersion !== options.browserVersion) {
      fail("license_browser_unsupported", "Browser version is outside the license range");
    }
    if (
      compareVersions(parseVersion(browserMin), browserVersion) > 0 ||
      compareVersions(browserVersion, parseVersion(browserMax)) > 0
    ) {
      fail("license_browser_unsupported", "Browser version is outside the license range");
    }

    const planIdValue = document.planId;
    const planId = planIdValue === undefined ? undefined : requiredString(document, "planId");
    const concurrencyValue = document.concurrencyLimit;
    const concurrencyLimit = concurrencyValue === undefined ? undefined : requiredInteger(document, "concurrencyLimit");
    if (concurrencyLimit !== undefined && concurrencyLimit < 1) {
      fail("license_invalid_claims", "Claim concurrencyLimit is invalid");
    }
    const paidThroughValue = document.paidThrough;
    const paidThrough = paidThroughValue === undefined || paidThroughValue === null
      ? paidThroughValue as undefined | null
      : requiredInteger(document, "paidThrough");
    if (paidThrough !== undefined && paidThrough !== null && paidThrough < 0) {
      fail("license_invalid_claims", "Claim paidThrough is invalid");
    }
    const licenseStatusValue = document.licenseStatus;
    const licenseStatus = licenseStatusValue === undefined
      ? undefined
      : requiredString(document, "licenseStatus") as LicenseClaims["licenseStatus"];
    if (licenseStatus !== undefined && !["active", "hold", "revoked"].includes(licenseStatus)) {
      fail("license_invalid_claims", "Claim licenseStatus is invalid");
    }
    const artifactSha256Value = document.artifactSha256;
    const artifactSha256 = artifactSha256Value === undefined ? undefined : requiredString(document, "artifactSha256");
    if (artifactSha256 !== undefined && !isSha256(artifactSha256)) {
      fail("license_invalid_claims", "Claim artifactSha256 is invalid");
    }
    const browserSha256Value = document.browserSha256;
    const browserSha256 = browserSha256Value === undefined ? undefined : requiredString(document, "browserSha256");
    if (browserSha256 !== undefined && !isSha256(browserSha256)) {
      fail("license_invalid_claims", "Claim browserSha256 is invalid");
    }
    const driverSha256Value = document.driverSha256;
    const driverSha256 = driverSha256Value === undefined ? undefined : requiredString(document, "driverSha256");
    if (driverSha256 !== undefined && !isSha256(driverSha256)) {
      fail("license_invalid_claims", "Claim driverSha256 is invalid");
    }
    const leaseGenerationValue = document.leaseGeneration;
    const leaseGeneration = leaseGenerationValue === undefined ? undefined : requiredInteger(document, "leaseGeneration");
    if (leaseGeneration !== undefined && leaseGeneration < 1) {
      fail("license_invalid_claims", "Claim leaseGeneration is invalid");
    }
    const artifact = optionalArtifactClaims(document, schemaVersion);
    if (artifact !== undefined &&
        (artifact.sha256 !== artifactSha256 || artifact.browserSha256 !== browserSha256 || artifact.driverSha256 !== driverSha256)) {
      fail("license_invalid_claims", "Claim artifact does not match flat hashes");
    }

    const features = document.features;
    if (
      !Array.isArray(features) ||
      features.some((item) => typeof item !== "string" || !item || item.length > 128) ||
      new Set(features).size !== features.length
    ) {
      fail("license_invalid_claims", "License features are invalid");
    }
    const missing = [...(options.requiredFeatures ?? [])].filter((item) => !features.includes(item));
    if (missing.length) fail("license_feature_denied", `License does not grant: ${missing.sort().join(", ")}`);

    const claimDeviceHash = document.deviceHash;
    if (claimDeviceHash !== undefined && (typeof claimDeviceHash !== "string" || !claimDeviceHash)) {
      fail("license_invalid_claims", "License device hash is invalid");
    }
    if (options.deviceHash !== undefined && claimDeviceHash !== options.deviceHash) {
      fail("license_device_mismatch", "License device binding does not match");
    }

    const claims: LicenseClaims = {
      schemaVersion,
      licenseId: requiredString(document, "licenseId"),
      audience,
      issuedAt,
      notBefore,
      expiresAt,
      ...(claimBrowserVersion === undefined ? {} : { browserVersion: claimBrowserVersion }),
      browserMin,
      browserMax,
      ...(planId === undefined ? {} : { planId }),
      ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
      ...(paidThrough === undefined ? {} : { paidThrough }),
      ...(licenseStatus === undefined ? {} : { licenseStatus }),
      ...(artifactSha256 === undefined ? {} : { artifactSha256 }),
      ...(browserSha256 === undefined ? {} : { browserSha256 }),
      ...(driverSha256 === undefined ? {} : { driverSha256 }),
      ...(artifact === undefined ? {} : { artifact }),
      ...(leaseGeneration === undefined ? {} : { leaseGeneration }),
      features: features as string[],
      sessionId: requiredString(document, "sessionId"),
      nonce: requiredString(document, "nonce"),
    };
    if (typeof claimDeviceHash === "string") claims.deviceHash = claimDeviceHash;
    return claims;
  }
}
