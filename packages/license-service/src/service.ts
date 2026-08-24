import type { CatalogArtifact, CatalogManifest, KernelMajor, ReleaseCatalog, VersionPolicy } from "./catalog.js";
import { invalidRequest, ServiceError } from "./errors.js";
import { effectivePlan, FEATURE_IDS, featuresForPlan, isPlanId, PLAN_CATALOG, type FeatureId, type PlanId } from "./plans.js";
import type { LicenseEnvelope } from "./signer.js";
import { LeaseSigner } from "./signer.js";
import type {
  EntitlementStore,
  EntitlementStatus,
  IssuedEntitlement,
  LicenseSecurityEventInput,
  Reservation,
  RuntimeActivation,
  RuntimeHeartbeat,
  RuntimeReservation,
  RuntimeRevocationTarget,
} from "./store.js";

export interface SessionRequest {
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  channel?: "stable";
  sdkVersion: string;
  deviceHash?: string;
  kernelMajor: KernelMajor;
  updateKernel: boolean;
  browserVersion?: string;
  versionPolicy?: VersionPolicy;
}

export interface RuntimeSessionRequest extends SessionRequest {
  startupId: string;
  automationBackend?: "project-webdriver" | "playwright" | "puppeteer";
}

export interface SessionGrant {
  schemaVersion: 1;
  sessionId: string;
  sessionToken: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: PlanId;
  features: readonly FeatureId[];
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  requestedBrowserVersion?: string;
  requestedKernelMajor: KernelMajor;
  versionPolicy: VersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  selectionMode: "latest" | "latest-in-major" | "cached-approved" | "exact" | "rollback";
  availableBrowserVersions: string[];
  latestAvailableVersion: string;
  updateAvailable: boolean;
  updateRequired: boolean;
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
  features: readonly FeatureId[];
  concurrencyLimit: number;
  activeSessions: number;
  lease: LicenseEnvelope;
}

export interface RuntimeSessionGrant {
  schemaVersion: 2;
  state: "reserved" | "active" | "closing";
  startupId: string;
  sessionId: string;
  bootstrapToken: string;
  activationTicket: string;
  driverActivationTicket?: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: PlanId;
  features: readonly FeatureId[];
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  requestedBrowserVersion?: string;
  requestedKernelMajor: KernelMajor;
  versionPolicy: VersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  selectionMode: SessionGrant["selectionMode"];
  availableBrowserVersions: string[];
  latestAvailableVersion: string;
  updateAvailable: boolean;
  updateRequired: boolean;
  updateRights: SessionGrant["updateRights"];
  lease: LicenseEnvelope;
  manifest: CatalogManifest;
  downloadTicket: {
    token: string;
    expiresAt: number;
    artifactSha256: string;
    artifactUrl: string;
  };
}

export interface RuntimeActivationGrant {
  schemaVersion: 2;
  state: "active";
  startupId: string;
  sessionId: string;
  runtimeToken: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: PlanId;
  features: readonly FeatureId[];
  concurrencyLimit: number;
  activeSessions: number;
  lease: LicenseEnvelope;
}

export interface RuntimeHeartbeatGrant {
  schemaVersion: 2;
  state: "reserved" | "active" | "closing";
  startupId: string;
  sessionId: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: PlanId;
  features: readonly FeatureId[];
  concurrencyLimit: number;
  activeSessions: number;
  lease: LicenseEnvelope;
}

export interface LicenseInfoResponse {
  schemaVersion: 1;
  channel: "stable";
  licenseStatus: EntitlementStatus;
  plan: PlanId;
  effectivePlan: PlanId;
  paidThrough: number | null;
  features: readonly FeatureId[];
  concurrencyLimit: number;
  activeSessions: number;
  availableSessions: number;
  sessionState: {
    activeBrowserProcesses: number;
    limit: number;
    available: number;
  };
  browserVersion: string;
  requestedBrowserVersion?: string;
  requestedKernelMajor: KernelMajor;
  versionPolicy: VersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  selectionMode: SessionGrant["selectionMode"];
  availableBrowserVersions: string[];
  latestAvailableVersion: string;
  updateAvailable: boolean;
  updateRequired: boolean;
  updateRights: SessionGrant["updateRights"];
  stableErrorCode: null;
}

