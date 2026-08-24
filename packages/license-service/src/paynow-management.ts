import { createHash } from "node:crypto";

import { ServiceError } from "./errors.js";
import {
  PAYNOW_BILLING_TEST_PRODUCT_IDS,
  PAYNOW_PRODUCT_PLANS,
  type CheckoutIntentRecord,
  type PayNowFirstPaymentVerifier,
  type PayNowPaymentCompletedEvent,
  type PayNowVerifiedFirstPayment,
  type PayNowVerifiedRenewalPayment,
  type PayNowOrderRefundClient,
  type PayNowRefundResult,
  type PayNowRefundStatus,
  type PayNowSubscriptionCancellationClient,
} from "./paynow.js";
import type {
  PayNowReconciledSubscriptionEvidence,
  PayNowReconciledSubscriptionStatus,
  PayNowReconciliationEvidenceClient,
  PayNowReconciliationListOptions,
} from "./paynow-reconciliation.js";
import { autoRenewForPlan } from "./plans.js";
import { PLAN_CONTRACT } from "./plans.js";
import type { PlanId } from "./plans.js";

type PaidPlanId = Exclude<PlanId, "free">;

export const PAYNOW_MANAGEMENT_API_BASE_URL = "https://api.paynow.gg/v1";

export const PAYNOW_PLAN_PRODUCT_IDS: Readonly<Record<PaidPlanId, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PAYNOW_PRODUCT_PLANS).map(([productId, plan]) => [plan, productId]),
  ) as Record<PaidPlanId, string>,
);

export interface PayNowCheckoutSession {
  customerId: string;
  checkoutId: string;
  checkoutToken: string;
  checkoutTokenHash: string;
  checkoutUrl: string;
}

export interface PayNowCheckoutClient {
  createCheckoutForIntent(input: {
    intent: CheckoutIntentRecord;
    billingEmail: string;
    returnUrl?: string;
    cancelUrl?: string;
  }): Promise<PayNowCheckoutSession>;
}

type FetchLike = (input: string | URL, init: RequestInit) => Promise<Response>;
type SleepLike = (milliseconds: number) => Promise<void>;

export interface PayNowManagementApiAuditEvent {
  operation: string;
  method: "GET" | "POST";
  path: string;
  outcome: "success" | "failure";
  durationMilliseconds: number;
  rateLimitedMilliseconds: number;
  status?: number | undefined;
  errorCode?: string | undefined;
  payNowCode?: string | undefined;
}

export type PayNowManagementApiAuditSink = (event: PayNowManagementApiAuditEvent) => void | Promise<void>;

export interface PayNowManagementRateLimitOptions {
  requestsPerMinute: number;
  maxQueue?: number;
  now?: () => number;
  sleep?: SleepLike;
}

function flakeId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{15,24}$/.test(value)) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4096) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function optionalMetadataIdentifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== "string") {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return Math.floor(milliseconds / 1000);
}

function optionalTimestamp(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return timestamp(value, name);
}

function positiveMoney(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function supportedCurrency(value: unknown): string {
  if (value !== PLAN_CONTRACT.currency) {
    throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow currency does not match the SlyBrowser catalog", 409);
  }
  return value;
}

function metadataFrom(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const document = value as Record<string, unknown>;
  return document.metadata && typeof document.metadata === "object" && !Array.isArray(document.metadata)
    ? document.metadata as Record<string, unknown>
    : undefined;
}

function firstOrderLine(lines: unknown): Record<string, unknown> {
  if (!Array.isArray(lines) || lines.length < 1) {
    throw new ServiceError("paynow_api_response_invalid", "PayNow order lines are invalid in PayNow response", 502);
  }
  return object(lines[0], "PayNow order line");
}

function optionalUrl(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("invalid protocol");
    return url.toString();
  } catch {
    throw new ServiceError("paynow_checkout_url_invalid", `${name} must be an absolute URL`, 500);
  }
}

