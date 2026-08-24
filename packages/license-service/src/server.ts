import { createReadStream } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ReleaseCatalog } from "./catalog.js";
import { ServiceError } from "./errors.js";
import type { PlanId } from "./plans.js";
import type { EntitlementService } from "./service.js";
import type { LicenseSecurityEventKind } from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface LicenseHttpServerTimeoutOptions {
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
}

const DEFAULT_LICENSE_HTTP_SERVER_TIMEOUTS: Required<LicenseHttpServerTimeoutOptions> = {
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
};

const RATE_LIMIT_BUCKETS = [
  "license-key",
  "session-token",
  "runtime-token",
  "download-ticket",
  "admin",
] as const;

type RateLimitBucket = typeof RATE_LIMIT_BUCKETS[number];

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export type RateLimitConfig = Partial<Record<RateLimitBucket, Partial<RateLimitRule> | false>>;

const DEFAULT_RATE_LIMITS: Record<RateLimitBucket, RateLimitRule> = {
  "license-key": { limit: 120, windowSeconds: 60 },
  "session-token": { limit: 600, windowSeconds: 60 },
  "runtime-token": { limit: 6_000, windowSeconds: 60 },
  "download-ticket": { limit: 180, windowSeconds: 60 },
  admin: { limit: 60, windowSeconds: 60 },
};

function boundedTimeoutInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const integer = value === undefined ? fallback : Math.floor(value);
  if (!Number.isSafeInteger(integer) || integer < 1 || integer > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return integer;
}

function licenseHttpServerTimeouts(options: LicenseHttpServerTimeoutOptions | undefined): Required<LicenseHttpServerTimeoutOptions> {
  return {
    headersTimeoutMs: boundedTimeoutInteger(
      options?.headersTimeoutMs,
      DEFAULT_LICENSE_HTTP_SERVER_TIMEOUTS.headersTimeoutMs,
      "license HTTP headers timeout",
      10 * 60 * 1000,
    ),
    requestTimeoutMs: boundedTimeoutInteger(
      options?.requestTimeoutMs,
      DEFAULT_LICENSE_HTTP_SERVER_TIMEOUTS.requestTimeoutMs,
      "license HTTP request timeout",
      30 * 60 * 1000,
    ),
    keepAliveTimeoutMs: boundedTimeoutInteger(
      options?.keepAliveTimeoutMs,
      DEFAULT_LICENSE_HTTP_SERVER_TIMEOUTS.keepAliveTimeoutMs,
      "license HTTP keep-alive timeout",
      5 * 60 * 1000,
    ),
  };
}

function applyLicenseHttpServerTimeouts(server: Server, options: LicenseHttpServerTimeoutOptions | undefined): void {
  const timeouts = licenseHttpServerTimeouts(options);
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
}

export interface LicenseRateLimiter {
  check(bucket: RateLimitBucket, request: IncomingMessage, credential?: string): void | Promise<void>;
}

export interface RedisRateLimitClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

type Awaitable<T> = T | Promise<T>;

export type LicenseAdminPermission = "licenses:issue" | "licenses:update" | "revocations:create";

export interface LicenseAdminPrincipal {
  actor: string;
  permissions: readonly LicenseAdminPermission[];
}

export interface LicenseAdminAuthenticator {
  authenticate(request: IncomingMessage, requiredPermission: LicenseAdminPermission): Awaitable<LicenseAdminPrincipal>;
}

export interface StaticLicenseAdminCredential {
  token: string;
  actor: string;
  permissions: readonly LicenseAdminPermission[];
}

export interface FailureBackoffRule {
  threshold: number;
  windowSeconds: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
}

export type FailureBackoffConfig = Partial<FailureBackoffRule>;

const DEFAULT_FAILURE_BACKOFF: FailureBackoffRule = {
  threshold: 5,
  windowSeconds: 5 * 60,
  baseDelaySeconds: 15,
  maxDelaySeconds: 10 * 60,
};

export class InMemoryFailureBackoff {
  readonly #rule: FailureBackoffRule;
  readonly #now: () => number;
  readonly #failures = new Map<string, { windowStart: number; count: number; lockedUntil: number }>();