export interface RuntimeRevocationResponse {
  schemaVersion: 1;
  target: RuntimeRevocationTarget;
  revokedSessions: number;
  effectiveAt: number;
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
  const allowed = new Set([
    "platform", "arch", "channel", "sdkVersion", "deviceHash",
    "kernelMajor", "updateKernel", "browserVersion", "versionPolicy",
  ]);
  if (Object.keys(value).some((name) => !allowed.has(name))) invalidRequest("Request contains unknown fields");
  if (!new Set(["windows", "linux", "macos"]).has(String(value.platform))) invalidRequest("Platform is invalid");
  if (!new Set(["x64", "arm64"]).has(String(value.arch))) invalidRequest("Architecture is invalid");
  if (value.channel !== undefined && value.channel !== "stable") invalidRequest("Only the Stable channel is supported");
  const sdkVersion = requiredIdentifier(value.sdkVersion, "SDK version", 64);
  if (!/^\d+(\.\d+){0,7}$/.test(sdkVersion)) invalidRequest("SDK version is invalid");
  const deviceHash = value.deviceHash === undefined ? undefined : requiredIdentifier(value.deviceHash, "Device hash", 256);
  const kernelMajor = value.kernelMajor === undefined || value.kernelMajor === "latest"
    ? "latest"
    : typeof value.kernelMajor === "number" && Number.isSafeInteger(value.kernelMajor) && value.kernelMajor > 0
      ? value.kernelMajor
      : invalidRequest("Kernel major must be a positive integer or latest");
  const updateKernel = value.updateKernel === undefined ? false : value.updateKernel;
  if (typeof updateKernel !== "boolean") invalidRequest("updateKernel must be a boolean");
  const versionPolicy = value.versionPolicy === undefined ? "latest" : requiredIdentifier(value.versionPolicy, "Version policy", 32);
  if (!new Set(["latest", "exact", "at-or-before"]).has(versionPolicy)) invalidRequest("Version policy is invalid");
  const browserVersion = value.browserVersion === undefined
    ? undefined
    : requiredIdentifier(value.browserVersion, "Browser version", 64);
  if (browserVersion !== undefined && !/^\d+(\.\d+){0,7}$/.test(browserVersion)) invalidRequest("Browser version is invalid");
  if (browserVersion !== undefined && kernelMajor !== "latest" && Number(browserVersion.split(".")[0]) !== kernelMajor) {
    throw new ServiceError("version_policy_invalid", "Browser version does not match kernelMajor", 400);
  }
  if (versionPolicy === "latest" && browserVersion !== undefined) invalidRequest("Latest selection cannot include a browser version");
  if (versionPolicy !== "latest" && browserVersion === undefined) invalidRequest(`${versionPolicy} selection requires a browser version`);
  return {
    platform: value.platform as SessionRequest["platform"],
    arch: value.arch as SessionRequest["arch"],
    channel: "stable",
    sdkVersion,
    ...(deviceHash === undefined ? {} : { deviceHash }),
    kernelMajor,
    updateKernel,
    ...(browserVersion === undefined ? {} : { browserVersion }),
    versionPolicy: versionPolicy as VersionPolicy,
  };
}

function validateRuntimeSessionRequest(input: unknown): RuntimeSessionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidRequest("Request body must be an object");
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "startupId",
    "platform",
    "arch",
    "channel",
    "sdkVersion",
    "automationBackend",
    "deviceHash",
    "kernelMajor",
    "updateKernel",
    "browserVersion",
    "versionPolicy",
  ]);
  if (Object.keys(value).some((name) => !allowed.has(name))) invalidRequest("Request contains unknown fields");
  const startupId = requiredIdentifier(value.startupId, "Startup ID", 128);
  if (!/^st_[A-Za-z0-9_-]{16,120}$/.test(startupId)) invalidRequest("Startup ID is invalid");
  const automationBackend = value.automationBackend === undefined
    ? undefined
    : requiredIdentifier(value.automationBackend, "Automation backend", 32);
  if (automationBackend !== undefined && !new Set(["project-webdriver", "playwright", "puppeteer"]).has(automationBackend)) {
    invalidRequest("Automation backend is invalid");
  }
  const sessionValue = { ...value };
  delete sessionValue.startupId;
  delete sessionValue.automationBackend;
  const session = validateSessionRequest(sessionValue);
  const result: RuntimeSessionRequest = {
    ...session,
    startupId,
  };
  if (automationBackend !== undefined) {
    result.automationBackend = automationBackend as NonNullable<RuntimeSessionRequest["automationBackend"]>;
  }
  return result;
}

