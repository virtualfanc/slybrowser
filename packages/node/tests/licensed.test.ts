import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical.js";
import { licenseServiceErrorOutput, parseInstallSelectionArguments, parseKernelMajorArgument } from "../src/cli.js";
import {
  acquireBrowserInstallationReference,
  findCurrentBrowserInstallation,
  installGrantedBrowser,
  isBrowserInstallationInUse,
  pruneBrowserInstallations,
} from "../src/installer.js";
import { LicenseServiceError } from "../src/errors.js";
import { LicenseServiceClient, importLicenseFileToSealedAuthorization, readLicenseAuthorization, type LicenseAuthorization } from "../src/service.js";
import {
  heartbeatDelayMilliseconds,
  installAuthorized,
  installLatest,
  installLatestAuthorizedBrowser,
  launchAuthorized,
  launchAuthorizedPlaywright,
  launchAuthorizedPuppeteer,
  launchLatest,
  launchLatestPlaywright,
  launchLatestPuppeteer,
  prepareAuthorizedBrowser,
  verifyBrowserVersionAudit,
} from "../src/licensed.js";
import { createCompactLicenseFixture, createEncryptedLicenseFixture } from "./helpers/license-file-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function rawPublicKey(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32);
}

function deterministicBytes(label: string, length: number): Buffer {
  const chunks: Buffer[] = [];
  for (let index = 0; Buffer.concat(chunks).length < length; index += 1) {
    chunks.push(createHash("sha256").update(`${label}:${index}`).digest());
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function corruptBase64Url(value: string): string {
  return `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
}

type FixtureOptions = {
  tamperManifest?: boolean;
  sessionError?: boolean;
  sessionErrorCode?: string;
  sessionErrorStatus?: number;
  heartbeatAfterSeconds?: number;
};

function fixture(options: FixtureOptions = {}) {
  const leaseKeys = generateKeyPairSync("ed25519");
  const releaseKeys = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const sessionToken = "session-token";
  const bootstrapToken = "bootstrap-token";
  const activationTicket = "activation-ticket";
  const driverActivationTicket = "driver-activation-ticket";
  const runtimeToken = "runtime-token";
  const downloadTicketToken = "download-token";
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
    planId: "basic",
    concurrencyLimit: 5,
    features: ["browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright", "puppeteer"],
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
    status: "available",
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
  let releases = 0;
  let bootstrapHeartbeats = 0;
  let runtimeStartupId = "st_nodev2runtime0001";
  const sessionRequests: Array<Record<string, unknown>> = [];
  const runtimeSessionRequests: Array<Record<string, unknown>> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/licenses/info") && init?.method === "POST") {
      const request = JSON.parse(String(init.body ?? "{}")) as {
        kernelMajor?: number | "latest";
        updateKernel?: boolean;
        versionPolicy?: "latest" | "exact" | "at-or-before";
        browserVersion?: string;
      };
      const versionPolicy = request.versionPolicy ?? "latest";
      return Response.json({
        schemaVersion: 1,
        channel: "stable",
        licenseStatus: "active",
        plan: "basic",
        effectivePlan: "basic",
        paidThrough: now + 86400,
        features: ["browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright", "puppeteer"],
        concurrencyLimit: 5,
        activeSessions: 0,
        availableSessions: 5,
        sessionState: {
          activeBrowserProcesses: 0,
          limit: 5,
          available: 5,
        },
        browserVersion: "150.0.8000.1",
        ...(request.browserVersion === undefined ? {} : { requestedBrowserVersion: request.browserVersion }),
        requestedKernelMajor: request.kernelMajor ?? "latest",
        versionPolicy,
        selectionReason: versionPolicy === "at-or-before" && request.browserVersion !== "150.0.8000.1"
          ? "rollback"
          : versionPolicy === "at-or-before" ? "exact" : versionPolicy,
        selectionMode: "latest-in-major",
        availableBrowserVersions: ["150.0.8000.1"],
        latestAvailableVersion: "150.0.8000.1",
        updateAvailable: false,
        updateRequired: false,
        updateRights: { status: "active", channel: "stable", updatesThrough: now + 86400, exactVersion: true, rollback: true },
        stableErrorCode: null,
      });
    }
    if (url.endsWith("/v1/licenses/sessions") && init?.method === "POST") {
      if (options.sessionError) {
        return new Response(JSON.stringify({ error: sessionLimitError(options) }), {
          status: options.sessionErrorStatus ?? 409,
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(String(init.body ?? "{}")) as {
        kernelMajor?: number | "latest";
        updateKernel?: boolean;
        versionPolicy?: "latest" | "exact" | "at-or-before";
        browserVersion?: string;
      };
      sessionRequests.push(request as Record<string, unknown>);
      const versionPolicy = request.versionPolicy ?? "latest";
      return Response.json({
        schemaVersion: 1,
        sessionId,
        sessionToken,
        heartbeatAfterSeconds: 60,
        expiresAt: claims.expiresAt,
        plan: "basic",
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
    if (url.endsWith("/v2/runtime/sessions") && init?.method === "POST") {
      if (options.sessionError) {
        return new Response(JSON.stringify({ error: sessionLimitError(options) }), {
          status: options.sessionErrorStatus ?? 409,
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(String(init.body ?? "{}")) as {
        startupId?: string;
        automationBackend?: string;
        kernelMajor?: number | "latest";
        updateKernel?: boolean;
        versionPolicy?: "latest" | "exact" | "at-or-before";
        browserVersion?: string;
      };
      runtimeSessionRequests.push(request as Record<string, unknown>);
      runtimeStartupId = request.startupId ?? runtimeStartupId;
      const versionPolicy = request.versionPolicy ?? "latest";
      return Response.json({
        schemaVersion: 2,
        state: "reserved",
        startupId: request.startupId,
        sessionId,
        bootstrapToken,
        activationTicket,
        ...(request.automationBackend === "project-webdriver" ? { driverActivationTicket } : {}),
        heartbeatAfterSeconds: options.heartbeatAfterSeconds ?? 60,
        expiresAt: claims.expiresAt,
        plan: "basic",
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
        downloadTicket: {
          token: downloadTicketToken,
          expiresAt: claims.expiresAt,
          artifactSha256: sha256,
          artifactUrl: `https://api.slybrowser.test/v1/releases/artifacts/${sha256}.zip`,
        },
      }, { status: 201 });
    }
    if (url.endsWith(`/v2/runtime/sessions/${sessionId}/bootstrap-heartbeat`) && init?.method === "POST") {
      bootstrapHeartbeats += 1;
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bootstrap ${bootstrapToken}`);
      return Response.json({
        schemaVersion: 2,
        state: "reserved",
        startupId: runtimeStartupId,
        sessionId,
        heartbeatAfterSeconds: options.heartbeatAfterSeconds ?? 60,
        expiresAt: claims.expiresAt,
        plan: "basic",
        concurrencyLimit: 5,
        activeSessions: 1,
        lease,
      });
    }
    if (url.endsWith(`/v2/runtime/sessions/${sessionId}/activate`) && init?.method === "POST") {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Activation ${activationTicket}`);
      return Response.json({
        schemaVersion: 2,
        state: "active",
        startupId: runtimeStartupId,
        sessionId,
        runtimeToken,
        heartbeatAfterSeconds: options.heartbeatAfterSeconds ?? 60,
        expiresAt: claims.expiresAt,
        plan: "basic",
        concurrencyLimit: 5,
        activeSessions: 1,
        lease,
      });
    }
    if (url.endsWith(`/v2/runtime/sessions/${sessionId}/heartbeat`) && init?.method === "POST") {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Runtime ${runtimeToken}`);
      return Response.json({
        schemaVersion: 2,
        state: "active",
        startupId: runtimeStartupId,
        sessionId,
        heartbeatAfterSeconds: options.heartbeatAfterSeconds ?? 60,
        expiresAt: claims.expiresAt,
        plan: "basic",
        concurrencyLimit: 5,
        activeSessions: 1,
        lease,
      });
    }
    if (url.endsWith(`/v2/runtime/sessions/${sessionId}/close`) && init?.method === "POST") {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Runtime ${runtimeToken}`);
      return Response.json({
        schemaVersion: 2,
        state: "closing",
        startupId: runtimeStartupId,
        sessionId,
        heartbeatAfterSeconds: options.heartbeatAfterSeconds ?? 60,
        expiresAt: claims.expiresAt,
        plan: "basic",
        concurrencyLimit: 5,
        activeSessions: 1,
        lease,
      });
    }
    if (url.includes("/v2/runtime/artifacts/")) {
      downloads += 1;
      expect((init?.headers as Record<string, string>).authorization).toBe(`Download ${downloadTicketToken}`);
      return new Response(artifact, { status: 200, headers: { "content-type": "application/zip" } });
    }
    if (url.includes("/v1/releases/artifacts/")) {
      downloads += 1;
      expect((init?.headers as Record<string, string>).authorization).toBe(`Session ${sessionToken}`);
      return new Response(artifact, { status: 200, headers: { "content-type": "application/zip" } });
    }
    if (init?.method === "DELETE") {
      releases += 1;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init?.method} ${url}`);
  };
  const trust = {
    licenseTrustedKeys: { "lease-test": rawPublicKey(leaseKeys.publicKey) },
    releaseTrustedKeys: { "release-test": rawPublicKey(releaseKeys.publicKey) },
    fetch: fetchMock,
  };
  const client = new LicenseServiceClient(authorization, trust);
  return {
    client,
    authorization,
    trust,
    sessionRequests,
    runtimeSessionRequests,
    bootstrapHeartbeats: () => bootstrapHeartbeats,
    downloads: () => downloads,
    releases: () => releases,
  };
}

function sessionLimitError(options: FixtureOptions): Record<string, unknown> {
  return {
    code: options.sessionErrorCode ?? "session_limit",
    message: "Limit reached for runtime-token buyer@example.com paynow-secret",
    concurrencyLimit: 5,
    activeSessions: 5,
    availableSessions: 0,
    runtimeToken: "runtime-token",
    downloadTicket: "download-token",
    email: "buyer@example.com",
    payNowId: "paynow-secret",
    actions: [
      {
        type: "close_session",
        api: "DELETE /v2/runtime/sessions/{sessionId}",
        authorization: "Runtime runtime-token",
      },
      { type: "upgrade_plan", url: "https://slybrowser.com/#pricing" },
    ],
  };
}

describe("authorized release client", () => {
  it("exports stable authorized aliases while keeping latest compatibility names", () => {
    expect(typeof prepareAuthorizedBrowser).toBe("function");
    expect(typeof installAuthorized).toBe("function");
    expect(typeof launchAuthorized).toBe("function");
    expect(typeof launchAuthorizedPlaywright).toBe("function");
    expect(typeof launchAuthorizedPuppeteer).toBe("function");
    expect(typeof installLatest).toBe("function");
    expect(typeof launchLatest).toBe("function");
    expect(typeof launchLatestPlaywright).toBe("function");
    expect(typeof launchLatestPuppeteer).toBe("function");
  });

  it("parses CLI kernel update controls as fail-closed by default", () => {
    expect(parseInstallSelectionArguments(["--authorization", "account.json"])).toEqual({ updateKernel: false });
    expect(parseInstallSelectionArguments(["--authorization", "account.json", "--kernel-major", "150"])).toEqual({
      kernelMajor: 150,
      updateKernel: false,
    });
    expect(parseInstallSelectionArguments(["--authorization", "account.json", "--kernel-major", "latest", "--update-kernel"])).toEqual({
      kernelMajor: "latest",
      updateKernel: true,
    });
    expect(parseInstallSelectionArguments(["--authorization", "account.json", "--version", "150.0.8000.1"])).toMatchObject({
      browserVersion: "150.0.8000.1",
      versionPolicy: "exact",
      updateKernel: false,
    });
    expect(() => parseInstallSelectionArguments(["--rollback"])).toThrow("--rollback requires --version VERSION");
    expect(() => parseKernelMajorArgument("150.0.8000.1")).toThrow("--kernel-major");
  });

  it("redacts CLI license service errors to stable code and status only", () => {
    const error = new LicenseServiceError(
      "download-token bootstrap-token runtime-token license@example.com",
      "session_limit",
      409,
      {
        runtimeToken: "runtime-token",
        downloadTicket: "download-token",
        email: "license@example.com",
        payNowOrderId: "700000000000000411",
      },
    );
    const serialized = JSON.stringify(licenseServiceErrorOutput(error));
    expect(serialized).toContain("session_limit");
    expect(serialized).toContain("409");
    expect(serialized).not.toContain("runtime-token");
    expect(serialized).not.toContain("download-token");
    expect(serialized).not.toContain("bootstrap-token");
    expect(serialized).not.toContain("license@example.com");
    expect(serialized).not.toContain("700000000000000411");
  });

  it("reads redacted online license info without creating a session", async () => {
    const context = fixture();
    const info = await context.client.licenseInfo({
      platform: "windows",
      arch: "x64",
      kernelMajor: 150,
      updateKernel: false,
    });
    expect(info).toMatchObject({
      schemaVersion: 1,
      channel: "stable",
      licenseStatus: "active",
      plan: "basic",
      effectivePlan: "basic",
      concurrencyLimit: 5,
      activeSessions: 0,
      availableSessions: 5,
      browserVersion: "150.0.8000.1",
      requestedKernelMajor: 150,
      selectionMode: "latest-in-major",
      stableErrorCode: null,
    });
    expect(info.features).toContain("playwright");
    expect(context.sessionRequests).toHaveLength(0);
    expect(context.runtimeSessionRequests).toHaveLength(0);
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain("sly_live_");
    expect(serialized).not.toContain("session-token");
    expect(serialized).not.toContain("download-token");
    expect(serialized).not.toContain("bootstrap-token");
  });

  it("keeps authorized updateKernel false while latest opts into updates and preserves kernelMajor", async () => {
    const extractor = async (_archive: string, destination: string): Promise<void> => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SlyBrowser.exe"), "browser");
      await writeFile(join(destination, "chromedriver.exe"), "driver");
    };
    async function writeAuthorization(authorization: LicenseAuthorization): Promise<string> {
      const cacheRoot = join(tmpdir(), `sly-sdk-update-defaults-${process.pid}-${Date.now()}-${Math.random()}`);
      temporaryDirectories.push(cacheRoot);
      await mkdir(cacheRoot, { recursive: true });
      const authorizationFile = join(cacheRoot, "account.authorization.json");
      await writeFile(authorizationFile, JSON.stringify(authorization), "utf8");
      return authorizationFile;
    }

    const authorized = fixture();
    const authorizedCacheRoot = join(tmpdir(), `sly-sdk-authorized-cache-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(authorizedCacheRoot);
    const authorizedFile = await writeAuthorization(authorized.authorization);
    const authorizedGrant = await prepareAuthorizedBrowser(authorizedFile, {
      trust: authorized.trust,
      platform: "windows",
      arch: "x64",
      kernelMajor: 150,
      install: { cacheRoot: authorizedCacheRoot, extractor },
    });
    await authorizedGrant.release();
    expect(authorized.sessionRequests).toHaveLength(0);
    expect(authorized.runtimeSessionRequests[0]).toMatchObject({
      automationBackend: "project-webdriver",
      kernelMajor: 150,
      updateKernel: false,
      versionPolicy: "latest",
    });
    const cachedGrant = await prepareAuthorizedBrowser(authorizedFile, {
      trust: authorized.trust,
      platform: "windows",
      arch: "x64",
      kernelMajor: 150,
      install: { cacheRoot: authorizedCacheRoot, extractor },
    });
    await cachedGrant.release();
    expect(authorized.runtimeSessionRequests[1]).toMatchObject({
      automationBackend: "project-webdriver",
      kernelMajor: 150,
      updateKernel: false,
      browserVersion: "150.0.8000.1",
      versionPolicy: "exact",
    });
    const withdrawn = fixture({
      sessionError: true,
      sessionErrorCode: "release_version_unavailable",
      sessionErrorStatus: 404,
    });
    await expect(prepareAuthorizedBrowser(authorizedFile, {
      trust: withdrawn.trust,
      platform: "windows",
      arch: "x64",
      kernelMajor: 150,
      install: { cacheRoot: authorizedCacheRoot, extractor },
    })).rejects.toMatchObject({ code: "kernel_update_required", status: 409 });

    const latest = fixture();
    const latestCacheRoot = join(tmpdir(), `sly-sdk-latest-cache-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(latestCacheRoot);
    const latestGrant = await installLatestAuthorizedBrowser(await writeAuthorization(latest.authorization), {
      trust: latest.trust,
      platform: "windows",
      arch: "x64",
      kernelMajor: 150,
      install: { cacheRoot: latestCacheRoot, extractor },
    });
    await latestGrant.release();
    expect(latest.sessionRequests).toHaveLength(0);
    expect(latest.runtimeSessionRequests[0]).toMatchObject({
      automationBackend: "project-webdriver",
      kernelMajor: 150,
      updateKernel: true,
      versionPolicy: "latest",
    });
  });

  it("schedules client heartbeats at the service interval", () => {
    expect(heartbeatDelayMilliseconds(120, () => 0)).toBe(120_000);
    expect(heartbeatDelayMilliseconds(120, () => 1)).toBe(120_000);
    expect(heartbeatDelayMilliseconds(120, () => 0.5)).toBe(120_000);
    expect(heartbeatDelayMilliseconds(5, () => 1)).toBe(5_000);
    expect(heartbeatDelayMilliseconds(0, () => 1)).toBe(1_000);
  });

  it("keeps authorized downloads alive with v2 bootstrap heartbeat", async () => {
    const context = fixture({ heartbeatAfterSeconds: 1 });
    const cacheRoot = join(tmpdir(), `sly-sdk-bootstrap-heartbeat-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    const authorizationFile = join(cacheRoot, "account.authorization.json");
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(authorizationFile, JSON.stringify(context.authorization), "utf8");
    const extractor = async (_archive: string, destination: string): Promise<void> => {
      await new Promise((accept) => setTimeout(accept, 1100));
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SlyBrowser.exe"), "browser");
      await writeFile(join(destination, "chromedriver.exe"), "driver");
    };
    const authorized = await prepareAuthorizedBrowser(authorizationFile, {
      trust: context.trust,
      platform: "windows",
      arch: "x64",
      install: { cacheRoot, extractor },
    });
    await authorized.release();
    expect(context.sessionRequests).toHaveLength(0);
    expect(context.runtimeSessionRequests[0]).toMatchObject({ automationBackend: "project-webdriver" });
    expect(context.bootstrapHeartbeats()).toBeGreaterThanOrEqual(1);
    expect(context.downloads()).toBe(1);
    expect(context.releases()).toBe(1);
  }, 10_000);

  it("reads encrypted/authenticated v2 test license files and fails closed on tampering", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const cacheRoot = join(tmpdir(), `sly-sdk-v2-license-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
    const licenseFile = join(cacheRoot, "account.slybrowser-license.json");
    const licenseDocument = createEncryptedLicenseFixture({
      kind: "test",
      licenseId: "00000000-0000-4000-8000-000000000002",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000002.${"x".repeat(43)}`,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      fileId: "lf_test_node_reader",
      passphrase: "test-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-license-file-salt", 16),
      nonce: deterministicBytes("node-license-file-nonce", 12),
      payloadNonce: "node-payload-nonce",
    });
    await writeFile(licenseFile, JSON.stringify(licenseDocument), "utf8");
    const trust = {
      licenseFilePassphrase: "test-passphrase-only",
      licenseFileTrustedKeys: { "license-file-test-v1": rawPublicKey(publicKey) },
      trustedServiceUrls: ["https://api.slybrowser.test"],
    };
    await expect(readLicenseAuthorization(licenseFile, trust)).resolves.toEqual({
      schemaVersion: 1,
      serviceUrl: "https://api.slybrowser.test",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000002.${"x".repeat(43)}`,
      channel: "stable",
    });
    const serialized = await readFile(licenseFile, "utf8");
    expect(serialized).not.toContain("sly_live_");

    const portableDocument = createEncryptedLicenseFixture({
      kind: "portable",
      licenseId: "00000000-0000-4000-8000-000000000003",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000003.${"y".repeat(43)}`,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      fileId: "lf_portable_node_reader",
      passphrase: "portable-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-portable-license-file-salt", 16),
      nonce: deterministicBytes("node-portable-license-file-nonce", 12),
      payloadNonce: "node-portable-payload-nonce",
    });
    await writeFile(licenseFile, JSON.stringify(portableDocument), "utf8");
    await expect(readLicenseAuthorization(licenseFile, {
      ...trust,
      licenseFilePassphrase: "portable-passphrase-only",
    })).resolves.toEqual({
      schemaVersion: 1,
      serviceUrl: "https://api.slybrowser.test",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000003.${"y".repeat(43)}`,
      channel: "stable",
    });

    await writeFile(licenseFile, JSON.stringify({ ...licenseDocument, serviceUrl: "https://evil.example" }), "utf8");
    await expect(readLicenseAuthorization(licenseFile, trust)).rejects.toMatchObject({ code: "license_file_untrusted_origin" });

    await writeFile(licenseFile, JSON.stringify({ ...licenseDocument, ciphertext: corruptBase64Url(licenseDocument.ciphertext) }), "utf8");
    await expect(readLicenseAuthorization(licenseFile, trust)).rejects.toMatchObject({ code: "license_file_signature_invalid" });

    await writeFile(licenseFile, JSON.stringify({
      ...licenseDocument,
      signature: { ...licenseDocument.signature, signature: corruptBase64Url(licenseDocument.signature.signature) },
    }), "utf8");
    await expect(readLicenseAuthorization(licenseFile, trust)).rejects.toMatchObject({ code: "license_file_signature_invalid" });

    await writeFile(licenseFile, JSON.stringify(licenseDocument), "utf8");
    await expect(readLicenseAuthorization(licenseFile, {
      ...trust,
      licenseFilePassphrase: "wrong-passphrase",
    })).rejects.toMatchObject({ code: "license_file_locked" });
    await expect(readLicenseAuthorization(licenseFile, {
      ...trust,
      licenseFileTrustedKeys: {},
    })).rejects.toMatchObject({ code: "license_file_key_unknown" });

    await writeFile(licenseFile, JSON.stringify({ ...licenseDocument, audience: "other-product" }), "utf8");
    await expect(readLicenseAuthorization(licenseFile, trust)).rejects.toMatchObject({ code: "authorization_invalid" });

    const expiredDocument = createEncryptedLicenseFixture({
      kind: "test",
      licenseId: "00000000-0000-4000-8000-000000000002",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000002.${"x".repeat(43)}`,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z",
      fileId: "lf_test_node_expired",
      passphrase: "test-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-license-file-expired-salt", 16),
      nonce: deterministicBytes("node-license-file-expired-nonce", 12),
      payloadNonce: "node-expired-payload-nonce",
    });
    await writeFile(licenseFile, JSON.stringify(expiredDocument), "utf8");
    await expect(readLicenseAuthorization(licenseFile, trust)).rejects.toMatchObject({ code: "license_file_expired" });

    const planClaimDocument = createEncryptedLicenseFixture({
      kind: "test",
      licenseId: "00000000-0000-4000-8000-000000000002",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000002.${"x".repeat(43)}`,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      fileId: "lf_test_node_plan_claim",
      passphrase: "test-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-license-file-plan-salt", 16),
      nonce: deterministicBytes("node-license-file-plan-nonce", 12),
      payloadNonce: "node-plan-payload-nonce",
      payloadOverrides: { plan: "ultra" },
    });
    await writeFile(licenseFile, JSON.stringify(planClaimDocument), "utf8");
    await expect(readLicenseAuthorization(licenseFile, trust)).rejects.toMatchObject({ code: "license_file_payload_invalid" });
  });

  it("resolves canonical v2 email-delivered license files through the configured service when no local unlock material is supplied", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const cacheRoot = join(tmpdir(), `sly-sdk-v2-license-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
    const licenseFile = join(cacheRoot, "slybrowser-free-user-example-com-exp-2033-08-16.license.json");
    const licenseKey = `sly_live_00000000-0000-4000-8000-000000000006.${"q".repeat(43)}`;
    const licenseDocument = createEncryptedLicenseFixture({
      kind: "portable",
      licenseId: "00000000-0000-4000-8000-000000000006",
      licenseKey,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      expiresAt: "2033-08-16T03:33:20.000Z",
      fileId: "lf_portable_node_v2",
      passphrase: "portable-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-v2-license-file-salt", 16),
      nonce: deterministicBytes("node-v2-license-file-nonce", 12),
      payloadNonce: "node-v2-license-payload",
    });
    await writeFile(licenseFile, JSON.stringify(licenseDocument), "utf8");
    const calls: Array<{ url: string; body: unknown }> = [];
    await expect(readLicenseAuthorization(licenseFile, {
      trustedServiceUrls: ["https://api.slybrowser.test"],
      licenseFileResolutionServiceUrl: "https://resolver.slybrowser.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as unknown });
        return new Response(JSON.stringify({
          schemaVersion: 1,
          serviceUrl: "https://api.slybrowser.test",
          licenseKey,
          channel: "stable",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    })).resolves.toEqual({
      schemaVersion: 1,
      serviceUrl: "https://api.slybrowser.test",
      licenseKey,
      channel: "stable",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://resolver.slybrowser.test/v1/license-files/authorization");
    expect(calls[0]?.body).toEqual({ schemaVersion: 1, licenseFile: licenseDocument });
    const serialized = await readFile(licenseFile, "utf8");
    expect(serialized).not.toContain(licenseKey);
    expect(serialized).toContain("\"schemaVersion\":2");
    expect(serialized).toContain("\"audience\":\"slybrowser-license-file\"");
  });

  it("continues resolving legacy compact license wrappers through the configured service", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const cacheRoot = join(tmpdir(), `sly-sdk-legacy-compact-license-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
    const licenseFile = join(cacheRoot, "legacy-compact.slybrowser-license.json");
    const licenseKey = `sly_live_00000000-0000-4000-8000-000000000016.${"q".repeat(43)}`;
    const compactDocument = createCompactLicenseFixture(createEncryptedLicenseFixture({
      kind: "portable",
      licenseId: "00000000-0000-4000-8000-000000000016",
      licenseKey,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      expiresAt: "2033-08-16T03:33:20.000Z",
      fileId: "lf_portable_node_legacy_compact",
      passphrase: "portable-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-legacy-compact-license-file-salt", 16),
      nonce: deterministicBytes("node-legacy-compact-license-file-nonce", 12),
      payloadNonce: "node-legacy-compact-license-payload",
    }));
    await writeFile(licenseFile, JSON.stringify(compactDocument), "utf8");
    const calls: Array<{ url: string; body: unknown }> = [];
    await expect(readLicenseAuthorization(licenseFile, {
      trustedServiceUrls: ["https://api.slybrowser.test"],
      licenseFileResolutionServiceUrl: "https://resolver.slybrowser.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as unknown });
        return new Response(JSON.stringify({
          schemaVersion: 1,
          serviceUrl: "https://api.slybrowser.test",
          licenseKey,
          channel: "stable",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    })).resolves.toMatchObject({
      schemaVersion: 1,
      serviceUrl: "https://api.slybrowser.test",
      licenseKey,
      channel: "stable",
    });
    expect(calls[0]?.body).toEqual({ schemaVersion: 1, licenseFile: compactDocument });
    const serialized = await readFile(licenseFile, "utf8");
    expect(serialized).not.toContain(licenseKey);
    expect(serialized).not.toContain("licenseId");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("signature");
  });

  it.skipIf(process.platform !== "win32")("imports v2 license files into Windows DPAPI sealed authorization files", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const cacheRoot = join(tmpdir(), `sly-sdk-sealed-license-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    await mkdir(cacheRoot, { recursive: true });
    const licenseFile = join(cacheRoot, "account.slybrowser-license.json");
    const sealedFile = join(cacheRoot, "account.slybrowser-sealed-license.json");
    const licenseDocument = createEncryptedLicenseFixture({
      kind: "portable",
      licenseId: "00000000-0000-4000-8000-000000000004",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000004.${"z".repeat(43)}`,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      fileId: "lf_portable_node_import",
      passphrase: "portable-passphrase-only",
      signingKeyId: "license-file-test-v1",
      signingPrivateKey: privateKey,
      salt: deterministicBytes("node-portable-license-import-salt", 16),
      nonce: deterministicBytes("node-portable-license-import-nonce", 12),
      payloadNonce: "node-portable-import-payload-nonce",
    });
    await writeFile(licenseFile, JSON.stringify(licenseDocument), "utf8");
    const trust = {
      licenseFilePassphrase: "portable-passphrase-only",
      licenseFileTrustedKeys: { "license-file-test-v1": rawPublicKey(publicKey) },
      trustedServiceUrls: ["https://api.slybrowser.test"],
    };
    const result = await importLicenseFileToSealedAuthorization(licenseFile, sealedFile, trust);
    expect(result).toMatchObject({
      output: sealedFile,
      serviceUrl: "https://api.slybrowser.test",
      channel: "stable",
      protection: "windows-dpapi-current-user",
    });
    const serialized = await readFile(sealedFile, "utf8");
    expect(serialized).not.toContain("sly_live_");
    expect(serialized).not.toContain("portable-passphrase-only");
    await expect(readLicenseAuthorization(sealedFile, {
      trustedServiceUrls: ["https://api.slybrowser.test"],
    })).resolves.toEqual({
      schemaVersion: 1,
      serviceUrl: "https://api.slybrowser.test",
      licenseKey: `sly_live_00000000-0000-4000-8000-000000000004.${"z".repeat(43)}`,
      channel: "stable",
    });
    await expect(importLicenseFileToSealedAuthorization(licenseFile, sealedFile, trust))
      .rejects.toMatchObject({ code: "EEXIST" });

    const tampered = JSON.parse(serialized) as Record<string, unknown>;
    tampered.licenseKeySha256 = "0".repeat(64);
    const tamperedFile = join(cacheRoot, "account.tampered-sealed-license.json");
    await writeFile(tamperedFile, JSON.stringify(tampered), "utf8");
    await expect(readLicenseAuthorization(tamperedFile, {
      trustedServiceUrls: ["https://api.slybrowser.test"],
    })).rejects.toMatchObject({ code: "sealed_license_locked" });
  }, 15_000);

  it("verifies the lease and manifest, downloads once, and loads a sibling runtime", async () => {
    const context = fixture();
    const grant = await context.client.createSession({ platform: "windows", arch: "x64" });
    expect(grant.plan).toBe("basic");
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

    await writeFile(repaired.driverExecutable, "tampered-again");
    await writeFile(join(cacheRoot, "downloads", `${grant.artifact.sha256}.zip`), "corrupt-archive");
    const repairedAfterArchiveDamage = await installGrantedBrowser(context.client, grant, { cacheRoot, extractor });
    expect(await readFile(repairedAfterArchiveDamage.driverExecutable, "utf8")).toBe("driver");
    expect(context.downloads()).toBe(2);
    expect((await readdir(join(cacheRoot, "downloads"))).some((name) => name.includes(".bad-"))).toBe(true);
    expect((await readdir(join(cacheRoot, "stable", grant.browserVersion))).some((name) => name.includes(".bad-"))).toBe(true);

    async function fakeInstallation(version: string, identity: string, hashPrefix: string) {
      const root = join(cacheRoot, "stable", version, identity);
      await mkdir(root, { recursive: true });
      const browserExecutable = join(root, "SlyBrowser.exe");
      const driverExecutable = join(root, "chromedriver.exe");
      await writeFile(browserExecutable, "old-browser");
      await writeFile(driverExecutable, "old-driver");
      const installation = {
        version,
        platform: "windows",
        arch: "x64",
        root,
        browserExecutable,
        driverExecutable,
        artifactSha256: hashPrefix.repeat(64),
      };
      await writeFile(join(root, ".sly-install.json"), `${JSON.stringify(installation, null, 2)}\n`);
      return installation;
    }
    const unused = await fakeInstallation("149.0.0.1", "windows-x64-aaaaaaaaaaaaaaaa", "a");
    const inUse = await fakeInstallation("149.0.0.2", "windows-x64-bbbbbbbbbbbbbbbb", "b");
    const reference = await acquireBrowserInstallationReference(inUse);
    const pruned = await pruneBrowserInstallations({ cacheRoot, platform: "windows", arch: "x64" });
    expect(pruned.removed).toEqual([unused.root]);
    expect(pruned.skippedInUse).toEqual([inUse.root]);
    expect(pruned.kept).toContain(repairedAfterArchiveDamage.root);
    await expect(access(unused.root)).rejects.toBeDefined();
    await expect(access(inUse.root)).resolves.toBeUndefined();
    await reference.release();
    const secondPrune = await pruneBrowserInstallations({ cacheRoot, platform: "windows", arch: "x64" });
    expect(secondPrune.removed).toEqual([inUse.root]);
  }, 10_000);

  it("uses v2 runtime credentials for reservation, activation, heartbeat, download and release", async () => {
    const context = fixture();
    const grant = await context.client.createRuntimeSession({
      platform: "windows",
      arch: "x64",
      automationBackend: "playwright",
      startupId: "st_nodev2runtime0001",
    });
    expect(grant).toMatchObject({
      schemaVersion: 2,
      state: "reserved",
      startupId: "st_nodev2runtime0001",
      bootstrapToken: "bootstrap-token",
      activationTicket: "activation-ticket",
      browserVersion: "150.0.8000.1",
      downloadTicket: {
        token: "download-token",
        artifactSha256: createHash("sha256").update(Buffer.from("signed-browser-archive")).digest("hex"),
      },
    });
    const bootstrapHeartbeat = await context.client.bootstrapHeartbeat(grant);
    expect(bootstrapHeartbeat).toMatchObject({ state: "reserved", sessionId: grant.sessionId });
    const cacheRoot = join(tmpdir(), `sly-sdk-runtime-install-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    const extractor = async (_archive: string, destination: string): Promise<void> => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SlyBrowser.exe"), "browser");
      await writeFile(join(destination, "chromedriver.exe"), "driver");
    };
    const installation = await installGrantedBrowser(context.client, grant, { cacheRoot, extractor });
    expect(installation.version).toBe("150.0.8000.1");
    expect(installation.browserExecutable.endsWith("SlyBrowser.exe")).toBe(true);
    const activated = await context.client.activateRuntimeSession(grant);
    expect(activated).toMatchObject({ state: "active", runtimeToken: "runtime-token" });
    const heartbeat = await context.client.runtimeHeartbeat(activated);
    expect(heartbeat).toMatchObject({ state: "active", sessionId: grant.sessionId });
    const closing = await context.client.closeRuntimeSession(activated);
    expect(closing).toMatchObject({ state: "closing", sessionId: grant.sessionId });
    await context.client.releaseRuntimeSession(activated);
    expect(context.releases()).toBe(1);
    expect(context.downloads()).toBe(1);

    const reserved = fixture();
    const reservedGrant = await reserved.client.createRuntimeSession({
      platform: "windows",
      arch: "x64",
      startupId: "st_nodev2runtime0001",
    });
    await reserved.client.releaseRuntimeSession(reservedGrant);
    expect(reserved.releases()).toBe(1);
  }, 10_000);

  it("rejects a manifest changed after signing", async () => {
    const context = fixture({ tamperManifest: true });
    await expect(context.client.createSession({ platform: "windows", arch: "x64" }))
      .rejects.toMatchObject({ code: "manifest_invalid_signature" });
  });

  it("preserves stable service concurrency errors", async () => {
    const context = fixture({ sessionError: true });
    let error: LicenseServiceError | undefined;
    try {
      await context.client.createSession({ platform: "windows", arch: "x64" });
    } catch (caught) {
      error = caught as LicenseServiceError;
    }
    expect(error).toEqual(expect.objectContaining<Partial<LicenseServiceError>>({
        code: "session_limit",
        status: 409,
        details: expect.objectContaining({
          concurrencyLimit: 5,
          activeSessions: 5,
          availableSessions: 0,
          actions: expect.arrayContaining([
            expect.objectContaining({ type: "close_session" }),
            expect.objectContaining({ type: "upgrade_plan" }),
          ]),
        }),
      }));
    expect((error!.details.actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("api");
    expect((error!.details.actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("authorization");
    const rendered = `${error!.message} ${JSON.stringify(error!.details)}`;
    expect(rendered).not.toContain("runtime-token");
    expect(rendered).not.toContain("download-token");
    expect(rendered).not.toContain("buyer@example.com");
    expect(rendered).not.toContain("paynow-secret");
  });

  it("shows a renewal prompt when a paid plan has expired", async () => {
    const context = fixture({
      sessionError: true,
      sessionErrorCode: "license_plan_expired",
      sessionErrorStatus: 403,
    });
    await expect(context.client.createSession({ platform: "windows", arch: "x64" })).rejects.toMatchObject({
      code: "license_plan_expired",
      status: 403,
      message: expect.stringMatching(/paid plan has expired.*renew/i),
    });
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

  it("launches authorized Playwright and Puppeteer with version audit and concurrency release", async () => {
    const context = fixture();
    const cacheRoot = join(tmpdir(), `sly-sdk-framework-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    const authorizationFile = join(cacheRoot, "account.authorization.json");
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(authorizationFile, JSON.stringify(context.authorization), "utf8");
    const extractor = async (_archive: string, destination: string): Promise<void> => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SlyBrowser.exe"), "browser");
      await writeFile(join(destination, "chromedriver.exe"), "driver");
    };

    let playwrightCloseCount = 0;
    let playwrightContextCount = 0;
    let playwrightPageCount = 0;
    const playwright = {
      chromium: {
        async launch(options: Record<string, unknown>) {
          expect(String(options.executablePath).endsWith("SlyBrowser.exe")).toBe(true);
          expect(options.args).toEqual(expect.arrayContaining([
            expect.stringMatching(/^--sly-config-file=/),
            expect.stringMatching(/^--sly-license-file=/),
            "--no-first-run",
          ]));
          return {
            version: () => "150.0.8000.1",
            async newContext() {
              playwrightContextCount += 1;
              return {
                async newPage() {
                  playwrightPageCount += 1;
                  return { async close() {} };
                },
                async close() {},
              };
            },
            async close() { playwrightCloseCount += 1; },
          };
        },
        async launchPersistentContext() {
          throw new Error("not used");
        },
      },
    };
    const browser = await launchLatestPlaywright(playwright, authorizationFile, {
      trust: context.trust,
      install: { cacheRoot, extractor },
      frameworkVersion: "1.62.1",
      launchOptions: { args: ["--no-first-run"] },
    });
    expect(browser.licenseRuntime?.versionAudit).toMatchObject({
      requested: null,
      selected: "150.0.8000.1",
      downloaded: "150.0.8000.1",
      launched: "150.0.8000.1",
      policy: "latest",
    });
    const playwrightReservationsBeforeContext = context.runtimeSessionRequests.length;
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    await page.close();
    await browserContext.close();
    expect(playwrightContextCount).toBe(1);
    expect(playwrightPageCount).toBe(1);
    expect(context.runtimeSessionRequests).toHaveLength(playwrightReservationsBeforeContext);
    const playwrightInstallation = await findCurrentBrowserInstallation({ cacheRoot, platform: "windows", arch: "x64" });
    expect(playwrightInstallation).not.toBeNull();
    await expect(isBrowserInstallationInUse(playwrightInstallation!)).resolves.toBe(true);
    expect(context.releases()).toBe(0);
    await browser.close();
    expect(playwrightCloseCount).toBe(1);
    expect(context.releases()).toBe(1);
    await expect(isBrowserInstallationInUse(playwrightInstallation!)).resolves.toBe(false);

    let puppeteerCloseCount = 0;
    let puppeteerPageCount = 0;
    const puppeteer = {
      async launch(options: Record<string, unknown>) {
        expect(String(options.executablePath).endsWith("SlyBrowser.exe")).toBe(true);
        expect(options.args).toEqual(expect.arrayContaining([
          expect.stringMatching(/^--sly-config-file=/),
          expect.stringMatching(/^--sly-license-file=/),
        ]));
        return {
          version: async () => "Chrome/150.0.8000.1",
          async newPage() {
            puppeteerPageCount += 1;
            return { async close() {} };
          },
          async close() { puppeteerCloseCount += 1; },
        };
      },
    };
    const puppeteerBrowser = await launchLatestPuppeteer(puppeteer, authorizationFile, {
      trust: context.trust,
      install: { cacheRoot, extractor },
      frameworkVersion: "25.8.0",
    });
    expect(puppeteerBrowser.licenseRuntime?.versionAudit).toMatchObject({
      selected: "150.0.8000.1",
      launched: "150.0.8000.1",
    });
    const puppeteerReservationsBeforePage = context.runtimeSessionRequests.length;
    const puppeteerPage = await puppeteerBrowser.newPage();
    await puppeteerPage.close();
    expect(puppeteerPageCount).toBe(1);
    expect(context.runtimeSessionRequests).toHaveLength(puppeteerReservationsBeforePage);
    const puppeteerInstallation = await findCurrentBrowserInstallation({ cacheRoot, platform: "windows", arch: "x64" });
    expect(puppeteerInstallation).not.toBeNull();
    await expect(isBrowserInstallationInUse(puppeteerInstallation!)).resolves.toBe(true);
    await puppeteerBrowser.close();
    expect(puppeteerCloseCount).toBe(1);
    expect(context.releases()).toBe(2);
    expect(context.downloads()).toBe(1);
    await expect(isBrowserInstallationInUse(puppeteerInstallation!)).resolves.toBe(false);
  }, 15_000);

  it("rejects authorized framework launches when the actual browser version differs", async () => {
    const context = fixture();
    const cacheRoot = join(tmpdir(), `sly-sdk-framework-mismatch-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(cacheRoot);
    const authorizationFile = join(cacheRoot, "account.authorization.json");
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(authorizationFile, JSON.stringify(context.authorization), "utf8");
    const extractor = async (_archive: string, destination: string): Promise<void> => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SlyBrowser.exe"), "browser");
      await writeFile(join(destination, "chromedriver.exe"), "driver");
    };
    let closeCount = 0;
    const playwright = {
      chromium: {
        async launch() {
          return {
            version: () => "151.0.0.0",
            async close() { closeCount += 1; },
          };
        },
        async launchPersistentContext() {
          throw new Error("not used");
        },
      },
    };
    await expect(launchLatestPlaywright(playwright, authorizationFile, {
      trust: context.trust,
      install: { cacheRoot, extractor },
      frameworkVersion: "1.62.1",
    })).rejects.toMatchObject({ code: "browser_version_chain_mismatch" });
    expect(closeCount).toBe(1);
    expect(context.releases()).toBe(1);
  }, 15_000);
});
