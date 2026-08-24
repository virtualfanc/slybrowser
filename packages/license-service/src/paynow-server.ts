import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { EmailTransport } from "./email.js";
import type {
  LicenseEmailDeliveryStatus,
  LicenseEmailDeliveryStatusStore,
  MarkLicenseEmailDeliveryStatusInput,
} from "./email-outbox.js";
import { ServiceError } from "./errors.js";
import type { PayNowCheckoutClient } from "./paynow-management.js";
import type {
  AdminBillingLookupStore,
  AdminCustomerEmailChangeStore,
  AdminLicenseFileResendStore,
  AdminLicenseRotationStore,
  AdminLicenseStatusStore,
  AdminOrderNoteStore,
  AdminSubscriptionCancellationStore,
  CustomerBillingPortalStore,
  AdminRefundStore,
  CustomerSubscriptionCancellationStore,
  PayNowOrderRefundClient,
  PayNowSubscriptionCancellationClient,
  PayNowVerificationStatus,
  PayNowWebhookReceiver,
} from "./paynow.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface BillingHttpServerTimeoutOptions {
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
}

const DEFAULT_BILLING_HTTP_SERVER_TIMEOUTS: Required<BillingHttpServerTimeoutOptions> = {
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
};

export type FeedbackRateLimitDimension = "ip" | "email" | "user_agent";

export interface FeedbackRateLimitEvent {
  dimension: FeedbackRateLimitDimension;
  keyHash: string;
  count: number;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number;
}

export interface FeedbackRateLimitOptions {
  windowSeconds?: number;
  maxPerIp?: number;
  maxPerEmail?: number;
  maxPerUserAgent?: number;
  now?: () => number;
  alertSink?: (event: FeedbackRateLimitEvent) => void;
}

export type BillingRateLimitAction =
  | "checkout_intent"
  | "checkout_status"
  | "customer_portal"
  | "customer_license_resend"
  | "customer_subscription_cancel"
  | "email_delivery_status"
  | "admin";

export interface BillingRateLimitRule {
  limit?: number;
  windowSeconds?: number;
}

export interface BillingRateLimitEvent {
  action: BillingRateLimitAction;
  keyHash: string;
  count: number;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number;
}

export interface BillingRateLimitOptions {
  rules?: Partial<Record<BillingRateLimitAction, BillingRateLimitRule | false>>;
  now?: () => number;
  alertSink?: (event: BillingRateLimitEvent) => void;
}

type Awaitable<T> = T | Promise<T>;

export type BillingAdminPermission = "orders:read" | "orders:note" | "orders:email" | "orders:refund" | "licenses:resend" | "licenses:rotate" | "licenses:update" | "subscriptions:cancel";

export interface BillingAdminPrincipal {
  actor: string;
  permissions: readonly BillingAdminPermission[];
}

export interface BillingAdminAuthenticator {
  authenticate(request: IncomingMessage, requiredPermission: BillingAdminPermission): Awaitable<BillingAdminPrincipal>;
}

export interface StaticBillingAdminCredential {
  token: string;
  actor: string;
  permissions: readonly BillingAdminPermission[];
}