function checkoutUrl(value: unknown): string {
  const raw = nonEmptyString(value, "PayNow checkout URL");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") {
      throw new ServiceError("paynow_api_response_invalid", "PayNow checkout URL must use HTTPS", 502);
    }
    return url.toString();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("paynow_api_response_invalid", "PayNow checkout URL is invalid", 502);
  }
}

function authorizationHeader(apiKey: string): string {
  const value = apiKey.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("PayNow API key is invalid");
  }
  return /^apikey\s+/i.test(value) ? value : `APIKey ${value}`;
}

function productIds(
  overrides: Partial<Record<PaidPlanId, string>> | undefined,
): Readonly<Record<PaidPlanId, string>> {
  const merged = { ...PAYNOW_PLAN_PRODUCT_IDS, ...(overrides ?? {}) };
  for (const plan of ["launch", "studio", "fleet", "grid"] as const) {
    if (!/^\d{15,24}$/.test(merged[plan])) {
      throw new TypeError(`PayNow product ID for ${plan} is invalid`);
    }
  }
  return Object.freeze(merged);
}

function sanitizePayNowCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

function sanitizePayNowMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized.slice(0, 512);
}

function sanitizePayNowErrors(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const errors: Array<Record<string, string>> = [];
  for (const entry of value.slice(0, 5)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const document = entry as Record<string, unknown>;
    const error: Record<string, string> = {};
    const path = sanitizePayNowMessage(document.path ?? document.field ?? document.property);
    const message = sanitizePayNowMessage(document.message);
    const code = sanitizePayNowCode(document.code);
    if (path && /^[A-Za-z0-9_.:/[\]-]{1,160}$/.test(path)) error.path = path;
    if (message) error.message = message;
    if (code) error.code = code;
    if (Object.keys(error).length) errors.push(error);
  }
  return errors.length ? errors : undefined;
}

function optionalListCursor(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function boundedListLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 250) {
    throw new TypeError("PayNow list limit must be between 1 and 250");
  }
  return value;
}