function requiredFeaturesForBackend(backend?: RuntimeSessionRequest["automationBackend"]): readonly FeatureId[] {
  const base: FeatureId[] = ["browser", "release-download", "webdriver"];
  if (backend === "playwright") return [...base, "playwright"];
  if (backend === "puppeteer") return [...base, "puppeteer"];
  return base;
}

function validateRuntimeRevocationTarget(input: unknown): RuntimeRevocationTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidRequest("Revocation target must be an object");
  const value = input as Record<string, unknown>;
  const scope = requiredIdentifier(value.scope, "Revocation scope", 32);
  switch (scope) {
    case "session": {
      if (Object.keys(value).some((name) => !new Set(["scope", "sessionId"]).has(name))) {
        invalidRequest("Revocation target contains unknown fields");
      }
      const sessionId = requiredIdentifier(value.sessionId, "Session ID", 64);
      if (!/^[0-9a-f-]{36}$/.test(sessionId)) invalidRequest("Session ID is invalid");
      return { scope, sessionId };
    }
    case "artifact": {
      if (Object.keys(value).some((name) => !new Set(["scope", "artifactSha256"]).has(name))) {
        invalidRequest("Revocation target contains unknown fields");
      }
      const artifactSha256 = requiredIdentifier(value.artifactSha256, "Artifact SHA-256", 64);
      if (!/^[a-f0-9]{64}$/.test(artifactSha256)) invalidRequest("Artifact SHA-256 is invalid");
      return { scope, artifactSha256 };
    }
    case "release": {
      if (Object.keys(value).some((name) => !new Set(["scope", "browserVersion"]).has(name))) {
        invalidRequest("Revocation target contains unknown fields");
      }
      const browserVersion = requiredIdentifier(value.browserVersion, "Browser version", 64);
      if (!/^\d+(\.\d+){0,7}$/.test(browserVersion)) invalidRequest("Browser version is invalid");
      return { scope, browserVersion };
    }
    case "channel": {
      if (Object.keys(value).some((name) => !new Set(["scope", "channel"]).has(name))) {
        invalidRequest("Revocation target contains unknown fields");
      }
      if (value.channel !== "stable") invalidRequest("Only the Stable channel is supported");
      return { scope, channel: "stable" };
    }
    case "feature": {
      if (Object.keys(value).some((name) => !new Set(["scope", "feature"]).has(name))) {
        invalidRequest("Revocation target contains unknown fields");
      }
      const feature = requiredIdentifier(value.feature, "Feature", 64);
      if (!FEATURE_IDS.includes(feature as FeatureId)) invalidRequest("Feature is invalid");
      return { scope, feature: feature as FeatureId };
    }
    default:
      invalidRequest("Revocation scope is invalid");
  }
}

export class EntitlementService {
  #lastMonotonicNow = 0;

  constructor(
    readonly store: EntitlementStore,
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
    const observed = Math.floor((this.options.now ?? (() => Date.now() / 1000))());
    if (!Number.isFinite(observed)) {
      throw new TypeError("Service clock returned a non-finite timestamp");
    }
    this.#lastMonotonicNow = Math.max(this.#lastMonotonicNow, observed);
    return this.#lastMonotonicNow;
  }

  get sessionTtlSeconds(): number {
    return this.options.sessionTtlSeconds ?? 660;
  }

  get heartbeatAfterSeconds(): number {
    return this.options.heartbeatAfterSeconds ?? 300;
  }

  plans(): object {
    return {
      schemaVersion: 1,
      currency: "USD",
      billingPeriod: "month",
      plans: Object.values(PLAN_CATALOG),
    };
  }