function headers(): Record<string, string> {
  return {
    "cache-control": "no-store, private, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { ...headers(), "content-length": String(body.length) });
  response.end(body);
}

async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ServiceError("request_too_large", "Request body is too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(request);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new ServiceError("invalid_json", "Request body is not valid JSON", 400);
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function boundedRateLimitInteger(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const integer = value === undefined ? fallback : Math.floor(value);
  if (!Number.isSafeInteger(integer) || integer < 1 || integer > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return integer;
}

function billingHttpServerTimeouts(options: BillingHttpServerTimeoutOptions | undefined): Required<BillingHttpServerTimeoutOptions> {
  return {
    headersTimeoutMs: boundedRateLimitInteger(
      options?.headersTimeoutMs,
      DEFAULT_BILLING_HTTP_SERVER_TIMEOUTS.headersTimeoutMs,
      "billing HTTP headers timeout",
      10 * 60 * 1000,
    ),
    requestTimeoutMs: boundedRateLimitInteger(
      options?.requestTimeoutMs,
      DEFAULT_BILLING_HTTP_SERVER_TIMEOUTS.requestTimeoutMs,
      "billing HTTP request timeout",
      30 * 60 * 1000,
    ),
    keepAliveTimeoutMs: boundedRateLimitInteger(
      options?.keepAliveTimeoutMs,
      DEFAULT_BILLING_HTTP_SERVER_TIMEOUTS.keepAliveTimeoutMs,
      "billing HTTP keep-alive timeout",
      5 * 60 * 1000,
    ),
  };
}

function applyBillingHttpServerTimeouts(server: Server, options: BillingHttpServerTimeoutOptions | undefined): void {
  const timeouts = billingHttpServerTimeouts(options);
  server.headersTimeout = timeouts.headersTimeoutMs;
  server.requestTimeout = timeouts.requestTimeoutMs;
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs;
}

function firstForwardedAddress(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function clientIp(request: IncomingMessage): string {
  return (
    header(request, "cf-connecting-ip") ??
    header(request, "x-real-ip") ??
    firstForwardedAddress(header(request, "x-forwarded-for")) ??
    request.socket.remoteAddress ??
    "unknown"
  ).trim().toLowerCase();
}

function userAgentIdentity(request: IncomingMessage, bodyUserAgent: string | undefined): string {
  return (bodyUserAgent ?? header(request, "user-agent") ?? "unknown").trim().slice(0, 500).toLowerCase();
}

function redactedKeyHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
}

function constantTimeEquals(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = header(request, "authorization");
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
  }
  return header(request, "x-sly-email-webhook-token");
}

function adminBearerToken(request: IncomingMessage): string | undefined {
  const authorization = header(request, "authorization");
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    return authorization.replace(/^Bearer\s+/i, "").trim();
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

function adminPermissions(value: readonly BillingAdminPermission[]): readonly BillingAdminPermission[] {
  const allowed = new Set<BillingAdminPermission>(["orders:read", "orders:note", "orders:email", "orders:refund", "licenses:resend", "licenses:rotate", "licenses:update", "subscriptions:cancel"]);
  const unique = [...new Set(value)];
  if (!unique.length || unique.some((permission) => !allowed.has(permission))) {
    throw new TypeError("Billing admin credential permissions are invalid");
  }
  return unique;
}

export class StaticBillingAdminAuthenticator implements BillingAdminAuthenticator {
  readonly #credentials: readonly StaticBillingAdminCredential[];

  constructor(credentials: readonly StaticBillingAdminCredential[]) {
    if (!credentials.length) throw new TypeError("At least one billing admin credential is required");
    this.#credentials = credentials.map((credential) => {
      if (!credential.token || credential.token.length < 24 || /[\u0000-\u001f\u007f]/.test(credential.token)) {
        throw new TypeError("Billing admin credential token is invalid");
      }
      return {
        token: credential.token,
        actor: adminActor(credential.actor, "system:admin"),
        permissions: adminPermissions(credential.permissions),
      };
    });
  }

  authenticate(request: IncomingMessage, requiredPermission: BillingAdminPermission): BillingAdminPrincipal {
    const token = adminBearerToken(request);
    let matchedCredential: StaticBillingAdminCredential | undefined;
    for (const credential of this.#credentials) {
      if (constantTimeEquals(token, credential.token)) {
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

async function authenticateBillingAdmin(
  request: IncomingMessage,
  options: { token?: string; adminAuth?: BillingAdminAuthenticator },
  requiredPermission: BillingAdminPermission,
  fallbackActor: string,
): Promise<BillingAdminPrincipal> {
  if (options.adminAuth) {
    return options.adminAuth.authenticate(request, requiredPermission);
  }
  if (!options.token) {
    throw new ServiceError("admin_authorization_invalid", "Billing admin authentication is not configured", 401);
  }
  if (!constantTimeEquals(adminBearerToken(request), options.token)) {
    throw new ServiceError("admin_authorization_invalid", "Admin authorization is invalid", 401);
  }
  return {
    actor: adminActor(header(request, "x-sly-admin-actor"), fallbackActor),
    permissions: [requiredPermission],
  };
}

function asServiceError(error: unknown): ServiceError {
  return error instanceof ServiceError
    ? error
    : new ServiceError("internal_error", "The billing service could not complete the request", 500);
}

function serviceErrorPayload(error: ServiceError): { error: Record<string, unknown> } {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...error.details,
    },
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_request", "Request body must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string, limit: number): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ServiceError("invalid_request", `${name} must be a string`, 400);
  }
  const trimmed = value.trim();
  if (trimmed.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    throw new ServiceError("invalid_request", `${name} is invalid`, 400);
  }
  return trimmed;
}

function optionalSingleQuery(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name).filter((value) => value.trim() !== "");
  if (values.length > 1) {
    throw new ServiceError("invalid_request", `${name} must be supplied once`, 400);
  }
  return values[0]?.trim();
}

function optionalIntegerQuery(url: URL, name: string, fallback: number, maximum: number): number {
  const value = optionalSingleQuery(url, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ServiceError("invalid_request", `${name} must be an integer`, 400);
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > maximum) {
    throw new ServiceError("invalid_request", `${name} is out of range`, 400);
  }
  return numeric;
}

function feedbackEmail(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 254 || /[\s<>]/.test(value) || !/^[^@]+@[^@]+\.[^@]+$/.test(value)) {
    throw new ServiceError("invalid_request", "email is invalid", 400);
  }
  return value.toLowerCase();
}

function feedbackCategory(value: string | undefined): string {
  if (value === undefined) return "general";
  const allowed = new Set(["general", "billing", "license", "bug", "feature"]);
  if (!allowed.has(value)) {
    throw new ServiceError("invalid_request", "category is invalid", 400);
  }
  return value;
}

function feedbackText(body: Record<string, unknown>, request: IncomingMessage): {
  email?: string;
  category: string;
  subject: string;
  text: string;
  userAgent?: string;
} {
  const email = feedbackEmail(stringField(body, "email", 254));
  const name = stringField(body, "name", 100);
  const category = feedbackCategory(stringField(body, "category", 32));
  const message = stringField(body, "message", 5_000);
  if (message === undefined || message.length < 10) {
    throw new ServiceError("invalid_request", "message must contain at least 10 characters", 400);
  }
  const page = stringField(body, "page", 1_000);
  const userAgent = stringField(body, "userAgent", 500) ?? header(request, "user-agent");
  return {
    ...(email === undefined ? {} : { email }),
    category,
    subject: `[SlyBrowser feedback] ${category}`,
    ...(userAgent === undefined ? {} : { userAgent }),
    text: [
      "New SlyBrowser feedback",
      "",
      `Category: ${category}`,
      ...(name === undefined ? [] : [`Name: ${name}`]),
      ...(email === undefined ? [] : [`Email: ${email}`]),
      ...(page === undefined ? [] : [`Page: ${page}`]),
      ...(userAgent === undefined ? [] : [`User-Agent: ${userAgent}`]),
      "",
      "Message:",
      message,
    ].join("\n"),
  };
}

