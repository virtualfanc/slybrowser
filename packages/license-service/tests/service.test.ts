import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseCatalog } from "../src/catalog.js";
import { assertSeparatedSigningKeys, selectLicenseStoreBackend } from "../src/config.js";
import { issueAuthorizationFile, issuePortableLicenseFile, issueTestLicenseFile } from "../src/authorization.js";
import { ServiceError } from "../src/errors.js";
import { createPortableLicenseFile, createTestLicenseFile, decryptLicenseFileV2, type LicenseFileV2 } from "../src/license-file.js";
import { PLAN_CATALOG, PLAN_CONTRACT, PLAN_IDS, type PlanId } from "../src/plans.js";
import { PostgresLicenseStore } from "../src/postgres-store.js";
import { createLicenseHttpServer, InMemoryRateLimiter, RedisFixedWindowRateLimiter, StaticLicenseAdminAuthenticator, type LicenseHttpMetricEvent } from "../src/server.js";
import { EntitlementService } from "../src/service.js";
import { LeaseSigner } from "../src/signer.js";
import { LicenseStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixture(
  now = 2_000_000_000,
  artifactBytes = Buffer.from("zip"),
  storePath = ":memory:",
  includeCodeSignature = true,
  sdkCompatibility = ">=0.1.0 <1.0.0",
): {
  service: EntitlementService;
  store: LicenseStore;
  catalog: ReleaseCatalog;
  now: { value: number };
  artifact: { bytes: Buffer; sha256: string; name: string };
  browserSha256: string;
  driverSha256: string;
} {
  const clock = { value: now };
  const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const browserSha256 = createHash("sha256").update("browser").digest("hex");
  const driverSha256 = createHash("sha256").update("driver").digest("hex");
  const name = `${sha256}.zip`;
  const manifest = {
    schemaVersion: 1,
    browserVersion: "150.0.8000.1",
    sdkCompatibility,
    status: "available",
    publishedAt: "2033-05-18T03:33:20Z",
    artifacts: [{
      platform: "windows",
      arch: "x64",
      url: `https://api.slybrowser.test/v1/releases/artifacts/${name}`,
      sha256,
      size: artifactBytes.length,
      archiveFormat: "zip",
      browserExecutable: "SlyBrowser.exe",
      driverExecutable: "chromedriver.exe",
      browserSha256,
      driverSha256,
      privateModules: [{
        path: "SlyBrowser/sly_private_module.dll",
        sha256: createHash("sha256").update("private-module").digest("hex"),
        size: Buffer.byteLength("private-module"),
        abi: "windows-x64",
      }],
      resources: [{
        path: "SlyBrowser/resources.pak",
        sha256: createHash("sha256").update("resources").digest("hex"),
        size: Buffer.byteLength("resources"),
      }],
      ...(includeCodeSignature ? { codeSignature: {
        scheme: "authenticode",
        subject: "CN=SlyBrowser Test Publisher",
        certificateSha256: "3".repeat(64),
        timestampRequired: true,
      } } : {}),
    }],
    evidence: {
      sbom: { url: "https://api.slybrowser.test/evidence/sbom.json", sha256: "0".repeat(64), size: 1, mediaType: "application/vnd.cyclonedx+json" },
      provenance: { url: "https://api.slybrowser.test/evidence/provenance.json", sha256: "1".repeat(64), size: 1, mediaType: "application/vnd.in-toto+json" },
      chromiumPatchInventory: { url: "https://api.slybrowser.test/evidence/patches.json", sha256: "2".repeat(64), size: 1, mediaType: "application/vnd.slybrowser.chromium-patch-inventory+json" },
      sourceBoundary: { sdk: "open-source", chromiumPatches: "inventory-and-approved-patches", proprietaryCore: "private" },
    },
    signature: { algorithm: "ed25519", keyId: "release-test", value: "test-signature" },
  };
  const catalog = new ReleaseCatalog([manifest]);
  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = new LeaseSigner("lease-test", privateKey);
  const store = new LicenseStore(storePath, Buffer.alloc(32, 7));
  return {
    service: new EntitlementService(store, catalog, signer, {
      now: () => clock.value,
      sessionTtlSeconds: 120,
      heartbeatAfterSeconds: 30,
    }),
    store,
    catalog,
    now: clock,
    artifact: { bytes: artifactBytes, sha256, name },
    browserSha256,
    driverSha256,
  };
}

async function issue(service: EntitlementService, plan: PlanId, paidThrough = 2_000_086_400) {
  return service.issueAuthorization({
    accountId: `account-${plan}`,
    plan,
    ...(plan === "free" ? {} : { paidThrough }),
    serviceUrl: "https://api.slybrowser.test",
  });
}

function request() {
  return { platform: "windows", arch: "x64", channel: "stable", sdkVersion: "0.1.0" };
}

function leaseClaims(lease: { payload: string }): Record<string, unknown> {
  return JSON.parse(Buffer.from(lease.payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("optional release code-signature metadata", () => {
  it("issues schema v2 leases without code-signature claims when the selected release omits them", async () => {
    const context = fixture(2_000_000_000, Buffer.from("zip"), ":memory:", false);
    const authorization = await issue(context.service, "launch");
    const grant = await context.service.createRuntimeSession(authorization.licenseKey, {
      ...request(),
      startupId: "st_optionalcodesig1",
      automationBackend: "project-webdriver",
      deviceHash: "device-optional-code-signature",
    });
    expect(leaseClaims(grant.lease).artifact).not.toHaveProperty("codeSignature");
  });
});

describe("release SDK compatibility", () => {
  it("accepts caret ranges used by signed release manifests", async () => {
    const context = fixture(2_000_000_000, Buffer.from("zip"), ":memory:", true, "^0.1.0");
    try {
      const authorization = await issue(context.service, "launch");
      const grant = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_caretrangecompat",
        automationBackend: "project-webdriver",
        sdkVersion: "0.1.0",
      });
      expect(grant.browserVersion).toBe("150.0.8000.1");
      expect(grant.lease.keyId).toBe("lease-test");
    } finally {
      context.store.close();
    }
  });
});

describe("plan and atomic concurrency authority", () => {
  it("uses production runtime lease defaults when not overridden", () => {
    const context = fixture();
    const { privateKey } = generateKeyPairSync("ed25519");
    try {
      const service = new EntitlementService(
        context.store,
        context.catalog,
        new LeaseSigner("lease-defaults", privateKey),
        { now: () => context.now.value },
      );
      expect(service.sessionTtlSeconds).toBe(660);
      expect(service.heartbeatAfterSeconds).toBe(300);
    } finally {
      context.store.close();
    }
  });

  it("does not allow SQLite as the production concurrency authority", () => {
    expect(selectLicenseStoreBackend({ SLY_LICENSE_DEPLOYMENT_MODE: "private-preview" } as NodeJS.ProcessEnv)).toBe("sqlite");
    expect(selectLicenseStoreBackend({
      SLY_LICENSE_DEPLOYMENT_MODE: "production",
      SLY_LICENSE_STORE: "postgres",
    } as NodeJS.ProcessEnv)).toBe("postgres");
    expect(() => selectLicenseStoreBackend({
      SLY_LICENSE_DEPLOYMENT_MODE: "production",
      SLY_LICENSE_STORE: "sqlite",
    } as NodeJS.ProcessEnv)).toThrowError(/PostgreSQL|postgres/i);
  });

  it("requires online lease and license-file signing keys to stay separated", () => {
    expect(() => assertSeparatedSigningKeys({
      onlineSigningKeyFile: "C:/secrets/online.pem",
      onlineKeyId: "license-prod-v1",
      licenseFileSigningKeyFile: "C:/secrets/online.pem",
      licenseFileKeyId: "license-file-prod-v1",
    })).toThrowError(/separate files/i);

    expect(() => assertSeparatedSigningKeys({
      onlineSigningKeyFile: "C:/secrets/online.pem",
      onlineKeyId: "shared-key-id",
      licenseFileSigningKeyFile: "C:/secrets/license-file.pem",
      licenseFileKeyId: "shared-key-id",
    })).toThrowError(/key ID/i);

    expect(() => assertSeparatedSigningKeys({
      onlineSigningKeyFile: "C:/secrets/online.pem",
      onlineKeyId: "license-prod-v1",
      licenseFileSigningKeyFile: "C:/secrets/license-file.pem",
      licenseFileKeyId: "license-file-prod-v1",
    })).not.toThrow();
  });

  it("reports non-mutating redacted license info without allocating a browser process", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "launch");
      const info = await context.service.licenseInfo(authorization.licenseKey, {
        ...request(),
        kernelMajor: 150,
        updateKernel: false,
      });
      expect(info).toMatchObject({
        schemaVersion: 1,
        channel: "stable",
        licenseStatus: "active",
        plan: "launch",
        effectivePlan: "launch",
        paidThrough: 2_000_086_400,
        concurrencyLimit: PLAN_CATALOG.launch.concurrency,
        activeSessions: 0,
        availableSessions: PLAN_CATALOG.launch.concurrency,
        browserVersion: "150.0.8000.1",
        requestedKernelMajor: 150,
        stableErrorCode: null,
      });
      expect(info.features).toContain("playwright");
      expect(JSON.stringify(info)).not.toContain("sly_live_");
      expect(JSON.stringify(info)).not.toContain("sessionToken");

      const session = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_licenseinfoactive",
        automationBackend: "project-webdriver",
      });
      const activeInfo = await context.service.licenseInfo(authorization.licenseKey, request());
      expect(activeInfo.activeSessions).toBe(1);
      expect(activeInfo.sessionState).toEqual({
        activeBrowserProcesses: 1,
        limit: PLAN_CATALOG.launch.concurrency,
        available: PLAN_CATALOG.launch.concurrency - 1,
      });
      await context.service.releaseRuntimeSession(session.sessionId, session.bootstrapToken);
    } finally {
      context.store.close();
    }
  });

  it("loads the five-plan price and concurrency matrix from contracts/plans.json", () => {
    expect(PLAN_CONTRACT).toMatchObject({
      schemaVersion: 1,
      currency: "USD",
      billingPeriod: "month",
    });
    expect(PLAN_CONTRACT.plans.map((plan) => plan.id)).toEqual([...PLAN_IDS]);
    expect(PLAN_CONTRACT.plans.map((plan) => plan.sku)).toEqual([...PLAN_IDS]);
    expect(Object.values(PLAN_CATALOG)).toEqual(PLAN_CONTRACT.plans);
    expect(PLAN_CATALOG.free.autoRenew).toBe(false);
    for (const plan of ["launch", "studio", "fleet", "grid"] as const) {
      expect(PLAN_CATALOG[plan].autoRenew).toBe(true);
      expect(PLAN_CATALOG[plan].sku).toBe(plan);
    }
    expect(PLAN_CATALOG.free.features).toEqual([
      "browser",
      "release-download",
      "webdriver",
      "fingerprint",
      "humanize",
    ]);
    expect(PLAN_CATALOG.launch.features).toEqual(expect.arrayContaining(["playwright", "puppeteer"]));
  });

  for (const plan of Object.keys(PLAN_CATALOG) as PlanId[]) {
    it(`enforces ${plan} concurrency atomically`, async () => {
      const context = fixture();
      try {
        const authorization = await issue(context.service, plan);
        const grants = await Promise.all(Array.from({ length: PLAN_CATALOG[plan].concurrency }, () =>
          context.service.createSession(authorization.licenseKey, request())));
        expect(grants).toHaveLength(PLAN_CATALOG[plan].concurrency);
        expect(grants.at(-1)?.activeSessions).toBe(PLAN_CATALOG[plan].concurrency);
        await expect(context.service.createSession(authorization.licenseKey, request())).rejects.toMatchObject(
          { code: "session_limit", status: 409 },
        );
        await context.service.release(grants[0]!.sessionId, grants[0]!.sessionToken);
        await expect(context.service.createSession(authorization.licenseKey, request()))
          .resolves.toMatchObject({ activeSessions: PLAN_CATALOG[plan].concurrency });
      } finally {
        context.store.close();
      }
    }, 20_000);
  }

  it("falls an expired paid entitlement back to Free capacity", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "launch", context.now.value + 10);
      const first = await context.service.createSession(authorization.licenseKey, request());
      expect(first.concurrencyLimit).toBe(5);
      context.now.value += 11;
      await expect(context.service.createSession(authorization.licenseKey, request())).rejects.toMatchObject(
        { code: "session_limit" },
      );
      await context.service.release(first.sessionId, first.sessionToken);
      const fallback = await context.service.createSession(authorization.licenseKey, request());
      expect(fallback.plan).toBe("free");
      expect(fallback.concurrencyLimit).toBe(1);
    } finally {
      context.store.close();
    }
  });

  it("renews a reservation by heartbeat and expires an orphan", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "free");
      const grant = await context.service.createSession(authorization.licenseKey, request());
      context.now.value += 60;
      const heartbeat = await context.service.heartbeat(grant.sessionId, grant.sessionToken);
      expect(heartbeat.expiresAt).toBe(context.now.value + 120);
      context.now.value += 121;
      await expect(context.service.heartbeat(grant.sessionId, grant.sessionToken)).rejects.toMatchObject(
        { code: "session_expired" },
      );
      await expect(context.service.createSession(authorization.licenseKey, request()))
        .resolves.toMatchObject({ activeSessions: 1 });
    } finally {
      context.store.close();
    }
  });

  it("binds paid status, artifact hash, and lease generation into the signed lease", async () => {
    const context = fixture();
    try {
      const paidThrough = context.now.value + 86_400;
      const authorization = await issue(context.service, "launch", paidThrough);
      const grant = await context.service.createSession(authorization.licenseKey, request());
      expect(leaseClaims(grant.lease)).toMatchObject({
        schemaVersion: 2,
        planId: "launch",
        concurrencyLimit: PLAN_CATALOG.launch.concurrency,
        paidThrough,
        licenseStatus: "active",
        browserVersion: "150.0.8000.1",
        artifactSha256: context.artifact.sha256,
        browserSha256: context.browserSha256,
        driverSha256: context.driverSha256,
        artifact: {
          sha256: context.artifact.sha256,
          platform: "windows",
          arch: "x64",
          browserSha256: context.browserSha256,
          driverSha256: context.driverSha256,
          privateModules: [
            {
              path: "SlyBrowser/sly_private_module.dll",
              sha256: createHash("sha256").update("private-module").digest("hex"),
              size: Buffer.byteLength("private-module"),
              abi: "windows-x64",
            },
          ],
          resources: [
            {
              path: "SlyBrowser/resources.pak",
              sha256: createHash("sha256").update("resources").digest("hex"),
              size: Buffer.byteLength("resources"),
            },
          ],
          codeSignature: {
            scheme: "authenticode",
            subject: "CN=SlyBrowser Test Publisher",
            certificateSha256: "3".repeat(64),
            timestampRequired: true,
          },
        },
        leaseGeneration: grant.expiresAt,
      });

      context.now.value += 10;
      const heartbeat = await context.service.heartbeat(grant.sessionId, grant.sessionToken);
      expect(leaseClaims(heartbeat.lease)).toMatchObject({
        schemaVersion: 2,
        paidThrough,
        licenseStatus: "active",
        browserVersion: "150.0.8000.1",
        artifactSha256: context.artifact.sha256,
        browserSha256: context.browserSha256,
        driverSha256: context.driverSha256,
        artifact: {
          sha256: context.artifact.sha256,
          platform: "windows",
          arch: "x64",
        },
        leaseGeneration: heartbeat.expiresAt,
      });
      expect(heartbeat.expiresAt).toBeGreaterThan(grant.expiresAt);
      const heartbeatGeneration = Number(leaseClaims(heartbeat.lease).leaseGeneration);
      context.now.value -= 5;
      const rollbackHeartbeat = await context.service.heartbeat(grant.sessionId, grant.sessionToken);
      expect(rollbackHeartbeat.expiresAt).toBe(heartbeat.expiresAt);
      expect(Number(leaseClaims(rollbackHeartbeat.lease).leaseGeneration)).toBeGreaterThan(heartbeatGeneration);
    } finally {
      context.store.close();
    }
  });

  it("stores license and runtime secrets only as HMAC-derived material", async () => {
    const root = join(tmpdir(), `sly-license-secret-store-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    const databasePath = join(root, "license.sqlite");
    const context = fixture(2_000_000_000, Buffer.from("zip"), databasePath);
    try {
      const authorization = await issue(context.service, "free");
      const reservation = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_secretstore0001x",
        automationBackend: "project-webdriver",
      });
      const activation = await context.service.activateRuntimeSession(reservation.sessionId, reservation.activationTicket);
      await context.service.closeRuntimeSession(reservation.sessionId, activation.runtimeToken);
      context.store.close();

      const databaseBytes = Buffer.concat(await Promise.all(
        [databasePath, `${databasePath}-wal`].map(async (path) => readFile(path).catch(() => Buffer.alloc(0))),
      ));
      const databaseText = databaseBytes.toString("utf8");
      const licenseSecret = authorization.licenseKey.split(".")[1]!;
      for (const secret of [
        authorization.licenseKey,
        licenseSecret,
        reservation.bootstrapToken,
        reservation.activationTicket,
        reservation.driverActivationTicket!,
        reservation.downloadTicket.token,
        activation.runtimeToken,
        JSON.stringify(reservation.lease),
        JSON.stringify(activation.lease),
      ]) {
        expect(databaseText).not.toContain(secret);
      }

      const database = new DatabaseSync(databasePath);
      try {
        const row = database.prepare(`
          SELECT token_hash, runtime_token_hash, activation_token_hash, download_token_hash
          FROM license_sessions WHERE session_id=?
        `).get(reservation.sessionId) as {
          token_hash: Uint8Array;
          runtime_token_hash: Uint8Array | null;
          activation_token_hash: Uint8Array | null;
          download_token_hash: Uint8Array | null;
        };
        expect(row.token_hash).toBeInstanceOf(Uint8Array);
        expect(row.runtime_token_hash).toBeInstanceOf(Uint8Array);
        expect(row.activation_token_hash).toBeNull();
        expect(row.download_token_hash).toBeInstanceOf(Uint8Array);
      } finally {
        database.close();
      }
    } finally {
      try {
        context.store.close();
      } catch {
        // The store is intentionally closed before inspecting the SQLite file.
      }
    }
  });

  it("binds session and download credentials to the selected artifact and expiry", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "free");
      const session = await context.service.createSession(authorization.licenseKey, request());
      const artifact = session.manifest.artifacts[0]!;
      const wrongArtifact = {
        ...artifact,
        sha256: "f".repeat(64),
        url: "https://api.slybrowser.test/v1/releases/artifacts/wrong.zip",
      };
      await expect(context.service.authorizeArtifact(session.sessionToken, wrongArtifact)).rejects.toMatchObject({
        code: "artifact_denied",
        status: 403,
      });
      await expect(context.service.authorizeArtifact(session.sessionToken, artifact)).resolves.toBeUndefined();
      context.now.value = session.expiresAt + 1;
      await expect(context.service.authorizeArtifact(session.sessionToken, artifact)).rejects.toMatchObject({
        code: "session_expired",
        status: 401,
      });
    } finally {
      context.store.close();
    }

    const runtimeContext = fixture();
    try {
      const authorization = await issue(runtimeContext.service, "free");
      const reservation = await runtimeContext.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_ticketbinding001",
        automationBackend: "project-webdriver",
      });
      const artifact = reservation.manifest.artifacts[0]!;
      const wrongArtifact = {
        ...artifact,
        sha256: "e".repeat(64),
        url: "https://api.slybrowser.test/v2/runtime/artifacts/wrong.zip",
      };
      await expect(runtimeContext.service.authorizeDownloadTicket(reservation.downloadTicket.token, wrongArtifact))
        .rejects.toMatchObject({
          code: "artifact_denied",
          status: 403,
        });
      await expect(runtimeContext.service.authorizeDownloadTicket(reservation.downloadTicket.token, artifact))
        .resolves.toBeUndefined();
      runtimeContext.now.value = reservation.expiresAt + 1;
      await expect(runtimeContext.service.authorizeDownloadTicket(reservation.downloadTicket.token, artifact))
        .rejects.toMatchObject({
          code: "download_ticket_expired",
          status: 401,
        });
    } finally {
      runtimeContext.store.close();
    }
  });
});

describe("HTTP authorization and artifact delivery", () => {
  it("sets bounded HTTP server timeouts by default and accepts explicit overrides", () => {
    const context = fixture();
    const defaultServer = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: "",
    });
    try {
      expect(defaultServer.headersTimeout).toBe(15_000);
      expect(defaultServer.requestTimeout).toBe(30_000);
      expect(defaultServer.keepAliveTimeout).toBe(5_000);
    } finally {
      defaultServer.close();
      context.store.close();
    }

    const customContext = fixture();
    const customServer = createLicenseHttpServer({
      service: customContext.service,
      catalog: customContext.catalog,
      artifactRoot: "",
      serverTimeouts: {
        headersTimeoutMs: 7_000,
        requestTimeoutMs: 21_000,
        keepAliveTimeoutMs: 3_000,
      },
    });
    try {
      expect(customServer.headersTimeout).toBe(7_000);
      expect(customServer.requestTimeout).toBe(21_000);
      expect(customServer.keepAliveTimeout).toBe(3_000);
    } finally {
      customServer.close();
      customContext.store.close();
    }
  });

  it("serves redacted license info with no-store headers", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-license-info-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    const authorization = await issue(context.service, "studio");
    const server = createLicenseHttpServer({ service: context.service, catalog: context.catalog, artifactRoot: root });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/v2/licenses/info`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...request(), kernelMajor: 150, updateKernel: false }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("vary")).toBe("Authorization");
      const body = await response.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        schemaVersion: 1,
        plan: "studio",
        effectivePlan: "studio",
        activeSessions: 0,
        concurrencyLimit: PLAN_CATALOG.studio.concurrency,
        browserVersion: "150.0.8000.1",
        stableErrorCode: null,
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("sly_live_");
      expect(serialized).not.toContain("sessionToken");
      expect(serialized).not.toContain("bootstrapToken");
      expect(await context.store.activeCount(authorization.licenseId, context.now.value)).toBe(0);
    } finally {
      await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
      context.store.close();
    }
  });

  it("requires the session token and stops download after release", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-license-service-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "free");
    const server = createLicenseHttpServer({ service: context.service, catalog: context.catalog, artifactRoot: root });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${origin}/v1/licenses/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(request()),
      });
      expect(created.status).toBe(201);
      const grant = await created.json() as { sessionId: string; sessionToken: string };
      const path = `/v1/releases/artifacts/${context.artifact.name}`;
      expect((await fetch(`${origin}${path}`)).status).toBe(401);
      const downloaded = await fetch(`${origin}${path}`, {
        headers: { authorization: `Session ${grant.sessionToken}` },
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("cache-control")).toBe("no-store");
      expect(downloaded.headers.get("vary")).toBe("Authorization");
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(context.artifact.bytes);
      const authorizedHead = await fetch(`${origin}${path}`, {
        method: "HEAD",
        headers: { authorization: `Session ${grant.sessionToken}` },
      });
      expect(authorizedHead.status).toBe(200);
      expect(authorizedHead.headers.get("cache-control")).toBe("no-store");
      expect(authorizedHead.headers.get("vary")).toBe("Authorization");
      expect(authorizedHead.headers.get("content-length")).toBe(String(context.artifact.bytes.length));
      expect((await fetch(`${origin}/v1/licenses/sessions/${grant.sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Session ${grant.sessionToken}` },
      })).status).toBe(204);
      expect((await fetch(`${origin}${path}`, {
        headers: { authorization: `Session ${grant.sessionToken}` },
      })).status).toBe(401);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("serves the v2 runtime lifecycle and download ticket routes", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-runtime-v2-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "free");
    const server = createLicenseHttpServer({ service: context.service, catalog: context.catalog, artifactRoot: root });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      ...request(),
      startupId: "st_httpaaaaaaaaaaaa",
      automationBackend: "project-webdriver",
    };
    try {
      const created = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const grant = await created.json() as {
        sessionId: string;
        bootstrapToken: string;
        activationTicket: string;
        downloadTicket: { token: string };
      };
      expect(grant.activationTicket).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(grant.activationTicket).not.toBe(grant.bootstrapToken);

      const retry = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(retry.status).toBe(201);
      expect((await retry.json() as { sessionId: string }).sessionId).toBe(grant.sessionId);

      const denied = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, startupId: "st_httpbbbbbbbbbbbb" }),
      });
      expect(denied.status).toBe(409);
      const deniedBody = await denied.json();
      expect(deniedBody).toMatchObject({
        error: {
          code: "session_limit",
          state: "denied",
          concurrencyLimit: 1,
          activeSessions: 1,
          availableSessions: 0,
          actions: expect.arrayContaining([
            expect.objectContaining({ type: "close_session", api: "DELETE /v2/runtime/sessions/{sessionId}" }),
            expect.objectContaining({ type: "upgrade_plan", url: "https://slybrowser.com/#pricing" }),
          ]),
        },
      });

      const path = `/v2/runtime/artifacts/${context.artifact.name}`;
      const downloaded = await fetch(`${origin}${path}`, {
        headers: { authorization: `Download ${grant.downloadTicket.token}` },
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("cache-control")).toBe("no-store");
      expect(downloaded.headers.get("vary")).toBe("Authorization");
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(context.artifact.bytes);
      const authorizedHead = await fetch(`${origin}${path}`, {
        method: "HEAD",
        headers: { authorization: `Download ${grant.downloadTicket.token}` },
      });
      expect(authorizedHead.status).toBe(200);
      expect(authorizedHead.headers.get("cache-control")).toBe("no-store");
      expect(authorizedHead.headers.get("vary")).toBe("Authorization");
      expect(authorizedHead.headers.get("content-length")).toBe(String(context.artifact.bytes.length));

      const bootstrapHeartbeat = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/bootstrap-heartbeat`, {
        method: "POST",
        headers: { authorization: `Bootstrap ${grant.bootstrapToken}` },
      });
      expect(bootstrapHeartbeat.status).toBe(200);
      expect(await bootstrapHeartbeat.json()).toMatchObject({ schemaVersion: 2, state: "reserved" });

      const bootstrapActivation = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/activate`, {
        method: "POST",
        headers: { authorization: `Bootstrap ${grant.bootstrapToken}` },
      });
      expect(bootstrapActivation.status).toBe(401);
      expect(await bootstrapActivation.json()).toMatchObject({ error: { code: "session_invalid" } });

      const activated = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/activate`, {
        method: "POST",
        headers: { authorization: `Activation ${grant.activationTicket}` },
      });
      expect(activated.status).toBe(200);
      const active = await activated.json() as { runtimeToken: string };

      const heartbeat = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/heartbeat`, {
        method: "POST",
        headers: { authorization: `Runtime ${active.runtimeToken}` },
      });
      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toMatchObject({ schemaVersion: 2, state: "active" });

      const closing = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/close`, {
        method: "POST",
        headers: { authorization: `Runtime ${active.runtimeToken}` },
      });
      expect(closing.status).toBe(200);
      expect(await closing.json()).toMatchObject({ schemaVersion: 2, state: "closing" });

      expect((await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Runtime ${active.runtimeToken}` },
      })).status).toBe(204);
      expect((await fetch(`${origin}${path}`, {
        headers: { authorization: `Download ${grant.downloadTicket.token}` },
      })).status).toBe(401);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("rate-limits license keys, download tickets, and admin credentials without echoing secrets", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-runtime-rate-limit-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "free");
    const server = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: root,
      adminToken: "admin-test-secret",
      rateLimitNow: () => 2_000_000_000,
      rateLimits: {
        "license-key": { limit: 1, windowSeconds: 60 },
        "download-ticket": { limit: 1, windowSeconds: 60 },
        admin: { limit: 1, windowSeconds: 60 },
        "runtime-token": false,
        "session-token": false,
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      ...request(),
      startupId: "st_httpratelimitaaa",
      automationBackend: "project-webdriver",
    };
    try {
      const created = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const grant = await created.json() as { downloadTicket: { token: string } };

      const licenseLimited = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(licenseLimited.status).toBe(429);
      const licenseLimitedBody = await licenseLimited.json();
      expect(licenseLimitedBody).toMatchObject({ error: { code: "request_rate_limited" } });
      expect(JSON.stringify(licenseLimitedBody)).not.toContain(authorization.licenseKey);

      const path = `/v2/runtime/artifacts/${context.artifact.name}`;
      expect((await fetch(`${origin}${path}`, {
        headers: { authorization: `Download ${grant.downloadTicket.token}` },
      })).status).toBe(200);
      const downloadLimited = await fetch(`${origin}${path}`, {
        headers: { authorization: `Download ${grant.downloadTicket.token}` },
      });
      expect(downloadLimited.status).toBe(429);
      const downloadLimitedBody = await downloadLimited.json();
      expect(downloadLimitedBody).toMatchObject({ error: { code: "request_rate_limited" } });
      expect(JSON.stringify(downloadLimitedBody)).not.toContain(grant.downloadTicket.token);

      const badAdminHeaders = { authorization: "Bearer bad-admin-secret", "content-type": "application/json" };
      expect((await fetch(`${origin}/v1/admin/licenses`, {
        method: "POST",
        headers: badAdminHeaders,
        body: "{}",
      })).status).toBe(401);
      const adminLimited = await fetch(`${origin}/v1/admin/licenses`, {
        method: "POST",
        headers: badAdminHeaders,
        body: "{}",
      });
      expect(adminLimited.status).toBe(429);
      const adminLimitedBody = await adminLimited.json();
      expect(adminLimitedBody).toMatchObject({ error: { code: "request_rate_limited" } });
      expect(JSON.stringify(adminLimitedBody)).not.toContain("bad-admin-secret");
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("sizes the default runtime-token bucket for a Grid three-times heartbeat burst", () => {
    const limiter = new InMemoryRateLimiter(undefined, () => 2_000_000_000);
    const request = { socket: { remoteAddress: "203.0.113.10" } };
    for (let index = 0; index < 6_000; index += 1) {
      expect(() => limiter.check("runtime-token", request as never, `runtime-token-${index}`)).not.toThrow();
    }
    expect(() => limiter.check("runtime-token", request as never, "runtime-token-over")).toThrowError(ServiceError);
  });

  it("rate-limits rotating bad download tickets by IP without echoing guesses", async () => {
    const context = fixture();
    const server = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: tmpdir(),
      rateLimitNow: () => 2_000_000_000,
      rateLimits: {
        "download-ticket": { limit: 1, windowSeconds: 60 },
        "license-key": false,
        "runtime-token": false,
        "session-token": false,
        admin: false,
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const path = `/v2/runtime/artifacts/${context.artifact.name}`;
    const firstGuess = "download_guess_one";
    const secondGuess = "download_guess_two";
    try {
      const first = await fetch(`${origin}${path}`, {
        headers: { authorization: `Download ${firstGuess}` },
      });
      expect(first.status).toBe(401);

      const second = await fetch(`${origin}${path}`, {
        headers: { authorization: `Download ${secondGuess}` },
      });
      expect(second.status).toBe(429);
      const limitedBody = await second.json();
      expect(limitedBody).toMatchObject({ error: { code: "request_rate_limited" } });
      expect(JSON.stringify(limitedBody)).not.toContain(firstGuess);
      expect(JSON.stringify(limitedBody)).not.toContain(secondGuess);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("applies local failure backoff to repeated authorization denials without echoing credentials", async () => {
    const context = fixture();
    const clock = { value: 2_000_000_000 };
    const firstGuess = "sly_live_00000000-0000-4000-8000-000000000000.firstguessfirstguessfirstguessfirstguess";
    const secondGuess = "sly_live_00000000-0000-4000-8000-000000000000.secondguesssecondguesssecondguess";
    const server = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: tmpdir(),
      rateLimits: false,
      rateLimitNow: () => clock.value,
      failureBackoff: {
        threshold: 1,
        windowSeconds: 60,
        baseDelaySeconds: 7,
        maxDelaySeconds: 30,
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const first = await fetch(`${origin}/v2/licenses/info`, {
        method: "POST",
        headers: { authorization: `License ${firstGuess}`, "content-type": "application/json" },
        body: JSON.stringify(request()),
      });
      expect(first.status).toBe(401);
      expect(await first.json()).toMatchObject({ error: { code: "license_key_invalid" } });

      const second = await fetch(`${origin}/v2/licenses/info`, {
        method: "POST",
        headers: { authorization: `License ${secondGuess}`, "content-type": "application/json" },
        body: JSON.stringify(request()),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("7");
      const body = await second.json();
      expect(body).toMatchObject({
        error: {
          code: "request_rate_limited",
          retryAfterSeconds: 7,
          backoff: true,
        },
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(firstGuess);
      expect(serialized).not.toContain(secondGuess);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("enforces RBAC credentials on license admin routes while keeping legacy token fallback separate", async () => {
    const context = fixture();
    const adminAuth = new StaticLicenseAdminAuthenticator([
      {
        token: "issue-token-abcdefghijklmnopqrstuvwxyz",
        actor: "license-issuer@example.test",
        permissions: ["licenses:issue"],
      },
      {
        token: "update-token-abcdefghijklmnopqrstuvwxyz",
        actor: "license-updater@example.test",
        permissions: ["licenses:update"],
      },
    ]);
    const server = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: tmpdir(),
      adminAuth,
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const updateOnlyIssue = await fetch(`${origin}/v1/admin/licenses`, {
        method: "POST",
        headers: { authorization: "Bearer update-token-abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" },
        body: JSON.stringify({ accountId: "rbac-account", plan: "free", serviceUrl: "https://api.slybrowser.test" }),
      });
      expect(updateOnlyIssue.status).toBe(403);
      expect(await updateOnlyIssue.json()).toMatchObject({ error: { code: "admin_authorization_forbidden" } });

      const issued = await fetch(`${origin}/v1/admin/licenses`, {
        method: "POST",
        headers: { authorization: "Bearer issue-token-abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" },
        body: JSON.stringify({ accountId: "rbac-account", plan: "free", serviceUrl: "https://api.slybrowser.test" }),
      });
      expect(issued.status).toBe(201);
      const issuedBody = await issued.json() as { licenseId: string; licenseKey: string };

      const issueOnlyUpdate = await fetch(`${origin}/v1/admin/licenses/${issuedBody.licenseId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer issue-token-abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" },
        body: JSON.stringify({ status: "hold" }),
      });
      expect(issueOnlyUpdate.status).toBe(403);
      expect(await issueOnlyUpdate.json()).toMatchObject({ error: { code: "admin_authorization_forbidden" } });

      const updated = await fetch(`${origin}/v1/admin/licenses/${issuedBody.licenseId}`, {
        method: "PATCH",
        headers: { authorization: "Bearer update-token-abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" },
        body: JSON.stringify({ status: "hold" }),
      });
      expect(updated.status).toBe(204);

      await expect(context.service.createSession(issuedBody.licenseKey, request())).rejects.toMatchObject({
        code: "license_on_hold",
      });
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("revokes active runtime sessions by feature without touching basic WebDriver sessions", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "launch");
      const playwright = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_revokefeature001",
        automationBackend: "playwright",
      });
      const webdriver = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_revokefeature002",
        automationBackend: "project-webdriver",
      });
      const playwrightActive = await context.service.activateRuntimeSession(playwright.sessionId, playwright.activationTicket);
      const webdriverActive = await context.service.activateRuntimeSession(webdriver.sessionId, webdriver.activationTicket);

      const featureRevocation = await context.service.revokeRuntimeSessions({
        target: { scope: "feature", feature: "playwright" },
      });
      expect(featureRevocation).toMatchObject({
        schemaVersion: 1,
        target: { scope: "feature", feature: "playwright" },
        revokedSessions: 1,
      });
      await expect(context.service.runtimeHeartbeat(playwright.sessionId, playwrightActive.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
      });
      await expect(context.service.runtimeHeartbeat(webdriver.sessionId, webdriverActive.runtimeToken)).resolves.toMatchObject({
        state: "active",
      });
      expect(context.store.activeCount(authorization.licenseId, context.now.value)).toBe(1);

      const channelRevocation = await context.service.revokeRuntimeSessions({
        target: { scope: "channel", channel: "stable" },
      });
      expect(channelRevocation.revokedSessions).toBe(1);
      await expect(context.service.runtimeHeartbeat(webdriver.sessionId, webdriverActive.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
      });
      expect(context.store.activeCount(authorization.licenseId, context.now.value)).toBe(0);

      const artifactSession = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_revokeartifact01",
        automationBackend: "project-webdriver",
      });
      const artifactActive = await context.service.activateRuntimeSession(artifactSession.sessionId, artifactSession.activationTicket);
      const artifactRevocation = await context.service.revokeRuntimeSessions({
        target: { scope: "artifact", artifactSha256: context.artifact.sha256 },
      });
      expect(artifactRevocation.revokedSessions).toBe(1);
      await expect(context.service.runtimeHeartbeat(artifactSession.sessionId, artifactActive.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
      });

      const releaseSession = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_revokerelease001",
        automationBackend: "project-webdriver",
      });
      const releaseActive = await context.service.activateRuntimeSession(releaseSession.sessionId, releaseSession.activationTicket);
      const releaseRevocation = await context.service.revokeRuntimeSessions({
        target: { scope: "release", browserVersion: releaseSession.browserVersion },
      });
      expect(releaseRevocation.revokedSessions).toBe(1);
      await expect(context.service.runtimeHeartbeat(releaseSession.sessionId, releaseActive.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
      });
    } finally {
      context.store.close();
    }
  });

  it("exposes session revocation through a dedicated RBAC-protected admin route", async () => {
    const context = fixture();
    const authorization = await issue(context.service, "launch");
    const grant = await context.service.createRuntimeSession(authorization.licenseKey, {
      ...request(),
      startupId: "st_revokeroute00001",
      automationBackend: "project-webdriver",
    });
    const active = await context.service.activateRuntimeSession(grant.sessionId, grant.activationTicket);
    const adminAuth = new StaticLicenseAdminAuthenticator([
      {
        token: "update-token-abcdefghijklmnopqrstuvwxyz",
        actor: "license-updater@example.test",
        permissions: ["licenses:update"],
      },
      {
        token: "revoke-token-abcdefghijklmnopqrstuvwxyz",
        actor: "license-revoker@example.test",
        permissions: ["revocations:create"],
      },
    ]);
    const server = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: tmpdir(),
      adminAuth,
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/runtime-revocations`, {
        method: "POST",
        headers: { authorization: "Bearer update-token-abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" },
        body: JSON.stringify({ target: { scope: "session", sessionId: grant.sessionId } }),
      });
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toMatchObject({ error: { code: "admin_authorization_forbidden" } });

      const revoked = await fetch(`${origin}/v1/admin/runtime-revocations`, {
        method: "POST",
        headers: { authorization: "Bearer revoke-token-abcdefghijklmnopqrstuvwxyz", "content-type": "application/json" },
        body: JSON.stringify({ target: { scope: "session", sessionId: grant.sessionId } }),
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({
        schemaVersion: 1,
        target: { scope: "session", sessionId: grant.sessionId },
        revokedSessions: 1,
      });
      await expect(context.service.runtimeHeartbeat(grant.sessionId, active.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
      });
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("shares Redis-backed license rate limits across service instances and fails closed", async () => {
    class FakeRedis {
      readonly counts = new Map<string, number>();
      readonly expirations = new Map<string, number>();
      fail = false;

      async incr(key: string): Promise<number> {
        if (this.fail) throw new Error("redis unavailable");
        const next = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, next);
        return next;
      }

      async expire(key: string, seconds: number): Promise<void> {
        if (this.fail) throw new Error("redis unavailable");
        this.expirations.set(key, seconds);
      }
    }

    const context = fixture();
    const redis = new FakeRedis();
    const clock = { value: 2_000_000_000 };
    const badLicense = `sly_live_00000000-0000-0000-0000-000000000000.${"b".repeat(43)}`;
    const serverA = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: tmpdir(),
      rateLimiter: new RedisFixedWindowRateLimiter({ "license-key": { limit: 1, windowSeconds: 60 } }, redis, {
        now: () => clock.value,
        prefix: "slybrowser:test-rate-limit",
      }),
    });
    const serverB = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: tmpdir(),
      rateLimiter: new RedisFixedWindowRateLimiter({ "license-key": { limit: 1, windowSeconds: 60 } }, redis, {
        now: () => clock.value,
        prefix: "slybrowser:test-rate-limit",
      }),
    });
    await Promise.all([serverA, serverB].map((server) => new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    })));
    const addressA = serverA.address();
    const addressB = serverB.address();
    if (!addressA || typeof addressA === "string" || !addressB || typeof addressB === "string") {
      throw new Error("Test server address is invalid");
    }
    const body = JSON.stringify({ ...request(), startupId: "st_redisratelimit01", automationBackend: "project-webdriver" });
    try {
      const first = await fetch(`http://127.0.0.1:${addressA.port}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${badLicense}`, "content-type": "application/json" },
        body,
      });
      expect(first.status).toBe(401);
      const second = await fetch(`http://127.0.0.1:${addressB.port}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${badLicense}`, "content-type": "application/json" },
        body,
      });
      expect(second.status).toBe(429);
      const secondBody = await second.json() as { error: { code: string; retryAfterSeconds: number } };
      expect(secondBody.error.code).toBe("request_rate_limited");
      expect(secondBody.error.retryAfterSeconds).toBeGreaterThan(0);
      expect(secondBody.error.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect([...redis.expirations.values()]).toContain(65);

      clock.value += 61;
      redis.fail = true;
      const backendDown = await fetch(`http://127.0.0.1:${addressA.port}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${badLicense}`, "content-type": "application/json" },
        body,
      });
      expect(backendDown.status).toBe(429);
      expect(await backendDown.json()).toMatchObject({ error: { code: "request_rate_limited", retryAfterSeconds: 60 } });
    } finally {
      await Promise.all([serverA, serverB].map((server) => new Promise<void>((accept) => server.close(() => accept()))));
      context.store.close();
    }
  });

  it("retains redacted security events for authorization denial, replay, hash errors, and recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), `sly-security-events-${process.pid}-`));
    temporaryDirectories.push(root);
    const databasePath = join(root, "license.sqlite");
    const context = fixture(2_000_000_000, Buffer.from("zip"), databasePath);
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "free");
    const badLicense = `sly_live_00000000-0000-0000-0000-000000000000.${"a".repeat(43)}`;
    const badDownloadToken = "bad-download-token";
    const server = createLicenseHttpServer({ service: context.service, catalog: context.catalog, artifactRoot: root });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const denied = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${badLicense}`, "content-type": "application/json", "user-agent": "SlySecurityTest/1.0" },
        body: JSON.stringify({ ...request(), startupId: "st_securitydenied01", automationBackend: "project-webdriver" }),
      });
      expect(denied.status).toBe(401);

      const replay = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: {
          authorization: `License ${authorization.licenseKey}`,
          "content-type": "application/json",
          "idempotency-key": "same-client-startup",
        },
        body: JSON.stringify({ ...request(), startupId: "st_conflictaaaaaaaa", automationBackend: "project-webdriver" }),
      });
      expect(replay.status).toBe(409);

      const badDownload = await fetch(`${origin}/v2/runtime/artifacts/${context.artifact.name}`, {
        headers: { authorization: `Download ${badDownloadToken}` },
      });
      expect(badDownload.status).toBe(401);

      await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_securityorphan01",
        automationBackend: "project-webdriver",
      });
      context.now.value += 121;
      await context.store.activeCount(authorization.licenseId, context.now.value);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      const rows = database.prepare(`
        SELECT kind, code, operation, http_status, created_at, expires_at,
               length(subject_hash) AS subject_hash_bytes,
               length(ip_hash) AS ip_hash_bytes,
               length(user_agent_hash) AS user_agent_hash_bytes,
               details
        FROM license_security_events
        ORDER BY kind, code
      `).all() as Array<{
        kind: string;
        code: string;
        operation: string;
        http_status: number | null;
        created_at: number;
        expires_at: number;
        subject_hash_bytes: number | null;
        ip_hash_bytes: number | null;
        user_agent_hash_bytes: number | null;
        details: string;
      }>;
      expect(rows.map((row) => [row.kind, row.code, row.operation, row.http_status])).toEqual([
        ["abnormal_session_recovery", "session_expired", "session_expire", null],
        ["authorization_denied", "license_key_invalid", "runtime_session_create", 401],
        ["request_replay", "idempotency_conflict", "runtime_session_create", 409],
        ["signature_or_hash_error", "download_ticket_expired", "runtime_artifact_download", 401],
      ]);
      expect(rows.every((row) => row.expires_at - row.created_at === 90 * 24 * 60 * 60)).toBe(true);
      expect(rows.filter((row) => row.subject_hash_bytes !== null).every((row) => row.subject_hash_bytes === 32)).toBe(true);
      expect(rows.some((row) => row.ip_hash_bytes === 32)).toBe(true);
      expect(rows.some((row) => row.user_agent_hash_bytes === 32)).toBe(true);
      expect(rows.map((row) => row.details).join("\n")).not.toContain(authorization.licenseKey);
    } finally {
      database.close();
    }

    const databaseText = (await readFile(databasePath)).toString("utf8");
    expect(databaseText).not.toContain(badLicense);
    expect(databaseText).not.toContain(badDownloadToken);
    expect(databaseText).not.toContain(authorization.licenseKey);
  });

  it("emits redacted lifecycle metrics with latency, result, and plan aggregation fields", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-runtime-metrics-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "free");
    const metrics: LicenseHttpMetricEvent[] = [];
    let tick = 0;
    const server = createLicenseHttpServer({
      service: context.service,
      catalog: context.catalog,
      artifactRoot: root,
      metrics: (event) => metrics.push(event),
      metricsNow: () => {
        tick += 7;
        return tick;
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      ...request(),
      startupId: "st_httpmetricsaaaaa",
      automationBackend: "project-webdriver",
    };
    try {
      const created = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const grant = await created.json() as { sessionId: string; bootstrapToken: string; activationTicket: string };

      const activated = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/activate`, {
        method: "POST",
        headers: { authorization: `Activation ${grant.activationTicket}` },
      });
      expect(activated.status).toBe(200);
      const active = await activated.json() as { runtimeToken: string };

      const heartbeat = await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}/heartbeat`, {
        method: "POST",
        headers: { authorization: `Runtime ${active.runtimeToken}` },
      });
      expect(heartbeat.status).toBe(200);

      expect((await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Runtime ${active.runtimeToken}` },
      })).status).toBe(204);

      expect(metrics.map((event) => ({
        operation: event.operation,
        status: event.status,
        result: event.result,
        plan: event.plan,
        latencyMs: event.latencyMs,
      }))).toEqual([
        { operation: "runtime_session_create", status: 201, result: "ok", plan: "free", latencyMs: 7 },
        { operation: "runtime_session_activate", status: 200, result: "ok", plan: "free", latencyMs: 7 },
        { operation: "runtime_session_heartbeat", status: 200, result: "ok", plan: "free", latencyMs: 7 },
        { operation: "runtime_session_release", status: 204, result: "ok", plan: undefined, latencyMs: 7 },
      ]);
      const metricText = JSON.stringify(metrics);
      expect(metricText).not.toContain(authorization.licenseKey);
      expect(metricText).not.toContain(grant.bootstrapToken);
      expect(metricText).not.toContain(grant.activationTicket);
      expect(metricText).not.toContain(active.runtimeToken);
      expect(metricText).not.toContain(grant.sessionId);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("derives v2 runtime startupId from Idempotency-Key when the HTTP body omits it", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-runtime-v2-idempotency-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "launch");
    const server = createLicenseHttpServer({ service: context.service, catalog: context.catalog, artifactRoot: root });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      ...request(),
      automationBackend: "project-webdriver",
    };
    try {
      const created = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: {
          authorization: `License ${authorization.licenseKey}`,
          "content-type": "application/json",
          "idempotency-key": "runtime-http-idempotency-1",
        },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const grant = await created.json() as { sessionId: string; startupId: string };
      expect(grant.startupId).toMatch(/^st_[A-Za-z0-9_-]{16,120}$/);

      const retry = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: {
          authorization: `License ${authorization.licenseKey}`,
          "content-type": "application/json",
          "idempotency-key": "runtime-http-idempotency-1",
        },
        body: JSON.stringify(body),
      });
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({
        sessionId: grant.sessionId,
        startupId: grant.startupId,
      });

      const conflict = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: {
          authorization: `License ${authorization.licenseKey}`,
          "content-type": "application/json",
          "idempotency-key": "runtime-http-idempotency-1",
        },
        body: JSON.stringify({ ...body, startupId: "st_explicitbbbbbbbb" }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict" } });
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("releases reserved v2 runtime sessions with bootstrap authorization", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-runtime-v2-bootstrap-release-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = await issue(context.service, "launch");
    const server = createLicenseHttpServer({ service: context.service, catalog: context.catalog, artifactRoot: root });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      ...request(),
      startupId: "st_httpreservedaaaa",
      automationBackend: "playwright",
    };
    try {
      const created = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(201);
      const grant = await created.json() as {
        sessionId: string;
        bootstrapToken: string;
        activationTicket: string;
        downloadTicket: { token: string };
      };
      expect((await fetch(`${origin}/v2/runtime/sessions/${grant.sessionId}`, {
        method: "DELETE",
        headers: { authorization: `Bootstrap ${grant.bootstrapToken}` },
      })).status).toBe(204);
      expect((await fetch(`${origin}/v2/runtime/artifacts/${context.artifact.name}`, {
        headers: { authorization: `Download ${grant.downloadTicket.token}` },
      })).status).toBe(401);

      const replacement = await fetch(`${origin}/v2/runtime/sessions`, {
        method: "POST",
        headers: { authorization: `License ${authorization.licenseKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, startupId: "st_httpreservedbbbb" }),
      });
      expect(replacement.status).toBe(201);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      context.store.close();
    }
  });

  it("rejects invalid license keys without revealing license existence", async () => {
    const context = fixture();
    try {
      await issue(context.service, "free");
      await expect(context.service.createSession(
        `sly_live_00000000-0000-0000-0000-000000000000.${"x".repeat(43)}`,
        request(),
      )).rejects.toMatchObject({ code: "license_key_invalid", status: 401 });
    } finally {
      context.store.close();
    }
  });
});

describe("explicit browser version selection", () => {
  it("distinguishes latest, exact pinning, and explicit rollback", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "launch");
      const latest = await context.service.createSession(authorization.licenseKey, request());
      expect(latest).toMatchObject({
        browserVersion: "150.0.8000.1",
        versionPolicy: "latest",
        selectionReason: "latest",
      });
      await context.service.release(latest.sessionId, latest.sessionToken);

      const exact = await context.service.createSession(authorization.licenseKey, {
        ...request(),
        versionPolicy: "exact",
        browserVersion: "150.0.8000.1",
      });
      expect(exact).toMatchObject({
        browserVersion: "150.0.8000.1",
        requestedBrowserVersion: "150.0.8000.1",
        versionPolicy: "exact",
        selectionReason: "exact",
        selectionMode: "cached-approved",
      });
      await context.service.release(exact.sessionId, exact.sessionToken);

      const rollback = await context.service.createSession(authorization.licenseKey, {
        ...request(),
        versionPolicy: "at-or-before",
        browserVersion: "151.0.0.0",
      });
      expect(rollback).toMatchObject({
        browserVersion: "150.0.8000.1",
        requestedBrowserVersion: "151.0.0.0",
        versionPolicy: "at-or-before",
        selectionReason: "rollback",
      });
      await context.service.release(rollback.sessionId, rollback.sessionToken);

      await expect(context.service.createSession(authorization.licenseKey, {
        ...request(),
        versionPolicy: "exact",
        browserVersion: "149.0.0.0",
      })).rejects.toMatchObject({ code: "release_version_unavailable", status: 404 });

      await expect(context.service.createSession(authorization.licenseKey, {
        ...request(),
        platform: "linux",
      })).rejects.toMatchObject({
        code: "release_version_unavailable",
        status: 404,
        message: expect.stringContaining("linux/x64"),
      });
    } finally {
      context.store.close();
    }
  });

  it("honors kernel major selection without silently crossing browser generations", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "launch");
      const selected = await context.service.createSession(authorization.licenseKey, {
        ...request(),
        kernelMajor: 150,
      });
      expect(selected).toMatchObject({
        browserVersion: "150.0.8000.1",
        requestedKernelMajor: 150,
        versionPolicy: "latest",
        selectionReason: "latest",
        selectionMode: "latest-in-major",
        availableBrowserVersions: ["150.0.8000.1"],
        latestAvailableVersion: "150.0.8000.1",
        updateAvailable: false,
        updateRequired: false,
      });
      await context.service.release(selected.sessionId, selected.sessionToken);

      await expect(context.service.createSession(authorization.licenseKey, {
        ...request(),
        kernelMajor: 149,
      })).rejects.toMatchObject({ code: "release_version_unavailable", status: 404 });

      await expect(context.service.createSession(authorization.licenseKey, {
        ...request(),
        kernelMajor: 149,
        versionPolicy: "exact",
        browserVersion: "150.0.8000.1",
      })).rejects.toMatchObject({ code: "version_policy_invalid", status: 400 });

      const runtime = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_kernelmajorv2aaa",
        automationBackend: "project-webdriver",
        kernelMajor: 150,
        updateKernel: true,
      });
      expect(runtime).toMatchObject({
        schemaVersion: 2,
        browserVersion: "150.0.8000.1",
        requestedKernelMajor: 150,
        versionPolicy: "latest",
        selectionReason: "latest",
        selectionMode: "latest-in-major",
        latestAvailableVersion: "150.0.8000.1",
        updateAvailable: false,
        updateRequired: false,
      });
      await context.service.releaseRuntimeSession(runtime.sessionId, runtime.bootstrapToken);
    } finally {
      context.store.close();
    }
  });
});

describe("v2 runtime session protocol", () => {
  it("uses a test-issued v2 license file, idempotent startup reservation and one-time activation", async () => {
    const context = fixture();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    try {
      const issued = await issue(context.service, "free");
      const document = createTestLicenseFile({
        licenseId: issued.licenseId,
        licenseKey: issued.licenseKey,
        serviceUrl: "https://api.slybrowser.test",
        issuedAt: "2033-05-18T03:33:20.000Z",
        fileId: "lf_test_runtime1",
        passphrase: "test-passphrase-only",
        signingKeyId: "license-file-test-v1",
        signingPrivateKey: privateKey,
        salt: deterministicBytes("runtime-license-file-salt", 16),
        nonce: deterministicBytes("runtime-license-file-nonce", 12),
        payloadNonce: "runtime-payload-nonce",
      });
      const secret = decryptLicenseFileV2(document, {
        passphrase: "test-passphrase-only",
        trustedPublicKeys: { "license-file-test-v1": publicKey.export({ format: "pem", type: "spki" }) as string },
        trustedServiceUrls: ["https://api.slybrowser.test"],
      });
      const runtimeRequest = {
        ...request(),
        startupId: "st_aaaaaaaaaaaaaaaa",
        automationBackend: "project-webdriver",
      };
      const first = await context.service.createRuntimeSession(secret.licenseKey, runtimeRequest);
      expect(first).toMatchObject({
        schemaVersion: 2,
        state: "reserved",
        startupId: "st_aaaaaaaaaaaaaaaa",
        plan: "free",
        features: PLAN_CATALOG.free.features,
        concurrencyLimit: 1,
        activeSessions: 1,
        browserVersion: "150.0.8000.1",
        downloadTicket: {
          artifactSha256: context.artifact.sha256,
          artifactUrl: `https://api.slybrowser.test/v1/releases/artifacts/${context.artifact.name}`,
        },
      });
      expect(leaseClaims(first.lease)).toMatchObject({
        schemaVersion: 2,
        planId: "free",
        concurrencyLimit: 1,
        browserVersion: "150.0.8000.1",
        artifact: {
          sha256: context.artifact.sha256,
          platform: "windows",
          arch: "x64",
        },
        features: PLAN_CATALOG.free.features,
      });
      expect(leaseClaims(first.lease).features).not.toContain("playwright");
      expect(first.bootstrapToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.activationTicket).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.activationTicket).not.toBe(first.bootstrapToken);
      expect(first.driverActivationTicket).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.driverActivationTicket).not.toBe(first.activationTicket);
      expect(first.downloadTicket.token).toMatch(/^[A-Za-z0-9_-]+$/);

      const retry = await context.service.createRuntimeSession(secret.licenseKey, runtimeRequest);
      expect(retry.sessionId).toBe(first.sessionId);
      expect(retry.bootstrapToken).toBe(first.bootstrapToken);
      expect(retry.activationTicket).toBe(first.activationTicket);
      expect(retry.driverActivationTicket).toBe(first.driverActivationTicket);
      expect(retry.activeSessions).toBe(1);

      context.now.value += 30;
      await expect(context.service.bootstrapHeartbeat(first.sessionId, first.bootstrapToken)).resolves.toMatchObject({
        schemaVersion: 2,
        state: "reserved",
        sessionId: first.sessionId,
        expiresAt: first.expiresAt + 30,
      });
      const retryAfterHeartbeat = await context.service.createRuntimeSession(secret.licenseKey, runtimeRequest);
      expect(retryAfterHeartbeat.sessionId).toBe(first.sessionId);
      expect(retryAfterHeartbeat.bootstrapToken).toBe(first.bootstrapToken);
      expect(retryAfterHeartbeat.activationTicket).toBe(first.activationTicket);
      expect(retryAfterHeartbeat.driverActivationTicket).toBe(first.driverActivationTicket);
      expect(retryAfterHeartbeat.downloadTicket.token).toBe(first.downloadTicket.token);

      await expect(context.service.createRuntimeSession(secret.licenseKey, {
        ...runtimeRequest,
        deviceHash: "device_changed_for_replay",
      })).rejects.toMatchObject({
        code: "session_invalid",
        status: 401,
        details: {
          state: "denied",
          reason: "startup_binding_mismatch",
        },
      });

      await expect(context.service.createRuntimeSession(secret.licenseKey, {
        ...runtimeRequest,
        startupId: "st_bbbbbbbbbbbbbbbb",
      })).rejects.toMatchObject({
        code: "session_limit",
        status: 409,
        details: {
          state: "denied",
          concurrencyLimit: 1,
          activeSessions: 1,
          availableSessions: 0,
          actions: expect.arrayContaining([
            expect.objectContaining({ type: "close_session" }),
            expect.objectContaining({ type: "upgrade_plan" }),
          ]),
        },
      });

      await expect(context.service.bootstrapHeartbeat(first.sessionId, first.bootstrapToken)).resolves.toMatchObject({
        schemaVersion: 2,
        state: "reserved",
        sessionId: first.sessionId,
      });
      await expect(context.service.activateRuntimeSession(first.sessionId, first.bootstrapToken)).rejects.toMatchObject(
        { code: "session_invalid", status: 401 },
      );
      const active = await context.service.activateRuntimeSession(first.sessionId, first.activationTicket);
      expect(active).toMatchObject({
        schemaVersion: 2,
        state: "active",
        sessionId: first.sessionId,
        features: PLAN_CATALOG.free.features,
        activeSessions: 1,
      });
      expect(leaseClaims(active.lease)).toMatchObject({
        schemaVersion: 2,
        planId: "free",
        concurrencyLimit: 1,
        browserVersion: "150.0.8000.1",
        features: PLAN_CATALOG.free.features,
      });
      expect(active.runtimeToken).toMatch(/^[A-Za-z0-9_-]+$/);
      await expect(context.service.activateRuntimeSession(first.sessionId, first.activationTicket)).rejects.toMatchObject(
        { code: "session_invalid", status: 401 },
      );
      await expect(context.service.releaseRuntimeSession(first.sessionId, first.bootstrapToken)).rejects.toMatchObject(
        { code: "session_invalid" },
      );
      await expect(context.service.runtimeHeartbeat(first.sessionId, active.runtimeToken)).resolves.toMatchObject({
        schemaVersion: 2,
        state: "active",
        sessionId: first.sessionId,
      });
      await expect(context.service.closeRuntimeSession(first.sessionId, active.runtimeToken)).resolves.toMatchObject({
        schemaVersion: 2,
        state: "closing",
      });
      await context.service.releaseRuntimeSession(first.sessionId, active.runtimeToken);
      await expect(context.service.runtimeHeartbeat(first.sessionId, active.runtimeToken)).rejects.toMatchObject(
        { code: "session_invalid" },
      );
      const replacement = await context.service.createRuntimeSession(secret.licenseKey, {
        ...runtimeRequest,
        startupId: "st_cccccccccccccccc",
      });
      expect(replacement.activeSessions).toBe(1);
    } finally {
      context.store.close();
    }
  });

  it("counts project WebDriver as a paired child process of one browser runtime session", async () => {
    const context = fixture();
    try {
      const authorization = await issue(context.service, "free");
      const runtimeRequest = {
        ...request(),
        startupId: "st_driverchild00001",
        automationBackend: "project-webdriver",
      };
      const first = await context.service.createRuntimeSession(authorization.licenseKey, runtimeRequest);
      expect(first.activeSessions).toBe(1);
      expect(first.driverActivationTicket).toBeDefined();

      const driver = await context.service.activateRuntimeSession(first.sessionId, first.driverActivationTicket!);
      expect(driver).toMatchObject({
        schemaVersion: 2,
        state: "active",
        sessionId: first.sessionId,
        activeSessions: 1,
      });
      await expect(context.service.activateRuntimeSession(first.sessionId, first.driverActivationTicket!))
        .rejects.toMatchObject({ code: "session_invalid", status: 401 });

      const browser = await context.service.activateRuntimeSession(first.sessionId, first.activationTicket);
      expect(browser).toMatchObject({
        schemaVersion: 2,
        state: "active",
        sessionId: first.sessionId,
        activeSessions: 1,
      });
      expect(browser.runtimeToken).not.toBe(driver.runtimeToken);
      await expect(context.service.runtimeHeartbeat(first.sessionId, driver.runtimeToken))
        .resolves.toMatchObject({ state: "active", activeSessions: 1 });
      await expect(context.service.runtimeHeartbeat(first.sessionId, browser.runtimeToken))
        .resolves.toMatchObject({ state: "active", activeSessions: 1 });
      await expect(context.service.createRuntimeSession(authorization.licenseKey, {
        ...runtimeRequest,
        startupId: "st_secondbrowser001",
      })).rejects.toMatchObject({ code: "session_limit", status: 409 });

      await context.service.releaseRuntimeSession(first.sessionId, driver.runtimeToken);
      const second = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...runtimeRequest,
        startupId: "st_browserfirst0001",
      });
      const secondBrowser = await context.service.activateRuntimeSession(second.sessionId, second.activationTicket);
      const secondDriver = await context.service.activateRuntimeSession(second.sessionId, second.driverActivationTicket!);
      expect(secondBrowser.runtimeToken).not.toBe(secondDriver.runtimeToken);
      expect(secondDriver.activeSessions).toBe(1);
      await context.service.releaseRuntimeSession(second.sessionId, secondBrowser.runtimeToken);
    } finally {
      context.store.close();
    }
  });

  it("denies paid automation backends on Free and stops paid-feature sessions after downgrade", async () => {
    const context = fixture();
    let active: { sessionId: string; runtimeToken: string } | undefined;
    try {
      const free = await issue(context.service, "free");
      await expect(context.service.createRuntimeSession(free.licenseKey, {
        ...request(),
        startupId: "st_freeplaywright001",
        automationBackend: "playwright",
      })).rejects.toMatchObject({
        code: "license_feature_denied",
        status: 403,
        details: { features: ["playwright"] },
      });

      const launch = await issue(context.service, "launch", context.now.value + 86_400);
      const reservation = await context.service.createRuntimeSession(launch.licenseKey, {
        ...request(),
        startupId: "st_featuredowngrade1",
        automationBackend: "playwright",
      });
      expect(reservation.features).toEqual(expect.arrayContaining(["playwright"]));
      expect(leaseClaims(reservation.lease)).toMatchObject({
        planId: "launch",
        concurrencyLimit: PLAN_CATALOG.launch.concurrency,
        features: PLAN_CATALOG.launch.features,
      });
      const activation = await context.service.activateRuntimeSession(reservation.sessionId, reservation.activationTicket);
      active = { sessionId: reservation.sessionId, runtimeToken: activation.runtimeToken };

      await context.store.updateEntitlement(launch.licenseId, {
        plan: "free",
        now: context.now.value,
      });

      await expect(context.service.authorizeDownloadTicket(reservation.downloadTicket.token, reservation.manifest.artifacts[0]!))
        .rejects.toMatchObject({
          code: "license_feature_denied",
          status: 403,
          details: { features: ["playwright"] },
        });
      await expect(context.service.runtimeHeartbeat(reservation.sessionId, activation.runtimeToken)).rejects.toMatchObject({
        code: "license_feature_denied",
        status: 403,
        details: { features: ["playwright"], state: "denied" },
      });
      await expect(context.service.runtimeHeartbeat(reservation.sessionId, activation.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
        status: 401,
      });
      active = undefined;
    } finally {
      if (active) await context.service.releaseRuntimeSession(active.sessionId, active.runtimeToken).catch(() => undefined);
      context.store.close();
    }
  });

  it("rechecks downgraded plan rank and revoked status on runtime heartbeats", async () => {
    const context = fixture();
    const activeSessions: Array<{ sessionId: string; runtimeToken: string }> = [];
    try {
      const authorization = await issue(context.service, "launch", context.now.value + 86_400);
      const first = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_downgrade000001x",
        automationBackend: "project-webdriver",
      });
      const firstActive = await context.service.activateRuntimeSession(first.sessionId, first.activationTicket);
      activeSessions.push({ sessionId: first.sessionId, runtimeToken: firstActive.runtimeToken });
      context.now.value += 1;
      const second = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_downgrade000002x",
        automationBackend: "project-webdriver",
      });
      const secondActive = await context.service.activateRuntimeSession(second.sessionId, second.activationTicket);
      activeSessions.push({ sessionId: second.sessionId, runtimeToken: secondActive.runtimeToken });

      await context.store.updateEntitlement(authorization.licenseId, {
        plan: "free",
        now: context.now.value,
      });

      await expect(context.service.runtimeHeartbeat(first.sessionId, firstActive.runtimeToken)).resolves.toMatchObject({
        schemaVersion: 2,
        state: "active",
        plan: "free",
        concurrencyLimit: PLAN_CATALOG.free.concurrency,
      });
      await expect(context.service.runtimeHeartbeat(second.sessionId, secondActive.runtimeToken)).rejects.toMatchObject({
        code: "session_limit",
        status: 409,
        details: { state: "denied" },
      });
      await expect(context.service.runtimeHeartbeat(first.sessionId, firstActive.runtimeToken)).resolves.toMatchObject({
        activeSessions: PLAN_CATALOG.free.concurrency,
      });

      await context.store.updateEntitlement(authorization.licenseId, {
        status: "revoked",
        now: context.now.value,
      });
      await expect(context.service.runtimeHeartbeat(first.sessionId, firstActive.runtimeToken)).rejects.toMatchObject({
        code: "license_revoked",
        status: 403,
      });
      expect(() => context.store.updateEntitlement(authorization.licenseId, {
        status: "active",
        now: context.now.value,
      })).toThrowError(expect.objectContaining({
        code: "license_revoked",
        status: 409,
      }));
    } finally {
      await Promise.allSettled(activeSessions.map((session) =>
        context.service.releaseRuntimeSession(session.sessionId, session.runtimeToken)));
      context.store.close();
    }
  });

  it("fails closed when an active runtime release is withdrawn from the catalog", async () => {
    const context = fixture();
    let active: { sessionId: string; runtimeToken: string } | undefined;
    try {
      const authorization = await issue(context.service, "free");
      const reservation = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_revokedrelease001",
        automationBackend: "project-webdriver",
      });
      const activation = await context.service.activateRuntimeSession(reservation.sessionId, reservation.activationTicket);
      active = { sessionId: reservation.sessionId, runtimeToken: activation.runtimeToken };
      const revokedCatalog = new ReleaseCatalog([{ ...reservation.manifest, status: "revoked" }]);
      const revokedService = new EntitlementService(context.store, revokedCatalog, context.service.signer, {
        now: () => context.now.value,
        sessionTtlSeconds: 120,
        heartbeatAfterSeconds: 30,
      });

      await expect(revokedService.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_revokedrelease002",
        automationBackend: "project-webdriver",
      })).rejects.toMatchObject({ code: "release_version_unavailable", status: 404 });

      await expect(revokedService.runtimeHeartbeat(active.sessionId, active.runtimeToken)).rejects.toMatchObject({
        code: "kernel_update_required",
        status: 409,
      });
      await expect(context.service.runtimeHeartbeat(active.sessionId, active.runtimeToken)).rejects.toMatchObject({
        code: "session_invalid",
        status: 401,
      });
    } finally {
      if (active) await context.service.releaseRuntimeSession(active.sessionId, active.runtimeToken).catch(() => undefined);
      context.store.close();
    }
  });
});

