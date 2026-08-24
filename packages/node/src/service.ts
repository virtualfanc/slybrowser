import { spawn } from "node:child_process";
import { createDecipheriv, createHash, createPublicKey, randomUUID, scryptSync, verify as verifySignature } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AutomationBackend } from "./automation.js";
import { canonicalJson, decodeBase64Url } from "./canonical.js";
import { LicenseServiceError } from "./errors.js";
import { type LicenseEnvelope, type LicenseClaims, LicenseVerifier } from "./license.js";
import {
  type ReleaseArtifact,
  type ReleaseManifest,
  isSdkCompatible,
  selectArtifact,
  verifyReleaseManifest,
} from "./manifest.js";

export interface LicenseAuthorization {
  schemaVersion: 1;
  serviceUrl: string;
  licenseKey: string;
  channel: "stable";
}

export interface LicenseFileReadOptions {
  allowInsecureLocalhost?: boolean;
  licenseFilePassphrase?: string;
  licenseFileTrustedKeys?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  trustedServiceUrls?: readonly string[];
}

export interface SealedLicenseImportResult {
  output: string;
  serviceUrl: string;
  channel: "stable";
  protection: "windows-dpapi-current-user";
  licenseKeySha256: string;
}

export interface LicensedSessionGrant {
  sessionId: string;
  sessionToken: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: "free" | "launch" | "studio" | "fleet" | "grid";
  features: readonly string[];
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  requestedBrowserVersion?: string;
  requestedKernelMajor?: KernelMajor;
  versionPolicy: BrowserVersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  selectionMode?: SelectionMode;
  availableBrowserVersions: string[];
  latestAvailableVersion?: string;
  updateAvailable?: boolean;
  updateRequired?: boolean;
  updateRights: {
    status: "active";
    channel: "stable";
    updatesThrough: number | null;
    exactVersion: true;
    rollback: true;
  };
  lease: LicenseEnvelope;
  claims: LicenseClaims;
  manifest: ReleaseManifest;
  artifact: ReleaseArtifact;
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
}

export interface LicenseInfo {
  schemaVersion: 1;
  channel: "stable";
  licenseStatus: "active" | "hold" | "revoked";
  plan: "free" | "launch" | "studio" | "fleet" | "grid";
  effectivePlan: "free" | "launch" | "studio" | "fleet" | "grid";
  paidThrough: number | null;
  features: readonly string[];
  concurrencyLimit: number;
  activeSessions: number;
  availableSessions: number;
  sessionState: {
    activeBrowserProcesses: number;
    limit: number;
    available: number;
  };
  browserVersion: string;
  requestedBrowserVersion?: string;
  requestedKernelMajor?: KernelMajor;
  versionPolicy: BrowserVersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  selectionMode?: SelectionMode;
  availableBrowserVersions: string[];
  latestAvailableVersion?: string;
  updateAvailable?: boolean;
  updateRequired?: boolean;
  updateRights: {
    status: "active";
    channel: "stable";
    updatesThrough: number | null;
    exactVersion: true;
    rollback: true;
  };
  stableErrorCode: null;
}

export interface RuntimeDownloadTicket {
  token: string;
  expiresAt: number;
  artifactSha256: string;
  artifactUrl: string;
}

export interface RuntimeSessionGrant extends Omit<LicensedSessionGrant, "sessionToken"> {
  schemaVersion: 2;
  state: "reserved" | "active" | "closing";
  startupId: string;
  bootstrapToken: string;
  activationTicket: string;
  driverActivationTicket?: string;
  automationBackend?: AutomationBackend;
  downloadTicket: RuntimeDownloadTicket;
}

export interface RuntimeActivationGrant {
  schemaVersion: 2;
  state: "active";
  startupId: string;
  sessionId: string;
  runtimeToken: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: LicensedSessionGrant["plan"];
  features: readonly string[];
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  automationBackend?: AutomationBackend;
  lease: LicenseEnvelope;
  claims: LicenseClaims;
}

export interface RuntimeHeartbeatGrant {
  schemaVersion: 2;
  state: "reserved" | "active" | "closing";
  startupId: string;
  sessionId: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: LicensedSessionGrant["plan"];
  features: readonly string[];
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  automationBackend?: AutomationBackend;
  lease: LicenseEnvelope;
  claims: LicenseClaims;
}

export type BrowserVersionPolicy = "latest" | "exact" | "at-or-before";
export type KernelMajor = number | "latest";
export type SelectionMode = "latest" | "latest-in-major" | "cached-approved" | "exact" | "rollback";

export interface LicenseServiceClientOptions {
  licenseTrustedKeys: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  releaseTrustedKeys: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  licenseFileTrustedKeys?: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  licenseFilePassphrase?: string;
  trustedServiceUrls?: readonly string[];
  fetch?: typeof fetch;
  allowInsecureLocalhost?: boolean;
}

function fail(code: string, message: string, status = 0, details: Record<string, unknown> = {}): never {
  throw new LicenseServiceError(message, code, status, details);
}

const SAFE_ERROR_DETAIL_FIELDS = new Set([
  "state",
  "concurrencyLimit",
  "activeSessions",
  "availableSessions",
  "retryAfterSeconds",
  "action",
  "dimension",
]);

function safeRemoteErrorCode(code: unknown): string {
  return typeof code === "string" && /^[a-z0-9_]{2,96}$/.test(code) ? code : "license_service_error";
}

function safeErrorDetails(error: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!error) return {};
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (SAFE_ERROR_DETAIL_FIELDS.has(key)) {
      const safeValue = safeErrorDetailValue(key, value);
      if (safeValue !== undefined) details[key] = safeValue;
    } else if (key === "actions" && Array.isArray(value)) {
      const actions = value.map(safeErrorAction).filter((action) => Object.keys(action).length > 0);
      if (actions.length) details.actions = actions;
    }
  }
  return details;
}

function safeErrorDetailValue(key: string, value: unknown): unknown {
  if (["concurrencyLimit", "activeSessions", "availableSessions", "retryAfterSeconds"].includes(key)) {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  return typeof value === "string" && /^[a-z0-9_:-]{1,96}$/.test(value) ? value : undefined;
}

function safeErrorAction(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const action = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  if (typeof action.type === "string" && /^[a-z0-9_:-]{1,96}$/.test(action.type)) result.type = action.type;
  if (typeof action.url === "string" && action.url.startsWith("https://slybrowser.com/")) result.url = action.url;
  return result;
}

function parseAuthorization(value: unknown, allowInsecureLocalhost = false): LicenseAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("authorization_invalid", "Authorization file must be an object");
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "channel,licenseKey,schemaVersion,serviceUrl" ||
      document.schemaVersion !== 1 || document.channel !== "stable" ||
      typeof document.licenseKey !== "string" ||
      !/^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/.test(document.licenseKey) ||
      typeof document.serviceUrl !== "string") {
    fail("authorization_invalid", "Authorization file fields are invalid");
  }
  let url: URL;
  try {
    url = new URL(document.serviceUrl);
  } catch {
    fail("authorization_invalid", "Authorization service URL is invalid");
  }
  const local = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && local && url.protocol === "http:")) {
    fail("authorization_invalid", "Authorization service URL must use HTTPS");
  }
  return {
    schemaVersion: 1,
    serviceUrl: url.toString().replace(/\/$/, ""),
    licenseKey: document.licenseKey,
    channel: "stable",
  };
}

