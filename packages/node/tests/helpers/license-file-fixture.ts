import { createCipheriv, scryptSync, sign, type KeyObject } from "node:crypto";
import { gzipSync } from "node:zlib";

import { canonicalJson } from "../../src/canonical.js";

type EncryptedLicenseFixtureOptions = {
  kind: "portable" | "test";
  licenseId: string;
  licenseKey: string;
  serviceUrl: string;
  issuedAt: string;
  expiresAt?: string;
  fileId: string;
  passphrase: string;
  signingKeyId: string;
  signingPrivateKey: KeyObject;
  salt: Buffer;
  nonce: Buffer;
  payloadNonce: string;
  payloadOverrides?: Record<string, unknown>;
};

export function createEncryptedLicenseFixture(options: EncryptedLicenseFixtureOptions) {
  const expiresAt = options.expiresAt
    ?? new Date(Date.parse(options.issuedAt) + 90 * 24 * 60 * 60 * 1000).toISOString();
  const purpose = options.kind === "test" ? "test-private-preview" : "portable-passphrase";
  const kdfName = options.kind === "test" ? "sly-test-scrypt-v1" : "sly-portable-scrypt-v1";
  const encryption = {
    algorithm: "AES-256-GCM",
    aad: "slybrowser-license-v2-public-header",
    nonce: options.nonce.toString("base64url"),
    kdf: {
      name: kdfName,
      purpose,
      salt: options.salt.toString("base64url"),
      cost: 16_384,
      blockSize: 8,
      parallelization: 1,
      keyLength: 32,
    },
  };
  const publicHeader = {
    schemaVersion: 2,
    type: "slybrowser-license",
    audience: "slybrowser-license-file",
    serviceUrl: options.serviceUrl,
    licenseId: options.licenseId,
    channel: "stable",
    issuedAt: options.issuedAt,
    expiresAt,
    fileId: options.fileId,
    encryption,
  };
  const secretPayload = {
    schemaVersion: 2,
    type: "slybrowser-license-secret",
    audience: publicHeader.audience,
    licenseId: options.licenseId,
    fileId: options.fileId,
    serviceUrl: options.serviceUrl,
    channel: "stable",
    licenseKey: options.licenseKey,
    secretVersion: 1,
    createdAt: options.issuedAt,
    expiresAt,
    nonce: options.payloadNonce,
    scope: purpose,
    ...options.payloadOverrides,
  };
  const cipher = createCipheriv(
    "aes-256-gcm",
    scryptSync(options.passphrase, options.salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
    options.nonce,
  );
  cipher.setAAD(canonicalJson(publicHeader));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(secretPayload), "utf8")),
    cipher.final(),
  ]).toString("base64url");
  const signedBody = {
    ...publicHeader,
    ciphertext,
    tag: cipher.getAuthTag().toString("base64url"),
  };
  return {
    ...signedBody,
    signature: {
      algorithm: "Ed25519",
      keyId: options.signingKeyId,
      signature: sign(null, canonicalJson(signedBody), options.signingPrivateKey).toString("base64url"),
    },
  };
}

export function createCompactLicenseFixture(document: unknown) {
  return {
    schemaVersion: 1,
    type: "slybrowser-license",
    format: "slybrowser-license-compact-v1",
    license: gzipSync(Buffer.from(JSON.stringify(document), "utf8")).toString("base64url"),
  };
}
