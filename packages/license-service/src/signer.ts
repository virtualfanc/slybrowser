import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

export interface LeaseClaims {
  schemaVersion: 1;
  licenseId: string;
  audience: "slybrowser";
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  browserMin: string;
  browserMax: string;
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