const LICENSE_FILE_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "type",
  "audience",
  "serviceUrl",
  "licenseId",
  "channel",
  "issuedAt",
  "expiresAt",
  "fileId",
  "encryption",
  "ciphertext",
  "tag",
  "signature",
]);
const LICENSE_FILE_SECRET_FIELDS = new Set([
  "schemaVersion",
  "type",
  "audience",
  "licenseId",
  "fileId",
  "serviceUrl",
  "channel",
  "licenseKey",
  "secretVersion",
  "createdAt",
  "expiresAt",
  "nonce",
  "scope",
]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function normalizeServiceUrl(value: string, allowInsecureLocalhost = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("authorization_invalid", "Authorization service URL is invalid");
  }
  const local = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && local && url.protocol === "http:")) {
    fail("authorization_invalid", "Authorization service URL must use HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredText(document: Record<string, unknown>, name: string, maximum = 2048): string {
  const value = document[name];
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    fail("authorization_invalid", `License file ${name} is invalid`);
  }
  return value;
}

function requiredInteger(document: Record<string, unknown>, name: string): number {
  const value = document[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("authorization_invalid", `License file ${name} is invalid`);
  }
  return value;
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("authorization_invalid", "License file fields are invalid");
  }
  return value as Record<string, unknown>;
}

function publicLicenseFileHeader(document: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: document.schemaVersion,
    type: document.type,
    audience: document.audience,
    serviceUrl: document.serviceUrl,
    licenseId: document.licenseId,
    channel: document.channel,
    issuedAt: document.issuedAt,
    expiresAt: document.expiresAt,
    fileId: document.fileId,
    encryption: document.encryption,
  };
}

function signedLicenseFileBody(document: Record<string, unknown>): Record<string, unknown> {
  return {
    ...publicLicenseFileHeader(document),
    ciphertext: document.ciphertext,
    tag: document.tag,
  };
}

function trustedKeyMap(keys: LicenseFileReadOptions["licenseFileTrustedKeys"]): Map<string, Buffer> {
  const entries = keys instanceof Map ? keys.entries() : Object.entries(keys ?? {});
  return new Map([...entries].map(([key, value]) => [key, Buffer.from(value)]));
}

function parseEncryptedLicenseFile(value: unknown, options: LicenseFileReadOptions): LicenseAuthorization {
  const document = requiredObject(value);
  if (Object.keys(document).some((name) => !LICENSE_FILE_TOP_LEVEL_FIELDS.has(name)) ||
      Object.keys(document).length !== LICENSE_FILE_TOP_LEVEL_FIELDS.size ||
      document.schemaVersion !== 2 ||
      document.type !== "slybrowser-license" ||
      document.audience !== "slybrowser-license-file" ||
      document.channel !== "stable") {
    fail("authorization_invalid", "License file fields are invalid");
  }
  const serviceUrl = normalizeServiceUrl(requiredText(document, "serviceUrl"), options.allowInsecureLocalhost ?? false);
  const trustedServiceUrls = (options.trustedServiceUrls ?? ["https://api.slybrowser.com"])
    .map((url) => normalizeServiceUrl(url, options.allowInsecureLocalhost ?? false));
  if (!trustedServiceUrls.includes(serviceUrl)) {
    fail("license_file_untrusted_origin", "License file service URL is not trusted", 403);
  }
  const licenseId = requiredText(document, "licenseId", 64);
  const issuedAt = Date.parse(requiredText(document, "issuedAt", 64));
  const expiresAt = Date.parse(requiredText(document, "expiresAt", 64));
  if (!/^[0-9a-f-]{36}$/.test(licenseId) || !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    fail("authorization_invalid", "License file identity fields are invalid");
  }
  if (expiresAt <= Date.now()) fail("license_file_expired", "License file has expired", 401);
  requiredText(document, "fileId", 128);
  const encryption = requiredObject(document.encryption);
  const kdf = requiredObject(encryption.kdf);
  const signature = requiredObject(document.signature);
  const kdfName = requiredText(kdf, "name", 64);
  const kdfPurpose = requiredText(kdf, "purpose", 64);
  const expectedScope = (
    kdfName === "sly-test-scrypt-v1" && kdfPurpose === "test-private-preview"
  ) || (
    kdfName === "sly-portable-scrypt-v1" && kdfPurpose === "portable-passphrase"
  ) ? kdfPurpose : null;
  if (requiredText(encryption, "algorithm", 64) !== "AES-256-GCM" ||
      requiredText(encryption, "aad", 128) !== "slybrowser-license-v2-public-header" ||
      expectedScope === null ||
      requiredInteger(kdf, "cost") !== 16_384 ||
      requiredInteger(kdf, "blockSize") !== 8 ||
      requiredInteger(kdf, "parallelization") !== 1 ||
      requiredInteger(kdf, "keyLength") !== 32 ||
      requiredText(signature, "algorithm", 64) !== "Ed25519") {
    fail("authorization_invalid", "License file algorithms are invalid");
  }
  const keyId = requiredText(signature, "keyId", 64);
  const publicKey = trustedKeyMap(options.licenseFileTrustedKeys).get(keyId);
  if (!publicKey) fail("license_file_key_unknown", "License file signing key is not trusted", 403);
  if (publicKey.length !== 32) fail("license_file_key_invalid", "License file signing key is invalid", 403);
  const signedBody = canonicalJson(signedLicenseFileBody({ ...document, serviceUrl }));
  const verified = verifySignature(
    null,
    signedBody,
    createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: "der", type: "spki" }),
    decodeBase64Url(requiredText(signature, "signature", 256), 64),
  );
  if (!verified) fail("license_file_signature_invalid", "License file signature is invalid", 401);
  const passphrase = options.licenseFilePassphrase;
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    fail("license_file_locked", "License file passphrase is missing or too short", 401);
  }
  const salt = decodeBase64Url(requiredText(kdf, "salt", 64), 16);
  if (salt.length !== 16) fail("authorization_invalid", "License file salt length is invalid");
  const nonce = decodeBase64Url(requiredText(encryption, "nonce", 64), 12);
  if (nonce.length !== 12) fail("authorization_invalid", "License file nonce length is invalid");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
    nonce,
  );
  decipher.setAAD(canonicalJson(publicLicenseFileHeader({ ...document, serviceUrl })));
  decipher.setAuthTag(decodeBase64Url(requiredText(document, "tag", 64), 16));
  let payload: Record<string, unknown>;
  try {
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(requiredText(document, "ciphertext", 64 * 1024), 64 * 1024)),
      decipher.final(),
    ]);
    payload = requiredObject(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof LicenseServiceError) throw error;
    fail("license_file_locked", "License file cannot be decrypted", 401);
  }
  if (Object.keys(payload).some((name) => !LICENSE_FILE_SECRET_FIELDS.has(name)) ||
      Object.keys(payload).length !== LICENSE_FILE_SECRET_FIELDS.size) {
    fail("license_file_payload_invalid", "License file payload contains unsupported claims");
  }
  const licenseKey = requiredText(payload, "licenseKey", 256);
  if (payload.schemaVersion !== 2 ||
      payload.type !== "slybrowser-license-secret" ||
      payload.audience !== document.audience ||
      payload.licenseId !== licenseId ||
      payload.fileId !== document.fileId ||
      normalizeServiceUrl(requiredText(payload, "serviceUrl"), options.allowInsecureLocalhost ?? false) !== serviceUrl ||
      payload.channel !== "stable" ||
      payload.secretVersion !== 1 ||
      payload.expiresAt !== document.expiresAt ||
      payload.scope !== expectedScope ||
      !/^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/.test(licenseKey) ||
      !licenseKey.startsWith(`sly_live_${licenseId}.`)) {
    fail("license_file_payload_invalid", "License file payload does not match its public header");
  }
  return { schemaVersion: 1, serviceUrl, licenseKey, channel: "stable" };
}