describe("v2 runtime denial audit", () => {
  it("records denied runtime reservations without consuming future capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), `sly-runtime-denied-${process.pid}-`));
    temporaryDirectories.push(root);
    const databasePath = join(root, "license.sqlite");
    const context = fixture(2_000_000_000, Buffer.from("zip"), databasePath);
    try {
      const authorization = await issue(context.service, "free");
      const first = await context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_deniedaaaaaaaaaa",
        automationBackend: "project-webdriver",
      });
      await expect(context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_deniedbbbbbbbbbb",
        automationBackend: "project-webdriver",
      })).rejects.toMatchObject({ code: "session_limit", status: 409, details: { state: "denied" } });
      await context.service.releaseRuntimeSession(first.sessionId, first.bootstrapToken);
      await expect(context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_deniedcccccccccc",
        automationBackend: "project-webdriver",
      })).resolves.toMatchObject({
        state: "reserved",
        activeSessions: 1,
      });
      context.now.value += 121;
      await expect(context.service.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_denieddddddddddd",
        automationBackend: "project-webdriver",
      })).resolves.toMatchObject({
        state: "reserved",
        activeSessions: 1,
      });
    } finally {
      context.store.close();
    }
    const database = new DatabaseSync(databasePath);
    try {
      const rows = database.prepare(`
        SELECT state, startup_id, released_at, expires_at
        FROM license_sessions
        WHERE startup_id IN ('st_deniedaaaaaaaaaa', 'st_deniedbbbbbbbbbb', 'st_deniedcccccccccc')
        ORDER BY startup_id
      `).all() as Array<{ state: string; startup_id: string; released_at: number; expires_at: number }>;
      expect(rows).toEqual([
        {
          state: "released",
          startup_id: "st_deniedaaaaaaaaaa",
          released_at: 2_000_000_000,
          expires_at: 2_000_000_000,
        },
        {
          state: "denied",
          startup_id: "st_deniedbbbbbbbbbb",
          released_at: 2_000_000_000,
          expires_at: 2_000_000_000,
        },
        {
          state: "expired",
          startup_id: "st_deniedcccccccccc",
          released_at: 2_000_000_120,
          expires_at: 2_000_000_120,
        },
      ]);
    } finally {
      database.close();
    }
  });
});

