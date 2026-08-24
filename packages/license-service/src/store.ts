import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ServiceError, type LicenseServiceErrorCode } from "./errors.js";
import { effectivePlan, isPlanId, missingPlanFeatures, PLAN_CATALOG, type FeatureId, type PlanId } from "./plans.js";

export type EntitlementStatus = "active" | "hold" | "revoked";
export type RuntimeSessionState = "reserved" | "active" | "closing" | "released" | "expired" | "denied";
type RuntimeTokenKind = "bootstrap" | "activation" | "runtime" | "driver-activation" | "driver-runtime" | "download";

export interface EntitlementRecord {
  license_id: string;
  account_id: string;
  plan: string;
  status: string;
  paid_through: number | null;
  key_hash: Uint8Array;
}

interface SessionRow {
  session_id: string;
  license_id: string;
  token_hash: Uint8Array;
  device_hash: string | null;
  platform: string;
  arch: string;
  browser_version: string;
  artifact_sha256: string;
  required_features: string | null;
  startup_id: string | null;
  state: RuntimeSessionState | null;
  runtime_token_hash: Uint8Array | null;
  activation_token_hash: Uint8Array | null;
  driver_runtime_token_hash: Uint8Array | null;
  driver_activation_token_hash: Uint8Array | null;
  download_token_hash: Uint8Array | null;
  token_expires_at: number | null;
  activated_at: number | null;
  closing_at: number | null;
  lease_generation: number | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  released_at: number | null;
}

export interface IssuedEntitlement {
  licenseId: string;
  licenseKey: string;
  accountId: string;
  plan: PlanId;
  paidThrough: number | null;
}

export interface Reservation {
  sessionId: string;
  sessionToken: string;
  licenseId: string;
  accountId: string;
  plan: PlanId;
  paidThrough: number | null;
  licenseStatus: EntitlementStatus;
  concurrencyLimit: number;
  activeSessions: number;
  expiresAt: number;
  leaseGeneration: number;
  browserVersion: string;
  artifactSha256: string;
  platform: string;
  arch: string;
  deviceHash?: string;
}

export interface RuntimeReservation extends Reservation {
  startupId: string;
  state: "reserved" | "active" | "closing";
  bootstrapToken: string;
  activationTicket: string;
  driverActivationTicket?: string;
  downloadTicket: string;
}

export interface RuntimeActivation extends Reservation {
  startupId: string;
  state: "active";
  runtimeToken: string;
}

export interface RuntimeHeartbeat extends Reservation {
  startupId: string;
  state: "reserved" | "active" | "closing";
}

export interface SessionAuthorization {
  sessionId: string;
  licenseId: string;
  browserVersion: string;
  artifactSha256: string;
  expiresAt: number;
}

export type RuntimeRevocationTarget =
  | { scope: "session"; sessionId: string }
  | { scope: "artifact"; artifactSha256: string }
  | { scope: "release"; browserVersion: string }
  | { scope: "channel"; channel: "stable" }
  | { scope: "feature"; feature: FeatureId };

export interface RuntimeRevocationInput {
  target: RuntimeRevocationTarget;
  now: number;
}

export interface RuntimeRevocationResult {
  target: RuntimeRevocationTarget;
  revokedSessions: number;
  effectiveAt: number;
}

interface RuntimeTokenBinding {
  sessionId: string;
  licenseId: string;
  startupId: string;
  deviceHash: string | null;
  platform: string;
  arch: string;
  browserVersion: string;
  artifactSha256: string;
  requiredFeatures: string | null;
  createdAt: number;
  tokenExpiresAt: number;
}

export function sessionLimitError(plan: PlanId, activeSessions?: number, message?: string): ServiceError {
  const limit = PLAN_CATALOG[plan].concurrency;
  return new ServiceError(
    "session_limit",
    message ?? `The ${PLAN_CATALOG[plan].name} plan allows ${limit} concurrent browser process${limit === 1 ? "" : "es"}`,
    409,
    {
      state: "denied",
      concurrencyLimit: limit,
      ...(activeSessions === undefined ? {} : { activeSessions }),
      availableSessions: activeSessions === undefined ? 0 : Math.max(0, limit - activeSessions),
      actions: [
        {
          type: "close_session",
          label: "Close an existing browser session, wait for release, then retry.",
          api: "DELETE /v2/runtime/sessions/{sessionId}",
          authorization: "Runtime <runtimeToken> or Bootstrap <bootstrapToken>",
        },
        {
          type: "upgrade_plan",
          label: "Upgrade to a plan with a higher browser-process concurrency limit.",
          url: "https://slybrowser.com/#pricing",
        },
      ],
    },
  );
}

export type LicenseSecurityEventKind =
  | "authorization_denied"
  | "request_replay"
  | "signature_or_hash_error"
  | "abnormal_session_recovery";

export interface LicenseSecurityEventInput {
  kind: LicenseSecurityEventKind;
  code: LicenseServiceErrorCode;
  operation: string;
  httpStatus?: number;
  subjectKind?: string;
  subject?: string;
  ip?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  now: number;
  retentionSeconds?: number;
}

export type MaybePromise<T> = T | Promise<T>;

