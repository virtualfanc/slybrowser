import type { CatalogArtifact, CatalogManifest, ReleaseCatalog, VersionPolicy } from "./catalog.js";
import { invalidRequest, ServiceError } from "./errors.js";
import { FULL_FEATURES, isPlanId, PLAN_CATALOG, type PlanId } from "./plans.js";
import type { LicenseEnvelope } from "./signer.js";
import { LeaseSigner } from "./signer.js";
import type { EntitlementStatus, IssuedEntitlement, LicenseStore, Reservation } from "./store.js";

export interface SessionRequest {
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  channel?: "stable";
  sdkVersion: string;
  deviceHash?: string;
  browserVersion?: string;
  versionPolicy?: VersionPolicy;
}

export interface SessionGrant {
  schemaVersion: 1;
  sessionId: string;
  sessionToken: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: PlanId;
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  requestedBrowserVersion?: string;
  versionPolicy: VersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  availableBrowserVersions: string[];
  updateRights: {
    status: "active";
    channel: "stable";
    updatesThrough: number | null;
    exactVersion: true;
    rollback: true;
  };
  lease: LicenseEnvelope;
  manifest: CatalogManifest;
}

export interface HeartbeatGrant {
  schemaVersion: 1;
  sessionId: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: PlanId;
  concurrencyLimit: number;
  activeSessions: number;
  lease: LicenseEnvelope;
}

function requiredIdentifier(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    invalidRequest(`${name} is invalid`);
  }
  return value;
}

function validateSessionRequest(input: unknown): SessionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidRequest("Request body must be an object");
  const value = input as Record<string, unknown>;
  const allowed = new Set(["platform", "arch", "channel", "sdkVersion", "deviceHash", "browserVersion", "versionPolicy"]);
  if (Object.keys(value).some((name) => !allowed.has(name))) invalidRequest("Request contains unknown fields");
  if (!new Set(["windows", "linux", "macos"]).has(String(value.platform))) invalidRequest("Platform is invalid");
  if (!new Set(["x64", "arm64"]).has(String(value.arch))) invalidRequest("Architecture is invalid");
  if (value.channel !== undefined && value.channel !== "stable") invalidRequest("Only the Stable channel is supported");
  const sdkVersion = requiredIdentifier(value.sdkVersion, "SDK version", 64);
  if (!/^\d+(\.\d+){0,7}$/.test(sdkVersion)) invalidRequest("SDK version is invalid");
  const deviceHash = value.deviceHash === undefined ? undefined : requiredIdentifier(value.deviceHash, "Device hash", 256);
  const versionPolicy = value.versionPolicy === undefined ? "latest" : requiredIdentifier(value.versionPolicy, "Version policy", 32);
  if (!new Set(["latest", "exact", "at-or-before"]).has(versionPolicy)) invalidRequest("Version policy is invalid");
  const browserVersion = value.browserVersion === undefined
    ? undefined
    : requiredIdentifier(value.browserVersion, "Browser version", 64);
  if (browserVersion !== undefined && !/^\d+(\.\d+){0,7}$/.test(browserVersion)) invalidRequest("Browser version is invalid");
  if (versionPolicy === "latest" && browserVersion !== undefined) invalidRequest("Latest selection cannot include a browser version");
  if (versionPolicy !== "latest" && browserVersion === undefined) invalidRequest(`${versionPolicy} selection requires a browser version`);
  return {
    platform: value.platform as SessionRequest["platform"],
    arch: value.arch as SessionRequest["arch"],
    channel: "stable",
    sdkVersion,
    ...(deviceHash === undefined ? {} : { deviceHash }),
    ...(browserVersion === undefined ? {} : { browserVersion }),
    versionPolicy: versionPolicy as VersionPolicy,
  };
}

export class EntitlementService {
  constructor(
    readonly store: LicenseStore,
    readonly catalog: ReleaseCatalog,
    readonly signer: LeaseSigner,
    readonly options: {
      now?: () => number;
      sessionTtlSeconds?: number;
      heartbeatAfterSeconds?: number;
    } = {},
  ) {
    if (this.sessionTtlSeconds < 120 || this.sessionTtlSeconds > 24 * 60 * 60) {
      throw new TypeError("Session TTL must be between 120 seconds and 24 hours");
    }
    if (this.heartbeatAfterSeconds < 15 || this.heartbeatAfterSeconds * 2 >= this.sessionTtlSeconds) {
      throw new TypeError("Heartbeat interval is outside the supported range");
    }
  }

  get now(): number {
    return Math.floor((this.options.now ?? (() => Date.now() / 1000))());
  }

  get sessionTtlSeconds(): number {
    return this.options.sessionTtlSeconds ?? 10 * 60;
  }

  get heartbeatAfterSeconds(): number {
    return this.options.heartbeatAfterSeconds ?? 60;
  }

  plans(): object {
    return {
      schemaVersion: 1,
      currency: "USD",
      billingPeriod: "month",
      plans: Object.values(PLAN_CATALOG),
    };
  }