const describePostgres = process.env.SLY_TEST_POSTGRES_URL ? describe : describe.skip;

describePostgres("PostgreSQL concurrency authority", () => {
  async function postgresServices() {
    const base = fixture();
    base.store.close();
    const storeA = await PostgresLicenseStore.connect(process.env.SLY_TEST_POSTGRES_URL!, Buffer.alloc(32, 7));
    const storeB = await PostgresLicenseStore.connect(process.env.SLY_TEST_POSTGRES_URL!, Buffer.alloc(32, 7));
    const serviceA = new EntitlementService(storeA, base.catalog, base.service.signer, {
      now: () => base.now.value,
      sessionTtlSeconds: 120,
      heartbeatAfterSeconds: 30,
    });
    const serviceB = new EntitlementService(storeB, base.catalog, base.service.signer, {
      now: () => base.now.value,
      sessionTtlSeconds: 120,
      heartbeatAfterSeconds: 30,
    });
    return { ...base, storeA, storeB, serviceA, serviceB };
  }

  it("keeps one shared N/N+1 authority across two service instances", async () => {
    const context = await postgresServices();
    const releases: Array<{ sessionId: string; token: string }> = [];
    try {
      const authorization = await issue(context.serviceA, "launch", context.now.value + 86_400);
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => {
        const service = index % 2 === 0 ? context.serviceA : context.serviceB;
        return service.createRuntimeSession(authorization.licenseKey, {
          ...request(),
          startupId: `st_pglaunch${String(index).padStart(8, "0")}`,
          automationBackend: "project-webdriver",
        });
      }));
      const granted = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<EntitlementService["createRuntimeSession"]>>> =>
        result.status === "fulfilled");
      const denied = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(granted).toHaveLength(PLAN_CATALOG.launch.concurrency);
      expect(denied).toHaveLength(3);
      expect(denied.every((result) => (result.reason as ServiceError).code === "session_limit")).toBe(true);
      releases.push(...granted.map((result) => ({ sessionId: result.value.sessionId, token: result.value.bootstrapToken })));
      await context.serviceA.releaseRuntimeSession(releases[0]!.sessionId, releases[0]!.token);
      releases.shift();
      await expect(context.serviceB.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_pglaunchreplacement",
        automationBackend: "project-webdriver",
      })).resolves.toMatchObject({ activeSessions: PLAN_CATALOG.launch.concurrency });
    } finally {
      await Promise.allSettled(releases.map((session) => context.serviceA.releaseRuntimeSession(session.sessionId, session.token)));
      await Promise.all([context.storeA.close(), context.storeB.close()]);
    }
  }, 30_000);

  it("deduplicates repeated startup reservations before counting concurrency", async () => {
    const context = await postgresServices();
    let grant: Awaited<ReturnType<EntitlementService["createRuntimeSession"]>> | undefined;
    try {
      const authorization = await issue(context.serviceA, "free");
      const repeated = await Promise.all(Array.from({ length: 100 }, (_, index) => {
        const service = index % 2 === 0 ? context.serviceA : context.serviceB;
        return service.createRuntimeSession(authorization.licenseKey, {
          ...request(),
          startupId: "st_pgidempotent0001",
          automationBackend: "project-webdriver",
        });
      }));
      grant = repeated[0]!;
      expect(new Set(repeated.map((value) => value.sessionId)).size).toBe(1);
      expect(repeated.at(-1)?.activeSessions).toBe(1);
      await expect(context.serviceB.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_pgidempotent0002",
        automationBackend: "project-webdriver",
      })).rejects.toMatchObject({ code: "session_limit", details: { state: "denied" } });
    } finally {
      if (grant) await context.serviceA.releaseRuntimeSession(grant.sessionId, grant.bootstrapToken);
      await Promise.all([context.storeA.close(), context.storeB.close()]);
    }
  }, 30_000);

  it("applies downgraded plan rank to active runtime heartbeats across service instances", async () => {
    const context = await postgresServices();
    const activeSessions: Array<{ sessionId: string; runtimeToken: string }> = [];
    try {
      const authorization = await issue(context.serviceA, "launch", context.now.value + 86_400);
      const first = await context.serviceA.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_pgdowngrade0001x",
        automationBackend: "project-webdriver",
      });
      const firstActive = await context.serviceA.activateRuntimeSession(first.sessionId, first.activationTicket);
      activeSessions.push({ sessionId: first.sessionId, runtimeToken: firstActive.runtimeToken });
      context.now.value += 1;
      const second = await context.serviceB.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_pgdowngrade0002x",
        automationBackend: "project-webdriver",
      });
      const secondActive = await context.serviceB.activateRuntimeSession(second.sessionId, second.activationTicket);
      activeSessions.push({ sessionId: second.sessionId, runtimeToken: secondActive.runtimeToken });

      await context.storeA.updateEntitlement(authorization.licenseId, {
        plan: "free",
        now: context.now.value,
      });

      await expect(context.serviceA.runtimeHeartbeat(first.sessionId, firstActive.runtimeToken)).resolves.toMatchObject({
        plan: "free",
        concurrencyLimit: PLAN_CATALOG.free.concurrency,
      });
      await expect(context.serviceB.runtimeHeartbeat(second.sessionId, secondActive.runtimeToken)).rejects.toMatchObject({
        code: "session_limit",
        status: 409,
        details: { state: "denied" },
      });
      await expect(context.serviceA.runtimeHeartbeat(first.sessionId, firstActive.runtimeToken)).resolves.toMatchObject({
        activeSessions: PLAN_CATALOG.free.concurrency,
      });
    } finally {
      await Promise.allSettled(activeSessions.map((session) =>
        context.serviceA.releaseRuntimeSession(session.sessionId, session.runtimeToken)));
      await Promise.all([context.storeA.close(), context.storeB.close()]);
    }
  }, 30_000);

  it("enforces paid feature downgrades across service instances", async () => {
    const context = await postgresServices();
    let active: { sessionId: string; runtimeToken: string } | undefined;
    try {
      const authorization = await issue(context.serviceA, "launch", context.now.value + 86_400);
      const reservation = await context.serviceA.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_pgfeaturedown001",
        automationBackend: "playwright",
      });
      const activation = await context.serviceB.activateRuntimeSession(reservation.sessionId, reservation.activationTicket);
      active = { sessionId: reservation.sessionId, runtimeToken: activation.runtimeToken };

      await context.storeA.updateEntitlement(authorization.licenseId, {
        plan: "free",
        now: context.now.value,
      });

      await expect(context.serviceB.runtimeHeartbeat(reservation.sessionId, activation.runtimeToken)).rejects.toMatchObject({
        code: "license_feature_denied",
        status: 403,
        details: { features: ["playwright"], state: "denied" },
      });
      active = undefined;
      await expect(context.serviceA.createRuntimeSession(authorization.licenseKey, {
        ...request(),
        startupId: "st_pgfeaturedown002",
        automationBackend: "project-webdriver",
      })).resolves.toMatchObject({
        plan: "free",
        features: PLAN_CATALOG.free.features,
        activeSessions: 1,
      });
    } finally {
      if (active) await context.serviceA.releaseRuntimeSession(active.sessionId, active.runtimeToken).catch(() => undefined);
      await Promise.all([context.storeA.close(), context.storeB.close()]);
    }
  }, 30_000);
});

