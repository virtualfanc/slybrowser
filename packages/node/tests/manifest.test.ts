import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, encodeBase64Url } from "../src/canonical.js";
import { isSdkCompatible, selectArtifact, verifyArtifact, verifyReleaseManifest } from "../src/manifest.js";

const directories: string[] = [];
const keys = generateKeyPairSync("ed25519");
const rawPublicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);

function manifest(content = Buffer.from("browser"), archiveFormat = "zip"): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    browserVersion: "123.0.4567.89",
    sdkCompatibility: ">=0.1.0 <0.2.0",
    status: "available",
    artifacts: [{
      platform: "windows",
      arch: "x64",
      url: "https://api.slybrowser.com/v1/releases/artifacts/test.zip",
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      archiveFormat,
      browserExecutable: "SlyBrowser.exe",
      driverExecutable: "chromedriver.exe",
      browserSha256: createHash("sha256").update("browser").digest("hex"),
      driverSha256: createHash("sha256").update("driver").digest("hex"),
      privateModules: [{
        path: "SlyBrowser/sly_private_module.dll",
        sha256: createHash("sha256").update("private-module").digest("hex"),
        size: 14,
        abi: "windows-x64",
      }],
      resources: [{
        path: "SlyBrowser/resources.pak",
        sha256: createHash("sha256").update("resources").digest("hex"),
        size: 9,
      }],
      codeSignature: {
        scheme: "authenticode",
        subject: "CN=SlyBrowser Test Publisher",
        certificateSha256: "3".repeat(64),
        timestampRequired: true,
      },
    }],
    evidence: {
      sbom: { url: "https://api.slybrowser.com/v1/releases/evidence/test.sbom.json", sha256: "0".repeat(64), size: 1, mediaType: "application/vnd.cyclonedx+json" },
      provenance: { url: "https://api.slybrowser.com/v1/releases/evidence/test.provenance.json", sha256: "1".repeat(64), size: 1, mediaType: "application/vnd.in-toto+json" },
      chromiumPatchInventory: { url: "https://api.slybrowser.com/v1/releases/evidence/test.patches.json", sha256: "2".repeat(64), size: 1, mediaType: "application/vnd.slybrowser.chromium-patch-inventory+json" },
      sourceBoundary: { sdk: "open-source", chromiumPatches: "inventory-and-approved-patches", proprietaryCore: "private" },
    },
  };
  payload.signature = {
    algorithm: "ed25519",
    keyId: "release-test",
    value: encodeBase64Url(sign(null, canonicalJson(payload), keys.privateKey)),
  };
  return payload;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("release manifest", () => {
  it("accepts the current 7z release archive contract", () => {
    const verified = verifyReleaseManifest(manifest(Buffer.from("browser"), "7z"), { "release-test": rawPublicKey });
    expect(selectArtifact(verified, "windows", "x64").archiveFormat).toBe("7z");
  });

  it("verifies a signed manifest and artifact", async () => {
    const content = Buffer.from("browser");
    const verified = verifyReleaseManifest(manifest(content), { "release-test": rawPublicKey });
    expect(verified.status).toBe("available");
    const artifact = selectArtifact(verified, "windows", "x64");
    const directory = await mkdtemp(join(tmpdir(), "sly-node-test-"));
    directories.push(directory);
    const path = join(directory, "browser.zip");
    await writeFile(path, content);
    await expect(verifyArtifact(path, artifact)).resolves.toBeUndefined();
    await writeFile(path, "tampered");
    await expect(verifyArtifact(path, artifact)).rejects.toMatchObject({ code: "artifact_size_mismatch" });
  });

  it("rejects a modified manifest", () => {
    const value = manifest();
    value.browserVersion = "999.0.0.0";
    expect(() => verifyReleaseManifest(value, { "release-test": rawPublicKey }))
      .toThrowError(expect.objectContaining({ code: "manifest_invalid_signature" }));
  });

  it("supports offline release signing key rotation with overlapping trusted keys", () => {
    const nextKeys = generateKeyPairSync("ed25519");
    const rawNextPublicKey = nextKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const value = manifest();
    delete value.signature;
    value.signature = {
      algorithm: "ed25519",
      keyId: "release-test-v2",
      value: encodeBase64Url(sign(null, canonicalJson(value), nextKeys.privateKey)),
    };
    expect(verifyReleaseManifest(value, {
      "release-test": rawPublicKey,
      "release-test-v2": rawNextPublicKey,
    }).signature.keyId).toBe("release-test-v2");
    expect(() => verifyReleaseManifest(value, { "release-test": rawPublicKey }))
      .toThrowError(expect.objectContaining({ code: "manifest_key_unknown" }));
  });

  it("accepts a signed manifest without optional supply-chain evidence", () => {
    const value = manifest();
    delete value.evidence;
    const payload = { ...value };
    delete payload.signature;
    value.signature = {
      algorithm: "ed25519",
      keyId: "release-test",
      value: encodeBase64Url(sign(null, canonicalJson(payload), keys.privateKey)),
    };
    const verified = verifyReleaseManifest(value, { "release-test": rawPublicKey });
    expect(verified.evidence).toBeUndefined();
    expect(verified.status).toBe("available");
  });

  it("supports caret SDK compatibility ranges used by signed release manifests", () => {
    expect(isSdkCompatible("^0.1.0", "0.1.0")).toBe(true);
    expect(isSdkCompatible("^0.1.0", "0.1.9")).toBe(true);
    expect(isSdkCompatible("^0.1.0", "0.2.0")).toBe(false);
    expect(isSdkCompatible("^1.2.3", "1.9.0")).toBe(true);
    expect(isSdkCompatible("^1.2.3", "2.0.0")).toBe(false);
  });
});