class FeedbackRateLimiter {
  readonly #windowSeconds: number;
  readonly #maxPerIp: number;
  readonly #maxPerEmail: number;
  readonly #maxPerUserAgent: number;
  readonly #now: () => number;
  readonly #alertSink: ((event: FeedbackRateLimitEvent) => void) | undefined;
  readonly #buckets = new Map<string, { count: number; resetAt: number; alerted: boolean }>();
  #checks = 0;

  constructor(options: FeedbackRateLimitOptions = {}) {
    this.#windowSeconds = boundedRateLimitInteger(options.windowSeconds, 15 * 60, "feedback rate-limit window", 24 * 60 * 60);
    this.#maxPerIp = boundedRateLimitInteger(options.maxPerIp, 10, "feedback IP rate-limit", 10_000);
    this.#maxPerEmail = boundedRateLimitInteger(options.maxPerEmail, 3, "feedback email rate-limit", 10_000);
    this.#maxPerUserAgent = boundedRateLimitInteger(options.maxPerUserAgent, 20, "feedback user-agent rate-limit", 10_000);
    this.#now = options.now ?? (() => Date.now() / 1000);
    this.#alertSink = options.alertSink;
  }

  check(input: { request: IncomingMessage; email?: string; userAgent?: string }): void {
    const now = Math.max(0, Math.floor(this.#now()));
    this.#checks += 1;
    if (this.#checks % 128 === 0) {
      for (const [bucketKey, bucket] of this.#buckets) {
        if (bucket.resetAt <= now) this.#buckets.delete(bucketKey);
      }
    }
    this.#checkDimension("ip", clientIp(input.request), this.#maxPerIp, now);
    if (input.email !== undefined) this.#checkDimension("email", input.email, this.#maxPerEmail, now);
    this.#checkDimension("user_agent", userAgentIdentity(input.request, input.userAgent), this.#maxPerUserAgent, now);
  }

  #checkDimension(dimension: FeedbackRateLimitDimension, value: string, limit: number, now: number): void {
    const keyHash = redactedKeyHash(`${dimension}:${value}`);
    const bucketKey = `${dimension}:${keyHash}`;
    let bucket = this.#buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.#windowSeconds, alerted: false };
      this.#buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= limit) return;

    const event: FeedbackRateLimitEvent = {
      dimension,
      keyHash,
      count: bucket.count,
      limit,
      windowSeconds: this.#windowSeconds,
      retryAfterSeconds: Math.max(1, bucket.resetAt - now),
    };
    if (!bucket.alerted) {
      bucket.alerted = true;
      this.#alertSink?.(event);
    }
    throw new ServiceError("feedback_rate_limited", "Too many feedback requests. Please try again later.", 429, {
      dimension,
      retryAfterSeconds: event.retryAfterSeconds,
    });
  }
}

const DEFAULT_BILLING_RATE_LIMITS: Record<BillingRateLimitAction, Required<BillingRateLimitRule>> = {
  checkout_intent: { limit: 12, windowSeconds: 15 * 60 },
  checkout_status: { limit: 180, windowSeconds: 60 },
  customer_portal: { limit: 120, windowSeconds: 60 },
  customer_license_resend: { limit: 3, windowSeconds: 60 * 60 },
  customer_subscription_cancel: { limit: 12, windowSeconds: 60 * 60 },
  email_delivery_status: { limit: 300, windowSeconds: 60 },
  admin: { limit: 60, windowSeconds: 60 },
};

class BillingActionRateLimiter {
  readonly #rules = new Map<BillingRateLimitAction, Required<BillingRateLimitRule>>();
  readonly #now: () => number;
  readonly #alertSink: ((event: BillingRateLimitEvent) => void) | undefined;
  readonly #buckets = new Map<string, { count: number; resetAt: number; alerted: boolean }>();
  #checks = 0;

  constructor(options: BillingRateLimitOptions | false = {}) {
    this.#now = options === false ? (() => Date.now() / 1000) : options.now ?? (() => Date.now() / 1000);
    this.#alertSink = options === false ? undefined : options.alertSink;
    if (options === false) return;
    for (const [action, fallback] of Object.entries(DEFAULT_BILLING_RATE_LIMITS) as Array<[BillingRateLimitAction, Required<BillingRateLimitRule>]>) {
      const override = options.rules?.[action];
      if (override === false) continue;
      const limit = boundedRateLimitInteger(override?.limit, fallback.limit, `billing ${action} rate-limit`, 100_000);
      const windowSeconds = boundedRateLimitInteger(
        override?.windowSeconds,
        fallback.windowSeconds,
        `billing ${action} rate-limit window`,
        24 * 60 * 60,
      );
      this.#rules.set(action, { limit, windowSeconds });
    }
  }

