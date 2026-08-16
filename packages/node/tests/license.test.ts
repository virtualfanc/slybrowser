import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJson, encodeBase64Url } from "../src/canonical.js";
import { LicenseError } from "../src/errors.js";
import { LicenseVerifier, type LicenseEnvelope } from "../src/license.js";

const NOW = 1_800_000_000;
const keys = generateKeyPairSync("ed25519");
const rawPublicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);

function envelope(updates: Record<string, unknown> = {}): LicenseEnvelope {
  const payload = canonicalJson({
    schemaVersion: 1,
    licenseId: "lic_test",
    audience: "slybrowser",
    issuedAt: NOW - 10,
    notBefore: NOW - 10,
    expiresAt: NOW + 300,
    browserMin: "148.0.0.0",
    browserMax: "148.9999.9999.9999",
    features: ["profiles", "proxy"],
    sessionId: "session_test",
    nonce: "nonce_test",
    deviceHash: "device_test",
    ...updates,
  });
  return {
    algorithm: "Ed25519",
    keyId: "test-1",
    payload: encodeBase64Url(payload),
    signature: encodeBase64Url(sign(null, payload, keys.privateKey)),
  };
}

describe("LicenseVerifier", () => {
  const verifier = new LicenseVerifier({ "test-1": rawPublicKey }, { now: () => NOW });

  it("accepts a valid lease", () => {
    const claims = verifier.verify(envelope(), {
      browserVersion: "148.0.7778.179",
      requiredFeatures: ["profiles"],
      deviceHash: "device_test",
    });
    expect(claims.licenseId).toBe("lic_test");
  });

  it("rejects a tampered payload", () => {
    const value = envelope();
    const claims = JSON.parse(Buffer.from(value.payload, "base64url").toString("utf8"));
    claims.features.push("admin");
    value.payload = encodeBase64Url(canonicalJson(claims));
    expect(() => verifier.verify(value, { browserVersion: "148.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_invalid_signature" }));
  });

  it("rejects expiry, browser mismatch, and missing features", () => {
    expect(() => verifier.verify(envelope({ issuedAt: NOW - 400, notBefore: NOW - 400, expiresAt: NOW - 40 }), { browserVersion: "148.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_expired" }));
    expect(() => verifier.verify(envelope(), { browserVersion: "149.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_browser_unsupported" }));
    expect(() => verifier.verify(envelope(), { browserVersion: "148.0.0.0", requiredFeatures: ["enterprise"] }))
      .toThrowError(expect.objectContaining({ code: "license_feature_denied" }));
  });

  it("rejects unknown keys and algorithm downgrade", () => {
    expect(() => verifier.verify({ ...envelope(), keyId: "unknown" }, { browserVersion: "148.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_key_unknown" }));
    const downgraded = { ...envelope(), algorithm: "HS256" } as unknown as LicenseEnvelope;
    try {
      verifier.verify(downgraded, { browserVersion: "148.0.0.0" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LicenseError);
      expect((error as LicenseError).code).toBe("license_algorithm_unsupported");
    }
  });
});