  async issueAuthorization(input: {
    accountId: string;
    plan: PlanId;
    paidThrough?: number | null;
    serviceUrl: string;
  }): Promise<IssuedEntitlement & { authorization: object }> {
    if (!isPlanId(input.plan)) invalidRequest("Plan is invalid");
    const serviceUrl = new URL(input.serviceUrl);
    if (serviceUrl.protocol !== "https:") invalidRequest("Service URL must use HTTPS");
    const issued = await this.store.issueEntitlement({
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

  async updateAuthorization(licenseId: string, input: {
    plan?: unknown;
    status?: unknown;
    paidThrough?: unknown;
  }): Promise<void> {
    const plan = input.plan === undefined ? undefined : isPlanId(input.plan) ? input.plan : invalidRequest("Plan is invalid");
    const statuses = new Set<unknown>(["active", "hold", "revoked"]);
    const status = input.status === undefined ? undefined : statuses.has(input.status)
      ? input.status as EntitlementStatus
      : invalidRequest("Status is invalid");
    const paidThrough = input.paidThrough === undefined ? undefined
      : input.paidThrough === null || Number.isSafeInteger(input.paidThrough)
        ? input.paidThrough as number | null
        : invalidRequest("Paid-through time is invalid");
    await this.store.updateEntitlement(licenseId, {
      ...(plan === undefined ? {} : { plan }),
      ...(status === undefined ? {} : { status }),
      ...(paidThrough === undefined ? {} : { paidThrough }),
      now: this.now,
    });
  }

  async revokeRuntimeSessions(input: { target?: unknown }): Promise<RuntimeRevocationResponse> {
    const target = validateRuntimeRevocationTarget(input.target);
    const result = await this.store.revokeRuntimeSessions({
      target,
      now: this.now,
    });
    return {
      schemaVersion: 1,
      target: result.target,
      revokedSessions: result.revokedSessions,
      effectiveAt: result.effectiveAt,
    };
  }

  async createSession(licenseKey: string, request: unknown): Promise<SessionGrant> {
    const input = validateSessionRequest(request);
    const entitlement = await this.store.authenticateLicenseKey(licenseKey);
    const selection = this.catalog.select(input.platform, input.arch, input.sdkVersion, {
      ...(input.versionPolicy === undefined ? {} : { versionPolicy: input.versionPolicy }),
      ...(input.browserVersion === undefined ? {} : { browserVersion: input.browserVersion }),
      kernelMajor: input.kernelMajor,
      updateKernel: input.updateKernel,
    });
    let reservation: Reservation | undefined;
    try {
      reservation = await this.store.reserve({
        licenseId: entitlement.license_id,
        ...(input.deviceHash === undefined ? {} : { deviceHash: input.deviceHash }),
        platform: input.platform,
        arch: input.arch,
        browserVersion: selection.manifest.browserVersion,
        artifactSha256: selection.artifact.sha256,
        requiredFeatures: requiredFeaturesForBackend("project-webdriver"),
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
        features: featuresForPlan(reservation.plan),
        concurrencyLimit: reservation.concurrencyLimit,
        activeSessions: reservation.activeSessions,
        browserVersion: reservation.browserVersion,
        ...(selection.requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: selection.requestedBrowserVersion }),
        requestedKernelMajor: selection.requestedKernelMajor,
        versionPolicy: selection.versionPolicy,
        selectionReason: selection.selectionReason,
        selectionMode: selection.selectionMode,
        availableBrowserVersions: selection.availableBrowserVersions,
        latestAvailableVersion: selection.latestAvailableVersion,
        updateAvailable: selection.updateAvailable,
        updateRequired: selection.updateRequired,
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
      if (reservation) await this.store.release(reservation.sessionToken, this.now);
      throw error;
    }
  }

  async licenseInfo(licenseKey: string, request: unknown): Promise<LicenseInfoResponse> {
    const input = validateSessionRequest(request);
    const entitlement = await this.store.authenticateLicenseKey(licenseKey);
    if (!isPlanId(entitlement.plan) || !new Set(["active", "hold", "revoked"]).has(entitlement.status)) {
      throw new ServiceError("license_invalid", "License state is invalid", 403);
    }
    const contractPlan = entitlement.plan;
    const licenseStatus = entitlement.status as EntitlementStatus;
    if (entitlement.status === "hold") throw new ServiceError("license_on_hold", "License is on hold", 403);
    if (entitlement.status === "revoked") throw new ServiceError("license_revoked", "License is revoked", 403);
    const selection = this.catalog.select(input.platform, input.arch, input.sdkVersion, {
      ...(input.versionPolicy === undefined ? {} : { versionPolicy: input.versionPolicy }),
      ...(input.browserVersion === undefined ? {} : { browserVersion: input.browserVersion }),
      kernelMajor: input.kernelMajor,
      updateKernel: input.updateKernel,
    });
    const effective = effectivePlan(contractPlan, entitlement.paid_through, this.now);
    const activeSessions = await this.store.activeCount(entitlement.license_id, this.now);
    const concurrencyLimit = PLAN_CATALOG[effective].concurrency;
    const availableSessions = Math.max(0, concurrencyLimit - activeSessions);
    return {
      schemaVersion: 1,
      channel: "stable",
      licenseStatus,
      plan: contractPlan,
      effectivePlan: effective,
      paidThrough: entitlement.paid_through,
      features: featuresForPlan(effective),
      concurrencyLimit,
      activeSessions,
      availableSessions,
      sessionState: {
        activeBrowserProcesses: activeSessions,
        limit: concurrencyLimit,
        available: availableSessions,
      },
      browserVersion: selection.manifest.browserVersion,
      ...(selection.requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: selection.requestedBrowserVersion }),
      requestedKernelMajor: selection.requestedKernelMajor,
      versionPolicy: selection.versionPolicy,
      selectionReason: selection.selectionReason,
      selectionMode: selection.selectionMode,
      availableBrowserVersions: selection.availableBrowserVersions,
      latestAvailableVersion: selection.latestAvailableVersion,
      updateAvailable: selection.updateAvailable,
      updateRequired: selection.updateRequired,
      updateRights: {
        status: "active",
        channel: "stable",
        updatesThrough: entitlement.paid_through,
        exactVersion: true,
        rollback: true,
      },
      stableErrorCode: null,
    };
  }

  async createRuntimeSession(licenseKey: string, request: unknown): Promise<RuntimeSessionGrant> {
    const input = validateRuntimeSessionRequest(request);
    const entitlement = await this.store.authenticateLicenseKey(licenseKey);
    const selection = this.catalog.select(input.platform, input.arch, input.sdkVersion, {
      ...(input.versionPolicy === undefined ? {} : { versionPolicy: input.versionPolicy }),
      ...(input.browserVersion === undefined ? {} : { browserVersion: input.browserVersion }),
      kernelMajor: input.kernelMajor,
      updateKernel: input.updateKernel,
    });
    const reservation = await this.store.reserveRuntime({
      licenseId: entitlement.license_id,
      startupId: input.startupId,
      ...(input.deviceHash === undefined ? {} : { deviceHash: input.deviceHash }),
      platform: input.platform,
      arch: input.arch,
      browserVersion: selection.manifest.browserVersion,
      artifactSha256: selection.artifact.sha256,
      requiredFeatures: requiredFeaturesForBackend(input.automationBackend),
      includeDriverRuntime: input.automationBackend === "project-webdriver",
      now: this.now,
      ttlSeconds: this.sessionTtlSeconds,
    });
    return {
      schemaVersion: 2,
      state: reservation.state,
      startupId: reservation.startupId,
      sessionId: reservation.sessionId,
      bootstrapToken: reservation.bootstrapToken,
      activationTicket: reservation.activationTicket,
      ...(reservation.driverActivationTicket === undefined ? {} : { driverActivationTicket: reservation.driverActivationTicket }),
      heartbeatAfterSeconds: this.heartbeatAfterSeconds,
      expiresAt: reservation.expiresAt,
      plan: reservation.plan,
      features: featuresForPlan(reservation.plan),
      concurrencyLimit: reservation.concurrencyLimit,
      activeSessions: reservation.activeSessions,
      browserVersion: reservation.browserVersion,
      ...(selection.requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: selection.requestedBrowserVersion }),
      requestedKernelMajor: selection.requestedKernelMajor,
      versionPolicy: selection.versionPolicy,
      selectionReason: selection.selectionReason,
      selectionMode: selection.selectionMode,
      availableBrowserVersions: selection.availableBrowserVersions,
      latestAvailableVersion: selection.latestAvailableVersion,
      updateAvailable: selection.updateAvailable,
      updateRequired: selection.updateRequired,
      updateRights: {
        status: "active",
        channel: "stable",
        updatesThrough: entitlement.paid_through,
        exactVersion: true,
        rollback: true,
      },
      lease: this.#lease(reservation),
      manifest: selection.manifest,
      downloadTicket: {
        token: reservation.downloadTicket,
        expiresAt: reservation.expiresAt,
        artifactSha256: selection.artifact.sha256,
        artifactUrl: selection.artifact.url,
      },
    };
  }

  async heartbeat(sessionId: string, sessionToken: string): Promise<HeartbeatGrant> {
    const reservation = await this.store.heartbeat(sessionToken, this.now, this.sessionTtlSeconds, sessionId);
    try {
      this.#assertArtifactAvailable(reservation);
    } catch (error) {
      await Promise.resolve(this.store.release(sessionToken, this.now, sessionId)).catch(() => undefined);
      throw error;
    }
    return {
      schemaVersion: 1,
      sessionId: reservation.sessionId,
      heartbeatAfterSeconds: this.heartbeatAfterSeconds,
      expiresAt: reservation.expiresAt,
      plan: reservation.plan,
      features: featuresForPlan(reservation.plan),
      concurrencyLimit: reservation.concurrencyLimit,
      activeSessions: reservation.activeSessions,
      lease: this.#lease(reservation),
    };
  }

  async bootstrapHeartbeat(sessionId: string, bootstrapToken: string): Promise<RuntimeHeartbeatGrant> {
    const reservation = await this.store.bootstrapHeartbeat(sessionId, bootstrapToken, this.now, this.sessionTtlSeconds);
    try {
      this.#assertArtifactAvailable(reservation);
    } catch (error) {
      await Promise.resolve(this.store.releaseRuntime(sessionId, bootstrapToken, this.now)).catch(() => undefined);
      throw error;
    }
    return this.#runtimeHeartbeatGrant(reservation);
  }

  async activateRuntimeSession(sessionId: string, activationTicket: string): Promise<RuntimeActivationGrant> {
    const activated = await this.store.activateRuntime(sessionId, activationTicket, this.now, this.sessionTtlSeconds);
    try {
      this.#assertArtifactAvailable(activated);
    } catch (error) {
      await Promise.resolve(this.store.releaseRuntime(sessionId, activated.runtimeToken, this.now)).catch(() => undefined);
      throw error;
    }
    return {
      schemaVersion: 2,
      state: "active",
      startupId: activated.startupId,
      sessionId: activated.sessionId,
      runtimeToken: activated.runtimeToken,
      heartbeatAfterSeconds: this.heartbeatAfterSeconds,
      expiresAt: activated.expiresAt,
      plan: activated.plan,
      features: featuresForPlan(activated.plan),
      concurrencyLimit: activated.concurrencyLimit,
      activeSessions: activated.activeSessions,
      lease: this.#lease(activated),
    };
  }

  async runtimeHeartbeat(sessionId: string, runtimeToken: string): Promise<RuntimeHeartbeatGrant> {
    const reservation = await this.store.runtimeHeartbeat(sessionId, runtimeToken, this.now, this.sessionTtlSeconds);
    try {
      this.#assertArtifactAvailable(reservation);
    } catch (error) {
      await Promise.resolve(this.store.releaseRuntime(sessionId, runtimeToken, this.now)).catch(() => undefined);
      throw error;
    }
    return this.#runtimeHeartbeatGrant(reservation);
  }

  async closeRuntimeSession(sessionId: string, runtimeToken: string): Promise<RuntimeHeartbeatGrant> {
    return this.#runtimeHeartbeatGrant(await this.store.closeRuntime(sessionId, runtimeToken, this.now));
  }

  async release(sessionId: string, sessionToken: string): Promise<void> {
    await this.store.release(sessionToken, this.now, sessionId);
  }

  async releaseRuntimeSession(sessionId: string, token: string): Promise<void> {
    await this.store.releaseRuntime(sessionId, token, this.now);
  }

  async recordSecurityEvent(input: Omit<LicenseSecurityEventInput, "now">): Promise<void> {
    await this.store.recordSecurityEvent({ ...input, now: this.now });
  }

  async pruneSecurityEvents(now = this.now): Promise<number> {
    return this.store.pruneSecurityEvents(now);
  }

  async authorizeArtifact(sessionToken: string, artifact: CatalogArtifact): Promise<void> {
    await this.store.authorizeSession(sessionToken, artifact.sha256, this.now);
  }

  async authorizeDownloadTicket(downloadTicket: string, artifact: CatalogArtifact): Promise<void> {
    await this.store.authorizeDownloadTicket(downloadTicket, artifact.sha256, this.now);
  }

  #assertArtifactAvailable(reservation: Reservation): void {
    this.catalog.assertArtifactAvailable(reservation.browserVersion, reservation.artifactSha256);
  }

  #lease(reservation: Reservation): LicenseEnvelope {
    const now = this.now;
    const artifact = this.catalog.assertArtifactAvailable(reservation.browserVersion, reservation.artifactSha256);
    return this.signer.sign({
      schemaVersion: 2,
      licenseId: reservation.licenseId,
      audience: "slybrowser",
      issuedAt: now,
      notBefore: now,
      expiresAt: reservation.expiresAt,
      browserVersion: reservation.browserVersion,
      browserMin: reservation.browserVersion,
      browserMax: reservation.browserVersion,
      planId: reservation.plan,
      concurrencyLimit: reservation.concurrencyLimit,
      paidThrough: reservation.paidThrough,
      licenseStatus: reservation.licenseStatus,
      artifactSha256: reservation.artifactSha256,
      browserSha256: artifact.browserSha256,
      driverSha256: artifact.driverSha256,
      artifact: {
        sha256: reservation.artifactSha256,
        platform: artifact.platform,
        arch: artifact.arch,
        archiveFormat: artifact.archiveFormat,
        browserExecutable: artifact.browserExecutable,
        driverExecutable: artifact.driverExecutable,
        browserSha256: artifact.browserSha256,
        driverSha256: artifact.driverSha256,
        privateModules: artifact.privateModules.map((module) => ({
          path: module.path,
          sha256: module.sha256,
          size: module.size,
          abi: module.abi,
        })),
        resources: artifact.resources.map((resource) => ({
          path: resource.path,
          sha256: resource.sha256,
          size: resource.size,
        })),
        ...(artifact.codeSignature === undefined ? {} : {
          codeSignature: {
            scheme: artifact.codeSignature.scheme,
            subject: artifact.codeSignature.subject,
            certificateSha256: artifact.codeSignature.certificateSha256,
            timestampRequired: artifact.codeSignature.timestampRequired,
          },
        }),
      },
      leaseGeneration: reservation.leaseGeneration,
      features: [...featuresForPlan(reservation.plan)],
      sessionId: reservation.sessionId,
      nonce: LeaseSigner.nonce(),
      ...(reservation.deviceHash === undefined ? {} : { deviceHash: reservation.deviceHash }),
    });
  }

  #runtimeHeartbeatGrant(reservation: RuntimeReservation | RuntimeActivation | RuntimeHeartbeat): RuntimeHeartbeatGrant {
    return {
      schemaVersion: 2,
      state: reservation.state,
      startupId: reservation.startupId,
      sessionId: reservation.sessionId,
      heartbeatAfterSeconds: this.heartbeatAfterSeconds,
      expiresAt: reservation.expiresAt,
      plan: reservation.plan,
      features: featuresForPlan(reservation.plan),
      concurrencyLimit: reservation.concurrencyLimit,
      activeSessions: reservation.activeSessions,
      lease: this.#lease(reservation),
    };
  }
}