  check(action: BillingRateLimitAction, request: IncomingMessage, credential = ""): void {
    const rule = this.#rules.get(action);
    if (!rule) return;
    const now = Math.max(0, Math.floor(this.#now()));
    const ipHash = redactedKeyHash(`ip:${clientIp(request)}`);
    const credentialHash = redactedKeyHash(`credential:${credential.trim().toLowerCase()}`);
    const bucketKey = `${action}:${ipHash}:${credentialHash}`;
    let bucket = this.#buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + rule.windowSeconds, alerted: false };
      this.#buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (++this.#checks % 1_000 === 0) {
      for (const [key, value] of this.#buckets.entries()) {
        if (value.resetAt <= now) this.#buckets.delete(key);
      }
    }
    if (bucket.count <= rule.limit) return;
    const event: BillingRateLimitEvent = {
      action,
      keyHash: redactedKeyHash(bucketKey),
      count: bucket.count,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
      retryAfterSeconds: Math.max(1, bucket.resetAt - now),
    };
    if (!bucket.alerted) {
      bucket.alerted = true;
      this.#alertSink?.(event);
    }
    throw new ServiceError("billing_rate_limited", "Too many billing requests. Please try again later.", 429, {
      action,
      retryAfterSeconds: event.retryAfterSeconds,
    });
  }
}

function verificationStatus(error: ServiceError): PayNowVerificationStatus {
  if (error.code === "paynow_signature_required") return "missing";
  if (error.code === "paynow_signature_invalid") return "invalid";
  if (error.code === "invalid_request" || error.code === "paynow_store_invalid" || error.code === "paynow_event_conflict") {
    return "verified";
  }
  return "unverified";
}

function checkoutResultUrl(origin: string | undefined, intentId: string, status: "return" | "cancel"): string | undefined {
  if (!origin) return undefined;
  const url = new URL("/billing/result", origin);
  url.searchParams.set("intent_id", intentId);
  url.searchParams.set("status", status);
  return url.toString();
}

function emailDeliveryStatus(value: unknown): LicenseEmailDeliveryStatus {
  if (value !== "delivered" && value !== "bounced" && value !== "failed") {
    throw new ServiceError("invalid_request", "Email delivery status is invalid", 400);
  }
  return value;
}

function customerAccessToken(request: IncomingMessage, body?: Record<string, unknown>): string {
  const value = body?.token ?? header(request, "x-sly-customer-access-token");
  if (typeof value !== "string" || !/^cst_[A-Za-z0-9_-]{32,160}$/.test(value)) {
    throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
  }
  return value;
}

function customerPublicOrderId(value: string | undefined): string {
  if (typeof value !== "string" || !/^spo_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
  }
  return value;
}

export function createPayNowBillingHttpServer(receiver: PayNowWebhookReceiver, options: {
  checkoutClient?: PayNowCheckoutClient;
  publicOrigin?: string;
  feedbackEmail?: {
    transport: EmailTransport;
    to: string;
    subjectPrefix?: string;
  };
  emailDeliveryStatus?: {
    store: LicenseEmailDeliveryStatusStore;
    token: string;
  };
  customerPortal?: {
    store: CustomerBillingPortalStore;
  };
  customerSubscriptionCancellation?: {
    store: CustomerSubscriptionCancellationStore;
    client: PayNowSubscriptionCancellationClient;
  };
  adminSubscriptionCancellations?: {
    store: AdminSubscriptionCancellationStore;
    client: PayNowSubscriptionCancellationClient;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminLookup?: {
    store: AdminBillingLookupStore;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminOrderNotes?: {
    store: AdminOrderNoteStore;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminCustomerEmails?: {
    store: AdminCustomerEmailChangeStore;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminRefunds?: {
    store: AdminRefundStore;
    client: PayNowOrderRefundClient;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminLicenseResends?: {
    store: AdminLicenseFileResendStore;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminLicenseRotations?: {
    store: AdminLicenseRotationStore;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  adminLicenseStatus?: {
    store: AdminLicenseStatusStore;
    token?: string;
    adminAuth?: BillingAdminAuthenticator;
  };
  feedbackRateLimit?: FeedbackRateLimitOptions;
  billingRateLimit?: BillingRateLimitOptions | false;
  serverTimeouts?: BillingHttpServerTimeoutOptions;
} = {}): Server {
  const feedbackRateLimiter = new FeedbackRateLimiter(options.feedbackRateLimit);
  const billingRateLimiter = new BillingActionRateLimiter(options.billingRateLimit);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://billing.invalid");
      if (url.pathname.startsWith("/v1/admin/")) {
        billingRateLimiter.check("admin", request, adminBearerToken(request) ?? "");
      }
      if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/v1/billing/healthz")) {
        sendJson(response, 200, { status: "ok", service: "slybrowser-billing" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/checkout-intents") {
        const body = objectBody(await readJson(request));
        const allowed = new Set(["plan_id", "email", "email_confirmation", "idempotency_key"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const headerIdempotencyKey = header(request, "idempotency-key");
        const bodyIdempotencyKey = body.idempotency_key;
        if (headerIdempotencyKey !== undefined && bodyIdempotencyKey !== undefined && headerIdempotencyKey !== bodyIdempotencyKey) {
          throw new ServiceError("invalid_request", "Idempotency key is inconsistent", 400);
        }
        billingRateLimiter.check("checkout_intent", request, String(body.email ?? ""));
        const intent = await receiver.store.createCheckoutIntent({
          planId: body.plan_id,
          email: body.email,
          emailConfirmation: body.email_confirmation,
          idempotencyKey: bodyIdempotencyKey ?? headerIdempotencyKey,
        });
        let checkout: { id: string; url: string } | undefined = intent.payNowCheckoutId && intent.payNowCheckoutUrl
          ? { id: intent.payNowCheckoutId, url: intent.payNowCheckoutUrl }
          : undefined;
        let status = intent.status;
        if (options.checkoutClient && intent.status === "pending_checkout") {
          const returnUrl = checkoutResultUrl(options.publicOrigin, intent.intentId, "return");
          const cancelUrl = checkoutResultUrl(options.publicOrigin, intent.intentId, "cancel");
          const created = await options.checkoutClient.createCheckoutForIntent({
            intent,
            billingEmail: String(body.email).trim(),
            ...(returnUrl === undefined ? {} : { returnUrl }),
            ...(cancelUrl === undefined ? {} : { cancelUrl }),
          });
          const updated = await receiver.store.markCheckoutCreated({
            intentId: intent.intentId,
            statusToken: intent.statusToken,
            customerId: created.customerId,
            checkoutId: created.checkoutId,
            checkoutTokenHash: created.checkoutTokenHash,
            checkoutUrl: created.checkoutUrl,
          });
          status = updated.status;
          checkout = {
            id: created.checkoutId,
            url: created.checkoutUrl,
          };
        }
        sendJson(response, 201, {
          schemaVersion: 1,
          intentId: intent.intentId,
          statusToken: intent.statusToken,
          status,
          plan: {
            id: intent.plan,
            sku: intent.sku,
            name: intent.planName,
            monthlyPriceCents: intent.monthlyPriceCents,
            currency: intent.currency,
            billingPeriod: intent.billingPeriod,
            autoRenew: intent.autoRenew,
            concurrency: intent.concurrency,
          },
          maskedEmail: intent.maskedEmail,
          expiresAt: intent.expiresAt,
          ...(checkout === undefined ? {} : { checkout }),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/feedback") {
        const body = objectBody(await readJson(request));
        const allowed = new Set(["name", "email", "category", "message", "page", "userAgent", "website"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const honeypot = stringField(body, "website", 300);
        if (honeypot) {
          sendJson(response, 202, { schemaVersion: 1, status: "received" });
          return;
        }
        if (!options.feedbackEmail) {
          throw new ServiceError("feedback_email_not_configured", "Feedback email delivery is not configured", 503);
        }
        const feedback = feedbackText(body, request);
        feedbackRateLimiter.check({
          request,
          ...(feedback.email === undefined ? {} : { email: feedback.email }),
          ...(feedback.userAgent === undefined ? {} : { userAgent: feedback.userAgent }),
        });
        try {
          await options.feedbackEmail.transport.send({
            to: options.feedbackEmail.to,
            subject: options.feedbackEmail.subjectPrefix === undefined
              ? feedback.subject
              : `${options.feedbackEmail.subjectPrefix} ${feedback.category}`,
            text: feedback.text,
            ...(feedback.email === undefined ? {} : { replyTo: feedback.email }),
          });
        } catch {
          throw new ServiceError("feedback_email_failed", "Feedback could not be delivered", 502);
        }
        sendJson(response, 202, { schemaVersion: 1, status: "received" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/email-deliveries") {
        billingRateLimiter.check("email_delivery_status", request, bearerToken(request) ?? "");
        if (!options.emailDeliveryStatus) {
          throw new ServiceError("email_delivery_status_not_configured", "Email delivery status updates are not configured", 503);
        }
        if (!constantTimeEquals(bearerToken(request), options.emailDeliveryStatus.token)) {
          throw new ServiceError("email_delivery_status_unauthorized", "Email delivery status token is invalid", 401);
        }
        const body = objectBody(await readJson(request));
        const allowed = new Set([
          "provider",
          "provider_message_id",
          "status",
          "provider_event_id",
          "error_code",
          "error_message",
        ]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const provider = stringField(body, "provider", 128);
        const providerMessageId = stringField(body, "provider_message_id", 512);
        if (!provider || !providerMessageId) {
          throw new ServiceError("invalid_request", "provider and provider_message_id are required", 400);
        }
        const deliveryUpdate: MarkLicenseEmailDeliveryStatusInput = {
          provider,
          providerMessageId,
          status: emailDeliveryStatus(body.status),
        };
        const providerEventId = stringField(body, "provider_event_id", 512);
        const errorCode = stringField(body, "error_code", 128);
        const errorMessage = stringField(body, "error_message", 512);
        if (providerEventId !== undefined) deliveryUpdate.providerEventId = providerEventId;
        if (errorCode !== undefined) deliveryUpdate.errorCode = errorCode;
        if (errorMessage !== undefined) deliveryUpdate.errorMessage = errorMessage;
        const result = await options.emailDeliveryStatus.store.markLicenseEmailDeliveryStatus(deliveryUpdate);
        sendJson(response, 202, {
          schemaVersion: 1,
          status: "recorded",
          outboxId: result.outboxId,
          deliveryStatus: result.status,
        });
        return;
      }
      const checkoutStatusMatch = /^\/v1\/billing\/checkout-intents\/(ci_[A-Za-z0-9_-]+)\/status$/.exec(url.pathname);
      if (request.method === "GET" && checkoutStatusMatch) {
        billingRateLimiter.check("checkout_status", request, header(request, "x-sly-checkout-status-token") ?? "");
        const status = await receiver.store.checkoutIntentStatus({
          intentId: checkoutStatusMatch[1]!,
          statusToken: header(request, "x-sly-checkout-status-token") ?? "",
        });
        sendJson(response, 200, {
          schemaVersion: 1,
          intentId: status.intentId,
          status: status.status,
          plan: {
            id: status.plan,
            sku: status.sku,
            name: status.planName,
            monthlyPriceCents: status.monthlyPriceCents,
            currency: status.currency,
            billingPeriod: status.billingPeriod,
            autoRenew: status.autoRenew,
            concurrency: status.concurrency,
          },
          maskedEmail: status.maskedEmail,
          createdAt: status.createdAt,
          expiresAt: status.expiresAt,
          ...(status.checkoutCreatedAt === undefined ? {} : { checkoutCreatedAt: status.checkoutCreatedAt }),
        });
        return;
      }
      const customerStatusMatch = /^\/v1\/billing\/orders\/(spo_[A-Za-z0-9_-]+)\/status$/.exec(url.pathname);
      if (request.method === "GET" && customerStatusMatch) {
        billingRateLimiter.check("customer_portal", request, header(request, "x-sly-customer-access-token") ?? "");
        if (!options.customerPortal) {
          throw new ServiceError("customer_portal_not_configured", "Customer billing portal is not configured", 503);
        }
        const status = await options.customerPortal.store.customerBillingStatus({
          publicOrderId: customerPublicOrderId(customerStatusMatch[1]),
          accessToken: customerAccessToken(request),
        });
        sendJson(response, 200, { schemaVersion: 1, ...status });
        return;
      }
      const customerResendMatch = /^\/v1\/billing\/orders\/(spo_[A-Za-z0-9_-]+)\/license-resend$/.exec(url.pathname);
      if (request.method === "POST" && customerResendMatch) {
        if (!options.customerPortal) {
          throw new ServiceError("customer_portal_not_configured", "Customer billing portal is not configured", 503);
        }
        const body = objectBody(await readJson(request));
        const allowed = new Set(["token"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        billingRateLimiter.check("customer_license_resend", request, typeof body.token === "string" ? body.token : "");
        const resend = await options.customerPortal.store.requestLicenseFileResend({
          publicOrderId: customerPublicOrderId(customerResendMatch[1]),
          accessToken: customerAccessToken(request, body),
        });
        sendJson(response, 202, { schemaVersion: 1, ...resend });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/orders") {
        if (!options.adminLookup) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin lookup is not configured", 503);
        }
        const allowed = new Set(["limit", "offset"]);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown query parameters", 400);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminLookup,
          "orders:read",
          header(request, "x-sly-admin-actor") ?? "system:admin-order-list-token",
        );
        const orders = await options.adminLookup.store.adminBillingOrders({
          requestedBy: admin.actor,
          limit: optionalIntegerQuery(url, "limit", 50, 200),
          offset: optionalIntegerQuery(url, "offset", 0, 1_000_000),
        });
        sendJson(response, 200, { schemaVersion: 1, ...orders });
        return;
      }
      const adminOrderMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (request.method === "GET" && adminOrderMatch) {
        if (!options.adminLookup) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin lookup is not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminLookup,
          "orders:read",
          header(request, "x-sly-admin-actor") ?? "system:admin-lookup-token",
        );
        const order = await options.adminLookup.store.adminBillingOrder({
          publicOrderId: customerPublicOrderId(adminOrderMatch[1]),
          requestedBy: admin.actor,
        });
        sendJson(response, 200, { schemaVersion: 1, ...order });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/admin/orders/lookup") {
        if (!options.adminLookup) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin lookup is not configured", 503);
        }
        const allowed = new Set(["publicOrderId", "payNowOrderId", "licenseId"]);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown query parameters", 400);
        }
        const publicOrderId = optionalSingleQuery(url, "publicOrderId");
        const payNowOrderId = optionalSingleQuery(url, "payNowOrderId");
        const licenseId = optionalSingleQuery(url, "licenseId");
        if ([publicOrderId, payNowOrderId, licenseId].filter((value) => value !== undefined).length !== 1) {
          throw new ServiceError("invalid_request", "Exactly one order lookup key is required", 400);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminLookup,
          "orders:read",
          header(request, "x-sly-admin-actor") ?? "system:admin-lookup-token",
        );
        const order = await options.adminLookup.store.adminBillingOrderLookup({
          ...(publicOrderId === undefined ? {} : { publicOrderId }),
          ...(payNowOrderId === undefined ? {} : { payNowOrderId }),
          ...(licenseId === undefined ? {} : { licenseId }),
          requestedBy: admin.actor,
        });
        sendJson(response, 200, { schemaVersion: 1, ...order });
        return;
      }
      const adminOrderNoteMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/notes$/.exec(url.pathname);
      if (request.method === "POST" && adminOrderNoteMatch) {
        if (!options.adminOrderNotes) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin order notes are not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminOrderNotes,
          "orders:note",
          header(request, "x-sly-admin-actor") ?? "system:admin-order-note-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["note"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const note = stringField(body, "note", 2000);
        if (!note || note.length < 4) {
          throw new ServiceError("invalid_request", "note must contain at least 4 characters", 400);
        }
        const created = await options.adminOrderNotes.store.addAdminOrderNote({
          publicOrderId: customerPublicOrderId(adminOrderNoteMatch[1]),
          requestedBy: admin.actor,
          note,
        });
        sendJson(response, 201, { schemaVersion: 1, ...created });
        return;
      }
      const adminCustomerEmailMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/customer-email$/.exec(url.pathname);
      if (request.method === "POST" && adminCustomerEmailMatch) {
        if (!options.adminCustomerEmails) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin customer email changes are not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminCustomerEmails,
          "orders:email",
          header(request, "x-sly-admin-actor") ?? "system:admin-customer-email-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["email", "email_confirmation", "reason", "ownership_evidence"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const email = feedbackEmail(stringField(body, "email", 254));
        const emailConfirmation = feedbackEmail(stringField(body, "email_confirmation", 254));
        if (!email || !emailConfirmation) {
          throw new ServiceError("invalid_request", "email and email_confirmation are required", 400);
        }
        if (email !== emailConfirmation) {
          throw new ServiceError("invalid_request", "Email confirmation does not match", 400);
        }
        const reason = stringField(body, "reason", 512);
        if (!reason || reason.length < 4) {
          throw new ServiceError("invalid_request", "reason must contain at least 4 characters", 400);
        }
        const ownershipEvidence = stringField(body, "ownership_evidence", 2000);
        if (!ownershipEvidence || ownershipEvidence.length < 8) {
          throw new ServiceError("invalid_request", "ownership_evidence must contain at least 8 characters", 400);
        }
        const changed = await options.adminCustomerEmails.store.changeAdminCustomerEmail({
          publicOrderId: customerPublicOrderId(adminCustomerEmailMatch[1]),
          requestedBy: admin.actor,
          email,
          reason,
          ownershipEvidence,
        });
        sendJson(response, 200, { schemaVersion: 1, ...changed });
        return;
      }
      const adminRefundMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/refunds$/.exec(url.pathname);
      if (request.method === "POST" && adminRefundMatch) {
        if (!options.adminRefunds) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin refunds are not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminRefunds,
          "orders:refund",
          header(request, "x-sly-admin-actor") ?? "system:admin-refund-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["reason", "idempotency_key"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const headerIdempotencyKey = header(request, "idempotency-key");
        const bodyIdempotencyKey = stringField(body, "idempotency_key", 160);
        if (headerIdempotencyKey !== undefined && bodyIdempotencyKey !== undefined && headerIdempotencyKey !== bodyIdempotencyKey) {
          throw new ServiceError("invalid_request", "Idempotency key is inconsistent", 400);
        }
        const idempotencyKey = bodyIdempotencyKey ?? headerIdempotencyKey;
        if (!idempotencyKey) {
          throw new ServiceError("invalid_request", "Idempotency-Key is required", 400);
        }
        const reason = stringField(body, "reason", 512);
        if (!reason || reason.length < 4) {
          throw new ServiceError("invalid_request", "reason must contain at least 4 characters", 400);
        }
        const prepared = await options.adminRefunds.store.prepareAdminOrderRefund({
          publicOrderId: customerPublicOrderId(adminRefundMatch[1]),
          idempotencyKey,
          requestedBy: admin.actor,
          reason,
        });
        if (prepared.alreadySubmitted) {
          sendJson(response, 202, {
            schemaVersion: 1,
            refundId: prepared.refundId,
            publicOrderId: prepared.publicOrderId,
            ...(prepared.payNowRefundId === undefined ? {} : { payNowRefundId: prepared.payNowRefundId }),
            status: prepared.status,
            amount: prepared.amount,
            currency: prepared.currency,
          });
          return;
        }
        let payNowRefund: Awaited<ReturnType<PayNowOrderRefundClient["refundOrder"]>>;
        try {
          payNowRefund = await options.adminRefunds.client.refundOrder({
            orderId: prepared.payNowOrderId,
          });
        } catch (error) {
          const serviceError = asServiceError(error);
          const failed = await options.adminRefunds.store.recordAdminOrderRefundFailed?.({
            refundId: prepared.refundId,
            payNowOrderId: prepared.payNowOrderId,
            errorCode: serviceError.code,
            errorMessage: serviceError.message,
          });
          sendJson(response, serviceError.status, {
            error: {
              code: serviceError.code,
              message: serviceError.message,
              refundId: failed?.refundId ?? prepared.refundId,
              publicOrderId: failed?.publicOrderId ?? prepared.publicOrderId,
              payNowOrderId: failed?.payNowOrderId ?? prepared.payNowOrderId,
              status: failed?.status ?? "failed",
            },
          });
          return;
        }
        const refund = await options.adminRefunds.store.recordAdminOrderRefundSubmitted({
          refundId: prepared.refundId,
          payNowOrderId: prepared.payNowOrderId,
          result: payNowRefund,
        });
        sendJson(response, 202, { schemaVersion: 1, ...refund });
        return;
      }
      const adminLicenseResendMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/license-resend$/.exec(url.pathname);
      if (request.method === "POST" && adminLicenseResendMatch) {
        if (!options.adminLicenseResends) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin license resend is not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminLicenseResends,
          "licenses:resend",
          header(request, "x-sly-admin-actor") ?? "system:admin-license-resend-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["reason"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const reason = stringField(body, "reason", 512);
        if (!reason || reason.length < 4) {
          throw new ServiceError("invalid_request", "reason must contain at least 4 characters", 400);
        }
        const resend = await options.adminLicenseResends.store.requestAdminLicenseFileResend({
          publicOrderId: customerPublicOrderId(adminLicenseResendMatch[1]),
          requestedBy: admin.actor,
          reason,
        });
        sendJson(response, 202, { schemaVersion: 1, ...resend });
        return;
      }
      const adminLicenseRotationMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/license-rotation$/.exec(url.pathname);
      if (request.method === "POST" && adminLicenseRotationMatch) {
        if (!options.adminLicenseRotations) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin license rotation is not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminLicenseRotations,
          "licenses:rotate",
          header(request, "x-sly-admin-actor") ?? "system:admin-license-rotation-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["reason", "idempotency_key"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const headerIdempotencyKey = header(request, "idempotency-key");
        const bodyIdempotencyKey = stringField(body, "idempotency_key", 160);
        if (headerIdempotencyKey !== undefined && bodyIdempotencyKey !== undefined && headerIdempotencyKey !== bodyIdempotencyKey) {
          throw new ServiceError("invalid_request", "Idempotency key is inconsistent", 400);
        }
        const idempotencyKey = bodyIdempotencyKey ?? headerIdempotencyKey;
        if (!idempotencyKey) {
          throw new ServiceError("invalid_request", "Idempotency-Key is required", 400);
        }
        const reason = stringField(body, "reason", 512);
        if (!reason || reason.length < 4) {
          throw new ServiceError("invalid_request", "reason must contain at least 4 characters", 400);
        }
        const rotation = await options.adminLicenseRotations.store.rotateLeakedLicenseFile({
          publicOrderId: customerPublicOrderId(adminLicenseRotationMatch[1]),
          idempotencyKey,
          requestedBy: admin.actor,
          reason,
        });
        sendJson(response, 202, { schemaVersion: 1, ...rotation });
        return;
      }
      const adminLicenseStatusMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/license-status$/.exec(url.pathname);
      if (request.method === "POST" && adminLicenseStatusMatch) {
        if (!options.adminLicenseStatus) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin license status updates are not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminLicenseStatus,
          "licenses:update",
          header(request, "x-sly-admin-actor") ?? "system:admin-license-status-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["status", "reason"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const status = stringField(body, "status", 32);
        if (status !== "active" && status !== "hold" && status !== "revoked") {
          throw new ServiceError("invalid_request", "status must be active, hold or revoked", 400);
        }
        const reason = stringField(body, "reason", 512);
        if (!reason || reason.length < 4) {
          throw new ServiceError("invalid_request", "reason must contain at least 4 characters", 400);
        }
        const updated = await options.adminLicenseStatus.store.updateAdminLicenseStatus({
          publicOrderId: customerPublicOrderId(adminLicenseStatusMatch[1]),
          requestedBy: admin.actor,
          status,
          reason,
        });
        sendJson(response, 200, { schemaVersion: 1, ...updated });
        return;
      }
      const adminSubscriptionCancelMatch = /^\/v1\/admin\/orders\/(spo_[A-Za-z0-9_-]+)\/subscription-cancellation$/.exec(url.pathname);
      if (request.method === "POST" && adminSubscriptionCancelMatch) {
        if (!options.adminSubscriptionCancellations) {
          throw new ServiceError("customer_portal_not_configured", "Billing admin subscription cancellation is not configured", 503);
        }
        const admin = await authenticateBillingAdmin(
          request,
          options.adminSubscriptionCancellations,
          "subscriptions:cancel",
          header(request, "x-sly-admin-actor") ?? "system:admin-subscription-cancel-token",
        );
        const body = objectBody(await readJson(request));
        const allowed = new Set(["reason"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        const reason = stringField(body, "reason", 512);
        if (!reason || reason.length < 4) {
          throw new ServiceError("invalid_request", "reason must contain at least 4 characters", 400);
        }
        const prepared = await options.adminSubscriptionCancellations.store.prepareAdminSubscriptionCancellation({
          publicOrderId: customerPublicOrderId(adminSubscriptionCancelMatch[1]),
          requestedBy: admin.actor,
          reason,
        });
        if (!prepared.alreadyCanceled) {
          await options.adminSubscriptionCancellations.client.cancelSubscription({
            subscriptionId: prepared.payNowSubscriptionId,
            cancelAtPeriodEnd: true,
          });
        }
        const canceled = await options.adminSubscriptionCancellations.store.recordAdminSubscriptionCanceled({
          publicOrderId: prepared.publicOrderId,
          payNowSubscriptionId: prepared.payNowSubscriptionId,
          requestedBy: admin.actor,
          reason,
        });
        sendJson(response, 202, { schemaVersion: 1, ...canceled });
        return;
      }
      const customerCancelMatch = /^\/v1\/billing\/orders\/(spo_[A-Za-z0-9_-]+)\/cancel-subscription$/.exec(url.pathname);
      if (request.method === "POST" && customerCancelMatch) {
        if (!options.customerSubscriptionCancellation) {
          throw new ServiceError("customer_portal_not_configured", "Customer billing portal is not configured", 503);
        }
        const body = objectBody(await readJson(request));
        const allowed = new Set(["token"]);
        if (Object.keys(body).some((key) => !allowed.has(key))) {
          throw new ServiceError("invalid_request", "Request contains unknown fields", 400);
        }
        billingRateLimiter.check("customer_subscription_cancel", request, typeof body.token === "string" ? body.token : "");
        const prepared = await options.customerSubscriptionCancellation.store.prepareCustomerSubscriptionCancellation({
          publicOrderId: customerPublicOrderId(customerCancelMatch[1]),
          accessToken: customerAccessToken(request, body),
        });
        if (prepared.alreadyCanceled) {
          sendJson(response, 202, {
            schemaVersion: 1,
            status: "already_canceled",
            publicOrderId: prepared.publicOrderId,
            ...(prepared.publicSubscriptionId === undefined ? {} : { publicSubscriptionId: prepared.publicSubscriptionId }),
            paidThrough: prepared.paidThrough,
            cancelAtPeriodEnd: true,
          });
          return;
        }
        await options.customerSubscriptionCancellation.client.cancelSubscription({
          subscriptionId: prepared.payNowSubscriptionId,
          cancelAtPeriodEnd: true,
        });
        const canceled = await options.customerSubscriptionCancellation.store.recordCustomerSubscriptionCanceled({
          publicOrderId: prepared.publicOrderId,
          payNowSubscriptionId: prepared.payNowSubscriptionId,
        });
        sendJson(response, 202, { schemaVersion: 1, ...canceled });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/paynow/webhook") {
        const startedAt = Date.now();
        const receivedAt = Math.floor(startedAt / 1000);
        let rawBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        try {
          rawBody = await readRaw(request);
          const result = await receiver.receive(
            rawBody,
            header(request, "paynow-timestamp"),
            header(request, "paynow-signature"),
          );
          const httpStatus = result.status === "pending" ? 202 : 200;
          await receiver.store.recordPaymentLog({
            rawBody,
            receivedAt,
            outcome: "success",
            processingResult: result.status,
            httpStatus,
            verificationStatus: "verified",
            durationMilliseconds: Date.now() - startedAt,
          });
          sendJson(response, httpStatus, result);
        } catch (error) {
          const serviceError = asServiceError(error);
          await receiver.store.recordPaymentLog({
            rawBody,
            receivedAt,
            outcome: "failure",
            processingResult: "rejected",
            httpStatus: serviceError.status,
            verificationStatus: verificationStatus(serviceError),
            durationMilliseconds: Date.now() - startedAt,
            errorCode: serviceError.code,
            errorMessage: serviceError.message,
          });
          sendJson(response, serviceError.status, serviceErrorPayload(serviceError));
        }
        return;
      }
      throw new ServiceError("not_found", "Route does not exist", 404);
    } catch (error) {
      const serviceError = asServiceError(error);
      sendJson(response, serviceError.status, serviceErrorPayload(serviceError));
    }
  });
  applyBillingHttpServerTimeouts(server, options.serverTimeouts);
  return server;
}
