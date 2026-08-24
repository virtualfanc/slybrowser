import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

export interface LeasePrivateModuleClaim {
  path: string;
  sha256: string;
  size: number;
  abi: string;
}

export interface LeaseResourceClaim {
  path: string;
  sha256: string;
  size: number;
}

export interface LeaseCodeSignatureClaim {
  scheme: "authenticode" | "apple-developer-id" | "x509-code-signing";
  subject: string;
  certificateSha256: string;
  timestampRequired: boolean;
}

export interface LeaseArtifactClaim {
  sha256: string;
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  archiveFormat: "zip";
  browserExecutable: string;
  driverExecutable: string;
  browserSha256: string;
  driverSha256: string;
  privateModules: LeasePrivateModuleClaim[];
  resources: LeaseResourceClaim[];
  codeSignature?: LeaseCodeSignatureClaim;
}

export interface LeaseClaims {
  schemaVersion: 1 | 2;
  licenseId: string;
  audience: "slybrowser";
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  browserVersion?: string;
  browserMin: string;
  browserMax: string;
  planId: string;
  concurrencyLimit: number;
  paidThrough: number | null;
  licenseStatus: "active" | "hold" | "revoked";
  artifactSha256: string;
  browserSha256: string;
  driverSha256: string;
  artifact?: LeaseArtifactClaim;
  leaseGeneration: number;
  features: string[];
  sessionId: string;
  nonce: string;
  deviceHash?: string;
}

export interface LicenseEnvelope {
  algorithm: "Ed25519";
  keyId: string;
  payload: string;
  signature: string;
}

export class LeaseSigner {
  readonly #key: KeyObject;

  constructor(
    readonly keyId: string,
    privateKey: string | Buffer | KeyObject,
  ) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new TypeError("Invalid signing key ID");
    this.#key = privateKey instanceof Object && "type" in privateKey
      ? privateKey as KeyObject
      : createPrivateKey(privateKey as string | Buffer);
    if (this.#key.asymmetricKeyType !== "ed25519") throw new TypeError("Lease signing key must be Ed25519");
  }

  sign(claims: LeaseClaims): LicenseEnvelope {
    const payload = Buffer.from(JSON.stringify(claims), "utf8");
    return {
      algorithm: "Ed25519",
      keyId: this.keyId,
      payload: payload.toString("base64url"),
      signature: sign(null, payload, this.#key).toString("base64url"),
    };
  }

  static nonce(): string {
    return randomBytes(24).toString("base64url");
  }
}
