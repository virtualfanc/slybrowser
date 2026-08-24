import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

import { ServiceError } from "./errors.js";
import { effectivePlan, isPlanId, missingPlanFeatures, PLAN_CATALOG, type FeatureId, type PlanId } from "./plans.js";
import {
  sessionLimitError,
  type EntitlementRecord,
  type EntitlementStatus,
  type EntitlementStore,
  type IssuedEntitlement,
  type LicenseSecurityEventInput,
  type Reservation,
  type RuntimeRevocationInput,
  type RuntimeRevocationResult,
  type RuntimeActivation,
  type RuntimeHeartbeat,
  type RuntimeReservation,
  type RuntimeRevocationTarget,
  type RuntimeSessionState,
  type SessionAuthorization,
} from "./store.js";

import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof import("pg");
const ADVISORY_LOCK_CLASS = 915_752_941;
const SECURITY_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
type RuntimeTokenKind = "bootstrap" | "activation" | "runtime" | "driver-activation" | "driver-runtime" | "download";

interface SessionRow {
  session_id: string;
  license_id: string;
  token_hash: Buffer;
  device_hash: string | null;
  platform: string;
  arch: string;
  browser_version: string;
  artifact_sha256: string;
  required_features: string | null;
  startup_id: string | null;
  state: RuntimeSessionState | null;
  runtime_token_hash: Buffer | null;
  activation_token_hash: Buffer | null;
  driver_runtime_token_hash: Buffer | null;
  driver_activation_token_hash: Buffer | null;
  download_token_hash: Buffer | null;
  token_expires_at: number | null;
  activated_at: number | null;
  closing_at: number | null;
  lease_generation: number | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  released_at: number | null;
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

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function integer(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new ServiceError("store_corrupt", "Stored integer value is invalid", 500);
  return result;
}

function optionalInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : integer(value);
}

function entitlementRow(row: Record<string, unknown> | undefined): EntitlementRecord | undefined {
  if (!row) return undefined;
  return {
    license_id: String(row.license_id),
    account_id: String(row.account_id),
    plan: String(row.plan),
    status: String(row.status),
    paid_through: optionalInteger(row.paid_through),
    key_hash: asBuffer(row.key_hash as Uint8Array),
  };
}

function sessionRow(row: Record<string, unknown> | undefined): SessionRow | undefined {
  if (!row) return undefined;
  return {
    session_id: String(row.session_id),
    license_id: String(row.license_id),
    token_hash: asBuffer(row.token_hash as Uint8Array),
    device_hash: row.device_hash === null ? null : String(row.device_hash),
    platform: String(row.platform),
    arch: String(row.arch),
    browser_version: String(row.browser_version),
    artifact_sha256: String(row.artifact_sha256),
    required_features: row.required_features === null || row.required_features === undefined ? null : String(row.required_features),
    startup_id: row.startup_id === null ? null : String(row.startup_id),
    state: row.state === null ? null : row.state as RuntimeSessionState,
    runtime_token_hash: row.runtime_token_hash === null ? null : asBuffer(row.runtime_token_hash as Uint8Array),
    activation_token_hash: row.activation_token_hash === null ? null : asBuffer(row.activation_token_hash as Uint8Array),
    driver_runtime_token_hash: row.driver_runtime_token_hash === null || row.driver_runtime_token_hash === undefined
      ? null
      : asBuffer(row.driver_runtime_token_hash as Uint8Array),
    driver_activation_token_hash: row.driver_activation_token_hash === null || row.driver_activation_token_hash === undefined
      ? null
      : asBuffer(row.driver_activation_token_hash as Uint8Array),
    download_token_hash: row.download_token_hash === null ? null : asBuffer(row.download_token_hash as Uint8Array),
    token_expires_at: optionalInteger(row.token_expires_at),
    activated_at: optionalInteger(row.activated_at),
    closing_at: optionalInteger(row.closing_at),
    lease_generation: optionalInteger(row.lease_generation),
    created_at: integer(row.created_at),
    last_seen_at: integer(row.last_seen_at),
    expires_at: integer(row.expires_at),
    released_at: optionalInteger(row.released_at),
  };
}

function secretEqual(actual: Buffer, expected: Uint8Array | null | undefined): boolean {
  if (!expected) return false;
  const right = asBuffer(expected);
  return actual.length === right.length && timingSafeEqual(actual, right);
}