const SEALED_LICENSE_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "type",
  "audience",
  "serviceUrl",
  "channel",
  "sealedAt",
  "licenseKeySha256",
  "protection",
  "ciphertext",
]);

function licenseKeySha256(licenseKey: string): string {
  return createHash("sha256").update(licenseKey, "utf8").digest("hex");
}

function sealedLicenseEntropy(document: Record<string, unknown>): string {
  return [
    "slybrowser-sealed-license-v1",
    requiredText(document, "serviceUrl", 2048),
    requiredText(document, "channel", 16),
    requiredText(document, "licenseKeySha256", 64),
  ].join("\0");
}

function assertTrustedAuthorizationOrigin(serviceUrl: string, options: LicenseFileReadOptions): void {
  const trustedServiceUrls = (options.trustedServiceUrls ?? ["https://api.slybrowser.com"])
    .map((url) => normalizeServiceUrl(url, options.allowInsecureLocalhost ?? false));
  if (!trustedServiceUrls.includes(serviceUrl)) {
    fail("license_file_untrusted_origin", "License file service URL is not trusted", 403);
  }
}

async function windowsDpapi(operation: "protect" | "unprotect", data: Buffer, entropy: string): Promise<Buffer> {
  if (process.platform !== "win32") {
    fail("sealed_license_unsupported", "Windows DPAPI sealed license files are only supported on Windows", 400);
  }
  const script = `
$ErrorActionPreference = 'Stop'
[System.Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$data = [Convert]::FromBase64String([string]$request.data)
$entropy = [Convert]::FromBase64String([string]$request.entropy)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ([string]$request.operation -eq 'protect') {
  $output = [System.Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
} elseif ([string]$request.operation -eq 'unprotect') {
  $output = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope)
} else {
  throw 'Unsupported DPAPI operation'
}
[Console]::Out.Write([Convert]::ToBase64String($output))
`;
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  const request = JSON.stringify({
    operation,
    data: data.toString("base64"),
    entropy: Buffer.from(entropy, "utf8").toString("base64"),
  });
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedCommand,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (Buffer.concat(stdout).length > 16 * 1024) {
        child.kill();
        rejectOnce(new LicenseServiceError("Windows DPAPI returned an oversized response", "sealed_license_invalid", 400));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (Buffer.concat(stderr).length > 8 * 1024) child.kill();
    });
    child.on("error", () => {
      rejectOnce(new LicenseServiceError("Windows DPAPI is unavailable", "sealed_license_unsupported", 400));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new LicenseServiceError("Sealed license file cannot be decrypted on this Windows user or machine", "sealed_license_locked", 401));
        return;
      }
      try {
        resolvePromise(Buffer.from(Buffer.concat(stdout).toString("utf8").trim(), "base64"));
      } catch {
        reject(new LicenseServiceError("Windows DPAPI returned an invalid sealed license response", "sealed_license_invalid", 400));
      }
    });
    child.stdin.end(request);
  });
}

async function parseSealedLicenseFile(value: unknown, options: LicenseFileReadOptions): Promise<LicenseAuthorization> {
  const document = requiredObject(value);
  if (Object.keys(document).some((name) => !SEALED_LICENSE_TOP_LEVEL_FIELDS.has(name)) ||
      Object.keys(document).length !== SEALED_LICENSE_TOP_LEVEL_FIELDS.size ||
      document.schemaVersion !== 3 ||
      document.type !== "slybrowser-sealed-authorization" ||
      document.audience !== "slybrowser") {
    fail("sealed_license_invalid", "Sealed license file fields are invalid");
  }
  const serviceUrl = normalizeServiceUrl(requiredText(document, "serviceUrl"), options.allowInsecureLocalhost ?? false);
  assertTrustedAuthorizationOrigin(serviceUrl, options);
  if (requiredText(document, "channel", 16) !== "stable") fail("sealed_license_invalid", "Sealed license channel is invalid");
  const sealedAt = Date.parse(requiredText(document, "sealedAt", 64));
  if (!Number.isFinite(sealedAt)) fail("sealed_license_invalid", "Sealed license timestamp is invalid");
  const sha256 = requiredText(document, "licenseKeySha256", 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("sealed_license_invalid", "Sealed license fingerprint is invalid");
  const protection = requiredObject(document.protection);
  if (Object.keys(protection).sort().join(",") !== "provider,scope" ||
      protection.provider !== "windows-dpapi" ||
      protection.scope !== "current-user") {
    fail("sealed_license_unsupported", "Sealed license protection is not supported", 400);
  }
  const ciphertext = decodeBase64Url(requiredText(document, "ciphertext", 64 * 1024), 64 * 1024);
  let parsed: unknown;
  try {
    const plaintext = await windowsDpapi("unprotect", ciphertext, sealedLicenseEntropy({ ...document, serviceUrl }));
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch (error) {
    if (error instanceof LicenseServiceError) throw error;
    fail("sealed_license_locked", "Sealed license file cannot be decrypted on this Windows user or machine", 401);
  }
  const authorization = parseAuthorization(parsed, options.allowInsecureLocalhost ?? false);
  if (authorization.serviceUrl !== serviceUrl || authorization.channel !== "stable" ||
      licenseKeySha256(authorization.licenseKey) !== sha256) {
    fail("sealed_license_mismatch", "Sealed license payload does not match its public header", 400);
  }
  return authorization;
}

export async function importLicenseFileToSealedAuthorization(
  inputPath: string,
  outputPath: string,
  options: LicenseFileReadOptions = {},
): Promise<SealedLicenseImportResult> {
  const raw = await readFile(resolve(inputPath));
  if (raw.length > 64 * 1024) fail("authorization_invalid", "Authorization file is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("authorization_invalid", "Authorization file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).schemaVersion !== 2) {
    fail("license_file_invalid", "Only encrypted v2 SlyBrowser license files can be imported", 400);
  }
  const authorization = parseEncryptedLicenseFile(parsed, options);
  assertTrustedAuthorizationOrigin(authorization.serviceUrl, options);
  const fingerprint = licenseKeySha256(authorization.licenseKey);
  const sealedAt = new Date().toISOString();
  const document: Record<string, unknown> = {
    schemaVersion: 3,
    type: "slybrowser-sealed-authorization",
    audience: "slybrowser",
    serviceUrl: authorization.serviceUrl,
    channel: authorization.channel,
    sealedAt,
    licenseKeySha256: fingerprint,
    protection: {
      provider: "windows-dpapi",
      scope: "current-user",
    },
    ciphertext: "",
  };
  const ciphertext = await windowsDpapi(
    "protect",
    Buffer.from(JSON.stringify(authorization), "utf8"),
    sealedLicenseEntropy(document),
  );
  document.ciphertext = ciphertext.toString("base64url");
  const output = resolve(outputPath);
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return {
    output,
    serviceUrl: authorization.serviceUrl,
    channel: "stable",
    protection: "windows-dpapi-current-user",
    licenseKeySha256: fingerprint,
  };
}

export async function readLicenseAuthorization(
  path: string,
  options: LicenseFileReadOptions = {},
): Promise<LicenseAuthorization> {
  const raw = await readFile(resolve(path));
  if (raw.length > 64 * 1024) fail("authorization_invalid", "Authorization file is too large");
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schemaVersion === 2) {
      return parseEncryptedLicenseFile(parsed, options);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schemaVersion === 3) {
      return await parseSealedLicenseFile(parsed, options);
    }
    return parseAuthorization(parsed, options.allowInsecureLocalhost ?? false);
  } catch (error) {
    if (error instanceof LicenseServiceError) throw error;
    fail("authorization_invalid", "Authorization file is not valid JSON");
  }
}