function queryPath(
  path: string,
  options: PayNowReconciliationListOptions & { status?: string } = {},
): string {
  const search = new URLSearchParams();
  const limit = boundedListLimit(options.limit);
  const after = optionalListCursor(options.after, "PayNow list after cursor");
  const before = optionalListCursor(options.before, "PayNow list before cursor");
  if (limit !== undefined) search.set("limit", String(limit));
  if (after !== undefined) search.set("after", after);
  if (before !== undefined) search.set("before", before);
  if (options.asc !== undefined) search.set("asc", options.asc ? "true" : "false");
  if (options.status !== undefined) search.set("status", options.status);
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function arrayPayload(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function subscriptionStatus(value: unknown): PayNowReconciledSubscriptionStatus {
  if (value === "invalid" || value === "created" || value === "active" || value === "canceled") return value;
  throw new ServiceError("paynow_api_response_invalid", "PayNow subscription status is invalid in PayNow response", 502);
}

function refundStatus(value: unknown): PayNowRefundStatus {
  if (
    value === "created" ||
    value === "approved" ||
    value === "processing" ||
    value === "completed" ||
    value === "canceled" ||
    value === "failed"
  ) {
    return value;
  }
  throw new ServiceError("paynow_api_response_invalid", "PayNow refund status is invalid in PayNow response", 502);
}

function optionalBoundedString(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceError("paynow_api_response_invalid", `${name} is invalid in PayNow response`, 502);
  }
  return value;
}

function paymentCompletedEvent(value: unknown): PayNowPaymentCompletedEvent | undefined {
  const payment = object(value, "PayNow payment");
  if (payment.status !== "completed" || payment.completed_at === null || payment.completed_at === undefined) {
    return undefined;
  }
  return {
    paymentId: flakeId(payment.id, "PayNow payment ID"),
    storeId: flakeId(payment.store_id, "PayNow payment store ID"),
    orderId: flakeId(payment.order_id, "PayNow payment order ID"),
    amount: positiveMoney(payment.amount, "PayNow payment amount"),
    currency: supportedCurrency(payment.currency),
    completedAt: timestamp(payment.completed_at, "PayNow payment completed at"),
  };
}

function subscriptionEvidence(value: unknown, observedAt: number): PayNowReconciledSubscriptionEvidence | undefined {
  const subscription = object(value, "PayNow subscription");
  const productId = flakeId(subscription.product_id, "PayNow subscription product ID");
  if (!PAYNOW_PRODUCT_PLANS[productId]) return undefined;
  const customer = object(subscription.customer, "PayNow subscription customer");
  const evidence: PayNowReconciledSubscriptionEvidence = {
    payNowSubscriptionId: flakeId(subscription.id, "PayNow subscription ID"),
    payNowCustomerId: flakeId(customer.id, "PayNow subscription customer ID"),
    storeId: flakeId(subscription.store_id, "PayNow subscription store ID"),
    productId,
    status: subscriptionStatus(subscription.status),
    observedAt,
  };
  const currentPeriodStart = optionalTimestamp(subscription.current_period_start, "PayNow subscription current period start");
  const currentPeriodEnd = optionalTimestamp(subscription.current_period_end, "PayNow subscription current period end");
  const nextAttemptAt = optionalTimestamp(subscription.next_attempt_at, "PayNow subscription next attempt at");
  const attemptCount = optionalNonNegativeInteger(subscription.attempt_count, "PayNow subscription attempt count");
  if (currentPeriodStart !== null) evidence.currentPeriodStart = currentPeriodStart;
  if (currentPeriodEnd !== null) evidence.currentPeriodEnd = currentPeriodEnd;
  evidence.nextAttemptAt = nextAttemptAt;
  evidence.attemptCount = attemptCount;
  return evidence;
}

function refundResult(value: unknown): PayNowRefundResult {
  const refund = object(value, "PayNow refund");
  const result: PayNowRefundResult = {
    payNowRefundId: flakeId(refund.id, "PayNow refund ID"),
    payNowPaymentId: flakeId(refund.payment_id, "PayNow refund payment ID"),
    payNowCustomerId: flakeId(refund.customer_id, "PayNow refund customer ID"),
    status: refundStatus(refund.status),
    amount: positiveMoney(refund.amount, "PayNow refund amount"),
    currency: supportedCurrency(refund.currency),
    createdAt: timestamp(refund.created_at, "PayNow refund created at"),
  };
  if (refund.order_line_id !== undefined && refund.order_line_id !== null) {
    result.payNowOrderLineId = flakeId(refund.order_line_id, "PayNow refund order line ID");
  }
  const completedAt = optionalTimestamp(refund.completed_at, "PayNow refund completed at");
  if (completedAt !== null) result.completedAt = completedAt;
  const failureReason = optionalBoundedString(refund.failure_reason, "PayNow refund failure reason");
  if (failureReason !== null) result.failureReason = failureReason;
  return result;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

function serviceErrorPayNowCode(error: unknown): string | undefined {
  if (!(error instanceof ServiceError)) return undefined;
  return sanitizePayNowCode(error.details.code);
}

class PayNowManagementRateLimiter {
  readonly #minimumSpacingMilliseconds: number;
  readonly #maxQueue: number;
  readonly #now: () => number;
  readonly #sleep: SleepLike;
  #nextAvailableAt = 0;
  #queueDepth = 0;

  constructor(options: PayNowManagementRateLimitOptions) {
    if (!Number.isSafeInteger(options.requestsPerMinute) ||
        options.requestsPerMinute < 1 ||
        options.requestsPerMinute > 6000) {
      throw new TypeError("PayNow API rate limit must be between 1 and 6000 requests per minute");
    }
    const maxQueue = options.maxQueue ?? 100;
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 1000) {
      throw new TypeError("PayNow API rate limit queue must be between 1 and 1000 requests");
    }
    this.#minimumSpacingMilliseconds = Math.ceil(60_000 / options.requestsPerMinute);
    this.#maxQueue = maxQueue;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? sleep;
  }

  async wait(): Promise<number> {
    const now = Math.max(0, Math.floor(this.#now()));
    const scheduledAt = Math.max(now, this.#nextAvailableAt);
    const delay = Math.max(0, scheduledAt - now);
    if (delay > 0) {
      if (this.#queueDepth >= this.#maxQueue) {
        throw new ServiceError(
          "paynow_api_rate_limit_queue_full",
          "PayNow API request queue is full",
          503,
        );
      }
      this.#queueDepth += 1;
    }
    this.#nextAvailableAt = scheduledAt + this.#minimumSpacingMilliseconds;
    if (delay > 0) {
      try {
        await this.#sleep(delay);
      } finally {
        this.#queueDepth -= 1;
      }
    }
    return delay;
  }
}

export class PayNowManagementClient implements PayNowCheckoutClient, PayNowFirstPaymentVerifier, PayNowReconciliationEvidenceClient, PayNowSubscriptionCancellationClient, PayNowOrderRefundClient {
  readonly #apiBaseUrl: URL;
  readonly #authorization: string;
  readonly #storeId: string;
  readonly #productIds: Readonly<Record<PaidPlanId, string>>;
  readonly #fetch: FetchLike;
  readonly #timeoutMilliseconds: number;
  readonly #rateLimiter: PayNowManagementRateLimiter | undefined;
  readonly #auditSink: PayNowManagementApiAuditSink | undefined;

  constructor(options: {
    apiKey: string;
    storeId: string;
    apiBaseUrl?: string;
    productIds?: Partial<Record<PaidPlanId, string>>;
    fetch?: FetchLike;
    timeoutMilliseconds?: number;
    rateLimit?: PayNowManagementRateLimitOptions;
    auditSink?: PayNowManagementApiAuditSink;
  }) {
    const apiBaseUrl = new URL(options.apiBaseUrl ?? PAYNOW_MANAGEMENT_API_BASE_URL);
    apiBaseUrl.pathname = apiBaseUrl.pathname.replace(/\/+$/, "");
    if (apiBaseUrl.protocol !== "https:" && apiBaseUrl.hostname !== "127.0.0.1" && apiBaseUrl.hostname !== "localhost") {
      throw new TypeError("PayNow API base URL must use HTTPS outside local tests");
    }
    if (!/^\d{15,24}$/.test(options.storeId)) throw new TypeError("PayNow store ID is invalid");
    const timeoutMilliseconds = options.timeoutMilliseconds ?? 20_000;
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1000 || timeoutMilliseconds > 60_000) {
      throw new TypeError("PayNow API timeout must be between 1000 and 60000 milliseconds");
    }
    this.#apiBaseUrl = apiBaseUrl;
    this.#authorization = authorizationHeader(options.apiKey);
    this.#storeId = options.storeId;
    this.#productIds = productIds(options.productIds);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#rateLimiter = options.rateLimit === undefined ? undefined : new PayNowManagementRateLimiter(options.rateLimit);
    this.#auditSink = options.auditSink;
  }

  async createCheckoutForIntent(input: {
    intent: CheckoutIntentRecord;
    billingEmail: string;
    returnUrl?: string;
    cancelUrl?: string;
  }): Promise<PayNowCheckoutSession> {
    const productId = this.#productIds[input.intent.plan];
    const autoRenew = (input.intent as CheckoutIntentRecord & { autoRenew?: boolean }).autoRenew
      ?? autoRenewForPlan(input.intent.plan);
    if (!autoRenew) {
      throw new ServiceError("paynow_sku_not_renewable", "PayNow checkout SKU is not configured for automatic renewal", 500);
    }
    const metadata = { sly_checkout_intent_id: input.intent.intentId };
    const customer = await this.#postJson("/customers", {
      name: "SlyBrowser customer",
      metadata,
    }, "create_customer");
    const customerId = flakeId((customer as Record<string, unknown>).id, "PayNow customer ID");
    const checkoutRequest: Record<string, unknown> = {
      customer_id: customerId,
      lines: [{
        product_id: productId,
        quantity: 1,
        subscription: autoRenew,
      }],
      customer_details: {
        billing_email: input.billingEmail,
      },
      metadata,
    };
    const returnUrl = optionalUrl(input.returnUrl, "Return URL");
    const cancelUrl = optionalUrl(input.cancelUrl, "Cancel URL");
    if (returnUrl) {
      checkoutRequest.return_url = returnUrl;
      checkoutRequest.auto_redirect = true;
    }
    if (cancelUrl) checkoutRequest.cancel_url = cancelUrl;

    const checkout = await this.#postJson("/checkouts", checkoutRequest, "create_checkout");
    const checkoutToken = nonEmptyString((checkout as Record<string, unknown>).token, "PayNow checkout token");
    return {
      customerId,
      checkoutId: flakeId((checkout as Record<string, unknown>).id, "PayNow checkout ID"),
      checkoutToken,
      checkoutTokenHash: createHash("sha256").update(checkoutToken, "utf8").digest("hex"),
      checkoutUrl: checkoutUrl((checkout as Record<string, unknown>).url),
    };
  }

  async verifyFirstPayment(event: PayNowPaymentCompletedEvent): Promise<PayNowVerifiedFirstPayment | undefined> {
    return this.#verifySubscriptionPayment(event, "subscription_initial");
  }

  async verifyRenewalPayment(event: PayNowPaymentCompletedEvent): Promise<PayNowVerifiedRenewalPayment | undefined> {
    return this.#verifySubscriptionPayment(event, "subscription_renewal");
  }

  async listCompletedPayments(options: PayNowReconciliationListOptions = {}): Promise<PayNowPaymentCompletedEvent[]> {
    const payload = arrayPayload(
      await this.#getJson(queryPath("/payments", { ...options, status: "completed" }), "list_payments"),
      "PayNow payments list",
    );
    return payload
      .map((entry) => paymentCompletedEvent(entry))
      .filter((entry): entry is PayNowPaymentCompletedEvent => entry !== undefined);
  }

  async listSubscriptions(
    options: PayNowReconciliationListOptions & { status?: PayNowReconciledSubscriptionStatus } = {},
  ): Promise<PayNowReconciledSubscriptionEvidence[]> {
    const observedAt = Math.floor(Date.now() / 1000);
    const payload = arrayPayload(
      await this.#getJson(queryPath("/subscriptions", options), "list_subscriptions"),
      "PayNow subscriptions list",
    );
    return payload
      .map((entry) => subscriptionEvidence(entry, observedAt))
      .filter((entry): entry is PayNowReconciledSubscriptionEvidence => entry !== undefined);
  }

  async cancelSubscription(input: {
    subscriptionId: string;
    cancelAtPeriodEnd?: boolean;
  }): Promise<void> {
    const subscriptionId = flakeId(input.subscriptionId, "PayNow subscription ID");
    await this.#postJson(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
      cancel_at_period_end: input.cancelAtPeriodEnd ?? true,
    }, "cancel_subscription");
  }

  async refundOrder(input: {
    orderId: string;
    orderLineId?: string;
    refundFromConnectedUserBalance?: boolean;
  }): Promise<PayNowRefundResult> {
    const orderId = flakeId(input.orderId, "PayNow order ID");
    const body: Record<string, unknown> = {};
    if (input.orderLineId !== undefined) body.order_line_id = flakeId(input.orderLineId, "PayNow order line ID");
    if (input.refundFromConnectedUserBalance !== undefined) {
      body.refund_from_connected_user_balance = input.refundFromConnectedUserBalance;
    }
    return refundResult(
      await this.#postJson(`/orders/${encodeURIComponent(orderId)}/refund`, body, "refund_order"),
    );
  }

  async #verifySubscriptionPayment(
    event: PayNowPaymentCompletedEvent,
    expectedOrderType: "subscription_initial" | "subscription_renewal",
  ): Promise<PayNowVerifiedFirstPayment | PayNowVerifiedRenewalPayment | undefined> {
    const payment = object(
      await this.#getJson(`/payments/${encodeURIComponent(event.paymentId)}`, "get_payment"),
      "PayNow payment",
    );
    const paymentId = flakeId(payment.id, "PayNow payment ID");
    const paymentStoreId = flakeId(payment.store_id, "PayNow payment store ID");
    const paymentOrderId = flakeId(payment.order_id, "PayNow payment order ID");
    const paymentCustomerId = flakeId(payment.customer_id, "PayNow payment customer ID");
    const paymentAmount = positiveMoney(payment.amount, "PayNow payment amount");
    const paymentCurrency = supportedCurrency(payment.currency);
    const paymentCompletedAt = timestamp(payment.completed_at, "PayNow payment completed at");
    if (paymentId !== event.paymentId ||
        paymentStoreId !== this.#storeId ||
        paymentOrderId !== event.orderId ||
        payment.status !== "completed" ||
        paymentAmount !== event.amount ||
        paymentCurrency !== event.currency ||
        paymentCompletedAt !== event.completedAt) {
      throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow payment details do not match the webhook", 409);
    }

    const order = object(
      await this.#getJson(`/orders/${encodeURIComponent(paymentOrderId)}`, "get_order"),
      "PayNow order",
    );
    const orderId = flakeId(order.id, "PayNow order ID");
    const orderStoreId = flakeId(order.store_id, "PayNow order store ID");
    const orderCustomerId = flakeId(order.customer_id, "PayNow order customer ID");
    const orderCheckoutId = flakeId(order.checkout_id, "PayNow order checkout ID");
    const orderSubscriptionId = flakeId(order.subscription_id, "PayNow order subscription ID");
    const orderLine = firstOrderLine(order.lines);
    const productId = flakeId(orderLine.product_id, "PayNow order product ID");
    const plan = PAYNOW_PRODUCT_PLANS[productId];
    if (!plan && PAYNOW_BILLING_TEST_PRODUCT_IDS.has(productId)) return undefined;
    if (!plan) {
      throw new ServiceError("paynow_product_unmapped", "PayNow product is not mapped to a SlyBrowser plan", 400);
    }
    if (order.type !== expectedOrderType) return undefined;
    if (orderId !== paymentOrderId ||
        orderStoreId !== this.#storeId ||
        orderCustomerId !== paymentCustomerId ||
        order.status !== "completed" ||
        order.is_subscription !== true ||
        positiveMoney(order.total_amount, "PayNow order total amount") !== paymentAmount ||
        supportedCurrency(order.currency) !== paymentCurrency) {
      throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow order details do not match the verified payment", 409);
    }

    const subscription = object(
      await this.#getJson(`/subscriptions/${encodeURIComponent(orderSubscriptionId)}`, "get_subscription"),
      "PayNow subscription",
    );
    const subscriptionId = flakeId(subscription.id, "PayNow subscription ID");
    const subscriptionStoreId = flakeId(subscription.store_id, "PayNow subscription store ID");
    const subscriptionCustomer = object(subscription.customer, "PayNow subscription customer");
    const subscriptionCustomerId = flakeId(subscriptionCustomer.id, "PayNow subscription customer ID");
    const subscriptionCheckoutId = flakeId(subscription.checkout_id, "PayNow subscription checkout ID");
    const subscriptionProductId = flakeId(subscription.product_id, "PayNow subscription product ID");
    const currentPeriodStart = timestamp(subscription.current_period_start, "PayNow subscription current period start");
    const currentPeriodEnd = timestamp(subscription.current_period_end, "PayNow subscription current period end");
    if (subscriptionId !== orderSubscriptionId ||
        subscriptionStoreId !== this.#storeId ||
        subscriptionCustomerId !== paymentCustomerId ||
        subscriptionCheckoutId !== orderCheckoutId ||
        subscriptionProductId !== productId ||
        subscription.status !== "active" ||
        currentPeriodEnd <= currentPeriodStart) {
      throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow subscription details do not match the verified payment", 409);
    }

    const customerMetadata = metadataFrom(order.customer) ?? metadataFrom(payment.customer) ?? metadataFrom(subscription.customer);
    return {
      checkoutIntentId: optionalMetadataIdentifier(customerMetadata?.sly_checkout_intent_id, "SlyBrowser checkout intent ID"),
      payNowCheckoutId: orderCheckoutId,
      payNowOrderId: orderId,
      payNowPaymentId: paymentId,
      payNowSubscriptionId: subscriptionId,
      payNowCustomerId: paymentCustomerId,
      amount: paymentAmount,
      currency: paymentCurrency,
      currentPeriodStart,
      currentPeriodEnd,
      accountId: optionalMetadataIdentifier(customerMetadata?.sly_account_id, "SlyBrowser account ID"),
      metadataLicenseId: optionalMetadataIdentifier(customerMetadata?.sly_license_id, "SlyBrowser license ID"),
    };
  }

  async #postJson(path: string, body: unknown, operation: string): Promise<unknown> {
    return this.#requestJson("POST", path, operation, body);
  }

  async #getJson(path: string, operation: string): Promise<unknown> {
    return this.#requestJson("GET", path, operation);
  }

  async #requestJson(method: "GET" | "POST", path: string, operation: string, body?: unknown): Promise<unknown> {
    const url = new URL(`${this.#apiBaseUrl.pathname}/stores/${this.#storeId}${path}`, this.#apiBaseUrl);
    const startedAt = Date.now();
    let rateLimitedMilliseconds = 0;
    let responseStatus: number | undefined;
    let response: Response;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      rateLimitedMilliseconds = this.#rateLimiter === undefined
        ? 0
        : await this.#rateLimiter.wait();
      timer = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
      const request: RequestInit = {
        method,
        headers: {
          accept: "application/json",
          authorization: this.#authorization,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        signal: controller.signal,
      };
      if (method === "POST") request.body = JSON.stringify(body);
      response = await this.#fetch(url, {
        ...request,
      });
      responseStatus = response.status;
    } catch (error) {
      if (error instanceof ServiceError) {
        await this.#emitAudit({
          operation,
          method,
          path,
          outcome: "failure",
          durationMilliseconds: Date.now() - startedAt,
          rateLimitedMilliseconds,
          errorCode: error.code,
        });
        throw error;
      }
      const serviceError = new ServiceError("paynow_api_unreachable", "PayNow API request could not be completed", 502, { operation });
      await this.#emitAudit({
        operation,
        method,
        path,
        outcome: "failure",
        durationMilliseconds: Date.now() - startedAt,
        rateLimitedMilliseconds,
        errorCode: serviceError.code,
      });
      throw serviceError;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const document = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const payNowMessage = sanitizePayNowMessage(document.message);
      const payNowErrors = sanitizePayNowErrors(document.errors);
      const serviceError = new ServiceError("paynow_api_error", "PayNow API rejected the request", 502, {
        operation,
        status: response.status,
        code: sanitizePayNowCode(document.code),
        ...(payNowMessage === undefined ? {} : { payNowMessage }),
        ...(payNowErrors === undefined ? {} : { payNowErrors }),
      });
      await this.#emitAudit({
        operation,
        method,
        path,
        outcome: "failure",
        durationMilliseconds: Date.now() - startedAt,
        rateLimitedMilliseconds,
        status: responseStatus,
        errorCode: serviceError.code,
        payNowCode: serviceErrorPayNowCode(serviceError),
      });
      throw serviceError;
    }
    if (!payload || typeof payload !== "object") {
      const serviceError = new ServiceError("paynow_api_response_invalid", "PayNow API response is invalid", 502, { operation });
      await this.#emitAudit({
        operation,
        method,
        path,
        outcome: "failure",
        durationMilliseconds: Date.now() - startedAt,
        rateLimitedMilliseconds,
        status: responseStatus,
        errorCode: serviceError.code,
      });
      throw serviceError;
    }
    await this.#emitAudit({
      operation,
      method,
      path,
      outcome: "success",
      durationMilliseconds: Date.now() - startedAt,
      rateLimitedMilliseconds,
      status: responseStatus,
    });
    return payload;
  }

  async #emitAudit(event: PayNowManagementApiAuditEvent): Promise<void> {
    if (!this.#auditSink) return;
    try {
      await this.#auditSink(event);
    } catch {
      // Audit sinks must not affect checkout creation or entitlement verification.
    }
  }
}