function safeText(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum);
}

function redactedDetails(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
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
}

export class PostgresLicenseStore implements EntitlementStore {
  readonly #pool: PgPool;
  readonly #pepper: Buffer;

  private constructor(pool: PgPool, pepper: Uint8Array) {
    if (pepper.length < 32) throw new TypeError("License key pepper must contain at least 32 bytes");
    this.#pool = pool;
    this.#pepper = Buffer.from(pepper);
  }

  static async connect(config: PoolConfig | string, pepper: Uint8Array): Promise<PostgresLicenseStore> {
    const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
    const store = new PostgresLicenseStore(pool, pepper);
    try {
      await store.initialize();
      return store;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async initialize(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS entitlements (
        license_id UUID PRIMARY KEY,
        account_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        paid_through BIGINT,
        key_hash BYTEA NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS license_sessions (
        session_id UUID PRIMARY KEY,
        license_id UUID NOT NULL REFERENCES entitlements(license_id),
        token_hash BYTEA NOT NULL UNIQUE,
        device_hash TEXT,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        browser_version TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL,
        required_features TEXT,
        startup_id TEXT,
        state TEXT,
        runtime_token_hash BYTEA UNIQUE,
        activation_token_hash BYTEA UNIQUE,
        driver_runtime_token_hash BYTEA UNIQUE,
        driver_activation_token_hash BYTEA UNIQUE,
        download_token_hash BYTEA UNIQUE,
        token_expires_at BIGINT,
        activated_at BIGINT,
        closing_at BIGINT,
        lease_generation BIGINT,
        created_at BIGINT NOT NULL,
        last_seen_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        released_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS license_sessions_active
        ON license_sessions(license_id, released_at, expires_at);
      CREATE INDEX IF NOT EXISTS license_sessions_startup
        ON license_sessions(license_id, startup_id, released_at, expires_at);
      ALTER TABLE license_sessions ADD COLUMN IF NOT EXISTS required_features TEXT;
      ALTER TABLE license_sessions ADD COLUMN IF NOT EXISTS activation_token_hash BYTEA;
      ALTER TABLE license_sessions ADD COLUMN IF NOT EXISTS driver_runtime_token_hash BYTEA;
      ALTER TABLE license_sessions ADD COLUMN IF NOT EXISTS driver_activation_token_hash BYTEA;
      ALTER TABLE license_sessions ADD COLUMN IF NOT EXISTS lease_generation BIGINT;
      ALTER TABLE license_sessions ADD COLUMN IF NOT EXISTS token_expires_at BIGINT;
      CREATE UNIQUE INDEX IF NOT EXISTS license_sessions_activation_token
        ON license_sessions(activation_token_hash)
        WHERE activation_token_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS license_sessions_driver_runtime_token
        ON license_sessions(driver_runtime_token_hash)
        WHERE driver_runtime_token_hash IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS license_sessions_driver_activation_token
        ON license_sessions(driver_activation_token_hash)
        WHERE driver_activation_token_hash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS license_security_events (
        event_id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        code TEXT NOT NULL,
        operation TEXT NOT NULL,
        http_status INTEGER,
        subject_kind TEXT,
        subject_hash BYTEA,
        ip_hash BYTEA,
        user_agent_hash BYTEA,
        details JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS license_security_events_expires
        ON license_security_events(expires_at);
      CREATE INDEX IF NOT EXISTS license_security_events_kind_created
        ON license_security_events(kind, created_at DESC);
    `);
  }

  async close(): Promise<void> {
    await this.#pool.end();
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

  async issueEntitlement(input: {
    accountId: string;
    plan: PlanId;
    paidThrough?: number | null;
    now: number;
  }): Promise<IssuedEntitlement> {
    if (!input.accountId || input.accountId.length > 256) throw new ServiceError("invalid_request", "Account ID is invalid", 400);
    const paidThrough = input.plan === "free" ? null : input.paidThrough ?? null;
    if (input.plan !== "free" && (paidThrough === null || paidThrough <= input.now)) {
      throw new ServiceError("invalid_request", "Paid plans require a future paid-through time", 400);
    }
    const licenseId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const licenseKey = `sly_live_${licenseId}.${secret}`;
    await this.#pool.query(`
      INSERT INTO entitlements
        (license_id, account_id, plan, status, paid_through, key_hash, created_at, updated_at)
      VALUES ($1, $2, $3, 'active', $4, $5, $6, $7)
    `, [licenseId, input.accountId, input.plan, paidThrough, this.#hash(secret), input.now, input.now]);
    return { licenseId, licenseKey, accountId: input.accountId, plan: input.plan, paidThrough };
  }

  async updateEntitlement(licenseId: string, input: {
    plan?: PlanId;
    status?: EntitlementStatus;
    paidThrough?: number | null;
    now: number;
  }): Promise<void> {
    await this.#transaction(licenseId, async (client) => {
      const current = await this.#entitlement(client, licenseId, true);
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
      await client.query(`
        UPDATE entitlements SET plan=$1, status=$2, paid_through=$3, updated_at=$4 WHERE license_id=$5
      `, [plan, status, paidThrough, input.now, licenseId]);
    });
  }

  async authenticateLicenseKey(licenseKey: string): Promise<EntitlementRecord> {
    const match = /^sly_live_([0-9a-f-]{36})\.([A-Za-z0-9_-]{40,})$/.exec(licenseKey);
    if (!match) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
    const licenseId = match[1]!;
    const secret = match[2]!;
    const row = await this.#entitlement(this.#pool, licenseId);
    const actual = this.#hash(secret);
    const expected = row ? asBuffer(row.key_hash) : Buffer.alloc(actual.length);
    if (!timingSafeEqual(actual, expected) || !row) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
    return row;
  }

  async reserve(input: {
    licenseId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    now: number;
    ttlSeconds: number;
  }): Promise<Reservation> {
    return this.#transaction(input.licenseId, async (client) => {
      await this.#expire(client, input.now, input.licenseId);
      const entitlement = await this.#entitlement(client, input.licenseId, true);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
      const plan = this.#assertEntitlement(entitlement, input.now);
      this.#assertFeaturesAvailable(plan, input.requiredFeatures);
      const limit = PLAN_CATALOG[plan].concurrency;
      const active = await this.#activeCount(client, input.licenseId, input.now);
      if (active >= limit) throw this.#sessionLimit(plan, active);
      const sessionId = randomUUID();
      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = input.now + input.ttlSeconds;
      await client.query(`
        INSERT INTO license_sessions
          (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
           artifact_sha256, required_features, lease_generation, created_at, last_seen_at, expires_at, released_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL)
      `, [sessionId, input.licenseId, this.#hash(sessionToken), input.deviceHash ?? null,
        input.platform, input.arch, input.browserVersion, input.artifactSha256,
        this.#encodeRequiredFeatures(input.requiredFeatures), expiresAt, input.now, input.now, expiresAt]);
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
    });
  }

  async reserveRuntime(input: {
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
  }): Promise<RuntimeReservation> {
    let deniedError: ServiceError | undefined;
    const reservation = await this.#transaction(input.licenseId, async (client) => {
      await this.#expire(client, input.now, input.licenseId);
      const entitlement = await this.#entitlement(client, input.licenseId, true);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
      const plan = this.#assertEntitlement(entitlement, input.now);
      this.#assertFeaturesAvailable(plan, input.requiredFeatures);
      const limit = PLAN_CATALOG[plan].concurrency;
      const existing = await this.#sessionByStartup(client, input.licenseId, input.startupId, input.now);
      if (existing && existing.state !== "released" && existing.state !== "expired") {
        this.#assertRuntimeBindingMatches(existing, input);
        this.#assertSessionFeaturesAvailable(plan, existing);
        const activeSessions = await this.#activeCount(client, input.licenseId, input.now);
        return this.#runtimeReservation(existing, this.#assertRuntimeState(existing, ["reserved", "active", "closing"]), entitlement, plan, limit, activeSessions);
      }
      const active = await this.#activeCount(client, input.licenseId, input.now);
      if (active >= limit) {
        await this.#recordDeniedRuntime(client, input);
        deniedError = this.#sessionLimit(plan, active);
        return undefined;
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
      await client.query(`
        INSERT INTO license_sessions
          (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
           artifact_sha256, required_features, startup_id, state, runtime_token_hash, activation_token_hash,
           driver_runtime_token_hash, driver_activation_token_hash, download_token_hash,
           token_expires_at, activated_at, closing_at, lease_generation, created_at, last_seen_at, expires_at, released_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', NULL, $11, NULL, $12, $13, $14, NULL, NULL, $15, $16, $17, $18, NULL)
      `, [sessionId, input.licenseId, this.#hash(bootstrapToken), input.deviceHash ?? null,
        input.platform, input.arch, input.browserVersion, input.artifactSha256,
        requiredFeatures,
        input.startupId, this.#hash(activationTicket),
        driverActivationTicket === undefined ? null : this.#hash(driverActivationTicket),
        this.#hash(downloadTicket), expiresAt, expiresAt, createdAt, input.now, expiresAt]);
      const session = await this.#sessionById(client, sessionId);
      if (!session) throw new ServiceError("session_invalid", "License session is invalid", 500);
      return this.#runtimeReservation(session, "reserved", entitlement, plan, limit, active + 1);
    });
    if (deniedError) throw deniedError;
    if (!reservation) throw new ServiceError("session_invalid", "License session is invalid", 500);
    return reservation;
  }

  async bootstrapHeartbeat(sessionId: string, bootstrapToken: string, now: number, ttlSeconds: number): Promise<RuntimeHeartbeat> {
    return this.#touchRuntime(sessionId, bootstrapToken, now, ttlSeconds, "bootstrap", ["reserved"]);
  }

  async activateRuntime(sessionId: string, activationTicket: string, now: number, ttlSeconds: number): Promise<RuntimeActivation> {
    return this.#withSessionLock(sessionId, now, async (client, session) => {
      const processRole = this.#activationTicketRole(session, activationTicket);
      if (processRole === null) {
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
      const entitlement = await this.#entitlement(client, session.license_id, true);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      this.#assertSessionFeaturesAvailable(plan, session);
      const limit = PLAN_CATALOG[plan].concurrency;
      const expiresAt = now + ttlSeconds;
      const runtimeToken = this.#runtimeToken(processRole === "driver" ? "driver-runtime" : "runtime", this.#runtimeTokenBinding(session, expiresAt));
      const leaseGeneration = this.#nextLeaseGeneration(session, expiresAt);
      if (processRole === "driver") {
        await client.query(`
          UPDATE license_sessions
          SET state='active', driver_runtime_token_hash=$1, driver_activation_token_hash=NULL,
              activated_at=COALESCE(activated_at, $2), last_seen_at=$3, expires_at=$4, lease_generation=$5
          WHERE session_id=$6
        `, [this.#hash(runtimeToken), now, now, expiresAt, leaseGeneration, session.session_id]);
      } else {
        await client.query(`
          UPDATE license_sessions
          SET state='active', runtime_token_hash=$1, activation_token_hash=NULL,
              activated_at=COALESCE(activated_at, $2), last_seen_at=$3, expires_at=$4, lease_generation=$5
          WHERE session_id=$6
        `, [this.#hash(runtimeToken), now, now, expiresAt, leaseGeneration, session.session_id]);
      }
      const active = await this.#activeCount(client, session.license_id, now);
      return {
        ...this.#reservation(session, entitlement, plan, limit, active, expiresAt, leaseGeneration),
        startupId: session.startup_id ?? "",
        state: "active",
        runtimeToken,
      };
    });
  }

  async runtimeHeartbeat(sessionId: string, runtimeToken: string, now: number, ttlSeconds: number): Promise<RuntimeHeartbeat> {
    return this.#touchRuntime(sessionId, runtimeToken, now, ttlSeconds, "runtime", ["active"]);
  }

  async closeRuntime(sessionId: string, runtimeToken: string, now: number): Promise<RuntimeHeartbeat> {
    return this.#withSessionLock(sessionId, now, async (client, session) => {
      if (!this.#matchesRuntimeToken(session, runtimeToken)) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      if (session.state !== "active" && session.state !== "closing") {
        throw new ServiceError("session_state_invalid", "Runtime session state is invalid", 409);
      }
      const leaseGeneration = this.#nextLeaseGeneration(session, session.expires_at);
      await client.query("UPDATE license_sessions SET state='closing', closing_at=$1, last_seen_at=$2, lease_generation=$3 WHERE session_id=$4",
        [now, now, leaseGeneration, session.session_id]);
      const entitlement = await this.#entitlement(client, session.license_id, true);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      const active = await this.#activeCount(client, session.license_id, now);
      return {
        ...this.#reservation(session, entitlement, plan, PLAN_CATALOG[plan].concurrency, active, session.expires_at, leaseGeneration),
        startupId: session.startup_id ?? "",
        state: "closing",
      };
    });
  }

  async releaseRuntime(sessionId: string, token: string, now: number): Promise<void> {
    await this.#withSessionLock(sessionId, now, async (client, session) => {
      const tokenHash = this.#hash(token);
      const matchesBootstrap = session.state === "reserved" && secretEqual(tokenHash, session.token_hash);
      const matchesRuntime = this.#matchesRuntimeTokenHash(session, tokenHash);
      if (!matchesBootstrap && !matchesRuntime) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      await client.query("UPDATE license_sessions SET state='released', released_at=$1, expires_at=$2 WHERE session_id=$3",
        [now, now, session.session_id]);
    });
  }

  async heartbeat(sessionToken: string, now: number, ttlSeconds: number, expectedSessionId?: string): Promise<Reservation> {
    const result = await this.#withTokenLock(sessionToken, now, async (client, session) => {
      if (expectedSessionId !== undefined && session.session_id !== expectedSessionId) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      const entitlement = await this.#entitlement(client, session.license_id, true);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      if (!this.#sessionFeaturesAvailable(plan, session)) {
        await client.query("UPDATE license_sessions SET released_at=$1, expires_at=$2, state=COALESCE(state, 'released') WHERE session_id=$3",
          [now, now, session.session_id]);
        return this.#featureDenied(plan, session);
      }
      const limit = PLAN_CATALOG[plan].concurrency;
      const rank = await this.#rank(client, session, now);
      if (rank > limit) {
        await client.query("UPDATE license_sessions SET released_at=$1, expires_at=$2, state=COALESCE(state, 'released') WHERE session_id=$3",
          [now, now, session.session_id]);
        const active = await this.#activeCount(client, session.license_id, now);
        return sessionLimitError(plan, active, "This session exceeds the current plan concurrency");
      }
      const expiresAt = now + ttlSeconds;
      const leaseGeneration = this.#nextLeaseGeneration(session, expiresAt);
      await client.query("UPDATE license_sessions SET last_seen_at=$1, expires_at=$2, lease_generation=$3 WHERE session_id=$4",
        [now, expiresAt, leaseGeneration, session.session_id]);
      const active = await this.#activeCount(client, session.license_id, now);
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
    });
    if (result instanceof ServiceError) throw result;
    return result;
  }

  async release(sessionToken: string, now: number, expectedSessionId?: string): Promise<void> {
    await this.#withTokenLock(sessionToken, now, async (client, session) => {
      if (expectedSessionId !== undefined && session.session_id !== expectedSessionId) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      await client.query("UPDATE license_sessions SET released_at=$1, expires_at=$2, state=COALESCE(state, 'released') WHERE session_id=$3",
        [now, now, session.session_id]);
    }, { allowExpired: true });
  }

  async authorizeSession(sessionToken: string, artifactSha256: string, now: number): Promise<SessionAuthorization> {
    const session = await this.#sessionByToken(this.#pool, sessionToken);
    if (!session || session.released_at !== null || session.expires_at <= now) {
      throw new ServiceError("session_expired", "License session has expired", 401);
    }
    const entitlement = await this.#entitlement(this.#pool, session.license_id);
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

  async authorizeDownloadTicket(downloadTicket: string, artifactSha256: string, now: number): Promise<SessionAuthorization> {
    const session = await this.#sessionByDownloadTicket(this.#pool, downloadTicket);
    if (!session || session.released_at !== null || session.expires_at <= now ||
        !new Set<RuntimeSessionState | null>(["reserved", "active"]).has(session.state)) {
      throw new ServiceError("download_ticket_expired", "Download ticket has expired", 401);
    }
    const entitlement = await this.#entitlement(this.#pool, session.license_id);
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

  async activeCount(licenseId: string, now: number): Promise<number> {
    return this.#transaction(licenseId, async (client) => {
      await this.#expire(client, now, licenseId);
      return this.#activeCount(client, licenseId, now);
    });
  }

  async revokeRuntimeSessions(input: RuntimeRevocationInput): Promise<RuntimeRevocationResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`
        SELECT * FROM license_sessions
        WHERE released_at IS NULL AND expires_at>$1
          AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
        FOR UPDATE
      `, [input.now]);
      let revokedSessions = 0;
      for (const row of rows) {
        const session = sessionRow(row);
        if (!session || !this.#matchesRevocationTarget(session, input.target)) continue;
        const result = await client.query(`
          UPDATE license_sessions
          SET state='denied', released_at=$1, expires_at=$1, last_seen_at=$1
          WHERE session_id=$2 AND released_at IS NULL
        `, [input.now, session.session_id]);
        revokedSessions += result.rowCount ?? 0;
      }
      await client.query("COMMIT");
      return { target: input.target, revokedSessions, effectiveAt: input.now };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordSecurityEvent(input: LicenseSecurityEventInput): Promise<void> {
    await this.#recordSecurityEvent(this.#pool, input);
  }

  async pruneSecurityEvents(now: number): Promise<number> {
    const result = await this.#pool.query("DELETE FROM license_security_events WHERE expires_at<=$1", [now]);
    return result.rowCount ?? 0;
  }

  async #transaction<T>(licenseId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#lockLicense(client, licenseId);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #withSessionLock<T>(
    sessionId: string,
    now: number,
    action: (client: PoolClient, session: SessionRow) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const initial = await this.#sessionById(client, sessionId);
      if (!initial || initial.released_at !== null || initial.expires_at <= now) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      await this.#lockLicense(client, initial.license_id);
      await this.#expire(client, now, initial.license_id);
      const session = await this.#sessionById(client, sessionId);
      if (!session || session.released_at !== null || session.expires_at <= now) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      const result = await action(client, session);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #withTokenLock<T>(
    sessionToken: string,
    now: number,
    action: (client: PoolClient, session: SessionRow) => Promise<T>,
    options: { allowExpired?: boolean } = {},
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const initial = await this.#sessionByToken(client, sessionToken);
      if (!initial || initial.released_at !== null || (!options.allowExpired && initial.expires_at <= now)) {
        throw new ServiceError(options.allowExpired ? "session_invalid" : "session_expired", "License session has expired", 401);
      }
      await this.#lockLicense(client, initial.license_id);
      await this.#expire(client, now, initial.license_id);
      const session = await this.#sessionById(client, initial.session_id);
      if (!session || session.released_at !== null || (!options.allowExpired && session.expires_at <= now)) {
        throw new ServiceError(options.allowExpired ? "session_invalid" : "session_expired", "License session has expired", 401);
      }
      const result = await action(client, session);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockLicense(client: PoolClient, licenseId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, licenseId]);
  }

  async #entitlement(client: PgPool | PoolClient, licenseId: string, forUpdate = false): Promise<EntitlementRecord | undefined> {
    const result = await client.query(`SELECT * FROM entitlements WHERE license_id=$1${forUpdate ? " FOR UPDATE" : ""}`, [licenseId]);
    return entitlementRow(result.rows[0] as Record<string, unknown> | undefined);
  }

  async #sessionByToken(client: PgPool | PoolClient, sessionToken: string): Promise<SessionRow | undefined> {
    const result = await client.query("SELECT * FROM license_sessions WHERE token_hash=$1", [this.#hash(sessionToken)]);
    return sessionRow(result.rows[0] as Record<string, unknown> | undefined);
  }

  async #sessionById(client: PgPool | PoolClient, sessionId: string): Promise<SessionRow | undefined> {
    const result = await client.query("SELECT * FROM license_sessions WHERE session_id=$1", [sessionId]);
    return sessionRow(result.rows[0] as Record<string, unknown> | undefined);
  }

  async #sessionByStartup(client: PgPool | PoolClient, licenseId: string, startupId: string, now: number): Promise<SessionRow | undefined> {
    const result = await client.query(`
      SELECT * FROM license_sessions
      WHERE license_id=$1 AND startup_id=$2 AND released_at IS NULL AND expires_at>$3
      ORDER BY created_at ASC LIMIT 1
    `, [licenseId, startupId, now]);
    return sessionRow(result.rows[0] as Record<string, unknown> | undefined);
  }

  async #sessionByDownloadTicket(client: PgPool | PoolClient, downloadTicket: string): Promise<SessionRow | undefined> {
    const result = await client.query("SELECT * FROM license_sessions WHERE download_token_hash=$1", [this.#hash(downloadTicket)]);
    return sessionRow(result.rows[0] as Record<string, unknown> | undefined);
  }

  #assertEntitlement(entitlement: EntitlementRecord, now: number): PlanId {
    if (entitlement.status === "hold") throw new ServiceError("license_on_hold", "License is on hold", 403);
    if (entitlement.status === "revoked") throw new ServiceError("license_revoked", "License is revoked", 403);
    if (entitlement.status !== "active" || !isPlanId(entitlement.plan)) {
      throw new ServiceError("license_invalid", "License state is invalid", 403);
    }
    return effectivePlan(entitlement.plan, entitlement.paid_through, now);
  }

  #sessionLimit(plan: PlanId, activeSessions?: number): ServiceError {
    return sessionLimitError(plan, activeSessions);
  }

  async #activeCount(client: PgPool | PoolClient, licenseId: string, now: number): Promise<number> {
    const result = await client.query(`
      SELECT COUNT(*) AS count FROM license_sessions
      WHERE license_id=$1 AND released_at IS NULL AND expires_at>$2
        AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
    `, [licenseId, now]);
    return integer((result.rows[0] as { count: unknown } | undefined)?.count ?? 0);
  }

  async #rank(client: PgPool | PoolClient, session: SessionRow, now: number): Promise<number> {
    const rankAt = session.activated_at ?? session.created_at;
    const result = await client.query(`
      SELECT COUNT(*) AS count FROM license_sessions
      WHERE license_id=$1 AND released_at IS NULL AND expires_at>$2
        AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
        AND (
          COALESCE(activated_at, created_at) < $3
          OR (COALESCE(activated_at, created_at) = $4 AND session_id <= $5)
        )
    `, [session.license_id, now, rankAt, rankAt, session.session_id]);
    return integer((result.rows[0] as { count: unknown } | undefined)?.count ?? 0);
  }

  #nextLeaseGeneration(session: SessionRow, expiresAt: number): number {
    return Math.max((session.lease_generation ?? session.expires_at) + 1, expiresAt);
  }

  async #recordDeniedRuntime(client: PoolClient, input: {
    licenseId: string;
    startupId: string;
    deviceHash?: string;
    platform: string;
    arch: string;
    browserVersion: string;
    artifactSha256: string;
    requiredFeatures: readonly FeatureId[];
    now: number;
  }): Promise<void> {
    await client.query(`
      INSERT INTO license_sessions
        (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
         artifact_sha256, required_features, startup_id, state, runtime_token_hash, activation_token_hash, download_token_hash,
         token_expires_at, activated_at, closing_at, lease_generation, created_at, last_seen_at, expires_at, released_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'denied', NULL, NULL, NULL, NULL, NULL, NULL, $11, $12, $13, $14, $15)
    `, [
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
    ]);
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

  async #expire(client: PgPool | PoolClient, now: number, licenseId: string): Promise<void> {
    const expired = await client.query<{ license_id: string; state: string | null; expires_at: number }>(`
      SELECT license_id, state, expires_at
      FROM license_sessions
      WHERE license_id=$1 AND released_at IS NULL AND expires_at<=$2
        AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
    `, [licenseId, now]);
    await client.query(`
      UPDATE license_sessions SET released_at=expires_at, state='expired'
      WHERE license_id=$1 AND released_at IS NULL AND expires_at<=$2
    `, [licenseId, now]);
    for (const row of expired.rows) {
      await this.#recordSecurityEvent(client, {
        kind: "abnormal_session_recovery",
        code: "session_expired",
        operation: "session_expire",
        subjectKind: "license",
        subject: row.license_id,
        details: {
          previousState: row.state ?? "legacy",
          expiredAt: integer(row.expires_at),
        },
        now,
      });
    }
  }

  async #recordSecurityEvent(client: PgPool | PoolClient, input: LicenseSecurityEventInput): Promise<void> {
    const now = input.now;
    const retentionSeconds = input.retentionSeconds ?? SECURITY_EVENT_RETENTION_SECONDS;
    await client.query(`
      INSERT INTO license_security_events
        (event_id, kind, code, operation, http_status, subject_kind, subject_hash, ip_hash,
         user_agent_hash, details, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
    `, [
      randomUUID(),
      input.kind,
      input.code,
      safeText(input.operation, 128) ?? "unknown",
      input.httpStatus ?? null,
      safeText(input.subjectKind, 32) ?? null,
      input.subject === undefined ? null : this.#hash(`subject:${input.subject}`),
      input.ip === undefined ? null : this.#hash(`ip:${input.ip}`),
      input.userAgent === undefined ? null : this.#hash(`ua:${input.userAgent}`),
      JSON.stringify(redactedDetails(input.details)),
      now,
      now + retentionSeconds,
    ]);
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
    if (secretEqual(tokenHash, session.activation_token_hash ?? (session.state === "reserved" ? session.token_hash : null))) return "browser";
    if (secretEqual(tokenHash, session.driver_activation_token_hash)) return "driver";
    return null;
  }

  #matchesRuntimeToken(session: SessionRow, runtimeToken: string): boolean {
    return this.#matchesRuntimeTokenHash(session, this.#hash(runtimeToken));
  }

  #matchesRuntimeTokenHash(session: SessionRow, tokenHash: Buffer): boolean {
    if (session.state !== "active" && session.state !== "closing") return false;
    return secretEqual(tokenHash, session.runtime_token_hash) || secretEqual(tokenHash, session.driver_runtime_token_hash);
  }

  #assertRuntimeState(session: SessionRow, allowed: Array<"reserved" | "active" | "closing">): "reserved" | "active" | "closing" {
    if (session.state === "reserved" || session.state === "active" || session.state === "closing") {
      if (allowed.includes(session.state)) return session.state;
    }
    throw new ServiceError("session_state_invalid", "Runtime session state is invalid", 409);
  }

  async #touchRuntime(
    sessionId: string,
    token: string,
    now: number,
    ttlSeconds: number,
    tokenKind: "bootstrap" | "runtime",
    states: Array<"reserved" | "active">,
  ): Promise<RuntimeHeartbeat> {
    const result = await this.#withSessionLock(sessionId, now, async (client, session) => {
      const tokenHash = this.#hash(token);
      const matchesToken = tokenKind === "bootstrap"
        ? secretEqual(tokenHash, session.token_hash)
        : this.#matchesRuntimeTokenHash(session, tokenHash);
      if (!matchesToken) {
        throw new ServiceError("session_invalid", "License session is invalid", 401);
      }
      const state = this.#assertRuntimeState(session, states);
      const entitlement = await this.#entitlement(client, session.license_id, true);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License does not exist", 401);
      const plan = this.#assertEntitlement(entitlement, now);
      const limit = PLAN_CATALOG[plan].concurrency;
      if (!this.#sessionFeaturesAvailable(plan, session)) {
        await client.query("UPDATE license_sessions SET state='denied', released_at=$1, expires_at=$2, last_seen_at=$3 WHERE session_id=$4",
          [now, now, now, session.session_id]);
        return this.#featureDenied(plan, session);
      }
      const rank = await this.#rank(client, session, now);
      if (rank > limit) {
        await client.query("UPDATE license_sessions SET state='denied', released_at=$1, expires_at=$2, last_seen_at=$3 WHERE session_id=$4",
          [now, now, now, session.session_id]);
        const active = await this.#activeCount(client, session.license_id, now);
        return sessionLimitError(plan, active, "This session exceeds the current plan concurrency");
      }
      const expiresAt = now + ttlSeconds;
      const leaseGeneration = this.#nextLeaseGeneration(session, expiresAt);
      await client.query("UPDATE license_sessions SET last_seen_at=$1, expires_at=$2, lease_generation=$3 WHERE session_id=$4",
        [now, expiresAt, leaseGeneration, session.session_id]);
      const active = await this.#activeCount(client, session.license_id, now);
      return {
        ...this.#reservation(session, entitlement, plan, limit, active, expiresAt, leaseGeneration),
        startupId: session.startup_id ?? "",
        state,
      };
    });
    if (result instanceof ServiceError) throw result;
    return result;
  }
}