function currentPlatform(): "windows" | "linux" | "macos" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  fail("platform_unsupported", `Unsupported platform: ${process.platform}`);
}

function currentArch(): "x64" | "arm64" {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  fail("platform_unsupported", `Unsupported architecture: ${process.arch}`);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "License service returned an invalid response");
  return value as Record<string, unknown>;
}

function versionParts(value: string): number[] {
  if (!/^\d+(\.\d+){0,7}$/.test(value)) fail("browser_version_invalid", `Browser version is invalid: ${value}`);
  return value.split(".").map(Number);
}

function compareVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function newStartupId(): string {
  return `st_${randomUUID().replaceAll("-", "")}`;
}

function requiredLeaseFeatures(backend?: AutomationBackend): readonly string[] {
  const base = ["browser", "release-download", "webdriver"];
  if (backend === "playwright") return [...base, "playwright"];
  if (backend === "puppeteer") return [...base, "puppeteer"];
  return base;
}

function parseResponseFeatures(value: unknown, fallback: readonly string[]): readonly string[] {
  const source = value === undefined ? fallback : value;
  if (
    !Array.isArray(source) ||
    source.some((item) => typeof item !== "string" || !item || item.length > 128) ||
    new Set(source).size !== source.length
  ) {
    fail("license_service_invalid_response", "License service features response is invalid");
  }
  return Object.freeze([...source]);
}

function parseRequestedKernelMajor(value: unknown): KernelMajor | undefined {
  if (value === undefined) return undefined;
  if (value === "latest") return "latest";
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  fail("license_service_invalid_response", "License service requested-kernel response is invalid");
}

function parseSelectionMode(value: unknown): SelectionMode | undefined {
  if (value === undefined) return undefined;
  if (new Set(["latest", "latest-in-major", "cached-approved", "exact", "rollback"]).has(String(value))) {
    return value as SelectionMode;
  }
  fail("license_service_invalid_response", "License service selection-mode response is invalid");
}

function parseOptionalVersion(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^\d+(\.\d+){0,7}$/.test(value)) return value;
  fail("license_service_invalid_response", `License service ${field} response is invalid`);
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  fail("license_service_invalid_response", `License service ${field} response is invalid`);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

function assertClaimsMatchPlan(
  claims: LicenseClaims,
  plan: LicensedSessionGrant["plan"],
  concurrencyLimit: number,
  features: readonly string[],
): void {
  if (claims.planId !== undefined && claims.planId !== plan) {
    fail("license_service_invalid_response", "Signed lease plan does not match the service response");
  }
  if (claims.concurrencyLimit !== undefined && claims.concurrencyLimit !== concurrencyLimit) {
    fail("license_service_invalid_response", "Signed lease concurrency does not match the service response");
  }
  if (!sameStringSet(claims.features, features)) {
    fail("license_service_invalid_response", "Signed lease features do not match the service response");
  }
}

export class LicenseServiceClient {
  readonly authorization: LicenseAuthorization;
  readonly #fetch: typeof fetch;
  readonly #licenseVerifier: LicenseVerifier;
  readonly #releaseTrustedKeys: LicenseServiceClientOptions["releaseTrustedKeys"];

  constructor(authorization: LicenseAuthorization, options: LicenseServiceClientOptions) {
    this.authorization = parseAuthorization(authorization, options.allowInsecureLocalhost ?? false);
    this.#fetch = options.fetch ?? fetch;
    this.#licenseVerifier = new LicenseVerifier(options.licenseTrustedKeys);
    this.#releaseTrustedKeys = options.releaseTrustedKeys;
  }

