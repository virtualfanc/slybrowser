import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, encodeBase64Url } from "../src/canonical.js";
import { selectArtifact, verifyArtifact, verifyReleaseManifest } from "../src/manifest.js";

const directories: string[] = [];
const keys = generateKeyPairSync("ed25519");
const rawPublicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);

function manifest(content = Buffer.from("browser")): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schemaVersion: 1,
    browserVersion: "148.0.7778.179",
    sdkCompatibility: ">=0.1.0 <0.2.0",
    artifacts: [{
      platform: "windows",
      arch: "x64",
      url: "https://downloads.slybrowser.com/test.zip",
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.length,
      archiveFormat: "zip",
      browserExecutable: "SlyBrowser.exe",
      driverExecutable: "chromedriver.exe",
      browserSha256: createHash("sha256").update("browser").digest("hex"),
      driverSha256: createHash("sha256").update("driver").digest("hex"),
    }],
    evidence: {
      sbom: { url: "https://downloads.slybrowser.com/test.sbom.json", sha256: "0".repeat(64), size: 1, mediaType: "application/vnd.cyclonedx+json" },
      provenance: { url: "https://downloads.slybrowser.com/test.provenance.json", sha256: "1".repeat(64), size: 1, mediaType: "application/vnd.in-toto+json" },
      chromiumPatchInventory: { url: "https://downloads.slybrowser.com/test.patches.json", sha256: "2".repeat(64), size: 1, mediaType: "application/vnd.slybrowser.chromium-patch-inventory+json" },
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
  it("verifies a signed manifest and artifact", async () => {
    const content = Buffer.from("browser");
    const verified = verifyReleaseManifest(manifest(content), { "release-test": rawPublicKey });
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

  it("rejects a signed manifest without supply-chain evidence", () => {
    const value = manifest();
    delete value.evidence;
    const payload = { ...value };
    delete payload.signature;
    value.signature = {
      algorithm: "ed25519",
      keyId: "release-test",
      value: encodeBase64Url(sign(null, canonicalJson(payload), keys.privateKey)),
    };
    expect(() => verifyReleaseManifest(value, { "release-test": rawPublicKey }))
      .toThrowError(expect.objectContaining({ code: "manifest_evidence_missing" }));
  });
});
