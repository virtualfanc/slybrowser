import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical.js";
import { installGrantedBrowser } from "../src/installer.js";
import { LicenseServiceError } from "../src/errors.js";
import { LicenseServiceClient, type LicenseAuthorization } from "../src/service.js";
import { verifyBrowserVersionAudit } from "../src/licensed.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32);
}

function fixture(options: { tamperManifest?: boolean; sessionError?: boolean } = {}) {
  const leaseKeys = generateKeyPairSync("ed25519");
  const releaseKeys = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const sessionToken = "session-token";
  const artifact = Buffer.from("signed-browser-archive");
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  const claims = {
    schemaVersion: 1,
    licenseId: "00000000-0000-4000-8000-000000000002",
    audience: "slybrowser",
    issuedAt: now,
    notBefore: now,
    expiresAt: now + 600,
    browserMin: "150.0.8000.1",
    browserMax: "150.0.8000.1",
    features: ["browser", "fingerprint", "humanize", "webdriver"],
    sessionId,
    nonce: "test-nonce",
  };
  const payload = Buffer.from(JSON.stringify(claims));
  const lease = {
    algorithm: "Ed25519",
    keyId: "lease-test",
    payload: payload.toString("base64url"),
    signature: sign(null, payload, leaseKeys.privateKey).toString("base64url"),
  };
  const unsignedManifest = {
    schemaVersion: 1,
    browserVersion: "150.0.8000.1",
    sdkCompatibility: ">=0.1.0 <1.0.0",
    publishedAt: new Date(now * 1000).toISOString(),
    artifacts: [{
      platform: "windows",
      arch: "x64",
      url: `https://api.slybrowser.test/v1/releases/artifacts/${sha256}.zip`,
      sha256,
      size: artifact.length,
      archiveFormat: "zip",
      browserExecutable: "SlyBrowser.exe",
      driverExecutable: "chromedriver.exe",
      browserSha256: createHash("sha256").update("browser").digest("hex"),
      driverSha256: createHash("sha256").update("driver").digest("hex"),
    }],
    evidence: {
      sbom: { url: "https://api.slybrowser.test/evidence/sbom.json", sha256: "0".repeat(64), size: 1, mediaType: "application/vnd.cyclonedx+json" },
      provenance: { url: "https://api.slybrowser.test/evidence/provenance.json", sha256: "1".repeat(64), size: 1, mediaType: "application/vnd.in-toto+json" },
      chromiumPatchInventory: { url: "https://api.slybrowser.test/evidence/patches.json", sha256: "2".repeat(64), size: 1, mediaType: "application/vnd.slybrowser.chromium-patch-inventory+json" },
      sourceBoundary: { sdk: "open-source", chromiumPatches: "inventory-and-approved-patches", proprietaryCore: "private" },
    },
  };
  const manifest = {
    ...unsignedManifest,
    signature: {
      algorithm: "ed25519",
      keyId: "release-test",
      value: sign(null, canonicalJson(unsignedManifest), releaseKeys.privateKey).toString("base64url"),
    },
  };
  if (options.tamperManifest) manifest.browserVersion = "151.0.0.0";
  const authorization: LicenseAuthorization = {
    schemaVersion: 1,
    serviceUrl: "https://api.slybrowser.test",
    licenseKey: `sly_live_00000000-0000-4000-8000-000000000002.${"x".repeat(43)}`,
    channel: "stable",
  };
  let downloads = 0;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/licenses/sessions") && init?.method === "POST") {
      if (options.sessionError) {
        return new Response(JSON.stringify({ error: { code: "session_limit", message: "Limit reached" } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(String(init.body ?? "{}")) as {
        versionPolicy?: "latest" | "exact" | "at-or-before";
        browserVersion?: string;
      };
      const versionPolicy = request.versionPolicy ?? "latest";
      return Response.json({
        schemaVersion: 1,
        sessionId,
        sessionToken,
        heartbeatAfterSeconds: 60,
        expiresAt: claims.expiresAt,
        plan: "launch",
        concurrencyLimit: 5,
        activeSessions: 1,
        browserVersion: "150.0.8000.1",
        ...(request.browserVersion === undefined ? {} : { requestedBrowserVersion: request.browserVersion }),
        versionPolicy,
        selectionReason: versionPolicy === "at-or-before" && request.browserVersion !== "150.0.8000.1"
          ? "rollback"
          : versionPolicy === "at-or-before" ? "exact" : versionPolicy,
        availableBrowserVersions: ["150.0.8000.1"],
        updateRights: { status: "active", channel: "stable", updatesThrough: now + 86400, exactVersion: true, rollback: true },
        lease,
        manifest,
      }, { status: 201 });
    }
    if (url.includes("/v1/releases/artifacts/")) {
      downloads += 1;
      expect((init?.headers as Record<string, string>).authorization).toBe(`Session ${sessionToken}`);
      return new Response(artifact, { status: 200, headers: { "content-type": "application/zip" } });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  };
  const client = new LicenseServiceClient(authorization, {
    licenseTrustedKeys: { "lease-test": rawPublicKey(leaseKeys.publicKey) },
    releaseTrustedKeys: { "release-test": rawPublicKey(releaseKeys.publicKey) },
    fetch: fetchMock,
  });
  return { client, downloads: () => downloads };
}

describe("authorized release client", () => {
  it("verifies the lease and manifest, downloads once, and loads a sibling runtime", async () => {
    const context = fixture();
    const grant = await context.client.createSession({ platform: "windows", arch: "x64" });
    expect(grant.plan).toBe("launch");
    expect(grant.concurrencyLimit).toBe(5);
    const cacheRoot = join(tmpdir(), `sly-sdk-install-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    const extractor = async (_archive: string, destination: string): Promise<void> => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SlyBrowser.exe"), "browser");
      await writeFile(join(destination, "chromedriver.exe"), "driver");
    };
    const first = await installGrantedBrowser(context.client, grant, { cacheRoot, extractor });
    expect(first.version).toBe("150.0.8000.1");
    expect(first.browserExecutable.endsWith("SlyBrowser.exe")).toBe(true);
    expect(first.driverExecutable.endsWith("chromedriver.exe")).toBe(true);
    const second = await installGrantedBrowser(context.client, grant, { cacheRoot, extractor });
    expect(second).toEqual(first);
    expect(context.downloads()).toBe(1);
    await writeFile(first.browserExecutable, "tampered");
    const repaired = await installGrantedBrowser(context.client, grant, { cacheRoot, extractor });
    expect(await (await import("node:fs/promises")).readFile(repaired.browserExecutable, "utf8")).toBe("browser");
    expect(context.downloads()).toBe(1);
  });

  it("rejects a manifest changed after signing", async () => {
    const context = fixture({ tamperManifest: true });
    await expect(context.client.createSession({ platform: "windows", arch: "x64" }))
      .rejects.toMatchObject({ code: "manifest_invalid_signature" });
  });

  it("preserves stable service concurrency errors", async () => {
    const context = fixture({ sessionError: true });
    await expect(context.client.createSession({ platform: "windows", arch: "x64" }))
      .rejects.toEqual(expect.objectContaining<Partial<LicenseServiceError>>({ code: "session_limit", status: 409 }));
  });

  it("requests exact versions and explicit at-or-before rollback without silent fallback", async () => {
    const exact = fixture();
    const exactGrant = await exact.client.createSession({
      platform: "windows",
      arch: "x64",
      browserVersion: "150.0.8000.1",
    });
    expect(exactGrant).toMatchObject({
      browserVersion: "150.0.8000.1",
      requestedBrowserVersion: "150.0.8000.1",
      versionPolicy: "exact",
      selectionReason: "exact",
    });

    const rollback = fixture();
    const rollbackGrant = await rollback.client.createSession({
      platform: "windows",
      arch: "x64",
      browserVersion: "151.0.0.0",
      versionPolicy: "at-or-before",
    });
    expect(rollbackGrant).toMatchObject({
      browserVersion: "150.0.8000.1",
      requestedBrowserVersion: "151.0.0.0",
      versionPolicy: "at-or-before",
      selectionReason: "rollback",
    });

    expect(verifyBrowserVersionAudit({
      requested: "151.0.0.0",
      selected: "150.0.8000.1",
      downloaded: "150.0.8000.1",
      launched: "150.0.8000.1",
      policy: "at-or-before",
      selectionReason: "rollback",
    })).toMatchObject({ selected: "150.0.8000.1", launched: "150.0.8000.1" });
    expect(() => verifyBrowserVersionAudit({
      requested: "150.0.8000.1",
      selected: "150.0.8000.1",
      downloaded: "150.0.8000.1",
      launched: "151.0.0.0",
      policy: "exact",
      selectionReason: "exact",
    })).toThrowError(expect.objectContaining({ code: "browser_version_chain_mismatch" }));
  });
});
