import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ServiceError } from "./errors.js";
import { effectivePlan, isPlanId, PLAN_CATALOG, type PlanId } from "./plans.js";

export type EntitlementStatus = "active" | "hold" | "revoked";

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
  concurrencyLimit: number;
  activeSessions: number;
  expiresAt: number;
  browserVersion: string;
  artifactSha256: string;
  deviceHash?: string;
}

export interface SessionAuthorization {
  sessionId: string;
  licenseId: string;
  browserVersion: string;
  artifactSha256: string;
  expiresAt: number;
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
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS license_sessions_active
        ON license_sessions(license_id, released_at, expires_at);
    `);
  }

  close(): void {
    this.#database.close();
  }

  #hash(value: string): Buffer {
    return createHmac("sha256", this.#pepper).update(value, "utf8").digest();
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
    now: number;
    ttlSeconds: number;
  }): Reservation {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#expire(input.now);
      const entitlement = this.#entitlement(input.licenseId);
      if (!entitlement) throw new ServiceError("license_key_invalid", "License key is invalid", 401);
      const plan = this.#assertEntitlement(entitlement, input.now);
      const limit = PLAN_CATALOG[plan].concurrency;
      const active = this.#activeCount(input.licenseId, input.now);
      if (active >= limit) {
        throw new ServiceError("session_limit", `The ${PLAN_CATALOG[plan].name} plan allows ${limit} concurrent browser process${limit === 1 ? "" : "es"}`, 409);
      }
      const sessionId = randomUUID();
      const sessionToken = randomBytes(32).toString("base64url");
      const expiresAt = input.now + input.ttlSeconds;
      this.#database.prepare(`
        INSERT INTO license_sessions
          (session_id, license_id, token_hash, device_hash, platform, arch, browser_version,
           artifact_sha256, created_at, last_seen_at, expires_at, released_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(sessionId, input.licenseId, this.#hash(sessionToken), input.deviceHash ?? null,
        input.platform, input.arch, input.browserVersion, input.artifactSha256,
        input.now, input.now, expiresAt);
      this.#database.exec("COMMIT");
      return {
        sessionId,
        sessionToken,
        licenseId: input.licenseId,
        accountId: entitlement.account_id,
        plan,
        concurrencyLimit: limit,
        activeSessions: active + 1,
        expiresAt,
        browserVersion: input.browserVersion,
        artifactSha256: input.artifactSha256,
        ...(input.deviceHash === undefined ? {} : { deviceHash: input.deviceHash }),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(sessionToken: string, now: number, ttlSeconds: number, expectedSessionId?: string): Reservation {
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
      const limit = PLAN_CATALOG[plan].concurrency;
      const rank = Number((this.#database.prepare(`
        SELECT COUNT(*) AS count FROM license_sessions
        WHERE license_id=? AND released_at IS NULL AND expires_at>?
          AND (created_at < ? OR (created_at = ? AND session_id <= ?))
      `).get(session.license_id, now, session.created_at, session.created_at, session.session_id) as { count: number }).count);
      if (rank > limit) {
        this.#database.prepare("UPDATE license_sessions SET released_at=? WHERE session_id=?").run(now, session.session_id);
        throw new ServiceError("session_limit", "This session exceeds the current plan concurrency", 409);
      }
      const expiresAt = now + ttlSeconds;
      this.#database.prepare("UPDATE license_sessions SET last_seen_at=?, expires_at=? WHERE session_id=?")
        .run(now, expiresAt, session.session_id);
      const active = this.#activeCount(session.license_id, now);
      this.#database.exec("COMMIT");
      return {
        sessionId: session.session_id,
        sessionToken,
        licenseId: session.license_id,
        accountId: entitlement.account_id,
        plan,
        concurrencyLimit: limit,
        activeSessions: active,
        expiresAt,
        browserVersion: session.browser_version,
        artifactSha256: session.artifact_sha256,
        ...(session.device_hash === null ? {} : { deviceHash: session.device_hash }),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
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
    this.#assertEntitlement(entitlement, now);
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

  activeCount(licenseId: string, now: number): number {
    this.#expire(now);
    return this.#activeCount(licenseId, now);
  }

  #entitlement(licenseId: string): EntitlementRecord | undefined {
    return this.#database.prepare("SELECT * FROM entitlements WHERE license_id=?").get(licenseId) as EntitlementRecord | undefined;
  }

  #sessionByToken(sessionToken: string): SessionRow | undefined {
    return this.#database.prepare("SELECT * FROM license_sessions WHERE token_hash=?")
      .get(this.#hash(sessionToken)) as SessionRow | undefined;
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
    `).get(licenseId, now) as { count: number };
    return Number(row.count);
  }

  #expire(now: number): void {
    this.#database.prepare(`
      UPDATE license_sessions SET released_at=expires_at
      WHERE released_at IS NULL AND expires_at<=?
    `).run(now);
  }
}
