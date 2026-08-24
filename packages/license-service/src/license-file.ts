import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scryptSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import { ServiceError, type LicenseServiceErrorCode } from "./errors.js";

export interface LicenseFileV2 {
  schemaVersion: 2;
  type: "slybrowser-license";
  audience: "slybrowser-license-file";
  serviceUrl: string;
  licenseId: string;
  channel: "stable";
  issuedAt: string;
  expiresAt: string;
  fileId: string;
  encryption: {
    algorithm: "AES-256-GCM";
    kdf: {
      name: "sly-test-scrypt-v1" | "sly-portable-scrypt-v1";
      purpose: "test-private-preview" | "portable-passphrase";
      salt: string;
      cost: number;
      blockSize: number;
      parallelization: number;
      keyLength: 32;
    };
    nonce: string;
    aad: "slybrowser-license-v2-public-header";
  };
  ciphertext: string;
  tag: string;
  signature: {
    algorithm: "Ed25519";
    keyId: string;
    signature: string;
  };
}

export interface LicenseFileSecret {
  schemaVersion: 2;
  type: "slybrowser-license-secret";
  audience: "slybrowser-license-file";
  licenseId: string;
  fileId: string;
  serviceUrl: string;
  channel: "stable";
  licenseKey: string;
  secretVersion: 1;
  createdAt: string;
  expiresAt: string;
  nonce: string;
  scope: "test-private-preview" | "portable-passphrase";
}

export interface CreateTestLicenseFileOptions {
  licenseId: string;
  licenseKey: string;
  serviceUrl: string;
  channel?: "stable";
  issuedAt?: Date | string;
  expiresAt?: Date | string;
  fileId?: string;
  passphrase: string;
  signingKeyId: string;
  signingPrivateKey: string | Buffer | KeyObject;
  salt?: Buffer;
  nonce?: Buffer;
  payloadNonce?: string;
  testPayloadOverrides?: Record<string, unknown>;
}

export interface CreatePortableLicenseFileOptions {
  licenseId: string;
  licenseKey: string;
  serviceUrl: string;
  channel?: "stable";
  issuedAt?: Date | string;
  expiresAt?: Date | string;
  fileId?: string;
  passphrase: string;
  signingKeyId: string;
  signingPrivateKey: string | Buffer | KeyObject;
  salt?: Buffer;
  nonce?: Buffer;
  payloadNonce?: string;
  payloadOverrides?: Record<string, unknown>;
}

export interface DecryptLicenseFileOptions {
  passphrase: string;
  trustedPublicKeys: Record<string, string | Buffer | KeyObject>;
  trustedServiceUrls?: string[];
  allowInsecureLocalhost?: boolean;
}