  issueAuthorization(input: {
    accountId: string;
    plan: PlanId;
    paidThrough?: number | null;
    serviceUrl: string;
  }): IssuedEntitlement & { authorization: object } {
    if (!isPlanId(input.plan)) invalidRequest("Plan is invalid");
    const serviceUrl = new URL(input.serviceUrl);
    if (serviceUrl.protocol !== "https:") invalidRequest("Service URL must use HTTPS");
    const issued = this.store.issueEntitlement({
      accountId: input.accountId,
      plan: input.plan,
      ...(input.paidThrough === undefined ? {} : { paidThrough: input.paidThrough }),
      now: this.now,
    });
    return {
      ...issued,
      authorization: {
        schemaVersion: 1,
        serviceUrl: serviceUrl.toString().replace(/\/$/, ""),
        licenseKey: issued.licenseKey,
        channel: "stable",
      },
    };
  }

  updateAuthorization(licenseId: string, input: {
    plan?: unknown;
    status?: unknown;
    paidThrough?: unknown;
  }): void {
    const plan = input.plan === undefined ? undefined : isPlanId(input.plan) ? input.plan : invalidRequest("Plan is invalid");
    const statuses = new Set<unknown>(["active", "hold", "revoked"]);
    const status = input.status === undefined ? undefined : statuses.has(input.status)
      ? input.status as EntitlementStatus
      : invalidRequest("Status is invalid");
    const paidThrough = input.paidThrough === undefined ? undefined
      : input.paidThrough === null || Number.isSafeInteger(input.paidThrough)
        ? input.paidThrough as number | null
        : invalidRequest("Paid-through time is invalid");
    this.store.updateEntitlement(licenseId, {
      ...(plan === undefined ? {} : { plan }),
      ...(status === undefined ? {} : { status }),
      ...(paidThrough === undefined ? {} : { paidThrough }),
      now: this.now,
    });
  }

  createSession(licenseKey: string, request: unknown): SessionGrant {
    const input = validateSessionRequest(request);
    const entitlement = this.store.authenticateLicenseKey(licenseKey);
    const selection = this.catalog.select(input.platform, input.arch, input.sdkVersion, {
      ...(input.versionPolicy === undefined ? {} : { versionPolicy: input.versionPolicy }),
      ...(input.browserVersion === undefined ? {} : { browserVersion: input.browserVersion }),
    });
    let reservation: Reservation | undefined;
    try {
      reservation = this.store.reserve({
        licenseId: entitlement.license_id,
        ...(input.deviceHash === undefined ? {} : { deviceHash: input.deviceHash }),
        platform: input.platform,
        arch: input.arch,
        browserVersion: selection.manifest.browserVersion,
        artifactSha256: selection.artifact.sha256,
        now: this.now,
        ttlSeconds: this.sessionTtlSeconds,
      });
      return {
        schemaVersion: 1,
        sessionId: reservation.sessionId,
        sessionToken: reservation.sessionToken,
        heartbeatAfterSeconds: this.heartbeatAfterSeconds,
        expiresAt: reservation.expiresAt,
        plan: reservation.plan,
        concurrencyLimit: reservation.concurrencyLimit,
        activeSessions: reservation.activeSessions,
        browserVersion: reservation.browserVersion,
        ...(selection.requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: selection.requestedBrowserVersion }),
        versionPolicy: selection.versionPolicy,
        selectionReason: selection.selectionReason,
        availableBrowserVersions: selection.availableBrowserVersions,
        updateRights: {
          status: "active",
          channel: "stable",
          updatesThrough: entitlement.paid_through,
          exactVersion: true,
          rollback: true,
        },
        lease: this.#lease(reservation),
        manifest: selection.manifest,
      };
    } catch (error) {
      if (reservation) this.store.release(reservation.sessionToken, this.now);
      throw error;
    }
  }

  heartbeat(sessionId: string, sessionToken: string): HeartbeatGrant {
    const reservation = this.store.heartbeat(sessionToken, this.now, this.sessionTtlSeconds, sessionId);
    return {
      schemaVersion: 1,
      sessionId: reservation.sessionId,
      heartbeatAfterSeconds: this.heartbeatAfterSeconds,
      expiresAt: reservation.expiresAt,
      plan: reservation.plan,
      concurrencyLimit: reservation.concurrencyLimit,
      activeSessions: reservation.activeSessions,
      lease: this.#lease(reservation),
    };
  }

  release(sessionId: string, sessionToken: string): void {
    this.store.release(sessionToken, this.now, sessionId);
  }

  authorizeArtifact(sessionToken: string, artifact: CatalogArtifact): void {
    this.store.authorizeSession(sessionToken, artifact.sha256, this.now);
  }

  #lease(reservation: Reservation): LicenseEnvelope {
    const now = this.now;
    return this.signer.sign({
      schemaVersion: 1,
      licenseId: reservation.licenseId,
      audience: "slybrowser",
      issuedAt: now,
      notBefore: now,
      expiresAt: reservation.expiresAt,
      browserMin: reservation.browserVersion,
      browserMax: reservation.browserVersion,
      features: [...FULL_FEATURES],
      sessionId: reservation.sessionId,
      nonce: LeaseSigner.nonce(),
      ...(reservation.deviceHash === undefined ? {} : { deviceHash: reservation.deviceHash }),
    });
  }
}
