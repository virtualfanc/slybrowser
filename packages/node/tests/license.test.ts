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
    browserMin: "123.0.0.0",
    browserMax: "123.9999.9999.9999",
    planId: "launch",
    concurrencyLimit: 5,
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

function artifactClaim() {
  return {
    sha256: "a".repeat(64),
    platform: "windows",
    arch: "x64",
    archiveFormat: "zip",
    browserExecutable: "SlyBrowser.exe",
    driverExecutable: "chromedriver.exe",
    browserSha256: "b".repeat(64),
    driverSha256: "c".repeat(64),
    privateModules: [{ path: "SlyBrowser/sly_private_module.dll", sha256: "d".repeat(64), size: 14, abi: "windows-x64" }],
    resources: [{ path: "SlyBrowser/resources.pak", sha256: "e".repeat(64), size: 9 }],
    codeSignature: {
      scheme: "authenticode",
      subject: "CN=SlyBrowser Test Publisher",
      certificateSha256: "f".repeat(64),
      timestampRequired: true,
    },
  };
}

describe("LicenseVerifier", () => {
  const verifier = new LicenseVerifier({ "test-1": rawPublicKey }, { now: () => NOW });

  it("accepts a valid lease", () => {
    const claims = verifier.verify(envelope(), {
      browserVersion: "123.0.4567.89",
      requiredFeatures: ["profiles"],
      deviceHash: "device_test",
    });
    expect(claims.licenseId).toBe("lic_test");
    expect(claims.planId).toBe("launch");
    expect(claims.concurrencyLimit).toBe(5);
  });

  it("accepts a v2 lease with signed artifact/module state", () => {
    const artifact = artifactClaim();
    const claims = verifier.verify(envelope({
      schemaVersion: 2,
      browserVersion: "123.0.4567.89",
      browserMin: "123.0.4567.89",
      browserMax: "123.0.4567.89",
      artifactSha256: artifact.sha256,
      browserSha256: artifact.browserSha256,
      driverSha256: artifact.driverSha256,
      artifact,
      leaseGeneration: NOW + 300,
    }), {
      browserVersion: "123.0.4567.89",
      requiredFeatures: ["profiles"],
      deviceHash: "device_test",
    });
    expect(claims.schemaVersion).toBe(2);
    expect(claims.browserVersion).toBe("123.0.4567.89");
    expect(claims.artifact?.privateModules[0]?.abi).toBe("windows-x64");
  });

  it("rejects a tampered payload", () => {
    const value = envelope();
    const claims = JSON.parse(Buffer.from(value.payload, "base64url").toString("utf8"));
    claims.features.push("admin");
    value.payload = encodeBase64Url(canonicalJson(claims));
    expect(() => verifier.verify(value, { browserVersion: "123.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_invalid_signature" }));
  });

  it("rejects expiry, browser mismatch, and missing features", () => {
    expect(() => verifier.verify(envelope({ issuedAt: NOW - 400, notBefore: NOW - 400, expiresAt: NOW - 40 }), { browserVersion: "123.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_expired" }));
    expect(() => verifier.verify(envelope(), { browserVersion: "149.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_browser_unsupported" }));
    expect(() => verifier.verify(envelope(), { browserVersion: "123.0.0.0", requiredFeatures: ["enterprise"] }))
      .toThrowError(expect.objectContaining({ code: "license_feature_denied" }));
  });

  it("rejects unknown keys and algorithm downgrade", () => {
    expect(() => verifier.verify({ ...envelope(), keyId: "unknown" }, { browserVersion: "123.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_key_unknown" }));
    const downgraded = { ...envelope(), algorithm: "HS256" } as unknown as LicenseEnvelope;
    try {
      verifier.verify(downgraded, { browserVersion: "123.0.0.0" });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(LicenseError);
      expect((error as LicenseError).code).toBe("license_algorithm_unsupported");
    }
  });

  it("supports online lease signing key rotation with overlapping trusted keys", () => {
    const nextKeys = generateKeyPairSync("ed25519");
    const rawNextPublicKey = nextKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const payload = canonicalJson({
      schemaVersion: 1,
      licenseId: "lic_test",
      audience: "slybrowser",
      issuedAt: NOW - 10,
      notBefore: NOW - 10,
      expiresAt: NOW + 300,
      browserMin: "123.0.0.0",
      browserMax: "123.9999.9999.9999",
      planId: "launch",
      concurrencyLimit: 5,
      features: ["profiles"],
      sessionId: "session_rotated",
      nonce: "nonce_rotated",
    });
    const rotatedEnvelope: LicenseEnvelope = {
      algorithm: "Ed25519",
      keyId: "test-2",
      payload: encodeBase64Url(payload),
      signature: encodeBase64Url(sign(null, payload, nextKeys.privateKey)),
    };
    const rotatingVerifier = new LicenseVerifier({
      "test-1": rawPublicKey,
      "test-2": rawNextPublicKey,
    }, { now: () => NOW });
    expect(rotatingVerifier.verify(rotatedEnvelope, { browserVersion: "123.0.0.0" }).sessionId)
      .toBe("session_rotated");
    expect(() => verifier.verify(rotatedEnvelope, { browserVersion: "123.0.0.0" }))
      .toThrowError(expect.objectContaining({ code: "license_key_unknown" }));
  });
});