describe("authorization file generation", () => {
  it("writes a new private credential file and never overwrites it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sly-authorization-"));
    temporaryDirectories.push(root);
    const database = join(root, "license.sqlite");
    const output = join(root, "studio.authorization.json");
    const result = await issueAuthorizationFile({
      database,
      pepper: Buffer.alloc(32, 9),
      accountId: "account-file-test",
      plan: "studio",
      paidThrough: 2_000_086_400,
      serviceUrl: "https://api.slybrowser.test/",
      output,
      now: 2_000_000_000,
    });
    const authorization = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    expect(result).toMatchObject({ accountId: "account-file-test", plan: "studio", authorizationFile: output });
    expect(authorization).toMatchObject({
      schemaVersion: 1,
      serviceUrl: "https://api.slybrowser.test",
      channel: "stable",
    });
    expect(authorization.licenseKey).toMatch(/^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
    await expect(issueAuthorizationFile({
      database,
      pepper: Buffer.alloc(32, 9),
      accountId: "must-not-overwrite",
      plan: "free",
      serviceUrl: "https://api.slybrowser.test",
      output,
      now: 2_000_000_000,
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(authorization);
  });

  it("generates encrypted/authenticated v2 test license files for every plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "sly-license-v2-"));
    temporaryDirectories.push(root);
    const database = join(root, "license.sqlite");
    const pepper = Buffer.alloc(32, 10);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
    const passphrase = "test-passphrase-only";

    for (const plan of PLAN_IDS) {
      const output = join(root, `${plan}.slybrowser-license.json`);
      const result = await issueTestLicenseFile({
        database,
        pepper,
        accountId: `account-v2-${plan}`,
        plan,
        ...(plan === "free" ? {} : { paidThrough: 2_000_086_400 }),
        serviceUrl: "https://api.slybrowser.test/",
        output,
        passphrase,
        signingKeyId: "license-file-test-v1",
        signingPrivateKey: privatePem,
        now: 2_000_000_000,
      });
      const document = JSON.parse(await readFile(output, "utf8")) as LicenseFileV2;
      const serialized = JSON.stringify(document);
      expect(result).toMatchObject({
        schemaVersion: 2,
        scope: "test-private-preview",
        accountId: `account-v2-${plan}`,
        plan,
        licenseFile: output,
      });
      expect(document).toMatchObject({
        schemaVersion: 2,
        type: "slybrowser-license",
        audience: "slybrowser-license-file",
        serviceUrl: "https://api.slybrowser.test",
        channel: "stable",
        encryption: {
          algorithm: "AES-256-GCM",
          kdf: {
            name: "sly-test-scrypt-v1",
            purpose: "test-private-preview",
          },
        },
        signature: {
          algorithm: "Ed25519",
          keyId: "license-file-test-v1",
        },
      });
      expect(document.fileId).toMatch(/^lf_test_/);
      expect(serialized).not.toContain("sly_live_");
      expect(serialized).not.toContain("paynow");
      expect(serialized).not.toContain("billing");
      expect(serialized).not.toContain(`"${plan}"`);

      const secret = decryptLicenseFileV2(document, {
        passphrase,
        trustedPublicKeys: { "license-file-test-v1": publicPem },
        trustedServiceUrls: ["https://api.slybrowser.test"],
      });
      expect(secret).toMatchObject({
        schemaVersion: 2,
        type: "slybrowser-license-secret",
        audience: "slybrowser-license-file",
        licenseId: result.licenseId,
        fileId: result.fileId,
        serviceUrl: "https://api.slybrowser.test",
        channel: "stable",
        scope: "test-private-preview",
      });

      const store = new LicenseStore(database, pepper);
      try {
        expect(store.authenticateLicenseKey(secret.licenseKey)).toMatchObject({
          license_id: result.licenseId,
          account_id: `account-v2-${plan}`,
          plan,
        });
      } finally {
        store.close();
      }
    }
  }, 30_000);

  it("issues production-format portable license files through the entitlement store", async () => {
    const root = await mkdtemp(join(tmpdir(), "sly-license-portable-"));
    temporaryDirectories.push(root);
    const database = join(root, "license.sqlite");
    const output = join(root, "launch.slybrowser-license.json");
    const pepper = Buffer.alloc(32, 11);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signingKeyId = "license-file-local-v1";
    const passphrase = "portable-passphrase-only";
    const result = await issuePortableLicenseFile({
      database,
      pepper,
      accountId: "test002@slybrowser.com",
      plan: "launch",
      paidThrough: 2_000_086_400,
      serviceUrl: "https://api.slybrowser.test/",
      output,
      passphrase,
      signingKeyId,
      signingPrivateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      now: 2_000_000_000,
      expiresAt: "2034-05-18T03:33:20.000Z",
    });
    const document = JSON.parse(await readFile(output, "utf8")) as LicenseFileV2;
    const serialized = JSON.stringify(document);
    expect(result).toMatchObject({
      schemaVersion: 2,
      scope: "portable-passphrase",
      accountId: "test002@slybrowser.com",
      plan: "launch",
      licenseFile: output,
    });
    expect(document).toMatchObject({
      schemaVersion: 2,
      type: "slybrowser-license",
      audience: "slybrowser-license-file",
      serviceUrl: "https://api.slybrowser.test",
      channel: "stable",
      encryption: {
        algorithm: "AES-256-GCM",
        kdf: {
          name: "sly-portable-scrypt-v1",
          purpose: "portable-passphrase",
        },
      },
      signature: {
        algorithm: "Ed25519",
        keyId: signingKeyId,
      },
    });
    expect(document.fileId).toMatch(/^lf_/);
    expect(document.fileId).not.toMatch(/^lf_test_/);
    expect(serialized).not.toContain("sly_live_");
    expect(serialized).not.toContain("test002@slybrowser.com");
    expect(serialized).not.toContain("\"launch\"");

    const secret = decryptLicenseFileV2(document, {
      passphrase,
      trustedPublicKeys: { [signingKeyId]: publicKey.export({ format: "pem", type: "spki" }) as string },
      trustedServiceUrls: ["https://api.slybrowser.test"],
    });
    expect(secret).toMatchObject({
      schemaVersion: 2,
      type: "slybrowser-license-secret",
      audience: "slybrowser-license-file",
      licenseId: result.licenseId,
      fileId: result.fileId,
      serviceUrl: "https://api.slybrowser.test",
      channel: "stable",
      scope: "portable-passphrase",
    });

    const store = new LicenseStore(database, pepper);
    try {
      expect(store.authenticateLicenseKey(secret.licenseKey)).toMatchObject({
        license_id: result.licenseId,
        account_id: "test002@slybrowser.com",
        plan: "launch",
      });
    } finally {
      store.close();
    }
    await expect(issuePortableLicenseFile({
      database,
      pepper,
      accountId: "must-not-overwrite",
      plan: "free",
      serviceUrl: "https://api.slybrowser.test",
      output,
      passphrase,
      signingKeyId,
      signingPrivateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      now: 2_000_000_000,
    })).rejects.toMatchObject({ code: "EEXIST" });
  }, 30_000);

  it("generates encrypted/authenticated private-preview portable license files", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const licenseId = "00000000-0000-4000-8000-000000000123";
    const licenseKey = `sly_live_${licenseId}.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH`;
    const signingKeyId = "license-file-private-preview-v1";
    const document = createPortableLicenseFile({
      licenseId,
      licenseKey,
      serviceUrl: "https://api.slybrowser.test",
      issuedAt: "2033-05-18T03:33:20.000Z",
      expiresAt: "2034-05-18T03:33:20.000Z",
      passphrase: "portable-passphrase-only",
      signingKeyId,
      signingPrivateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
      salt: deterministicBytes("portable-salt", 16),
      nonce: deterministicBytes("portable-nonce", 12),
      payloadNonce: deterministicBytes("portable-payload", 24).toString("base64url"),
    });
    const serialized = JSON.stringify(document);
    expect(document.fileId).toMatch(/^lf_/);
    expect(document.fileId).not.toMatch(/^lf_test_/);
    expect(document.encryption.kdf).toMatchObject({
      name: "sly-portable-scrypt-v1",
      purpose: "portable-passphrase",
    });
    expect(serialized).not.toContain(licenseKey);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH");
    const secret = decryptLicenseFileV2(document, {
      passphrase: "portable-passphrase-only",
      trustedPublicKeys: {
        [signingKeyId]: publicKey.export({ format: "pem", type: "spki" }) as string,
      },
      trustedServiceUrls: ["https://api.slybrowser.test"],
    });
    expect(secret).toMatchObject({
      licenseId,
      licenseKey,
      scope: "portable-passphrase",
    });
  });

  it("fails closed when a v2 test license file is tampered or opened with the wrong secret", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const document = createFixtureDocument(privateKey.export({ format: "pem", type: "pkcs8" }) as string);
    const publicPem = publicKey.export({ format: "pem", type: "spki" }) as string;
    const trust = {
      passphrase: "test-passphrase-only",
      trustedPublicKeys: { "license-file-test-v1": publicPem },
      trustedServiceUrls: ["https://api.slybrowser.test"],
    };
    expect(decryptLicenseFileV2(document, trust).licenseKey).toMatch(/^sly_live_/);
    expect(() => decryptLicenseFileV2({ ...document, serviceUrl: "https://evil.example" }, trust)).toThrowError(
      expect.objectContaining({ code: "license_file_untrusted_origin" }),
    );
    expect(() => decryptLicenseFileV2({
      ...document,
      ciphertext: corruptBase64Url(document.ciphertext),
    }, trust)).toThrowError(expect.objectContaining({ code: "license_file_signature_invalid" }));
    expect(() => decryptLicenseFileV2({
      ...document,
      signature: { ...document.signature, signature: corruptBase64Url(document.signature.signature) },
    }, trust)).toThrowError(expect.objectContaining({ code: "license_file_signature_invalid" }));
    expect(() => decryptLicenseFileV2(document, { ...trust, passphrase: "wrong-passphrase" })).toThrowError(
      expect.objectContaining({ code: "license_file_locked" }),
    );
    expect(() => decryptLicenseFileV2(document, {
      ...trust,
      trustedPublicKeys: {},
    })).toThrowError(expect.objectContaining({ code: "license_file_key_unknown" }));
    expect(() => decryptLicenseFileV2({ ...document, audience: "other-product" }, trust)).toThrowError(
      expect.objectContaining({ code: "license_file_invalid" }),
    );
    expect(() => decryptLicenseFileV2(createFixtureDocument(privateKey.export({ format: "pem", type: "pkcs8" }) as string, {
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z",
      fileId: "lf_test_expired1",
    }), trust)).toThrowError(expect.objectContaining({ code: "license_file_expired" }));
    expect(() => decryptLicenseFileV2(createFixtureDocument(privateKey.export({ format: "pem", type: "pkcs8" }) as string, {
      fileId: "lf_test_plan_claim",
      testPayloadOverrides: { plan: "grid" },
    }), trust)).toThrowError(expect.objectContaining({ code: "license_file_payload_invalid" }));
  });
});

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

function createFixtureDocument(signingPrivateKey: string, overrides: Partial<{
  issuedAt: string;
  expiresAt: string;
  fileId: string;
  testPayloadOverrides: Record<string, unknown>;
}> = {}): LicenseFileV2 {
  return createTestLicenseFile({
    licenseId: "11111111-1111-4111-8111-111111111111",
    licenseKey: `sly_live_11111111-1111-4111-8111-111111111111.${"a".repeat(43)}`,
    serviceUrl: "https://api.slybrowser.test",
    issuedAt: overrides.issuedAt ?? "2033-05-18T03:33:20.000Z",
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt }),
    fileId: overrides.fileId ?? "lf_test_deterministic",
    passphrase: "test-passphrase-only",
    signingKeyId: "license-file-test-v1",
    signingPrivateKey,
    salt: deterministicBytes("license-file-salt", 16),
    nonce: deterministicBytes("license-file-nonce", 12),
    payloadNonce: "fixture-payload-nonce",
    ...(overrides.testPayloadOverrides === undefined ? {} : { testPayloadOverrides: overrides.testPayloadOverrides }),
  });
}