  constructor(config: FailureBackoffConfig | undefined, now: () => number) {
    this.#rule = { ...DEFAULT_FAILURE_BACKOFF, ...(config ?? {}) };
    if (!Number.isSafeInteger(this.#rule.threshold) || this.#rule.threshold < 1 ||
        !Number.isSafeInteger(this.#rule.windowSeconds) || this.#rule.windowSeconds < 1 ||
        !Number.isSafeInteger(this.#rule.baseDelaySeconds) || this.#rule.baseDelaySeconds < 1 ||
        !Number.isSafeInteger(this.#rule.maxDelaySeconds) || this.#rule.maxDelaySeconds < this.#rule.baseDelaySeconds) {
      throw new TypeError("Invalid failure-backoff rule");
    }
    this.#now = now;
  }

  recordFailure(request: IncomingMessage, error: ServiceError, operation: string): void {
    if (error.code === "request_rate_limited") return;
    const now = Math.max(0, Math.floor(this.#now()));
    const windowStart = now - (now % this.#rule.windowSeconds);
    const key = failureBackoffKey(request, error, operation);
    let failure = this.#failures.get(key);
    if (!failure || failure.windowStart !== windowStart) {
      failure = { windowStart, count: 0, lockedUntil: 0 };
      this.#failures.set(key, failure);
    }
    if (failure.lockedUntil > now) {
      throw failureBackoffError(failure.lockedUntil - now);
    }
    failure.count += 1;
    if (failure.count <= this.#rule.threshold) return;
    const overThreshold = failure.count - this.#rule.threshold;
    const retryAfterSeconds = Math.min(
      this.#rule.maxDelaySeconds,
      this.#rule.baseDelaySeconds * (2 ** Math.min(10, overThreshold - 1)),
    );
    failure.lockedUntil = now + retryAfterSeconds;
    throw failureBackoffError(retryAfterSeconds);
  }
}

function failureBackoffError(retryAfterSeconds: number): ServiceError {
  return new ServiceError(
    "request_rate_limited",
    "Too many failed authorization attempts. Please wait before retrying.",
    429,
    { retryAfterSeconds, backoff: true },
  );
}

function failureBackoffKey(request: IncomingMessage, error: ServiceError, operation: string): string {
  const subject = authorizationSubject(request);
  return [
    operation,
    error.code,
    hashForRateLimit(request.socket.remoteAddress ?? "unknown"),
    subject.subjectKind ?? "none",
  ].join(":");
}

function rateLimitRules(config: RateLimitConfig | false | undefined): ReadonlyMap<RateLimitBucket, RateLimitRule> {
  const rules = new Map<RateLimitBucket, RateLimitRule>();
  if (config !== false) {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const override = config?.[bucket];
      if (override === false) continue;
      const rule = { ...DEFAULT_RATE_LIMITS[bucket], ...(override ?? {}) };
      if (!Number.isSafeInteger(rule.limit) || rule.limit < 1 ||
          !Number.isSafeInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
        throw new TypeError(`Invalid rate-limit rule for ${bucket}`);
      }
      rules.set(bucket, rule);
    }
  }
  return rules;
}

export class InMemoryRateLimiter implements LicenseRateLimiter {
  readonly #rules: ReadonlyMap<RateLimitBucket, RateLimitRule>;
  readonly #now: () => number;
  readonly #counters = new Map<string, { windowStart: number; count: number }>();

  constructor(config: RateLimitConfig | false | undefined, now: () => number) {
    this.#rules = rateLimitRules(config);
    this.#now = now;
  }

  check(bucket: RateLimitBucket, request: IncomingMessage, credential = ""): void {
    const rule = this.#rules.get(bucket);
    if (!rule) return;
    const now = Math.max(0, Math.floor(this.#now()));
    const windowStart = now - (now % rule.windowSeconds);
    for (const key of rateLimitCounterKeys(bucket, request, credential)) {
      const counter = this.#counters.get(key);
      if (!counter || counter.windowStart !== windowStart) {
        this.#counters.set(key, { windowStart, count: 1 });
        continue;
      }
      counter.count += 1;
      if (counter.count > rule.limit) {
        const retryAfterSeconds = Math.max(1, windowStart + rule.windowSeconds - now);
        throw new ServiceError(
          "request_rate_limited",
          "Too many requests. Please retry after the current rate-limit window.",
          429,
          { retryAfterSeconds },
        );
      }
    }
  }
}

export class RedisFixedWindowRateLimiter implements LicenseRateLimiter {
  readonly #rules: ReadonlyMap<RateLimitBucket, RateLimitRule>;
  readonly #client: RedisRateLimitClient;
  readonly #now: () => number;
  readonly #prefix: string;

  constructor(
    config: RateLimitConfig | false | undefined,
    client: RedisRateLimitClient,
    options: { now?: () => number; prefix?: string } = {},
  ) {
    this.#rules = rateLimitRules(config);
    this.#client = client;
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#prefix = options.prefix ?? "slybrowser:license-rate-limit";
  }

  async check(bucket: RateLimitBucket, request: IncomingMessage, credential = ""): Promise<void> {
    const rule = this.#rules.get(bucket);
    if (!rule) return;
    const now = Math.max(0, Math.floor(this.#now()));
    const windowStart = now - (now % rule.windowSeconds);
    for (const counterKey of rateLimitCounterKeys(bucket, request, credential)) {
      const key = [this.#prefix, windowStart, counterKey].join(":");
      let count: number;
      try {
        count = await this.#client.incr(key);
        if (count === 1) await this.#client.expire(key, rule.windowSeconds + 5);
      } catch {
        throw new ServiceError(
          "request_rate_limited",
          "Rate-limit backend is unavailable; request denied fail-closed.",
          429,
          { retryAfterSeconds: rule.windowSeconds },
        );
      }
      if (count > rule.limit) {
        const retryAfterSeconds = Math.max(1, windowStart + rule.windowSeconds - now);
        throw new ServiceError(
          "request_rate_limited",
          "Too many requests. Please retry after the current rate-limit window.",
          429,
          { retryAfterSeconds },
        );
      }
    }
  }
}

function rateLimitCounterKeys(bucket: RateLimitBucket, request: IncomingMessage, credential: string): string[] {
  const ipHash = hashForRateLimit(request.socket.remoteAddress ?? "unknown");
  return [
    [bucket, "ip", ipHash].join(":"),
    [bucket, "credential", ipHash, hashForRateLimit(credential)].join(":"),
  ];
}

function hashForRateLimit(value: string): string {
  return createHash("sha256").update("slybrowser-rate-limit:", "utf8").update(value, "utf8").digest("base64url");
}

function responseHeaders(contentType = "application/json; charset=utf-8"): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "vary": "Authorization",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { ...responseHeaders(), ...extraHeaders, "content-length": String(body.length) });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ServiceError("request_too_large", "Request body is too large", 413);
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_json", "Request body is not valid JSON", 400);
  }
}

function authorization(request: IncomingMessage, scheme: "License" | "Session" | "Bearer" | "Bootstrap" | "Activation" | "Runtime" | "Download"): string {
  const value = request.headers.authorization;
  const prefix = `${scheme} `;
  if (!value?.startsWith(prefix) || value.length <= prefix.length) {
    throw new ServiceError("authorization_required", `${scheme} authorization is required`, 401);
  }
  return value.slice(prefix.length);
}

function runtimeActivationAuthorization(request: IncomingMessage): string {
  const value = request.headers.authorization;
  for (const scheme of ["Activation", "Bootstrap"] as const) {
    const prefix = `${scheme} `;
    if (value?.startsWith(prefix) && value.length > prefix.length) {
      return value.slice(prefix.length);
    }
  }
  throw new ServiceError("authorization_required", "Activation authorization is required", 401);
}

function runtimeReleaseAuthorization(request: IncomingMessage): string {
  const value = request.headers.authorization;
  for (const scheme of ["Runtime", "Bootstrap"] as const) {
    const prefix = `${scheme} `;
    if (value?.startsWith(prefix) && value.length > prefix.length) {
      return value.slice(prefix.length);
    }
  }
  throw new ServiceError("authorization_required", "Runtime or Bootstrap authorization is required", 401);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_request", "Request body must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function idempotencyKey(request: IncomingMessage): string | undefined {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceError("invalid_request", "Idempotency-Key is invalid", 400);
  }
  return value;
}

function startupIdForIdempotencyKey(value: string): string {
  return `st_${createHash("sha256")
    .update("slybrowser-runtime-session:", "utf8")
    .update(value, "utf8")
    .digest("base64url")
    .slice(0, 32)}`;
}

async function runtimeSessionBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = objectBody(await readJson(request));
  const key = idempotencyKey(request);
  if (key === undefined) return body;
  const startupId = startupIdForIdempotencyKey(key);
  if (body.startupId === undefined) {
    return { ...body, startupId };
  }
  if (body.startupId !== startupId) {
    throw new ServiceError("idempotency_conflict", "Idempotency-Key conflicts with startupId", 409);
  }
  return body;
}

function equalSecret(actual: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function adminBearerToken(request: IncomingMessage): string | undefined {
  const value = headerValue(request.headers.authorization);
  if (value && /^Bearer\s+/i.test(value)) {
    return value.replace(/^Bearer\s+/i, "").trim();
  }
  return undefined;
}

function adminActor(value: string | undefined, fallback: string): string {
  const actor = (value ?? fallback).trim();
  if (!/^[A-Za-z0-9@._:-]{3,160}$/.test(actor)) {
    throw new ServiceError("admin_authorization_invalid", "Admin actor is invalid", 401);
  }
  return actor;
}

function licenseAdminPermissions(value: readonly LicenseAdminPermission[]): readonly LicenseAdminPermission[] {
  const allowed = new Set<LicenseAdminPermission>(["licenses:issue", "licenses:update", "revocations:create"]);
  const unique = [...new Set(value)];
  if (!unique.length || unique.some((permission) => !allowed.has(permission))) {
    throw new TypeError("License admin credential permissions are invalid");
  }
  return unique;
}

export class StaticLicenseAdminAuthenticator implements LicenseAdminAuthenticator {
  readonly #credentials: readonly StaticLicenseAdminCredential[];

  constructor(credentials: readonly StaticLicenseAdminCredential[]) {
    if (!credentials.length) throw new TypeError("At least one license admin credential is required");
    this.#credentials = credentials.map((credential) => {
      if (!credential.token || credential.token.length < 24 || /[\u0000-\u001f\u007f]/.test(credential.token)) {
        throw new TypeError("License admin credential token is invalid");
      }
      return {
        token: credential.token,
        actor: adminActor(credential.actor, "license:admin"),
        permissions: licenseAdminPermissions(credential.permissions),
      };
    });
  }

  authenticate(request: IncomingMessage, requiredPermission: LicenseAdminPermission): LicenseAdminPrincipal {
    const token = adminBearerToken(request);
    let matchedCredential: StaticLicenseAdminCredential | undefined;
    for (const credential of this.#credentials) {
      if (equalSecret(token ?? "", credential.token)) {
        matchedCredential = credential;
        break;
      }
    }
    if (!matchedCredential) {
      throw new ServiceError("admin_authorization_invalid", "Admin authorization is invalid", 401);
    }
    if (!matchedCredential.permissions.includes(requiredPermission)) {
      throw new ServiceError("admin_authorization_forbidden", "Admin credential is not allowed to perform this operation", 403);
    }
    return {
      actor: matchedCredential.actor,
      permissions: matchedCredential.permissions,
    };
  }
}

async function authenticateLicenseAdmin(
  request: IncomingMessage,
  options: LicenseHttpServerOptions,
  requiredPermission: LicenseAdminPermission,
  fallbackActor: string,
): Promise<LicenseAdminPrincipal> {
  if (options.adminAuth) {
    return options.adminAuth.authenticate(request, requiredPermission);
  }
  if (!options.adminToken) {
    throw new ServiceError("admin_authorization_invalid", "License admin authentication is not configured", 401);
  }
  if (!equalSecret(authorization(request, "Bearer"), options.adminToken)) {
    throw new ServiceError("admin_authorization_invalid", "Admin authorization is invalid", 401);
  }
  return {
    actor: adminActor(headerValue(request.headers["x-sly-admin-actor"]), fallbackActor),
    permissions: [requiredPermission],
  };
}

export interface LicenseHttpServerOptions {
  service: EntitlementService;
  catalog: ReleaseCatalog;
  artifactRoot: string;
  adminToken?: string;
  adminAuth?: LicenseAdminAuthenticator;
  rateLimits?: RateLimitConfig | false;
  rateLimiter?: LicenseRateLimiter;
  rateLimitNow?: () => number;
  failureBackoff?: FailureBackoffConfig | false;
  serverTimeouts?: LicenseHttpServerTimeoutOptions;
  metrics?: (event: LicenseHttpMetricEvent) => void;
  metricsNow?: () => number;
}

export interface LicenseHttpMetricEvent {
  operation: string;
  method: string;
  status: number;
  result: string;
  latencyMs: number;
  plan?: PlanId;
}

function securityEventKind(error: ServiceError): LicenseSecurityEventKind | undefined {
  if (new Set([
    "artifact_denied",
    "download_ticket_expired",
    "kernel_update_required",
    "license_file_invalid",
    "license_file_signature_invalid",
    "paynow_second_confirmation_mismatch",
    "paynow_signature_invalid",
    "paynow_timestamp_invalid",
  ]).has(error.code)) {
    return "signature_or_hash_error";
  }
  if (new Set([
    "idempotency_conflict",
    "paynow_event_conflict",
    "paynow_event_replay_incomplete",
    "session_activation_invalid",
  ]).has(error.code)) {
    return "request_replay";
  }
  if (new Set([
    "admin_authorization_invalid",
    "authorization_required",
    "license_feature_denied",
    "license_invalid",
    "license_key_invalid",
    "license_on_hold",
    "license_revoked",
    "request_rate_limited",
    "session_expired",
    "session_invalid",
    "session_limit",
    "session_state_invalid",
  ]).has(error.code)) {
    return "authorization_denied";
  }
  return undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

function authorizationSubject(request: IncomingMessage): { subjectKind?: string; subject?: string } {
  const value = headerValue(request.headers.authorization);
  if (!value) return {};
  const separator = value.indexOf(" ");
  const subjectKind = separator > 0 ? value.slice(0, separator).toLowerCase() : "authorization";
  const subject = separator > 0 ? value.slice(separator + 1) : value;
  return {
    subjectKind,
    ...(subject ? { subject } : {}),
  };
}

export function createLicenseHttpServer(options: LicenseHttpServerOptions): Server {
  const rateLimiter = options.rateLimiter ??
    new InMemoryRateLimiter(options.rateLimits, options.rateLimitNow ?? (() => Date.now() / 1000));
  const failureBackoff = options.failureBackoff === false
    ? undefined
    : new InMemoryFailureBackoff(options.failureBackoff, options.rateLimitNow ?? (() => Date.now() / 1000));
  const server = createServer(async (request, response) => {
    const metricsNow = options.metricsNow ?? Date.now;
    const startedAt = metricsNow();
    let operation = "route_not_found";
    let metricEmitted = false;
    const emitMetric = (status: number, result: string, plan?: PlanId): void => {
      if (metricEmitted) return;
      metricEmitted = true;
      if (!options.metrics) return;
      const event: LicenseHttpMetricEvent = {
        operation,
        method: request.method ?? "UNKNOWN",
        status,
        result,
        latencyMs: Math.max(0, Math.floor(metricsNow() - startedAt)),
      };
      if (plan !== undefined) event.plan = plan;
      options.metrics(event);
    };
    try {
      const url = new URL(request.url ?? "/", "http://license.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        operation = "healthz";
        sendJson(response, 200, { status: "ok" });
        emitMetric(200, "ok");
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/plans") {
        operation = "plans";
        sendJson(response, 200, options.service.plans());
        emitMetric(200, "ok");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/licenses/info") {
        operation = "license_info";
        const licenseKey = authorization(request, "License");
        await rateLimiter.check("license-key", request, licenseKey);
        const info = await options.service.licenseInfo(licenseKey, await readJson(request));
        sendJson(response, 200, info);
        emitMetric(200, "ok", info.effectivePlan);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/licenses/sessions") {
        operation = "license_session_create";
        const licenseKey = authorization(request, "License");
        await rateLimiter.check("license-key", request, licenseKey);
        const grant = await options.service.createSession(licenseKey, await readJson(request));
        sendJson(response, 201, grant);
        emitMetric(201, "ok", grant.plan);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v2/runtime/sessions") {
        operation = "runtime_session_create";
        const licenseKey = authorization(request, "License");
        await rateLimiter.check("license-key", request, licenseKey);
        const grant = await options.service.createRuntimeSession(licenseKey, await runtimeSessionBody(request));
        sendJson(response, 201, grant);
        emitMetric(201, "ok", grant.plan);
        return;
      }
      const sessionMatch = /^\/v1\/licenses\/sessions\/([0-9a-f-]{36})$/.exec(url.pathname);
      const heartbeatMatch = /^\/v1\/licenses\/sessions\/([0-9a-f-]{36})\/heartbeat$/.exec(url.pathname);
      const runtimeMatch = /^\/v2\/runtime\/sessions\/([0-9a-f-]{36})$/.exec(url.pathname);
      const runtimeBootstrapHeartbeatMatch = /^\/v2\/runtime\/sessions\/([0-9a-f-]{36})\/bootstrap-heartbeat$/.exec(url.pathname);
      const runtimeActivateMatch = /^\/v2\/runtime\/sessions\/([0-9a-f-]{36})\/activate$/.exec(url.pathname);
      const runtimeHeartbeatMatch = /^\/v2\/runtime\/sessions\/([0-9a-f-]{36})\/heartbeat$/.exec(url.pathname);
      const runtimeCloseMatch = /^\/v2\/runtime\/sessions\/([0-9a-f-]{36})\/close$/.exec(url.pathname);
      if (request.method === "POST" && heartbeatMatch) {
        operation = "license_session_heartbeat";
        const token = authorization(request, "Session");
        await rateLimiter.check("session-token", request, token);
        const grant = await options.service.heartbeat(heartbeatMatch[1]!, token);
        sendJson(response, 200, grant);
        emitMetric(200, "ok", grant.plan);
        return;
      }
      if (request.method === "POST" && runtimeBootstrapHeartbeatMatch) {
        operation = "runtime_bootstrap_heartbeat";
        const token = authorization(request, "Bootstrap");
        await rateLimiter.check("runtime-token", request, token);
        const grant = await options.service.bootstrapHeartbeat(runtimeBootstrapHeartbeatMatch[1]!, token);
        sendJson(response, 200, grant);
        emitMetric(200, "ok", grant.plan);
        return;
      }
      if (request.method === "POST" && runtimeActivateMatch) {
        operation = "runtime_session_activate";
        const token = runtimeActivationAuthorization(request);
        await rateLimiter.check("runtime-token", request, token);
        const grant = await options.service.activateRuntimeSession(runtimeActivateMatch[1]!, token);
        sendJson(response, 200, grant);
        emitMetric(200, "ok", grant.plan);
        return;
      }
      if (request.method === "POST" && runtimeHeartbeatMatch) {
        operation = "runtime_session_heartbeat";
        const token = authorization(request, "Runtime");
        await rateLimiter.check("runtime-token", request, token);
        const grant = await options.service.runtimeHeartbeat(runtimeHeartbeatMatch[1]!, token);
        sendJson(response, 200, grant);
        emitMetric(200, "ok", grant.plan);
        return;
      }
      if (request.method === "POST" && runtimeCloseMatch) {
        operation = "runtime_session_close";
        const token = authorization(request, "Runtime");
        await rateLimiter.check("runtime-token", request, token);
        const grant = await options.service.closeRuntimeSession(runtimeCloseMatch[1]!, token);
        sendJson(response, 200, grant);
        emitMetric(200, "ok", grant.plan);
        return;
      }
      if (request.method === "DELETE" && sessionMatch) {
        operation = "license_session_release";
        const token = authorization(request, "Session");
        await rateLimiter.check("session-token", request, token);
        await options.service.release(sessionMatch[1]!, token);
        response.writeHead(204, responseHeaders());
        response.end();
        emitMetric(204, "ok");
        return;
      }
      if (request.method === "DELETE" && runtimeMatch) {
        operation = "runtime_session_release";
        const token = runtimeReleaseAuthorization(request);
        await rateLimiter.check("runtime-token", request, token);
        await options.service.releaseRuntimeSession(runtimeMatch[1]!, token);
        response.writeHead(204, responseHeaders());
        response.end();
        emitMetric(204, "ok");
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/v1/releases/artifacts/")) {
        operation = "release_artifact_download";
        const token = authorization(request, "Session");
        await rateLimiter.check("session-token", request, token);
        const artifact = options.catalog.findArtifactByPath(url.pathname);
        if (!artifact) throw new ServiceError("artifact_not_found", "Release artifact does not exist", 404);
        await options.service.authorizeArtifact(token, artifact);
        const path = options.catalog.artifactPath(options.artifactRoot, artifact);
        const info = await stat(path);
        if (!info.isFile() || info.size !== artifact.size) {
          throw new ServiceError("artifact_unavailable", "Release artifact is unavailable", 503);
        }
        response.writeHead(200, {
          ...responseHeaders("application/zip"),
          "content-length": String(info.size),
          "content-disposition": `attachment; filename="${new URL(artifact.url).pathname.split("/").at(-1)}"`,
        });
        emitMetric(200, "ok");
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        createReadStream(path).on("error", () => response.destroy()).pipe(response);
        return;
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/v2/runtime/artifacts/")) {
        operation = "runtime_artifact_download";
        const token = authorization(request, "Download");
        await rateLimiter.check("download-ticket", request, token);
        const v1Path = url.pathname.replace("/v2/runtime/artifacts/", "/v1/releases/artifacts/");
        const artifact = options.catalog.findArtifactByPath(v1Path);
        if (!artifact) throw new ServiceError("artifact_not_found", "Release artifact does not exist", 404);
        await options.service.authorizeDownloadTicket(token, artifact);
        const path = options.catalog.artifactPath(options.artifactRoot, artifact);
        const info = await stat(path);
        if (!info.isFile() || info.size !== artifact.size) {
          throw new ServiceError("artifact_unavailable", "Release artifact is unavailable", 503);
        }
        response.writeHead(200, {
          ...responseHeaders("application/zip"),
          "content-length": String(info.size),
          "content-disposition": `attachment; filename="${new URL(artifact.url).pathname.split("/").at(-1)}"`,
        });
        emitMetric(200, "ok");
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        createReadStream(path).on("error", () => response.destroy()).pipe(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/licenses") {
        operation = "admin_license_issue";
        await rateLimiter.check("admin", request, request.headers.authorization ?? "");
        await authenticateLicenseAdmin(request, options, "licenses:issue", "license:issuer");
        const body = objectBody(await readJson(request));
        const paidThrough = body.paidThrough === undefined ? undefined : body.paidThrough as number | null;
        const issued = await options.service.issueAuthorization({
          accountId: String(body.accountId ?? ""),
          plan: body.plan as PlanId,
          ...(paidThrough === undefined ? {} : { paidThrough }),
          serviceUrl: String(body.serviceUrl ?? ""),
        });
        sendJson(response, 201, issued);
        emitMetric(201, "ok", issued.plan);
        return;
      }
      const adminLicenseMatch = /^\/v1\/admin\/licenses\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "PATCH" && adminLicenseMatch) {
        operation = "admin_license_update";
        await rateLimiter.check("admin", request, request.headers.authorization ?? "");
        await authenticateLicenseAdmin(request, options, "licenses:update", "license:updater");
        await options.service.updateAuthorization(adminLicenseMatch[1]!, objectBody(await readJson(request)));
        response.writeHead(204, responseHeaders());
        response.end();
        emitMetric(204, "ok");
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/runtime-revocations") {
        operation = "admin_runtime_revocation";
        await rateLimiter.check("admin", request, request.headers.authorization ?? "");
        await authenticateLicenseAdmin(request, options, "revocations:create", "license:revoker");
        const revoked = await options.service.revokeRuntimeSessions(objectBody(await readJson(request)));
        sendJson(response, 200, revoked);
        emitMetric(200, "ok");
        return;
      }
      throw new ServiceError("not_found", "Route does not exist", 404);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      let serviceError = error instanceof ServiceError
        ? error
        : new ServiceError("internal_error", "The license service could not complete the request", 500);
      let kind = securityEventKind(serviceError);
      if (kind === "authorization_denied" && failureBackoff) {
        try {
          failureBackoff.recordFailure(request, serviceError, operation);
        } catch (backoffError) {
          if (backoffError instanceof ServiceError) {
            serviceError = backoffError;
            kind = securityEventKind(serviceError);
          }
        }
      }
      emitMetric(serviceError.status, serviceError.code);
      if (kind) {
        const subject = authorizationSubject(request);
        const ip = request.socket.remoteAddress;
        const userAgent = headerValue(request.headers["user-agent"]);
        await options.service.recordSecurityEvent({
          kind,
          code: serviceError.code,
          operation,
          httpStatus: serviceError.status,
          ...subject,
          ...(ip === undefined ? {} : { ip }),
          ...(userAgent === undefined ? {} : { userAgent }),
          details: serviceError.details,
        }).catch(() => undefined);
      }
      const retryAfterSeconds = serviceError.details.retryAfterSeconds;
      const errorHeaders = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)
        ? { "retry-after": String(Math.max(1, Math.floor(retryAfterSeconds))) }
        : {};
      sendJson(response, serviceError.status, {
        error: { code: serviceError.code, message: serviceError.message, ...serviceError.details },
      }, errorHeaders);
    }
  });
  applyLicenseHttpServerTimeouts(server, options.serverTimeouts);
  return server;
}