const TOP_LEVEL_FIELDS = new Set([
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
const SECRET_FIELDS = new Set([
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
const LICENSE_KEY_PATTERN = /^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_TRUSTED_SERVICE_URLS = ["https://api.slybrowser.com"];

function fail(code: LicenseServiceErrorCode, message: string, status = 400): never {
  throw new ServiceError(code, message, status);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) throw new TypeError("Canonical JSON cannot encode undefined");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => {
    const child = record[key];
    if (child === undefined) throw new TypeError("Canonical JSON cannot encode undefined");
    return `${JSON.stringify(key)}:${canonicalJson(child)}`;
  }).join(",")}}`;
}

function keyObject(value: string | Buffer | KeyObject, kind: "private" | "public"): KeyObject {
  if (typeof value === "object" && "type" in value) return value as KeyObject;
  return kind === "private" ? createPrivateKey(value) : createPublicKey(value);
}

function normalizeServiceUrl(value: string, allowInsecureLocalhost = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail("license_file_invalid", "License service URL is invalid");
  }
  const localhost = new Set(["localhost", "127.0.0.1", "::1"]).has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(allowInsecureLocalhost && parsed.protocol === "http:" && localhost)) {
    fail("license_file_invalid", "License service URL must use HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

function asRecord(value: unknown, code: LicenseServiceErrorCode = "license_file_invalid"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "License file must be an object");
  return value as Record<string, unknown>;
}

function textField(record: Record<string, unknown>, name: string, maximum = 2048): string {
  const value = record[name];
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    fail("license_file_invalid", `License file ${name} is invalid`);
  }
  return value;
}

function integerField(record: Record<string, unknown>, name: string): number {
  const value = record[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("license_file_invalid", `License file ${name} is invalid`);
  }
  return value;
}

function bytes(value: string, name: string, expectedLength?: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) fail("license_file_invalid", `License file ${name} encoding is invalid`);
  const decoded = Buffer.from(value, "base64url");
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    fail("license_file_invalid", `License file ${name} length is invalid`);
  }
  return decoded;
}

function publicHeader(document: LicenseFileV2): Omit<LicenseFileV2, "ciphertext" | "tag" | "signature"> {
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

function signedBody(document: LicenseFileV2): Omit<LicenseFileV2, "signature"> {
  return {
    ...publicHeader(document),
    ciphertext: document.ciphertext,
    tag: document.tag,
  };
}

function deriveTestKey(passphrase: string, kdf: LicenseFileV2["encryption"]["kdf"]): Buffer {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    fail("license_file_locked", "License file passphrase is missing or too short", 401);
  }
  const salt = bytes(kdf.salt, "salt", 16);
  const supportedTest = kdf.name === "sly-test-scrypt-v1" && kdf.purpose === "test-private-preview";
  const supportedPortable = kdf.name === "sly-portable-scrypt-v1" && kdf.purpose === "portable-passphrase";
  if ((!supportedTest && !supportedPortable) ||
      kdf.cost !== 16_384 || kdf.blockSize !== 8 || kdf.parallelization !== 1 || kdf.keyLength !== 32) {
    fail("license_file_kdf_unsupported", "License file KDF is not supported");
  }
  return scryptSync(passphrase, salt, 32, {
    N: kdf.cost,
    r: kdf.blockSize,
    p: kdf.parallelization,
    maxmem: 64 * 1024 * 1024,
  });
}

export function createTestLicenseFile(input: CreateTestLicenseFileOptions): LicenseFileV2 {
  if (!UUID_PATTERN.test(input.licenseId)) fail("license_file_invalid", "License ID is invalid");
  if (!LICENSE_KEY_PATTERN.test(input.licenseKey)) fail("license_file_invalid", "License key format is invalid");
  if (!input.licenseKey.startsWith(`sly_live_${input.licenseId}.`)) {
    fail("license_file_invalid", "License key does not match license ID");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.signingKeyId) || !input.signingKeyId.includes("test")) {
    fail("license_file_invalid", "Test license-file signing key ID must be explicit and non-production");
  }
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  const issuedAt = input.issuedAt instanceof Date
    ? input.issuedAt.toISOString()
    : input.issuedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(issuedAt))) fail("license_file_invalid", "Issued-at timestamp is invalid");
  const expiresAt = input.expiresAt instanceof Date
    ? input.expiresAt.toISOString()
    : input.expiresAt ?? new Date(Date.parse(issuedAt) + 366 * 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail("license_file_invalid", "License file expiry timestamp is invalid");
  }
  const fileId = input.fileId ?? `lf_test_${randomBytes(18).toString("base64url")}`;
  if (!/^lf_test_[A-Za-z0-9_-]{8,80}$/.test(fileId)) {
    fail("license_file_invalid", "Test license file ID must use lf_test_ prefix");
  }
  const salt = input.salt ?? randomBytes(16);
  if (salt.length !== 16) fail("license_file_invalid", "License file salt length is invalid");
  const nonce = input.nonce ?? randomBytes(12);
  if (nonce.length !== 12) fail("license_file_invalid", "License file nonce length is invalid");
  const document = {
    schemaVersion: 2,
    type: "slybrowser-license",
    audience: "slybrowser-license-file",
    serviceUrl,
    licenseId: input.licenseId,
    channel: input.channel ?? "stable",
    issuedAt,
    expiresAt,
    fileId,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: {
        name: "sly-test-scrypt-v1",
        purpose: "test-private-preview",
        salt: salt.toString("base64url"),
        cost: 16_384,
        blockSize: 8,
        parallelization: 1,
        keyLength: 32,
      },
      nonce: nonce.toString("base64url"),
      aad: "slybrowser-license-v2-public-header",
    },
    ciphertext: "",
    tag: "",
    signature: {
      algorithm: "Ed25519",
      keyId: input.signingKeyId,
      signature: "",
    },
  } satisfies LicenseFileV2;
  const secret = {
    schemaVersion: 2,
    type: "slybrowser-license-secret",
    audience: "slybrowser-license-file",
    licenseId: document.licenseId,
    fileId: document.fileId,
    serviceUrl: document.serviceUrl,
    channel: document.channel,
    licenseKey: input.licenseKey,
    secretVersion: 1,
    createdAt: document.issuedAt,
    expiresAt: document.expiresAt,
    nonce: input.payloadNonce ?? randomBytes(24).toString("base64url"),
    scope: "test-private-preview",
    ...(input.testPayloadOverrides ?? {}),
  };
  const key = deriveTestKey(input.passphrase, document.encryption.kdf);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(publicHeader(document)), "utf8"));
  document.ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(secret), "utf8")),
    cipher.final(),
  ]).toString("base64url");
  document.tag = cipher.getAuthTag().toString("base64url");
  document.signature.signature = sign(
    null,
    Buffer.from(canonicalJson(signedBody(document)), "utf8"),
    keyObject(input.signingPrivateKey, "private"),
  ).toString("base64url");
  return document;
}

export function createPortableLicenseFile(input: CreatePortableLicenseFileOptions): LicenseFileV2 {
  if (!UUID_PATTERN.test(input.licenseId)) fail("license_file_invalid", "License ID is invalid");
  if (!LICENSE_KEY_PATTERN.test(input.licenseKey)) fail("license_file_invalid", "License key format is invalid");
  if (!input.licenseKey.startsWith(`sly_live_${input.licenseId}.`)) {
    fail("license_file_invalid", "License key does not match license ID");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.signingKeyId)) {
    fail("license_file_invalid", "License-file signing key ID is invalid");
  }
  const serviceUrl = normalizeServiceUrl(input.serviceUrl);
  const issuedAt = input.issuedAt instanceof Date
    ? input.issuedAt.toISOString()
    : input.issuedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(issuedAt))) fail("license_file_invalid", "Issued-at timestamp is invalid");
  const expiresAt = input.expiresAt instanceof Date
    ? input.expiresAt.toISOString()
    : input.expiresAt ?? new Date(Date.parse(issuedAt) + 366 * 24 * 60 * 60 * 1000).toISOString();
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail("license_file_invalid", "License file expiry timestamp is invalid");
  }
  const fileId = input.fileId ?? `lf_${randomBytes(18).toString("base64url")}`;
  if (!/^lf_[A-Za-z0-9_-]{8,80}$/.test(fileId) || fileId.startsWith("lf_test_")) {
    fail("license_file_invalid", "Portable license file ID is invalid");
  }
  const salt = input.salt ?? randomBytes(16);
  if (salt.length !== 16) fail("license_file_invalid", "License file salt length is invalid");
  const nonce = input.nonce ?? randomBytes(12);
  if (nonce.length !== 12) fail("license_file_invalid", "License file nonce length is invalid");
  const document = {
    schemaVersion: 2,
    type: "slybrowser-license",
    audience: "slybrowser-license-file",
    serviceUrl,
    licenseId: input.licenseId,
    channel: input.channel ?? "stable",
    issuedAt,
    expiresAt,
    fileId,
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: {
        name: "sly-portable-scrypt-v1",
        purpose: "portable-passphrase",
        salt: salt.toString("base64url"),
        cost: 16_384,
        blockSize: 8,
        parallelization: 1,
        keyLength: 32,
      },
      nonce: nonce.toString("base64url"),
      aad: "slybrowser-license-v2-public-header",
    },
    ciphertext: "",
    tag: "",
    signature: {
      algorithm: "Ed25519",
      keyId: input.signingKeyId,
      signature: "",
    },
  } satisfies LicenseFileV2;
  const secret = {
    schemaVersion: 2,
    type: "slybrowser-license-secret",
    audience: "slybrowser-license-file",
    licenseId: document.licenseId,
    fileId: document.fileId,
    serviceUrl: document.serviceUrl,
    channel: document.channel,
    licenseKey: input.licenseKey,
    secretVersion: 1,
    createdAt: document.issuedAt,
    expiresAt: document.expiresAt,
    nonce: input.payloadNonce ?? randomBytes(24).toString("base64url"),
    scope: "portable-passphrase",
    ...(input.payloadOverrides ?? {}),
  };
  const key = deriveTestKey(input.passphrase, document.encryption.kdf);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonicalJson(publicHeader(document)), "utf8"));
  document.ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(secret), "utf8")),
    cipher.final(),
  ]).toString("base64url");
  document.tag = cipher.getAuthTag().toString("base64url");
  document.signature.signature = sign(
    null,
    Buffer.from(canonicalJson(signedBody(document)), "utf8"),
    keyObject(input.signingPrivateKey, "private"),
  ).toString("base64url");
  return document;
}

export function parseLicenseFileV2(value: unknown): LicenseFileV2 {
  const document = asRecord(value);
  if (Object.keys(document).some((name) => !TOP_LEVEL_FIELDS.has(name)) ||
      TOP_LEVEL_FIELDS.size !== Object.keys(document).length ||
      integerField(document, "schemaVersion") !== 2 ||
      textField(document, "type", 64) !== "slybrowser-license" ||
      textField(document, "audience", 64) !== "slybrowser-license-file" ||
      textField(document, "channel", 32) !== "stable") {
    fail("license_file_invalid", "License file fields are invalid");
  }
  const serviceUrl = normalizeServiceUrl(textField(document, "serviceUrl"));
  const licenseId = textField(document, "licenseId", 64);
  if (!UUID_PATTERN.test(licenseId)) fail("license_file_invalid", "License ID is invalid");
  const issuedAt = textField(document, "issuedAt", 64);
  if (!Number.isFinite(Date.parse(issuedAt))) fail("license_file_invalid", "Issued-at timestamp is invalid");
  const expiresAt = textField(document, "expiresAt", 64);
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail("license_file_invalid", "Expiry timestamp is invalid");
  }
  const fileId = textField(document, "fileId", 128);
  const encryption = asRecord(document.encryption);
  const kdf = asRecord(encryption.kdf);
  const signature = asRecord(document.signature);
  const parsed: LicenseFileV2 = {
    schemaVersion: 2,
    type: "slybrowser-license",
    audience: "slybrowser-license-file",
    serviceUrl,
    licenseId,
    channel: "stable",
    issuedAt,
    expiresAt,
    fileId,
    encryption: {
      algorithm: textField(encryption, "algorithm", 64) as LicenseFileV2["encryption"]["algorithm"],
      kdf: {
        name: textField(kdf, "name", 64) as LicenseFileV2["encryption"]["kdf"]["name"],
        purpose: textField(kdf, "purpose", 64) as LicenseFileV2["encryption"]["kdf"]["purpose"],
        salt: textField(kdf, "salt", 64),
        cost: integerField(kdf, "cost"),
        blockSize: integerField(kdf, "blockSize"),
        parallelization: integerField(kdf, "parallelization"),
        keyLength: integerField(kdf, "keyLength") as 32,
      },
      nonce: textField(encryption, "nonce", 64),
      aad: textField(encryption, "aad", 128) as LicenseFileV2["encryption"]["aad"],
    },
    ciphertext: textField(document, "ciphertext", 64 * 1024),
    tag: textField(document, "tag", 64),
    signature: {
      algorithm: textField(signature, "algorithm", 64) as LicenseFileV2["signature"]["algorithm"],
      keyId: textField(signature, "keyId", 64),
      signature: textField(signature, "signature", 256),
    },
  };
  if (parsed.encryption.algorithm !== "AES-256-GCM" ||
      parsed.encryption.aad !== "slybrowser-license-v2-public-header" ||
      parsed.signature.algorithm !== "Ed25519") {
    fail("license_file_invalid", "License file algorithms are invalid");
  }
  bytes(parsed.encryption.nonce, "nonce", 12);
  bytes(parsed.ciphertext, "ciphertext");
  bytes(parsed.tag, "tag", 16);
  bytes(parsed.signature.signature, "signature", 64);
  return parsed;
}

export function decryptLicenseFileV2(value: unknown, options: DecryptLicenseFileOptions): LicenseFileSecret {
  const document = parseLicenseFileV2(value);
  const trustedServiceUrls = (options.trustedServiceUrls ?? DEFAULT_TRUSTED_SERVICE_URLS)
    .map((url) => normalizeServiceUrl(url, options.allowInsecureLocalhost ?? false));
  if (!trustedServiceUrls.includes(document.serviceUrl)) {
    fail("license_file_untrusted_origin", "License file service URL is not trusted", 403);
  }
  if (Date.parse(document.expiresAt) <= Date.now()) {
    fail("license_file_expired", "License file has expired", 401);
  }
  const publicKey = options.trustedPublicKeys[document.signature.keyId];
  if (!publicKey) fail("license_file_key_unknown", "License file signing key is not trusted", 403);
  const signatureOk = verify(
    null,
    Buffer.from(canonicalJson(signedBody(document)), "utf8"),
    keyObject(publicKey, "public"),
    bytes(document.signature.signature, "signature", 64),
  );
  if (!signatureOk) fail("license_file_signature_invalid", "License file signature is invalid", 401);
  const key = deriveTestKey(options.passphrase, document.encryption.kdf);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes(document.encryption.nonce, "nonce", 12));
  decipher.setAAD(Buffer.from(canonicalJson(publicHeader(document)), "utf8"));
  decipher.setAuthTag(bytes(document.tag, "tag", 16));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(bytes(document.ciphertext, "ciphertext")),
      decipher.final(),
    ]);
  } catch {
    fail("license_file_locked", "License file cannot be decrypted", 401);
  }
  let secret: Record<string, unknown>;
  try {
    secret = asRecord(JSON.parse(plaintext.toString("utf8")));
  } catch {
    fail("license_file_payload_invalid", "License file payload is invalid");
  }
  if (Object.keys(secret).some((name) => !SECRET_FIELDS.has(name)) ||
      Object.keys(secret).length !== SECRET_FIELDS.size) {
    fail("license_file_payload_invalid", "License file payload contains unsupported claims");
  }
  const parsed: LicenseFileSecret = {
    schemaVersion: integerField(secret, "schemaVersion") as 2,
    type: textField(secret, "type", 64) as LicenseFileSecret["type"],
    audience: textField(secret, "audience", 64) as LicenseFileSecret["audience"],
    licenseId: textField(secret, "licenseId", 64),
    fileId: textField(secret, "fileId", 128),
    serviceUrl: normalizeServiceUrl(textField(secret, "serviceUrl")),
    channel: textField(secret, "channel", 32) as "stable",
    licenseKey: textField(secret, "licenseKey", 256),
    secretVersion: integerField(secret, "secretVersion") as 1,
    createdAt: textField(secret, "createdAt", 64),
    expiresAt: textField(secret, "expiresAt", 64),
    nonce: textField(secret, "nonce", 128),
    scope: textField(secret, "scope", 64) as LicenseFileSecret["scope"],
  };
  if (parsed.schemaVersion !== 2 || parsed.type !== "slybrowser-license-secret" ||
      parsed.audience !== document.audience ||
      parsed.secretVersion !== 1 ||
      (parsed.scope !== "test-private-preview" && parsed.scope !== "portable-passphrase") ||
      parsed.licenseId !== document.licenseId || parsed.fileId !== document.fileId ||
      parsed.serviceUrl !== document.serviceUrl || parsed.channel !== document.channel ||
      parsed.expiresAt !== document.expiresAt ||
      !LICENSE_KEY_PATTERN.test(parsed.licenseKey) ||
      !parsed.licenseKey.startsWith(`sly_live_${document.licenseId}.`) ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !Number.isFinite(Date.parse(parsed.expiresAt))) {
    fail("license_file_payload_invalid", "License file payload does not match its public header");
  }
  return parsed;
}