  async licenseInfo(options: {
    platform?: "windows" | "linux" | "macos";
    arch?: "x64" | "arm64";
    sdkVersion?: string;
    deviceHash?: string;
    kernelMajor?: KernelMajor;
    updateKernel?: boolean;
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
  } = {}): Promise<LicenseInfo> {
    const platform = options.platform ?? currentPlatform();
    const arch = options.arch ?? currentArch();
    const sdkVersion = options.sdkVersion ?? "0.1.0";
    const versionPolicy = options.versionPolicy ?? (options.browserVersion === undefined ? "latest" : "exact");
    if (versionPolicy === "latest" && options.browserVersion !== undefined) {
      fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (versionPolicy !== "latest" && options.browserVersion === undefined) {
      fail("version_policy_invalid", `${versionPolicy} selection requires a browser version`);
    }
    if (options.browserVersion !== undefined) versionParts(options.browserVersion);
    if (options.kernelMajor !== undefined && options.kernelMajor !== "latest" &&
        (!Number.isSafeInteger(options.kernelMajor) || options.kernelMajor < 1)) {
      fail("version_policy_invalid", "kernelMajor must be a positive integer or latest");
    }
    if (options.browserVersion !== undefined && options.kernelMajor !== undefined && options.kernelMajor !== "latest" &&
        Number(options.browserVersion.split(".")[0]) !== options.kernelMajor) {
      fail("version_policy_invalid", "browserVersion does not match kernelMajor");
    }
    const value = object(await this.#request("POST", "/v2/licenses/info", {
      authorization: `License ${this.authorization.licenseKey}`,
      body: {
        platform,
        arch,
        channel: this.authorization.channel,
        sdkVersion,
        ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
        ...(options.kernelMajor === undefined ? {} : { kernelMajor: options.kernelMajor }),
        ...(options.updateKernel === undefined ? {} : { updateKernel: options.updateKernel }),
        versionPolicy,
        ...(options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
      },
    }), "license_service_invalid_response");
    const plan = String(value.plan ?? "");
    const effectivePlan = String(value.effectivePlan ?? "");
    const licenseStatus = String(value.licenseStatus ?? "");
    const browserVersion = String(value.browserVersion ?? "");
    const requestedBrowserVersion = value.requestedBrowserVersion;
    const availableBrowserVersions = value.availableBrowserVersions;
    const updateRights = value.updateRights as Record<string, unknown> | undefined;
    const requestedKernelMajor = parseRequestedKernelMajor(value.requestedKernelMajor);
    const selectionMode = parseSelectionMode(value.selectionMode);
    const latestAvailableVersion = parseOptionalVersion(value.latestAvailableVersion, "latest-available-version");
    const updateAvailable = parseOptionalBoolean(value.updateAvailable, "update-available");
    const updateRequired = parseOptionalBoolean(value.updateRequired, "update-required");
    const sessionState = value.sessionState as Record<string, unknown> | undefined;
    const plans = new Set(["free", "launch", "studio", "fleet", "grid"]);
    if (value.schemaVersion !== 1 || value.channel !== "stable" ||
        !new Set(["active", "hold", "revoked"]).has(licenseStatus) ||
        !plans.has(plan) || !plans.has(effectivePlan) ||
        !Number.isSafeInteger(value.concurrencyLimit) ||
        !Number.isSafeInteger(value.activeSessions) ||
        !Number.isSafeInteger(value.availableSessions) ||
        !browserVersion || !/^\d+(\.\d+){0,7}$/.test(browserVersion) ||
        value.versionPolicy !== versionPolicy ||
        !new Set(["latest", "exact", "rollback"]).has(String(value.selectionReason ?? "")) ||
        (options.browserVersion === undefined ? requestedBrowserVersion !== undefined : requestedBrowserVersion !== options.browserVersion) ||
        !Array.isArray(availableBrowserVersions) ||
        !availableBrowserVersions.every((item) => typeof item === "string" && /^\d+(\.\d+){0,7}$/.test(item)) ||
        !updateRights || updateRights.status !== "active" || updateRights.channel !== "stable" ||
        (updateRights.updatesThrough !== null && !Number.isSafeInteger(updateRights.updatesThrough)) ||
        updateRights.exactVersion !== true || updateRights.rollback !== true ||
        value.stableErrorCode !== null ||
        !sessionState ||
        sessionState.activeBrowserProcesses !== value.activeSessions ||
        sessionState.limit !== value.concurrencyLimit ||
        sessionState.available !== value.availableSessions) {
      fail("license_service_invalid_response", "License service info response is invalid");
    }
    const features = parseResponseFeatures(value.features, []);
    const result: LicenseInfo = {
      schemaVersion: 1,
      channel: "stable",
      licenseStatus: licenseStatus as LicenseInfo["licenseStatus"],
      plan: plan as LicenseInfo["plan"],
      effectivePlan: effectivePlan as LicenseInfo["effectivePlan"],
      paidThrough: value.paidThrough === null ? null : Number(value.paidThrough),
      features,
      concurrencyLimit: Number(value.concurrencyLimit),
      activeSessions: Number(value.activeSessions),
      availableSessions: Number(value.availableSessions),
      sessionState: {
        activeBrowserProcesses: Number(sessionState.activeBrowserProcesses),
        limit: Number(sessionState.limit),
        available: Number(sessionState.available),
      },
      browserVersion,
      ...(requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: String(requestedBrowserVersion) }),
      ...(requestedKernelMajor === undefined ? {} : { requestedKernelMajor }),
      versionPolicy,
      selectionReason: String(value.selectionReason) as LicenseInfo["selectionReason"],
      ...(selectionMode === undefined ? {} : { selectionMode }),
      availableBrowserVersions: availableBrowserVersions as string[],
      ...(latestAvailableVersion === undefined ? {} : { latestAvailableVersion }),
      ...(updateAvailable === undefined ? {} : { updateAvailable }),
      ...(updateRequired === undefined ? {} : { updateRequired }),
      updateRights: updateRights as LicenseInfo["updateRights"],
      stableErrorCode: null,
    };
    if (value.paidThrough !== null && !Number.isSafeInteger(value.paidThrough)) {
      fail("license_service_invalid_response", "License service paid-through response is invalid");
    }
    return result;
  }

  async createSession(options: {
    platform?: "windows" | "linux" | "macos";
    arch?: "x64" | "arm64";
    sdkVersion?: string;
    deviceHash?: string;
    kernelMajor?: KernelMajor;
    updateKernel?: boolean;
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
  } = {}): Promise<LicensedSessionGrant> {
    const platform = options.platform ?? currentPlatform();
    const arch = options.arch ?? currentArch();
    const sdkVersion = options.sdkVersion ?? "0.1.0";
    const versionPolicy = options.versionPolicy ?? (options.browserVersion === undefined ? "latest" : "exact");
    if (versionPolicy === "latest" && options.browserVersion !== undefined) {
      fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (versionPolicy !== "latest" && options.browserVersion === undefined) {
      fail("version_policy_invalid", `${versionPolicy} selection requires a browser version`);
    }
    if (options.browserVersion !== undefined) versionParts(options.browserVersion);
    if (options.kernelMajor !== undefined && options.kernelMajor !== "latest" &&
        (!Number.isSafeInteger(options.kernelMajor) || options.kernelMajor < 1)) {
      fail("version_policy_invalid", "kernelMajor must be a positive integer or latest");
    }
    if (options.browserVersion !== undefined && options.kernelMajor !== undefined && options.kernelMajor !== "latest" &&
        Number(options.browserVersion.split(".")[0]) !== options.kernelMajor) {
      fail("version_policy_invalid", "browserVersion does not match kernelMajor");
    }
    const value = object(await this.#request("POST", "/v1/licenses/sessions", {
      authorization: `License ${this.authorization.licenseKey}`,
      body: {
        platform,
        arch,
        channel: this.authorization.channel,
        sdkVersion,
        ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
        ...(options.kernelMajor === undefined ? {} : { kernelMajor: options.kernelMajor }),
        ...(options.updateKernel === undefined ? {} : { updateKernel: options.updateKernel }),
        versionPolicy,
        ...(options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
      },
    }), "license_service_invalid_response");
    const sessionId = String(value.sessionId ?? "");
    const sessionToken = String(value.sessionToken ?? "");
    const browserVersion = String(value.browserVersion ?? "");
    if (!sessionId || !sessionToken || !browserVersion || !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.heartbeatAfterSeconds)) {
      fail("license_service_invalid_response", "License service session response is invalid");
    }
    const returnedPolicy = String(value.versionPolicy ?? "");
    const selectionReason = String(value.selectionReason ?? "");
    const requestedBrowserVersion = value.requestedBrowserVersion;
    const availableBrowserVersions = value.availableBrowserVersions;
    const updateRights = value.updateRights as Record<string, unknown> | undefined;
    const requestedKernelMajor = parseRequestedKernelMajor(value.requestedKernelMajor);
    const selectionMode = parseSelectionMode(value.selectionMode);
    const latestAvailableVersion = parseOptionalVersion(value.latestAvailableVersion, "latest-available-version");
    const updateAvailable = parseOptionalBoolean(value.updateAvailable, "update-available");
    const updateRequired = parseOptionalBoolean(value.updateRequired, "update-required");
    if (returnedPolicy !== versionPolicy ||
        !new Set(["latest", "exact", "rollback"]).has(selectionReason) ||
        (options.browserVersion === undefined
          ? requestedBrowserVersion !== undefined
          : requestedBrowserVersion !== options.browserVersion) ||
        !Array.isArray(availableBrowserVersions) ||
        !availableBrowserVersions.every((item) => typeof item === "string" && /^\d+(\.\d+){0,7}$/.test(item)) ||
        !updateRights || updateRights.status !== "active" || updateRights.channel !== "stable" ||
        (updateRights.updatesThrough !== null && !Number.isSafeInteger(updateRights.updatesThrough)) ||
        updateRights.exactVersion !== true || updateRights.rollback !== true) {
      fail("license_service_invalid_response", "License service version-selection response is invalid");
    }
    if (versionPolicy === "exact" && browserVersion !== options.browserVersion) {
      fail("release_version_mismatch", `Requested browser ${options.browserVersion} but service selected ${browserVersion}`);
    }
    if (versionPolicy === "at-or-before" && compareVersion(browserVersion, options.browserVersion!) > 0) {
      fail("release_version_mismatch", `Rollback selection ${browserVersion} is newer than requested ${options.browserVersion}`);
    }
    const lease = value.lease as LicenseEnvelope;
    const claims = this.#licenseVerifier.verify(lease, {
      browserVersion,
      requiredFeatures: requiredLeaseFeatures(),
      ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
    });
    if (claims.sessionId !== sessionId || claims.expiresAt !== value.expiresAt) {
      fail("license_service_invalid_response", "Signed lease does not match the allocated session");
    }
    const manifest = verifyReleaseManifest(value.manifest as Record<string, unknown>, this.#releaseTrustedKeys);
    if (manifest.browserVersion !== browserVersion) {
      fail("license_service_invalid_response", "Release manifest does not match the signed lease");
    }
    if (!isSdkCompatible(manifest.sdkCompatibility, sdkVersion)) {
      fail("sdk_version_unsupported", `Browser ${browserVersion} does not support SDK ${sdkVersion}`);
    }
    const artifact = selectArtifact(manifest, platform, arch);
    const serviceOrigin = new URL(this.authorization.serviceUrl).origin;
    if (new URL(artifact.url).origin !== serviceOrigin) {
      fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
    }
    const plan = value.plan;
    if (!new Set(["free", "launch", "studio", "fleet", "grid"]).has(String(plan)) ||
        !Number.isSafeInteger(value.concurrencyLimit) || !Number.isSafeInteger(value.activeSessions)) {
      fail("license_service_invalid_response", "License service plan response is invalid");
    }
    const features = parseResponseFeatures(value.features, claims.features);
    assertClaimsMatchPlan(claims, plan as LicensedSessionGrant["plan"], Number(value.concurrencyLimit), features);
    return {
      sessionId,
      sessionToken,
      heartbeatAfterSeconds: Number(value.heartbeatAfterSeconds),
      expiresAt: Number(value.expiresAt),
      plan: plan as LicensedSessionGrant["plan"],
      features,
      concurrencyLimit: Number(value.concurrencyLimit),
      activeSessions: Number(value.activeSessions),
      browserVersion,
      ...(requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: String(requestedBrowserVersion) }),
      ...(requestedKernelMajor === undefined ? {} : { requestedKernelMajor }),
      versionPolicy,
      selectionReason: selectionReason as LicensedSessionGrant["selectionReason"],
      ...(selectionMode === undefined ? {} : { selectionMode }),
      availableBrowserVersions: availableBrowserVersions as string[],
      ...(latestAvailableVersion === undefined ? {} : { latestAvailableVersion }),
      ...(updateAvailable === undefined ? {} : { updateAvailable }),
      ...(updateRequired === undefined ? {} : { updateRequired }),
      updateRights: updateRights as LicensedSessionGrant["updateRights"],
      lease,
      claims,
      manifest,
      artifact,
      platform,
      arch,
    };
  }

  async createRuntimeSession(options: {
    startupId?: string;
    automationBackend?: AutomationBackend;
    platform?: "windows" | "linux" | "macos";
    arch?: "x64" | "arm64";
    sdkVersion?: string;
    deviceHash?: string;
    kernelMajor?: KernelMajor;
    updateKernel?: boolean;
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
  } = {}): Promise<RuntimeSessionGrant> {
    const platform = options.platform ?? currentPlatform();
    const arch = options.arch ?? currentArch();
    const sdkVersion = options.sdkVersion ?? "0.1.0";
    const startupId = options.startupId ?? newStartupId();
    if (!/^st_[A-Za-z0-9_-]{16,120}$/.test(startupId)) {
      fail("startup_id_invalid", "Runtime startup ID is invalid");
    }
    const versionPolicy = options.versionPolicy ?? (options.browserVersion === undefined ? "latest" : "exact");
    if (versionPolicy === "latest" && options.browserVersion !== undefined) {
      fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (versionPolicy !== "latest" && options.browserVersion === undefined) {
      fail("version_policy_invalid", `${versionPolicy} selection requires a browser version`);
    }
    if (options.browserVersion !== undefined) versionParts(options.browserVersion);
    if (options.kernelMajor !== undefined && options.kernelMajor !== "latest" &&
        (!Number.isSafeInteger(options.kernelMajor) || options.kernelMajor < 1)) {
      fail("version_policy_invalid", "kernelMajor must be a positive integer or latest");
    }
    if (options.browserVersion !== undefined && options.kernelMajor !== undefined && options.kernelMajor !== "latest" &&
        Number(options.browserVersion.split(".")[0]) !== options.kernelMajor) {
      fail("version_policy_invalid", "browserVersion does not match kernelMajor");
    }
    const value = object(await this.#request("POST", "/v2/runtime/sessions", {
      authorization: `License ${this.authorization.licenseKey}`,
      body: {
        startupId,
        platform,
        arch,
        channel: this.authorization.channel,
        sdkVersion,
        ...(options.automationBackend === undefined ? {} : { automationBackend: options.automationBackend }),
        ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
        ...(options.kernelMajor === undefined ? {} : { kernelMajor: options.kernelMajor }),
        ...(options.updateKernel === undefined ? {} : { updateKernel: options.updateKernel }),
        versionPolicy,
        ...(options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
      },
    }), "license_service_invalid_response");
    if (value.schemaVersion !== 2 || value.state !== "reserved" && value.state !== "active" && value.state !== "closing" ||
        value.startupId !== startupId) {
      fail("license_service_invalid_response", "Runtime session response is invalid");
    }
    const sessionId = String(value.sessionId ?? "");
    const bootstrapToken = String(value.bootstrapToken ?? "");
    const activationTicket = String(value.activationTicket ?? "");
    const driverActivationTicket = value.driverActivationTicket;
    const browserVersion = String(value.browserVersion ?? "");
    if (!sessionId || !bootstrapToken || !activationTicket || !browserVersion || !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.heartbeatAfterSeconds)) {
      fail("license_service_invalid_response", "Runtime session response is invalid");
    }
    if (driverActivationTicket !== undefined && (typeof driverActivationTicket !== "string" || driverActivationTicket.length === 0)) {
      fail("license_service_invalid_response", "Runtime driver activation ticket is invalid");
    }
    if (options.automationBackend === "project-webdriver" && driverActivationTicket === undefined) {
      fail("license_service_invalid_response", "Project WebDriver runtime session is missing a driver activation ticket");
    }
    const returnedPolicy = String(value.versionPolicy ?? "");
    const selectionReason = String(value.selectionReason ?? "");
    const requestedBrowserVersion = value.requestedBrowserVersion;
    const availableBrowserVersions = value.availableBrowserVersions;
    const updateRights = value.updateRights as Record<string, unknown> | undefined;
    const requestedKernelMajor = parseRequestedKernelMajor(value.requestedKernelMajor);
    const selectionMode = parseSelectionMode(value.selectionMode);
    const latestAvailableVersion = parseOptionalVersion(value.latestAvailableVersion, "latest-available-version");
    const updateAvailable = parseOptionalBoolean(value.updateAvailable, "update-available");
    const updateRequired = parseOptionalBoolean(value.updateRequired, "update-required");
    if (returnedPolicy !== versionPolicy ||
        !new Set(["latest", "exact", "rollback"]).has(selectionReason) ||
        (options.browserVersion === undefined
          ? requestedBrowserVersion !== undefined
          : requestedBrowserVersion !== options.browserVersion) ||
        !Array.isArray(availableBrowserVersions) ||
        !availableBrowserVersions.every((item) => typeof item === "string" && /^\d+(\.\d+){0,7}$/.test(item)) ||
        !updateRights || updateRights.status !== "active" || updateRights.channel !== "stable" ||
        (updateRights.updatesThrough !== null && !Number.isSafeInteger(updateRights.updatesThrough)) ||
        updateRights.exactVersion !== true || updateRights.rollback !== true) {
      fail("license_service_invalid_response", "Runtime version-selection response is invalid");
    }
    if (versionPolicy === "exact" && browserVersion !== options.browserVersion) {
      fail("release_version_mismatch", `Requested browser ${options.browserVersion} but service selected ${browserVersion}`);
    }
    if (versionPolicy === "at-or-before" && compareVersion(browserVersion, options.browserVersion!) > 0) {
      fail("release_version_mismatch", `Rollback selection ${browserVersion} is newer than requested ${options.browserVersion}`);
    }
    const lease = value.lease as LicenseEnvelope;
    const claims = this.#licenseVerifier.verify(lease, {
      browserVersion,
      requiredFeatures: requiredLeaseFeatures(options.automationBackend),
      ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
    });
    if (claims.sessionId !== sessionId || claims.expiresAt !== value.expiresAt) {
      fail("license_service_invalid_response", "Runtime lease does not match the allocated session");
    }
    const manifest = verifyReleaseManifest(value.manifest as Record<string, unknown>, this.#releaseTrustedKeys);
    if (manifest.browserVersion !== browserVersion) {
      fail("license_service_invalid_response", "Release manifest does not match the runtime lease");
    }
    if (!isSdkCompatible(manifest.sdkCompatibility, sdkVersion)) {
      fail("sdk_version_unsupported", `Browser ${browserVersion} does not support SDK ${sdkVersion}`);
    }
    const artifact = selectArtifact(manifest, platform, arch);
    const serviceOrigin = new URL(this.authorization.serviceUrl).origin;
    if (new URL(artifact.url).origin !== serviceOrigin) {
      fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
    }
    const ticket = value.downloadTicket as Record<string, unknown> | undefined;
    const artifactUrl = String(ticket?.artifactUrl ?? "");
    const artifactSha256 = String(ticket?.artifactSha256 ?? "");
    if (!ticket || typeof ticket.token !== "string" || !ticket.token ||
        !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt !== value.expiresAt ||
        artifactSha256 !== artifact.sha256 || !artifactUrl ||
        new URL(artifactUrl).origin !== serviceOrigin) {
      fail("license_service_invalid_response", "Runtime download ticket response is invalid");
    }
    const plan = value.plan;
    if (!new Set(["free", "launch", "studio", "fleet", "grid"]).has(String(plan)) ||
        !Number.isSafeInteger(value.concurrencyLimit) || !Number.isSafeInteger(value.activeSessions)) {
      fail("license_service_invalid_response", "Runtime plan response is invalid");
    }
    const features = parseResponseFeatures(value.features, claims.features);
    assertClaimsMatchPlan(claims, plan as RuntimeSessionGrant["plan"], Number(value.concurrencyLimit), features);
    return {
      schemaVersion: 2,
      state: value.state as RuntimeSessionGrant["state"],
      startupId,
      sessionId,
      bootstrapToken,
      activationTicket,
      ...(driverActivationTicket === undefined ? {} : { driverActivationTicket }),
      heartbeatAfterSeconds: Number(value.heartbeatAfterSeconds),
      expiresAt: Number(value.expiresAt),
      plan: plan as RuntimeSessionGrant["plan"],
      features,
      concurrencyLimit: Number(value.concurrencyLimit),
      activeSessions: Number(value.activeSessions),
      browserVersion,
      ...(requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: String(requestedBrowserVersion) }),
      ...(requestedKernelMajor === undefined ? {} : { requestedKernelMajor }),
      versionPolicy,
      selectionReason: selectionReason as RuntimeSessionGrant["selectionReason"],
      ...(selectionMode === undefined ? {} : { selectionMode }),
      availableBrowserVersions: availableBrowserVersions as string[],
      ...(latestAvailableVersion === undefined ? {} : { latestAvailableVersion }),
      ...(updateAvailable === undefined ? {} : { updateAvailable }),
      ...(updateRequired === undefined ? {} : { updateRequired }),
      updateRights: updateRights as RuntimeSessionGrant["updateRights"],
      lease,
      claims,
      manifest,
      artifact,
      platform,
      arch,
      ...(options.automationBackend === undefined ? {} : { automationBackend: options.automationBackend }),
      downloadTicket: {
        token: ticket.token,
        expiresAt: Number(ticket.expiresAt),
        artifactSha256,
        artifactUrl,
      },
    };
  }

  async heartbeat(grant: LicensedSessionGrant): Promise<{ expiresAt: number; lease: LicenseEnvelope; claims: LicenseClaims }> {
    const value = object(await this.#request("POST", `/v1/licenses/sessions/${encodeURIComponent(grant.sessionId)}/heartbeat`, {
      authorization: `Session ${grant.sessionToken}`,
      body: {},
    }), "license_service_invalid_response");
    const lease = value.lease as LicenseEnvelope;
    const claims = this.#licenseVerifier.verify(lease, {
      browserVersion: grant.browserVersion,
      requiredFeatures: requiredLeaseFeatures(),
      ...(grant.claims.deviceHash === undefined ? {} : { deviceHash: grant.claims.deviceHash }),
    });
    if (claims.sessionId !== grant.sessionId || claims.expiresAt !== value.expiresAt) {
      fail("license_service_invalid_response", "Heartbeat lease does not match the active session");
    }
    const plan = value.plan;
    if (!new Set(["free", "launch", "studio", "fleet", "grid"]).has(String(plan)) ||
        !Number.isSafeInteger(value.concurrencyLimit) || !Number.isSafeInteger(value.activeSessions)) {
      fail("license_service_invalid_response", "Heartbeat plan response is invalid");
    }
    const features = parseResponseFeatures(value.features, claims.features);
    assertClaimsMatchPlan(claims, plan as LicensedSessionGrant["plan"], Number(value.concurrencyLimit), features);
    return { expiresAt: Number(value.expiresAt), lease, claims };
  }

  async bootstrapHeartbeat(grant: RuntimeSessionGrant): Promise<RuntimeHeartbeatGrant> {
    const value = object(await this.#request("POST", `/v2/runtime/sessions/${encodeURIComponent(grant.sessionId)}/bootstrap-heartbeat`, {
      authorization: `Bootstrap ${grant.bootstrapToken}`,
    }), "license_service_invalid_response");
    return this.#runtimeHeartbeatGrant(value, grant);
  }

  async activateRuntimeSession(grant: RuntimeSessionGrant): Promise<RuntimeActivationGrant> {
    const value = object(await this.#request("POST", `/v2/runtime/sessions/${encodeURIComponent(grant.sessionId)}/activate`, {
      authorization: `Activation ${grant.activationTicket}`,
    }), "license_service_invalid_response");
    const heartbeat = this.#runtimeHeartbeatGrant(value, grant);
    const runtimeToken = String(value.runtimeToken ?? "");
    if (heartbeat.state !== "active" || !runtimeToken) {
      fail("license_service_invalid_response", "Runtime activation response is invalid");
    }
    return { ...heartbeat, state: "active", runtimeToken };
  }

  async runtimeHeartbeat(grant: RuntimeActivationGrant): Promise<RuntimeHeartbeatGrant> {
    const value = object(await this.#request("POST", `/v2/runtime/sessions/${encodeURIComponent(grant.sessionId)}/heartbeat`, {
      authorization: `Runtime ${grant.runtimeToken}`,
    }), "license_service_invalid_response");
    return this.#runtimeHeartbeatGrant(value, grant);
  }

  async closeRuntimeSession(grant: RuntimeActivationGrant): Promise<RuntimeHeartbeatGrant> {
    const value = object(await this.#request("POST", `/v2/runtime/sessions/${encodeURIComponent(grant.sessionId)}/close`, {
      authorization: `Runtime ${grant.runtimeToken}`,
    }), "license_service_invalid_response");
    return this.#runtimeHeartbeatGrant(value, grant);
  }

  async release(grant: Pick<LicensedSessionGrant, "sessionId" | "sessionToken">): Promise<void> {
    await this.#request("DELETE", `/v1/licenses/sessions/${encodeURIComponent(grant.sessionId)}`, {
      authorization: `Session ${grant.sessionToken}`,
    });
  }

  async releaseRuntimeSession(grant: RuntimeSessionGrant | RuntimeActivationGrant): Promise<void> {
    if ("runtimeToken" in grant) {
      await this.#request("DELETE", `/v2/runtime/sessions/${encodeURIComponent(grant.sessionId)}`, {
        authorization: `Runtime ${grant.runtimeToken}`,
      });
      return;
    }
    await this.#request("DELETE", `/v2/runtime/sessions/${encodeURIComponent(grant.sessionId)}`, {
      authorization: `Bootstrap ${grant.bootstrapToken}`,
    });
  }

  async downloadArtifact(grant: LicensedSessionGrant): Promise<Response> {
    const response = await this.#fetch(grant.artifact.url, {
      method: "GET",
      headers: { authorization: `Session ${grant.sessionToken}` },
      redirect: "error",
    });
    if (!response.ok || !response.body) await this.#throwResponse(response);
    return response;
  }

  async downloadRuntimeArtifact(grant: RuntimeSessionGrant): Promise<Response> {
    const artifactUrl = new URL(grant.downloadTicket.artifactUrl);
    if (artifactUrl.pathname.startsWith("/v1/releases/artifacts/")) {
      artifactUrl.pathname = artifactUrl.pathname.replace("/v1/releases/artifacts/", "/v2/runtime/artifacts/");
    }
    if (!artifactUrl.pathname.startsWith("/v2/runtime/artifacts/")) {
      fail("license_service_invalid_response", "Runtime artifact URL is invalid");
    }
    const response = await this.#fetch(artifactUrl.toString(), {
      method: "GET",
      headers: { authorization: `Download ${grant.downloadTicket.token}` },
      redirect: "error",
    });
    if (!response.ok || !response.body) await this.#throwResponse(response);
    return response;
  }

  #runtimeHeartbeatGrant(value: Record<string, unknown>, grant: RuntimeSessionGrant | RuntimeActivationGrant): RuntimeHeartbeatGrant {
    if (value.schemaVersion !== 2 || value.startupId !== grant.startupId ||
        value.sessionId !== grant.sessionId || !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.heartbeatAfterSeconds)) {
      fail("license_service_invalid_response", "Runtime heartbeat response is invalid");
    }
    const state = String(value.state ?? "");
    if (state !== "reserved" && state !== "active" && state !== "closing") {
      fail("license_service_invalid_response", "Runtime session state is invalid");
    }
    const lease = value.lease as LicenseEnvelope;
    const claims = this.#licenseVerifier.verify(lease, {
      browserVersion: grant.browserVersion,
      requiredFeatures: requiredLeaseFeatures(grant.automationBackend),
      ...(grant.claims.deviceHash === undefined ? {} : { deviceHash: grant.claims.deviceHash }),
    });
    if (claims.sessionId !== grant.sessionId || claims.expiresAt !== value.expiresAt) {
      fail("license_service_invalid_response", "Runtime heartbeat lease does not match the active session");
    }
    const plan = value.plan;
    if (!new Set(["free", "launch", "studio", "fleet", "grid"]).has(String(plan)) ||
        !Number.isSafeInteger(value.concurrencyLimit) || !Number.isSafeInteger(value.activeSessions)) {
      fail("license_service_invalid_response", "Runtime heartbeat plan response is invalid");
    }
    const features = parseResponseFeatures(value.features, claims.features);
    assertClaimsMatchPlan(claims, plan as RuntimeHeartbeatGrant["plan"], Number(value.concurrencyLimit), features);
    return {
      schemaVersion: 2,
      state: state as RuntimeHeartbeatGrant["state"],
      startupId: grant.startupId,
      sessionId: grant.sessionId,
      heartbeatAfterSeconds: Number(value.heartbeatAfterSeconds),
      expiresAt: Number(value.expiresAt),
      plan: plan as RuntimeHeartbeatGrant["plan"],
      features,
      concurrencyLimit: Number(value.concurrencyLimit),
      activeSessions: Number(value.activeSessions),
      browserVersion: grant.browserVersion,
      ...(grant.automationBackend === undefined ? {} : { automationBackend: grant.automationBackend }),
      lease,
      claims,
    };
  }

  async #request(method: string, path: string, options: {
    authorization: string;
    body?: unknown;
  }): Promise<unknown> {
    const response = await this.#fetch(`${this.authorization.serviceUrl}${path}`, {
      method,
      headers: {
        authorization: options.authorization,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
    });
    if (!response.ok) await this.#throwResponse(response);
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      fail("license_service_invalid_response", "License service returned invalid JSON", response.status);
    }
  }

  async #throwResponse(response: Response): Promise<never> {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string; [key: string]: unknown } } | null;
    const error = payload?.error;
    const code = safeRemoteErrorCode(error?.code);
    fail(
      code,
      `License service request failed with HTTP ${response.status} (${code})`,
      response.status,
      safeErrorDetails(error),
    );
  }
}