export interface EntitlementStore {
  close(): void | Promise<void>;
  issueEntitlement(input: {
    accountId: string;
    plan: PlanId;
    paidThrough?: number | null;
    now: number;
  }): MaybePromise<IssuedEntitlement>;
  updateEntitlement(licenseId: string, input: {
    plan?: PlanId;
    status?: EntitlementStatus;
    paidThrough?: number | null;
    now: number;
  }): MaybePromise<void>;
  authenticateLicenseKey(licenseKey: string): MaybePromise<EntitlementRecord>;
  reserve(input: {
    licenseId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    now: number;
    ttlSeconds: number;
  }): MaybePromise<Reservation>;
  reserveRuntime(input: {
    licenseId: string;
    startupId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    includeDriverRuntime?: boolean;
    now: number;
    ttlSeconds: number;
  }): MaybePromise<RuntimeReservation>;
  bootstrapHeartbeat(sessionId: string, bootstrapToken: string, now: number, ttlSeconds: number): MaybePromise<RuntimeHeartbeat>;
  activateRuntime(sessionId: string, activationTicket: string, now: number, ttlSeconds: number): MaybePromise<RuntimeActivation>;
  runtimeHeartbeat(sessionId: string, runtimeToken: string, now: number, ttlSeconds: number): MaybePromise<RuntimeHeartbeat>;
  closeRuntime(sessionId: string, runtimeToken: string, now: number): MaybePromise<RuntimeHeartbeat>;
  releaseRuntime(sessionId: string, token: string, now: number): MaybePromise<void>;
  heartbeat(sessionToken: string, now: number, ttlSeconds: number, expectedSessionId?: string): MaybePromise<Reservation>;
  release(sessionToken: string, now: number, expectedSessionId?: string): MaybePromise<void>;
  authorizeSession(sessionToken: string, artifactSha256: string, now: number): MaybePromise<SessionAuthorization>;
  authorizeDownloadTicket(downloadTicket: string, artifactSha256: string, now: number): MaybePromise<SessionAuthorization>;
  activeCount(licenseId: string, now: number): MaybePromise<number>;
  revokeRuntimeSessions(input: RuntimeRevocationInput): MaybePromise<RuntimeRevocationResult>;
  recordSecurityEvent(input: LicenseSecurityEventInput): MaybePromise<void>;
  pruneSecurityEvents(now: number): MaybePromise<number>;
}

const SECURITY_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

function safeText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum);
}

