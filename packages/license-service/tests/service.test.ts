import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReleaseCatalog } from "../src/catalog.js";
import { issueAuthorizationFile } from "../src/authorization.js";
import { ServiceError } from "../src/errors.js";
import { PLAN_CATALOG, type PlanId } from "../src/plans.js";
import { createLicenseHttpServer } from "../src/server.js";
import { EntitlementService } from "../src/service.js";
import { LeaseSigner } from "../src/signer.js";
import { LicenseStore } from "../src/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixture(now = 2_000_000_000, artifactBytes = Buffer.from("zip")): {
  service: EntitlementService;
  store: LicenseStore;
  catalog: ReleaseCatalog;
  now: { value: number };
  artifact: { bytes: Buffer; sha256: string; name: string };
} {
  const clock = { value: now };
  const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const browserSha256 = createHash("sha256").update("browser").digest("hex");
  const driverSha256 = createHash("sha256").update("driver").digest("hex");
  const name = `${sha256}.zip`;
  const manifest = {
    schemaVersion: 1,
    browserVersion: "150.0.8000.1",
    sdkCompatibility: ">=0.1.0 <1.0.0",
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
  const store = new LicenseStore(":memory:", Buffer.alloc(32, 7));
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
  };
}

function issue(service: EntitlementService, plan: PlanId, paidThrough = 2_000_086_400) {
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

describe("plan and atomic concurrency authority", () => {
  it("uses the approved five-plan price and concurrency matrix", () => {
    expect(PLAN_CATALOG).toEqual({
      free: { id: "free", name: "Free", monthlyPriceCents: 0, concurrency: 1 },
      launch: { id: "launch", name: "Launch", monthlyPriceCents: 1900, concurrency: 5 },
      studio: { id: "studio", name: "Studio", monthlyPriceCents: 4900, concurrency: 20 },
      fleet: { id: "fleet", name: "Fleet", monthlyPriceCents: 19900, concurrency: 200 },
      grid: { id: "grid", name: "Grid", monthlyPriceCents: 49900, concurrency: 2000 },
    });
  });

  for (const plan of Object.keys(PLAN_CATALOG) as PlanId[]) {
    it(`enforces ${plan} concurrency atomically`, () => {
      const context = fixture();
      try {
        const authorization = issue(context.service, plan);
        const grants = Array.from({ length: PLAN_CATALOG[plan].concurrency }, () =>
          context.service.createSession(authorization.licenseKey, request()));
        expect(grants).toHaveLength(PLAN_CATALOG[plan].concurrency);
        expect(grants.at(-1)?.activeSessions).toBe(PLAN_CATALOG[plan].concurrency);
        expect(() => context.service.createSession(authorization.licenseKey, request())).toThrowError(
          expect.objectContaining({ code: "session_limit", status: 409 }),
        );
        context.service.release(grants[0]!.sessionId, grants[0]!.sessionToken);
        expect(context.service.createSession(authorization.licenseKey, request()).activeSessions)
          .toBe(PLAN_CATALOG[plan].concurrency);
      } finally {
        context.store.close();
      }
    }, 20_000);
  }

  it("falls an expired paid entitlement back to Free capacity", () => {
    const context = fixture();
    try {
      const authorization = issue(context.service, "launch", context.now.value + 10);
      const first = context.service.createSession(authorization.licenseKey, request());
      expect(first.concurrencyLimit).toBe(5);
      context.now.value += 11;
      expect(() => context.service.createSession(authorization.licenseKey, request())).toThrowError(
        expect.objectContaining({ code: "session_limit" }),
      );
      context.service.release(first.sessionId, first.sessionToken);
      const fallback = context.service.createSession(authorization.licenseKey, request());
      expect(fallback.plan).toBe("free");
      expect(fallback.concurrencyLimit).toBe(1);
    } finally {
      context.store.close();
    }
  });

  it("renews a reservation by heartbeat and expires an orphan", () => {
    const context = fixture();
    try {
      const authorization = issue(context.service, "free");
      const grant = context.service.createSession(authorization.licenseKey, request());
      context.now.value += 60;
      const heartbeat = context.service.heartbeat(grant.sessionId, grant.sessionToken);
      expect(heartbeat.expiresAt).toBe(context.now.value + 120);
      context.now.value += 121;
      expect(() => context.service.heartbeat(grant.sessionId, grant.sessionToken)).toThrowError(
        expect.objectContaining({ code: "session_expired" }),
      );
      expect(context.service.createSession(authorization.licenseKey, request()).activeSessions).toBe(1);
    } finally {
      context.store.close();
    }
  });
});

describe("HTTP authorization and artifact delivery", () => {
  it("requires the session token and stops download after release", async () => {
    const context = fixture();
    const root = join(tmpdir(), `sly-license-service-${process.pid}-${Date.now()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, context.artifact.name), context.artifact.bytes);
    const authorization = issue(context.service, "launch");
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
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(context.artifact.bytes);
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

  it("rejects invalid license keys without revealing license existence", () => {
    const context = fixture();
    try {
      issue(context.service, "free");
      expect(() => context.service.createSession(
        `sly_live_00000000-0000-0000-0000-000000000000.${"x".repeat(43)}`,
        request(),
      )).toThrowError(expect.objectContaining({ code: "license_key_invalid", status: 401 }));
    } finally {
      context.store.close();
    }
  });
});

describe("explicit browser version selection", () => {
  it("distinguishes latest, exact pinning, and explicit rollback", () => {
    const context = fixture();
    try {
      const authorization = issue(context.service, "launch");
      const latest = context.service.createSession(authorization.licenseKey, request());
      expect(latest).toMatchObject({
        browserVersion: "150.0.8000.1",
        versionPolicy: "latest",
        selectionReason: "latest",
      });
      context.service.release(latest.sessionId, latest.sessionToken);

      const exact = context.service.createSession(authorization.licenseKey, {
        ...request(),
        versionPolicy: "exact",
        browserVersion: "150.0.8000.1",
      });
      expect(exact).toMatchObject({
        browserVersion: "150.0.8000.1",
        requestedBrowserVersion: "150.0.8000.1",
        versionPolicy: "exact",
        selectionReason: "exact",
      });
      context.service.release(exact.sessionId, exact.sessionToken);

      const rollback = context.service.createSession(authorization.licenseKey, {
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
      context.service.release(rollback.sessionId, rollback.sessionToken);

      expect(() => context.service.createSession(authorization.licenseKey, {
        ...request(),
        versionPolicy: "exact",
        browserVersion: "149.0.0.0",
      })).toThrowError(expect.objectContaining({ code: "release_version_unavailable", status: 404 }));

      expect(() => context.service.createSession(authorization.licenseKey, {
        ...request(),
        platform: "linux",
      })).toThrowError(expect.objectContaining({
        code: "release_version_unavailable",
        status: 404,
        message: expect.stringContaining("linux/x64"),
      }));
    } finally {
      context.store.close();
    }
  });
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
});