function redactedDetails(value: Record<string, unknown> | undefined): string {
  if (!value) return "{}";
  const redacted = Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/authorization|credential|email|fingerprint|key|license|secret|ticket|token/i.test(key)) {
      return [key, "[redacted]"];
    }
    if (typeof item === "string") return [key, safeText(item, 256)];
    if (typeof item === "number" && Number.isFinite(item)) return [key, item];
    if (typeof item === "boolean" || item === null) return [key, item];
    if (Array.isArray(item)) {
      return [key, item.slice(0, 16).map((entry) => typeof entry === "string" ? safeText(entry, 128) : entry)];
    }
    return [key, "[object]"];
  }));
  return JSON.stringify(redacted);
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class LicenseStore {
  readonly #database: DatabaseSync;
  readonly #pepper: Buffer;

  constructor(path: string, pepper: Uint8Array) {
    if (pepper.length < 32) throw new TypeError("License key pepper must contain at least 32 bytes");
    this.#pepper = Buffer.from(pepper);
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS entitlements (
        license_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        paid_through INTEGER,
        key_hash BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS license_sessions (
        session_id TEXT PRIMARY KEY,
        license_id TEXT NOT NULL REFERENCES entitlements(license_id),
        token_hash BLOB NOT NULL UNIQUE,
        device_hash TEXT,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        browser_version TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        required_features TEXT,
        startup_id TEXT,
        state TEXT,
        runtime_token_hash BLOB,
        activation_token_hash BLOB,
        driver_runtime_token_hash BLOB,
        driver_activation_token_hash BLOB,
        download_token_hash BLOB,
        token_expires_at INTEGER,
        activated_at INTEGER,
        closing_at INTEGER,
        lease_generation INTEGER,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS license_sessions_active
        ON license_sessions(license_id, released_at, expires_at);
      CREATE INDEX IF NOT EXISTS license_sessions_startup
        ON license_sessions(license_id, startup_id, released_at, expires_at);
      CREATE TABLE IF NOT EXISTS license_security_events (
        event_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        code TEXT NOT NULL,
        operation TEXT NOT NULL,
        http_status INTEGER,
        subject_kind TEXT,
        subject_hash BLOB,
        ip_hash BLOB,
        user_agent_hash BLOB,
        details TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS license_security_events_expires
        ON license_security_events(expires_at);
      CREATE INDEX IF NOT EXISTS license_security_events_kind_created
        ON license_security_events(kind, created_at DESC);
    `);
    this.#ensureColumn("startup_id", "TEXT");
    this.#ensureColumn("state", "TEXT");
    this.#ensureColumn("runtime_token_hash", "BLOB");
    this.#ensureColumn("activation_token_hash", "BLOB");
    this.#ensureColumn("driver_runtime_token_hash", "BLOB");
    this.#ensureColumn("driver_activation_token_hash", "BLOB");
    this.#ensureColumn("download_token_hash", "BLOB");
    this.#ensureColumn("token_expires_at", "INTEGER");
    this.#ensureColumn("required_features", "TEXT");
    this.#ensureColumn("activated_at", "INTEGER");
    this.#ensureColumn("closing_at", "INTEGER");
    this.#ensureColumn("lease_generation", "INTEGER");
  }

  close(): void {
    this.#database.close();
  }

  #hash(value: string): Buffer {
    return createHmac("sha256", this.#pepper).update(value, "utf8").digest();
  }

  #legacyRuntimeToken(kind: RuntimeTokenKind, sessionId: string, startupId: string, createdAt: number): string {
    return createHmac("sha256", this.#pepper)
      .update(`slybrowser:${kind}:${sessionId}:${startupId}:${createdAt}`, "utf8")
      .digest("base64url");
  }

  #runtimeToken(kind: RuntimeTokenKind, binding: RuntimeTokenBinding): string {
    return createHmac("sha256", this.#pepper)
      .update(JSON.stringify({
        schemaVersion: 2,
        purpose: "slybrowser-runtime-token",
        kind,
        sessionId: binding.sessionId,
        licenseId: binding.licenseId,
        startupId: binding.startupId,
        deviceHash: binding.deviceHash ?? "",
        platform: binding.platform,
        arch: binding.arch,
        browserVersion: binding.browserVersion,
        artifactSha256: binding.artifactSha256,
        requiredFeatures: binding.requiredFeatures ?? "[]",
        createdAt: binding.createdAt,
        tokenExpiresAt: binding.tokenExpiresAt,
      }), "utf8")
      .digest("base64url");
  }

  issueEntitlement(input: {
    accountId: string;
    plan: PlanId;
    paidThrough?: number | null;
    now: number;
  }): IssuedEntitlement {
    if (!input.accountId || input.accountId.length > 256) throw new ServiceError("invalid_request", "Account ID is invalid", 400);
    const paidThrough = input.plan === "free" ? null : input.paidThrough ?? null;
    if (input.plan !== "free" && (paidThrough === null || paidThrough <= input.now)) {
      throw new ServiceError("invalid_request", "Paid plans require a future paid-through time", 400);
    }
    const licenseId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const licenseKey = `sly_live_${licenseId}.${secret}`;
    this.#database.prepare(`
      INSERT INTO entitlements
        (license_id, account_id, plan, status, paid_through, key_hash, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(licenseId, input.accountId, input.plan, paidThrough, this.#hash(secret), input.now, input.now);
    return { licenseId, licenseKey, accountId: input.accountId, plan: input.plan, paidThrough };
  }

  updateEntitlement(licenseId: string, input: {
    plan?: PlanId;
    status?: EntitlementStatus;
    paidThrough?: number | null;
    now: number;
  }): void {
    const current = this.#entitlement(licenseId);
    if (!current) throw new ServiceError("license_not_found", "License does not exist", 404);
    const plan = input.plan ?? current.plan;
    if (!isPlanId(plan)) throw new ServiceError("invalid_request", "Plan is invalid", 400);
    const status = input.status ?? current.status;
    if (!new Set(["active", "hold", "revoked"]).has(status)) throw new ServiceError("invalid_request", "Status is invalid", 400);
    if (current.status === "revoked" && status !== "revoked") {
      throw new ServiceError("license_revoked", "Revoked licenses cannot be restored by standard authorization update", 409);
    }
    const paidThrough = plan === "free" ? null : input.paidThrough === undefined ? current.paid_through : input.paidThrough;
    if (plan !== "free" && (paidThrough === null || paidThrough <= input.now)) {
      throw new ServiceError("invalid_request", "Paid plans require a future paid-through time", 400);
    }
    this.#database.prepare(`
      UPDATE entitlements SET plan=?, status=?, paid_through=?, updated_at=? WHERE license_id=?
    `).run(plan, status, paidThrough, input.now, licenseId);
  }

  authenticateLicenseKey(licenseKey: string): EntitlementRecord {
    const match = /^sly_live_([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/.exec(licenseKey);
    if (!match) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
    const licenseId = match[1]!;
    const secret = match[2]!;
    const row = this.#entitlement(licenseId);
    const actual = this.#hash(secret);
    const expected = row ? asBuffer(row.key_hash) : Buffer.alloc(actual.length);
    if (!timingSafeEqual(actual, expected) || !row) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
    return row;
  }

  reserve(input: {
    licenseId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    now: number;
    ttlSeconds: number;
  }): Reservation {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(input.now);
      const entitlement = this.#entitlement(input.licenseId);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
      const plan = this.#assertEntitlement(entitlement, input.now);
      this.#assertFeaturesAvailable(plan, input.requiredFeatures);
      const limit = PLAN_CATALOG[plan].concurrency;
      const active = this.#activeCount(input.licenseId, input.now);
      if (active >= limit) {
        throw sessionLimitError(plan, active);
      }
      const sessionId = randomUUID();
      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = input.now + input.ttlSeconds;
      this.#database.prepare(`
        INSERT INTO license_sessions
          (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
           artifact_sha256, required_features, lease_generation, created_at, last_seen_at, expires_at, released_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(sessionId, input.licenseId, this.#hash(sessionToken), input.deviceHash ?? null,
        input.platform, input.arch, input.browserVersion, input.artifactSha256,
        this.#encodeRequiredFeatures(input.requiredFeatures),
        expiresAt, input.now, input.now, expiresAt);
      this.#database.exec("COMMIT");
      return {
        sessionId,
        sessionToken,
        licenseId: input.licenseId,
        accountId: entitlement.account_id,
        plan,
        paidThrough: entitlement.paid_through,
        licenseStatus: entitlement.status as EntitlementStatus,
        concurrencyLimit: limit,
        activeSessions: active + 1,
        expiresAt,
        leaseGeneration: expiresAt,
        browserVersion: input.browserVersion,
        artifactSha256: input.artifactSha256,
        platform: input.platform,
        arch: input.arch,
        ...(input.deviceHash === undefined ? {} : { deviceHash: input.deviceHash }),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  reserveRuntime(input: {
    licenseId: string;
    startupId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    includeDriverRuntime?: boolean;
    now: number;
    ttlSeconds: number;
  }): RuntimeReservation {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(input.now);
      const entitlement = this.#entitlement(input.licenseId);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
      const plan = this.#assertEntitlement(entitlement, input.now);
      this.#assertFeaturesAvailable(plan, input.requiredFeatures);
      const limit = PLAN_CATALOG[plan].concurrency;
      const existing = this.#sessionByStartup(input.licenseId, input.startupId, input.now);
      if (existing && existing.state !== "released" && existing.state !== "expired") {
        this.#assertRuntimeBindingMatches(existing, input);
        this.#assertSessionFeaturesAvailable(plan, existing);
        const activeSessions = this.#activeCount(input.licenseId, input.now);
        this.#database.exec("COMMIT");
        return this.#runtimeReservation(existing, this.#assertRuntimeState(existing, ["reserved", "active", "closing"]), entitlement, plan, limit, activeSessions);
      }
      const active = this.#activeCount(input.licenseId, input.now);
      if (active >= limit) {
        this.#recordDeniedRuntime(input);
        this.#database.exec("COMMIT");
        throw sessionLimitError(plan, active);
      }
      const sessionId = randomUUID();
      const createdAt = input.now;
      const expiresAt = input.now + input.ttlSeconds;
      const requiredFeatures = this.#encodeRequiredFeatures(input.requiredFeatures);
      const tokenBinding = {
        sessionId,
        licenseId: input.licenseId,
        startupId: input.startupId,
        deviceHash: input.deviceHash ?? null,
        platform: input.platform,
        arch: input.arch,
        browserVersion: input.browserVersion,
        artifactSha256: input.artifactSha256,
        requiredFeatures,
        createdAt,
        tokenExpiresAt: expiresAt,
      };
      const bootstrapToken = this.#runtimeToken("bootstrap", tokenBinding);
      const activationTicket = this.#runtimeToken("activation", tokenBinding);
      const driverActivationTicket = input.includeDriverRuntime ? this.#runtimeToken("driver-activation", tokenBinding) : undefined;
      const downloadTicket = this.#runtimeToken("download", tokenBinding);
      this.#database.prepare(`
        INSERT INTO license_sessions
          (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
           artifact_sha256, required_features, startup_id, state, runtime_token_hash, activation_token_hash,
           driver_runtime_token_hash, driver_activation_token_hash, download_token_hash,
           token_expires_at, activated_at, closing_at, lease_generation, created_at, last_seen_at, expires_at, released_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)
      `).run(sessionId, input.licenseId, this.#hash(bootstrapToken), input.deviceHash ?? null,
        input.platform, input.arch, input.browserVersion, input.artifactSha256,
        requiredFeatures,
        input.startupId, this.#hash(activationTicket),
        driverActivationTicket === undefined ? null : this.#hash(driverActivationTicket),
        this.#hash(downloadTicket), expiresAt, expiresAt, createdAt, input.now, expiresAt);
      const session = this.#sessionById(sessionId);
      if (!session) throw new ServiceError("session_invalid", "License session is invalid", 500);
      this.#database.exec("COMMIT");
      return this.#runtimeReservation(session, "reserved", entitlement, plan, limit, active + 1);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // A fail-closed denied audit row is committed before returning the session_limit error.
      }
      throw error;
    }
  }

  bootstrapHeartbeat(sessionId: string, bootstrapToken: string, now: number, ttlSeconds: number): RuntimeHeartbeat {
    return this.#touchRuntime(sessionId, bootstrapToken, now, ttlSeconds, "bootstrap", ["reserved"]);
  }

  activateRuntime(sessionId: string, activationTicket: string, now: number, ttlSeconds: number): RuntimeActivation {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(now);
      const session = this.#sessionById(sessionId);
      const processRole = session ? this.#activationTicketRole(session, activationTicket) : null;
      if (!session || session.released_at !== null || session.expires_at <= now || processRole === null) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      if (session.state !== "reserved" && session.state !== "active") {
        throw new ServiceError("session_state_invalid", "Runtime session state is invalid", 409);
      }
      if (processRole === "browser" && !session.activation_token_hash && session.state !== "reserved") {
        throw new ServiceError("session_activation_invalid", "Runtime activation is one-time", 409);
      }
      if (processRole === "driver" && !session.driver_activation_token_hash) {
        throw new ServiceError("session_activation_invalid", "Runtime activation is one-time", 409);
      }
      const entitlement = this.#entitlement(session.license_id);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      this.#assertSessionFeaturesAvailable(plan, session);
      const limit = PLAN_CATALOG[plan].concurrency;
      const expiresAt = now + ttlSeconds;
      const runtimeToken = this.#runtimeToken(processRole === "driver" ? "driver-runtime" : "runtime", this.#runtimeTokenBinding(session, expiresAt));
      const leaseGeneration = this.#nextLeaseGeneration(session, expiresAt);
      if (processRole === "driver") {
        this.#database.prepare(`
          UPDATE license_sessions
          SET state='active', driver_runtime_token_hash=?, driver_activation_token_hash=NULL,
              activated_at=COALESCE(activated_at, ?), last_seen_at=?, expires_at=?, lease_generation=?
          WHERE session_id=?
        `).run(this.#hash(runtimeToken), now, now, expiresAt, leaseGeneration, session.session_id);
      } else {
        this.#database.prepare(`
          UPDATE license_sessions
          SET state='active', runtime_token_hash=?, activation_token_hash=NULL,
              activated_at=COALESCE(activated_at, ?), last_seen_at=?, expires_at=?, lease_generation=?
          WHERE session_id=?
        `).run(this.#hash(runtimeToken), now, now, expiresAt, leaseGeneration, session.session_id);
      }
      const active = this.#activeCount(session.license_id, now);
      this.#database.exec("COMMIT");
      return {
        ...this.#reservation(session, entitlement, plan, limit, active, expiresAt, leaseGeneration),
        startupId: session.startup_id ?? "",
        state: "active",
        runtimeToken,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  runtimeHeartbeat(sessionId: string, runtimeToken: string, now: number, ttlSeconds: number): RuntimeHeartbeat {
    return this.#touchRuntime(sessionId, runtimeToken, now, ttlSeconds, "runtime", ["active"]);
  }

  closeRuntime(sessionId: string, runtimeToken: string, now: number): RuntimeHeartbeat {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(now);
      const session = this.#sessionById(sessionId);
      if (!session || session.released_at !== null || session.expires_at <= now ||
          !this.#matchesRuntimeToken(session, runtimeToken)) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      if (session.state !== "active" && session.state !== "closing") {
        throw new ServiceError("session_state_invalid", "Runtime session state is invalid", 409);
      }
      const leaseGeneration = this.#nextLeaseGeneration(session, session.expires_at);
      this.#database.prepare("UPDATE license_sessions SET state='closing', closing_at=?, last_seen_at=?, lease_generation=? WHERE session_id=?")
        .run(now, now, leaseGeneration, session.session_id);
      const entitlement = this.#entitlement(session.license_id);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      const active = this.#activeCount(session.license_id, now);
      this.#database.exec("COMMIT");
      return {
        ...this.#reservation(session, entitlement, plan, PLAN_CATALOG[plan].concurrency, active, session.expires_at, leaseGeneration),
        startupId: session.startup_id ?? "",
        state: "closing",
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseRuntime(sessionId: string, token: string, now: number): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(now);
      const session = this.#sessionById(sessionId);
      const tokenHash = this.#hash(token);
      const matchesBootstrap = session?.state === "reserved" ? timingSafeEqual(tokenHash, asBuffer(session.token_hash)) : false;
      const matchesRuntime = session ? this.#matchesRuntimeTokenHash(session, tokenHash) : false;
      if (!session || session.released_at !== null || (!matchesBootstrap && !matchesRuntime)) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      this.#database.prepare("UPDATE license_sessions SET state='released', released_at=?, expires_at=? WHERE session_id=?")
        .run(now, now, session.session_id);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(sessionToken: string, now: number, ttlSeconds: number, expectedSessionId?: string): Reservation {
    let committed = false;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(now);
      const session = this.#sessionByToken(sessionToken);
      if (!session || session.released_at !== null || session.expires_at <= now) {
        throw new ServiceError("session_expired", "License session has expired", 401);
      }
      if (expectedSessionId !== undefined && session.session_id !== expectedSessionId) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      const entitlement = this.#entitlement(session.license_id);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      if (!this.#sessionFeaturesAvailable(plan, session)) {
        this.#database.prepare("UPDATE license_sessions SET released_at=?, expires_at=?, state=COALESCE(state, 'released') WHERE session_id=?")
          .run(now, now, session.session_id);
        this.#database.exec("COMMIT");
        committed = true;
        throw this.#featureDenied(plan, session);
      }
      const limit = PLAN_CATALOG[plan].concurrency;
      const rank = this.#rank(session, now);
      if (rank > limit) {
        this.#database.prepare("UPDATE license_sessions SET released_at=?, expires_at=?, state=COALESCE(state, 'released') WHERE session_id=?")
          .run(now, now, session.session_id);
        this.#database.exec("COMMIT");
        committed = true;
        throw sessionLimitError(plan, this.#activeCount(session.license_id, now), "This session exceeds the current plan concurrency");
      }
      const expiresAt = now + ttlSeconds;
      const leaseGeneration = this.#nextLeaseGeneration(session, expiresAt);
      this.#database.prepare("UPDATE license_sessions SET last_seen_at=?, expires_at=?, lease_generation=? WHERE session_id=?")
        .run(now, expiresAt, leaseGeneration, session.session_id);
      const active = this.#activeCount(session.license_id, now);
      this.#database.exec("COMMIT");
      return {
        sessionId: session.session_id,
        sessionToken,
        licenseId: session.license_id,
        accountId: entitlement.account_id,
        plan,
        paidThrough: entitlement.paid_through,
        licenseStatus: entitlement.status as EntitlementStatus,
        concurrencyLimit: limit,
        activeSessions: active,
        expiresAt,
        leaseGeneration,
        browserVersion: session.browser_version,
        artifactSha256: session.artifact_sha256,
        platform: session.platform,
        arch: session.arch,
        ...(session.device_hash === null ? {} : { deviceHash: session.device_hash }),
      };
    } catch (error) {
      if (!committed) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  release(sessionToken: string, now: number, expectedSessionId?: string): void {
    const session = this.#sessionByToken(sessionToken);
    if (!session) throw new ServiceError("session_invalid", "License session is invalid", 401);
    if (expectedSessionId !== undefined && session.session_id !== expectedSessionId) {
      throw new ServiceError("session_invalid", "License session is invalid", 401);
    }
    if (session.released_at === null) {
      this.#database.prepare("UPDATE license_sessions SET released_at=?, expires_at=? WHERE session_id=?")
        .run(now, now, session.session_id);
    }
  }

  authorizeSession(sessionToken: string, artifactSha256: string, now: number): SessionAuthorization {
    const session = this.#sessionByToken(sessionToken);
    if (!session || session.released_at !== null || session.expires_at <= now) {
      throw new ServiceError("session_expired", "License session has expired", 401);
    }
    const entitlement = this.#entitlement(session.license_id);
    if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
    const plan = this.#assertEntitlement(entitlement, now);
    this.#assertSessionFeaturesAvailable(plan, session);
    if (session.artifact_sha256 !== artifactSha256) {
      throw new ServiceError("artifact_denied", "This session is not authorized for the requested artifact", 403);
    }
    return {
      sessionId: session.session_id,
      licenseId: session.license_id,
      browserVersion: session.browser_version,
      artifactSha256: session.artifact_sha256,
      expiresAt: session.expires_at,
    };
  }

  authorizeDownloadTicket(downloadTicket: string, artifactSha256: string, now: number): SessionAuthorization {
    const session = this.#sessionByDownloadTicket(downloadTicket);
    if (!session || session.released_at !== null || session.expires_at <= now ||
        !new Set<RuntimeSessionState | null>(["reserved", "active"]).has(session.state)) {
      throw new ServiceError("download_ticket_expired", "Download ticket has expired", 401);
    }
    const entitlement = this.#entitlement(session.license_id);
    if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
    const plan = this.#assertEntitlement(entitlement, now);
    this.#assertSessionFeaturesAvailable(plan, session);
    if (session.artifact_sha256 !== artifactSha256) {
      throw new ServiceError("artifact_denied", "This download ticket is not authorized for the requested artifact", 403);
    }
    return {
      sessionId: session.session_id,
      licenseId: session.license_id,
      browserVersion: session.browser_version,
      artifactSha256: session.artifact_sha256,
      expiresAt: session.expires_at,
    };
  }

  activeCount(licenseId: string, now: number): number {
    this.#expire(now);
    return this.#activeCount(licenseId, now);
  }

  revokeRuntimeSessions(input: RuntimeRevocationInput): RuntimeRevocationResult {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(input.now);
      const sessions = this.#database.prepare(`
        SELECT * FROM license_sessions
        WHERE released_at IS NULL AND expires_at>?
          AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
      `).all(input.now) as unknown as SessionRow[];
      let revokedSessions = 0;
      const update = this.#database.prepare(`
        UPDATE license_sessions
        SET state='denied', released_at=?, expires_at=?, last_seen_at=?
        WHERE session_id=? AND released_at IS NULL
      `);
      for (const session of sessions) {
        if (!this.#matchesRevocationTarget(session, input.target)) continue;
        const result = update.run(input.now, input.now, input.now, session.session_id);
        revokedSessions += Number(result.changes ?? 0);
      }
      this.#database.exec("COMMIT");
      return { target: input.target, revokedSessions, effectiveAt: input.now };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  recordSecurityEvent(input: LicenseSecurityEventInput): void {
    this.#recordSecurityEvent(input);
  }

  pruneSecurityEvents(now: number): number {
    const result = this.#database.prepare("DELETE FROM license_security_events WHERE expires_at<=?").run(now);
    return Number(result.changes ?? 0);
  }

  #entitlement(licenseId: string): EntitlementRecord | undefined {
    return this.#database.prepare("SELECT * FROM entitlements WHERE license_id=?").get(licenseId) as EntitlementRecord | undefined;
  }

  #sessionByToken(sessionToken: string): SessionRow | undefined {
    return this.#database.prepare("SELECT * FROM license_sessions WHERE token_hash=?")
      .get(this.#hash(sessionToken)) as SessionRow | undefined;
  }

  #sessionById(sessionId: string): SessionRow | undefined {
    return this.#database.prepare("SELECT * FROM license_sessions WHERE session_id=?")
      .get(sessionId) as SessionRow | undefined;
  }

  #sessionByStartup(licenseId: string, startupId: string, now: number): SessionRow | undefined {
    return this.#database.prepare(`
      SELECT * FROM license_sessions
      WHERE license_id=? AND startup_id=? AND released_at IS NULL AND expires_at>?
      ORDER BY created_at ASC LIMIT 1
    `).get(licenseId, startupId, now) as SessionRow | undefined;
  }

  #sessionByDownloadTicket(downloadTicket: string): SessionRow | undefined {
    return this.#database.prepare("SELECT * FROM license_sessions WHERE download_token_hash=?")
      .get(this.#hash(downloadTicket)) as SessionRow | undefined;
  }

  #assertEntitlement(entitlement: EntitlementRecord, now: number): PlanId {
    if (entitlement.status === "hold") throw new ServiceError("license_on_hold", "License is on hold", 403);
    if (entitlement.status === "revoked") throw new ServiceError("license_revoked", "License is revoked", 403);
    if (entitlement.status !== "active" || !isPlanId(entitlement.plan)) {
      throw new ServiceError("license_invalid", "License state is invalid", 403);
    }
    return effectivePlan(entitlement.plan, entitlement.paid_through, now);
  }

  #activeCount(licenseId: string, now: number): number {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM license_sessions
      WHERE license_id=? AND released_at IS NULL AND expires_at>?
        AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
    `).get(licenseId, now) as { count: number };
    return Number(row.count);
  }

  #recordDeniedRuntime(input: {
    licenseId: string;
    startupId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    now: number;
  }): void {
    this.#database.prepare(`
      INSERT INTO license_sessions
        (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
         artifact_sha256, required_features, startup_id, state, runtime_token_hash, activation_token_hash, download_token_hash,
         token_expires_at, activated_at, closing_at, lease_generation, created_at, last_seen_at, expires_at, released_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'denied', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.licenseId,
      this.#hash(randomBytes(32).toString("base64url")),
      input.deviceHash ?? null,
      input.platform,
      input.arch,
      input.browserVersion,
      input.artifactSha256,
      this.#encodeRequiredFeatures(input.requiredFeatures),
      input.startupId,
      input.now,
      input.now,
      input.now,
      input.now,
      input.now,
    );
  }

  #encodeRequiredFeatures(features: readonly FeatureId[]): string {
    return JSON.stringify([...new Set(features)]);
  }

  #requiredFeatures(session: SessionRow): string[] {
    if (session.required_features === null) return [];
    try {
      const parsed: unknown = JSON.parse(session.required_features);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.length > 0 && item.length <= 128)) {
        return [...new Set(parsed)];
      }
    } catch {
      // Report below.
    }
    throw new ServiceError("store_corrupt", "Stored session feature contract is invalid", 500);
  }

  #sessionFeaturesAvailable(plan: PlanId, session: SessionRow): boolean {
    return missingPlanFeatures(plan, this.#requiredFeatures(session)).length === 0;
  }

  #matchesRevocationTarget(session: SessionRow, target: RuntimeRevocationTarget): boolean {
    switch (target.scope) {
      case "session":
        return session.session_id === target.sessionId;
      case "artifact":
        return session.artifact_sha256 === target.artifactSha256;
      case "release":
        return session.browser_version === target.browserVersion;
      case "channel":
        return target.channel === "stable";
      case "feature":
        return this.#requiredFeatures(session).includes(target.feature);
    }
  }

  #assertFeaturesAvailable(plan: PlanId, requiredFeatures: readonly string[]): void {
    const missing = missingPlanFeatures(plan, requiredFeatures);
    if (missing.length > 0) {
      throw new ServiceError(
        "license_feature_denied",
        `The ${PLAN_CATALOG[plan].name} plan does not grant: ${missing.join(", ")}`,
        403,
        { features: missing },
      );
    }
  }

  #assertSessionFeaturesAvailable(plan: PlanId, session: SessionRow): void {
    this.#assertFeaturesAvailable(plan, this.#requiredFeatures(session));
  }

  #assertRuntimeBindingMatches(session: SessionRow, input: {
    licenseId: string;
    startupId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
  }): void {
    const expectedRequiredFeatures = this.#encodeRequiredFeatures(input.requiredFeatures);
    if (session.license_id !== input.licenseId ||
        (session.startup_id ?? "") !== input.startupId ||
        session.device_hash !== (input.deviceHash ?? null) ||
        session.platform !== input.platform ||
        session.arch !== input.arch ||
        session.browser_version !== input.browserVersion ||
        session.artifact_sha256 !== input.artifactSha256 ||
        (session.required_features ?? "[]") !== expectedRequiredFeatures) {
      throw new ServiceError("session_invalid", "Runtime startup binding does not match the existing session", 401, {
        state: "denied",
        reason: "startup_binding_mismatch",
      });
    }
  }

  #featureDenied(plan: PlanId, session: SessionRow): ServiceError {
    const missing = missingPlanFeatures(plan, this.#requiredFeatures(session));
    return new ServiceError(
      "license_feature_denied",
      `The ${PLAN_CATALOG[plan].name} plan no longer grants: ${missing.join(", ")}`,
      403,
      { features: missing, state: "denied" },
    );
  }

  #expire(now: number): void {
    const expired = this.#database.prepare(`
      SELECT license_id, state, expires_at
      FROM license_sessions
      WHERE released_at IS NULL AND expires_at<=?
        AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
    `).all(now) as Array<{ license_id: string; state: string | null; expires_at: number }>;
    this.#database.prepare(`
      UPDATE license_sessions SET released_at=expires_at, state='expired'
      WHERE released_at IS NULL AND expires_at<=?
    `).run(now);
    for (const row of expired) {
      this.#recordSecurityEvent({
        kind: "abnormal_session_recovery",
        code: "session_expired",
        operation: "session_expire",
        subjectKind: "license",
        subject: row.license_id,
        details: {
          previousState: row.state ?? "legacy",
          expiredAt: row.expires_at,
        },
        now,
      });
    }
  }

  #recordSecurityEvent(input: LicenseSecurityEventInput): void {
    const now = input.now;
    const retentionSeconds = input.retentionSeconds ?? SECURITY_EVENT_RETENTION_SECONDS;
    this.#database.prepare(`
      INSERT INTO license_security_events
        (event_id, kind, code, operation, http_status, subject_kind, subject_hash, ip_hash,
         user_agent_hash, details, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.kind,
      input.code,
      safeText(input.operation, 128) ?? "unknown",
      input.httpStatus ?? null,
      safeText(input.subjectKind, 32) ?? null,
      input.subject === undefined ? null : this.#hash(`subject:${input.subject}`),
      input.ip === undefined ? null : this.#hash(`ip:${input.ip}`),
      input.userAgent === undefined ? null : this.#hash(`ua:${input.userAgent}`),
      redactedDetails(input.details),
      now,
      now + retentionSeconds,
    );
  }

  #reservation(
    session: SessionRow,
    entitlement: EntitlementRecord,
    plan: PlanId,
    concurrencyLimit: number,
    activeSessions: number,
    expiresAt = session.expires_at,
    leaseGeneration = session.lease_generation ?? expiresAt,
  ): Reservation {
    return {
      sessionId: session.session_id,
      sessionToken: "",
      licenseId: session.license_id,
      accountId: entitlement.account_id,
      plan,
      paidThrough: entitlement.paid_through,
      licenseStatus: entitlement.status as EntitlementStatus,
      concurrencyLimit,
      activeSessions,
      expiresAt,
      leaseGeneration,
      browserVersion: session.browser_version,
      artifactSha256: session.artifact_sha256,
      platform: session.platform,
      arch: session.arch,
      ...(session.device_hash === null ? {} : { deviceHash: session.device_hash }),
    };
  }

  #runtimeReservation(
    session: SessionRow,
    state: "reserved" | "active" | "closing",
    entitlement: EntitlementRecord,
    plan: PlanId,
    concurrencyLimit: number,
    activeSessions: number,
  ): RuntimeReservation {
    const startupId = session.startup_id ?? "";
    return {
      ...this.#reservation(session, entitlement, plan, concurrencyLimit, activeSessions),
      sessionToken: "",
      startupId,
      state,
      bootstrapToken: this.#runtimeTokenForSession("bootstrap", session),
      activationTicket: session.activation_token_hash
        ? this.#runtimeTokenForSession("activation", session)
        : this.#runtimeTokenForSession("bootstrap", session),
      ...(session.driver_activation_token_hash
        ? { driverActivationTicket: this.#runtimeTokenForSession("driver-activation", session) }
        : {}),
      downloadTicket: this.#runtimeTokenForSession("download", session),
    };
  }

  #runtimeTokenBinding(session: SessionRow, tokenExpiresAt: number): RuntimeTokenBinding {
    return {
      sessionId: session.session_id,
      licenseId: session.license_id,
      startupId: session.startup_id ?? "",
      deviceHash: session.device_hash,
      platform: session.platform,
      arch: session.arch,
      browserVersion: session.browser_version,
      artifactSha256: session.artifact_sha256,
      requiredFeatures: session.required_features,
      createdAt: session.created_at,
      tokenExpiresAt,
    };
  }

  #runtimeTokenForSession(kind: RuntimeTokenKind, session: SessionRow): string {
    const startupId = session.startup_id ?? "";
    if (session.token_expires_at === null) {
      return this.#legacyRuntimeToken(kind, session.session_id, startupId, session.created_at);
    }
    return this.#runtimeToken(kind, this.#runtimeTokenBinding(session, session.token_expires_at));
  }

  #activationTicketRole(session: SessionRow, activationTicket: string): "browser" | "driver" | null {
    const tokenHash = this.#hash(activationTicket);
    const browserExpected = session.activation_token_hash ?? (session.state === "reserved" ? session.token_hash : null);
    if (browserExpected && timingSafeEqual(tokenHash, asBuffer(browserExpected))) return "browser";
    if (session.driver_activation_token_hash && timingSafeEqual(tokenHash, asBuffer(session.driver_activation_token_hash))) return "driver";
    return null;
  }

  #matchesRuntimeToken(session: SessionRow, runtimeToken: string): boolean {
    return this.#matchesRuntimeTokenHash(session, this.#hash(runtimeToken));
  }

  #matchesRuntimeTokenHash(session: SessionRow, tokenHash: Buffer): boolean {
    if (session.state !== "active" && session.state !== "closing") return false;
    if (session.runtime_token_hash && timingSafeEqual(tokenHash, asBuffer(session.runtime_token_hash))) return true;
    return !!session.driver_runtime_token_hash && timingSafeEqual(tokenHash, asBuffer(session.driver_runtime_token_hash));
  }

  #assertRuntimeState(session: SessionRow, allowed: Array<"reserved" | "active" | "closing">): "reserved" | "active" | "closing" {
    if (session.state === "reserved" || session.state === "active" || session.state === "closing") {
      if (allowed.includes(session.state)) return session.state;
    }
    throw new ServiceError("session_state_invalid", "Runtime session state is invalid", 409);
  }

  #touchRuntime(
    sessionId: string,
    token: string,
    now: number,
    ttlSeconds: number,
    tokenKind: "bootstrap" | "runtime",
    states: Array<"reserved" | "active">,
  ): RuntimeHeartbeat {
    let committed = false;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(now);
      const session = this.#sessionById(sessionId);
      const tokenHash = this.#hash(token);
      const matchesToken = tokenKind === "bootstrap"
        ? !!session && timingSafeEqual(tokenHash, asBuffer(session.token_hash))
        : !!session && this.#matchesRuntimeTokenHash(session, tokenHash);
      if (!session || session.released_at !== null || session.expires_at <= now || !matchesToken) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      const state = this.#assertRuntimeState(session, states);
      const entitlement = this.#entitlement(session.license_id);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      const limit = PLAN_CATALOG[plan].concurrency;
      if (!this.#sessionFeaturesAvailable(plan, session)) {
        this.#database.prepare("UPDATE license_sessions SET state='denied', released_at=?, expires_at=?, last_seen_at=? WHERE session_id=?")
          .run(now, now, now, session.session_id);
        this.#database.exec("COMMIT");
        committed = true;
        throw this.#featureDenied(plan, session);
      }
      const rank = this.#rank(session, now);
      if (rank > limit) {
        this.#database.prepare("UPDATE license_sessions SET state='denied', released_at=?, expires_at=?, last_seen_at=? WHERE session_id=?")
          .run(now, now, now, session.session_id);
        this.#database.exec("COMMIT");
        committed = true;
        throw sessionLimitError(plan, this.#activeCount(session.license_id, now), "This session exceeds the current plan concurrency");
      }
      const expiresAt = now + ttlSeconds;
      const leaseGeneration = this.#nextLeaseGeneration(session, expiresAt);
      this.#database.prepare("UPDATE license_sessions SET last_seen_at=?, expires_at=?, lease_generation=? WHERE session_id=?")
        .run(now, expiresAt, leaseGeneration, session.session_id);
      const active = this.#activeCount(session.license_id, now);
      this.#database.exec("COMMIT");
      return {
        ...this.#reservation(session, entitlement, plan, PLAN_CATALOG[plan].concurrency, active, expiresAt, leaseGeneration),
        startupId: session.startup_id ?? "",
        state,
      };
    } catch (error) {
      if (!committed) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #rank(session: SessionRow, now: number): number {
    const rankAt = session.activated_at ?? session.created_at;
    return Number((this.#database.prepare(`
      SELECT COUNT(*) AS count FROM license_sessions
      WHERE license_id=? AND released_at IS NULL AND expires_at>?
        AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
        AND (
          COALESCE(activated_at, created_at) < ?
          OR (COALESCE(activated_at, created_at) = ? AND session_id <= ?)
        )
    `).get(session.license_id, now, rankAt, rankAt, session.session_id) as { count: number }).count);
  }

  #nextLeaseGeneration(session: SessionRow, expiresAt: number): number {
    return Math.max((session.lease_generation ?? session.expires_at) + 1, expiresAt);
  }

  #ensureColumn(name: string, definition: string): void {
    try {
      this.#database.exec(`ALTER TABLE license_sessions ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      if (!String((error as Error).message).toLowerCase().includes("duplicate column")) throw error;
    }
  }
}
