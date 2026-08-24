import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ServiceError, invalidRequest } from "./errors.js";
import { PLAN_CATALOG, PLAN_CONTRACT, type PlanId } from "./plans.js";

export const PAYNOW_PRODUCT_PLANS: Readonly<Record<string, Exclude<PlanId, "free">>> = Object.freeze({
  "592701767033036800": "launch",
  "592701920221593600": "studio",
  "592702024412299264": "fleet",
  "592702180452990976": "grid",
});

export const PAYNOW_BILLING_TEST_PRODUCT_IDS: ReadonlySet<string> = new Set([
  "592719053055860736",
]);

export type PayNowSubscriptionEventType =
  | "ON_SUBSCRIPTION_ACTIVATED"
  | "ON_SUBSCRIPTION_RENEWED"
  | "ON_SUBSCRIPTION_CANCELED";

export type PayNowPaymentEventType = "ON_PAYMENT_COMPLETED";

export type PayNowEventOnlyEventType =
  | "ON_ORDER_COMPLETED"
  | "ON_REFUND"
  | "ON_CHARGEBACK"
  | "ON_CHARGEBACK_CLOSED";

export type PayNowWebhookEventType =
  | PayNowSubscriptionEventType
  | PayNowPaymentEventType
  | PayNowEventOnlyEventType;

export interface PayNowPaymentCompletedEvent {
  paymentId: string;
  storeId: string;
  orderId: string;
  amount: number;
  currency: string;
  completedAt: number;
}

export interface PayNowSubscriptionRecord {
  subscriptionId: string;
  storeId: string;
  customerId: string;
  productId: string;
  checkoutIntentId?: string | null;
  plan: Exclude<PlanId, "free">;
  status: "active" | "canceled";
  currentPeriodStart: number | null;
  currentPeriodEnd: number;
  canceledAt: number | null;
  accountId: string | null;
  licenseId: string | null;
  lastEventId: string;
  updatedAt: number;
}

export type Awaitable<T> = T | Promise<T>;

export interface CustomerBillingStatusRecord {
  publicOrderId: string;
  publicSubscriptionId?: string;
  plan: Exclude<PlanId, "free">;
  planName: string;
  concurrency: number;
  orderStatus: "completed" | "refunded" | "disputed" | "canceled";
  subscriptionStatus: "active" | "past_due" | "grace_period" | "cancel_at_period_end" | "canceled" | "suspended";
  paidThrough: number;
  remainingDays: number;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  licenseStatus: "active" | "hold" | "revoked";
  licenseFileDeliveryStatus?: string;
}

export interface CustomerLicenseFileResendRecord {
  status: "queued" | "duplicate";
  publicOrderId: string;
  outboxId: string;
  nextAttemptAt: number;
}

export interface CustomerSubscriptionCancellationPrepareRecord {
  publicOrderId: string;
  publicSubscriptionId?: string;
  payNowSubscriptionId: string;
  paidThrough: number;
  alreadyCanceled: boolean;
}

export interface CustomerSubscriptionCancellationRecord {
  status: "cancel_at_period_end" | "already_canceled";
  publicOrderId: string;
  publicSubscriptionId?: string;
  paidThrough: number;
  cancelAtPeriodEnd: true;
}

export interface CustomerBillingPortalStore {
  customerBillingStatus(input: {
    publicOrderId: string;
    accessToken: string;
    now?: number;
  }): Awaitable<CustomerBillingStatusRecord>;
  requestLicenseFileResend(input: {
    publicOrderId: string;
    accessToken: string;
    now?: number;
  }): Awaitable<CustomerLicenseFileResendRecord>;
}

export interface CustomerSubscriptionCancellationStore {
  prepareCustomerSubscriptionCancellation(input: {
    publicOrderId: string;
    accessToken: string;
    now?: number;
  }): Awaitable<CustomerSubscriptionCancellationPrepareRecord>;
  recordCustomerSubscriptionCanceled(input: {
    publicOrderId: string;
    payNowSubscriptionId: string;
    now?: number;
  }): Awaitable<CustomerSubscriptionCancellationRecord>;
}

export interface AdminSubscriptionCancellationPrepareRecord {
  publicOrderId: string;
  publicSubscriptionId?: string;
  payNowSubscriptionId: string;
  paidThrough: number;
  alreadyCanceled: boolean;
}

export interface AdminSubscriptionCancellationRecord {
  status: "cancel_at_period_end" | "already_canceled";
  publicOrderId: string;
  publicSubscriptionId?: string;
  paidThrough: number;
  cancelAtPeriodEnd: true;
  requestedBy: string;
}

export interface AdminSubscriptionCancellationStore {
  prepareAdminSubscriptionCancellation(input: {
    publicOrderId: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Awaitable<AdminSubscriptionCancellationPrepareRecord>;
  recordAdminSubscriptionCanceled(input: {
    publicOrderId: string;
    payNowSubscriptionId: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Awaitable<AdminSubscriptionCancellationRecord>;
}

export interface PayNowSubscriptionCancellationClient {
  cancelSubscription(input: {
    subscriptionId: string;
    cancelAtPeriodEnd?: boolean;
  }): Awaitable<void>;
}

export type PayNowRefundStatus = "created" | "approved" | "processing" | "completed" | "canceled" | "failed";
export type AdminRefundStatus = "requested" | "processing" | "completed" | "failed";

export interface PayNowRefundResult {
  payNowRefundId: string;
  payNowPaymentId: string;
  payNowCustomerId: string;
  payNowOrderLineId?: string;
  status: PayNowRefundStatus;
  amount: number;
  currency: string;
  createdAt: number;
  completedAt?: number | null;
  failureReason?: string | null;
}

export interface PayNowOrderRefundClient {
  refundOrder(input: {
    orderId: string;
    orderLineId?: string;
    refundFromConnectedUserBalance?: boolean;
  }): Awaitable<PayNowRefundResult>;
}

export interface AdminRefundPrepareRecord {
  refundId: string;
  orderId: string;
  publicOrderId: string;
  paymentId: string;
  payNowOrderId: string;
  payNowRefundId?: string;
  amount: number;
  currency: string;
  reason: string;
  status: AdminRefundStatus;
  alreadySubmitted: boolean;
}

export interface AdminRefundRecord {
  refundId: string;
  publicOrderId: string;
  payNowOrderId?: string;
  payNowPaymentId?: string;
  payNowRefundId?: string;
  status: AdminRefundStatus;
  amount: number;
  currency: string;
  errorCode?: string;
  failureMessage?: string;
}

export interface AdminRefundStore {
  prepareAdminOrderRefund(input: {
    publicOrderId: string;
    idempotencyKey: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Awaitable<AdminRefundPrepareRecord>;
  recordAdminOrderRefundSubmitted(input: {
    refundId: string;
    payNowOrderId: string;
    result: PayNowRefundResult;
    now?: number;
  }): Awaitable<AdminRefundRecord>;
  recordAdminOrderRefundFailed?(input: {
    refundId: string;
    payNowOrderId: string;
    errorCode: string;
    errorMessage: string;
    now?: number;
  }): Awaitable<AdminRefundRecord>;
}

export interface AdminBillingPaymentRecord {
  paymentId: string;
  payNowPaymentId?: string | null;
  amount: number;
  currency: string;
  status: string;
  createdAt: number;
  completedAt?: number | null;
  refundedAt?: number | null;
}

export interface AdminBillingSubscriptionRecord {
  publicSubscriptionId?: string | null;
  payNowSubscriptionId: string;
  status: string;
  paidThrough: number;
  cancelAtPeriodEnd: boolean;
  canceledAt?: number | null;
}

export interface AdminBillingRefundSummaryRecord {
  refundId: string;
  payNowRefundId?: string | null;
  amount: number;
  currency: string;
  status: AdminRefundStatus;
  requestedBy: string;
  requestedAt: number;
  completedAt?: number | null;
  failureMessage?: string | null;
}

export interface AdminBillingAuditLogRecord {
  auditId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  externalResult?: unknown;
  createdAt: number;
}

export interface AdminBillingOrderRecord {
  publicOrderId: string;
  orderId: string;
  payNowOrderId?: string | null;
  payNowCheckoutId?: string | null;
  plan: Exclude<PlanId, "free">;
  orderStatus: string;
  entitlementId: string;
  licenseId: string;
  licenseStatus: string;
  paidThrough?: number | null;
  payments: AdminBillingPaymentRecord[];
  subscriptions: AdminBillingSubscriptionRecord[];
  refunds: AdminBillingRefundSummaryRecord[];
  auditLogs: AdminBillingAuditLogRecord[];
}

export interface AdminBillingOrderSummaryRecord {
  publicOrderId: string;
  payNowOrderId?: string | null;
  plan: Exclude<PlanId, "free">;
  orderStatus: string;
  licenseId: string;
  licenseStatus: string;
  paidThrough?: number | null;
  createdAt: number;
  latestPayment?: {
    amount: number;
    currency: string;
    status: string;
    completedAt?: number | null;
  };
  latestRefund?: {
    status: AdminRefundStatus;
    requestedAt: number;
    completedAt?: number | null;
  };
  refundCount: number;
}

export interface AdminBillingOrderListRecord {
  orders: AdminBillingOrderSummaryRecord[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AdminBillingLookupStore {
  adminBillingOrders(input: {
    requestedBy: string;
    limit?: number;
    offset?: number;
    now?: number;
  }): Awaitable<AdminBillingOrderListRecord>;
  adminBillingOrder(input: {
    publicOrderId: string;
    requestedBy: string;
    now?: number;
  }): Awaitable<AdminBillingOrderRecord>;
  adminBillingOrderLookup(input: {
    publicOrderId?: string;
    payNowOrderId?: string;
    licenseId?: string;
    requestedBy: string;
    now?: number;
  }): Awaitable<AdminBillingOrderRecord>;
}

export interface AdminOrderNoteRecord {
  noteId: string;
  publicOrderId: string;
  requestedBy: string;
  note: string;
  createdAt: number;
}

export interface AdminOrderNoteStore {
  addAdminOrderNote(input: {
    publicOrderId: string;
    requestedBy: string;
    note: string;
    now?: number;
  }): Awaitable<AdminOrderNoteRecord>;
}

export interface AdminCustomerEmailChangeRecord {
  publicOrderId: string;
  requestedBy: string;
  previousMaskedEmail: string;
  maskedEmail: string;
  changed: boolean;
  updatedAt: number;
}

export interface AdminCustomerEmailChangeStore {
  changeAdminCustomerEmail(input: {
    publicOrderId: string;
    requestedBy: string;
    email: string;
    reason: string;
    ownershipEvidence: string;
    now?: number;
  }): Awaitable<AdminCustomerEmailChangeRecord>;
}

export interface AdminLicenseRotationRecord {
  status: "queued" | "duplicate";
  publicOrderId: string;
  oldEntitlementId: string;
  oldLicenseId: string;
  newEntitlementId: string;
  newLicenseId: string;
  outboxId: string;
  nextAttemptAt: number;
}

export interface AdminLicenseRotationStore {
  rotateLeakedLicenseFile(input: {
    publicOrderId: string;
    idempotencyKey: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Awaitable<AdminLicenseRotationRecord>;
}

export interface AdminLicenseStatusRecord {
  publicOrderId: string;
  entitlementId: string;
  licenseId: string;
  previousStatus: "active" | "hold" | "revoked";
  status: "active" | "hold" | "revoked";
  updatedAt: number;
}

export interface AdminLicenseStatusStore {
  updateAdminLicenseStatus(input: {
    publicOrderId: string;
    requestedBy: string;
    status: "active" | "hold" | "revoked";
    reason: string;
    now?: number;
  }): Awaitable<AdminLicenseStatusRecord>;
}

export interface AdminLicenseFileResendRecord {
  status: "queued" | "duplicate";
  publicOrderId: string;
  outboxId: string;
  nextAttemptAt: number;
  requestedBy: string;
}

export interface AdminLicenseFileResendStore {
  requestAdminLicenseFileResend(input: {
    publicOrderId: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Awaitable<AdminLicenseFileResendRecord>;
}

export const PAYNOW_PAYMENT_LOG_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export type PayNowPaymentLogOutcome = "success" | "failure";
export type PayNowVerificationStatus = "verified" | "missing" | "invalid" | "unverified";

export interface PayNowSecurityAlertEvent {
  kind: "paynow_event_conflict";
  eventId: string;
  eventType: PayNowWebhookEventType;
  payloadSha256: string;
  errorCode: string;
}

export interface PayNowPaymentLogRecord {
  logId: string;
  receivedAt: number;
  expiresAt: number;
  outcome: PayNowPaymentLogOutcome;
  processingResult: string;
  httpStatus: number;
  verificationStatus: PayNowVerificationStatus;
  durationMilliseconds: number;
  payloadBytes: number;
  payloadSha256: string;
  eventId: string | null;
  eventType: string | null;
  storeId: string | null;
  productId: string | null;
  checkoutId: string | null;
  subscriptionId: string | null;
  customerId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export type CheckoutIntentStatus = "pending_checkout" | "checkout_created" | "paid";

export interface CheckoutIntentRecord {
  intentId: string;
  statusToken: string;
  status: CheckoutIntentStatus;
  plan: Exclude<PlanId, "free">;
  sku: string;
  planName: string;
  monthlyPriceCents: number;
  currency: string;
  billingPeriod: string;
  autoRenew: boolean;
  concurrency: number;
  maskedEmail: string;
  createdAt: number;
  expiresAt: number;
  payNowCustomerId?: string;
  payNowCheckoutId?: string;
  payNowCheckoutUrl?: string;
  checkoutCreatedAt?: number;
}

export interface CheckoutIntentStatusRecord {
  intentId: string;
  status: CheckoutIntentStatus;
  plan: Exclude<PlanId, "free">;
  sku: string;
  planName: string;
  monthlyPriceCents: number;
  currency: string;
  billingPeriod: string;
  autoRenew: boolean;
  concurrency: number;
  maskedEmail: string;
  createdAt: number;
  expiresAt: number;
  checkoutCreatedAt?: number;
}

export interface PayNowVerifiedFirstPayment {
  checkoutIntentId?: string | null;
  payNowCheckoutId: string;
  payNowOrderId: string;
  payNowPaymentId: string;
  payNowSubscriptionId: string;
  payNowCustomerId: string;
  amount: number;
  currency?: string;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  accountId?: string | null;
  metadataLicenseId?: string | null;
}

export interface PayNowVerifiedRenewalPayment extends PayNowVerifiedFirstPayment {}

export interface PayNowFirstPaymentVerifier {
  verifyFirstPayment(event: PayNowPaymentCompletedEvent): Awaitable<PayNowVerifiedFirstPayment | undefined>;
  verifyRenewalPayment?(event: PayNowPaymentCompletedEvent): Awaitable<PayNowVerifiedRenewalPayment | undefined>;
}

export interface PayNowFirstPaymentRecorder {
  recordVerifiedFirstPayment(input: PayNowVerifiedFirstPayment & {
    sourceEventId?: string | null;
    sourceEventType?: PayNowPaymentEventType | null;
    sourcePayloadSha256?: string | null;
    now: number;
  }): Awaitable<{ status: "processed" | "duplicate" }>;
  recordVerifiedRenewalPayment?(input: PayNowVerifiedRenewalPayment & {
    sourceEventId?: string | null;
    sourceEventType?: PayNowPaymentEventType | null;
    sourcePayloadSha256?: string | null;
    now: number;
  }): Awaitable<{ status: "processed" | "duplicate" }>;
}

export interface PayNowPendingFirstPaymentRecord {
  eventId: string;
  eventType: PayNowPaymentEventType;
  payloadSha256: string;
  payment: PayNowPaymentCompletedEvent;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface PayNowPendingFirstPaymentQueue {
  recordPendingFirstPayment(input: {
    eventId: string;
    eventType: PayNowPaymentEventType;
    payloadSha256: string;
    payment: PayNowPaymentCompletedEvent;
    errorCode: string;
    errorMessage?: string;
    now: number;
    nextAttemptAt?: number;
  }): Awaitable<"queued" | "duplicate">;
  claimPendingFirstPayments(options?: {
    limit?: number;
    now?: number;
    visibilityTimeoutSeconds?: number;
    maxAttempts?: number;
  }): Awaitable<PayNowPendingFirstPaymentRecord[]>;
  markPendingFirstPaymentProcessed(input: {
    eventId: string;
    payloadSha256: string;
    now?: number;
  }): Awaitable<void>;
  markPendingFirstPaymentFailed(input: {
    eventId: string;
    payloadSha256: string;
    errorCode: string;
    errorMessage?: string;
    now?: number;
    maxAttempts?: number;
  }): Awaitable<"pending" | "failed">;
}

export interface PayNowBillingStore {
  createCheckoutIntent(input: {
    planId: unknown;
    email: unknown;
    emailConfirmation: unknown;
    idempotencyKey?: unknown;
    now?: number;
  }): Awaitable<CheckoutIntentRecord>;
  markCheckoutCreated(input: {
    intentId: string;
    statusToken: string;
    customerId: string;
    checkoutId: string;
    checkoutTokenHash: string;
    checkoutUrl: string;
    now?: number;
  }): Awaitable<CheckoutIntentRecord>;
  checkoutIntentStatus(input: {
    intentId: string;
    statusToken: string;
    now?: number;
  }): Awaitable<CheckoutIntentStatusRecord>;
  apply(event: NormalizedPayNowEvent, payloadSha256: string, nowSeconds: number): Awaitable<"processed" | "duplicate">;
  subscription(subscriptionId: string): Awaitable<PayNowSubscriptionRecord | undefined>;
  recordPaymentLog(input: {
    rawBody: Buffer;
    receivedAt: number;
    outcome: PayNowPaymentLogOutcome;
    processingResult: string;
    httpStatus: number;
    verificationStatus: PayNowVerificationStatus;
    durationMilliseconds: number;
    errorCode?: string;
    errorMessage?: string;
  }): Awaitable<PayNowPaymentLogRecord>;
  paymentLogs(options?: { limit?: number; outcome?: PayNowPaymentLogOutcome; since?: number }): Awaitable<PayNowPaymentLogRecord[]>;
  prunePaymentLogs(nowSeconds?: number): Awaitable<number>;
  close(): Awaitable<void>;
}

export interface NormalizedPayNowEvent {
  eventId: string;
  eventType: PayNowWebhookEventType;
  subscription: Omit<PayNowSubscriptionRecord, "lastEventId" | "updatedAt"> | null;
  paymentCompleted: PayNowPaymentCompletedEvent | null;
  eventOnly: {
    id: string;
    storeId: string;
    orderId: string | null;
    paymentId: string | null;
    subscriptionId: string | null;
    customerId: string | null;
    amount: number | null;
    currency: string | null;
  } | null;
}

interface SubscriptionRow {
  subscription_id: string;
  store_id: string;
  customer_id: string;
  product_id: string;
  plan: Exclude<PlanId, "free">;
  status: "active" | "canceled";
  current_period_start: number | null;
  current_period_end: number;
  canceled_at: number | null;
  account_id: string | null;
  license_id: string | null;
  last_event_id: string;
  updated_at: number;
}

interface PaymentLogRow {
  log_id: string;
  received_at: number;
  expires_at: number;
  outcome: PayNowPaymentLogOutcome;
  processing_result: string;
  http_status: number;
  verification_status: PayNowVerificationStatus;
  duration_ms: number;
  payload_bytes: number;
  payload_sha256: string;
  event_id: string | null;
  event_type: string | null;
  store_id: string | null;
  product_id: string | null;
  checkout_id: string | null;
  subscription_id: string | null;
  customer_id: string | null;
  error_code: string | null;
  error_message: string | null;
}

interface CheckoutIntentRow {
  intent_id: string;
  idempotency_key_hash: Uint8Array | null;
  status_token_hash: Uint8Array;
  status: CheckoutIntentStatus;
  plan: Exclude<PlanId, "free">;
  plan_name: string;
  monthly_price_cents: number;
  currency: string;
  billing_period: string;
  concurrency: number;
  masked_email: string;
  email_hmac: Uint8Array;
  created_at: number;
  expires_at: number;
  paynow_customer_id: string | null;
  paynow_checkout_id: string | null;
  paynow_checkout_url_ciphertext: Uint8Array | null;
  paynow_checkout_url_nonce: Uint8Array | null;
  paynow_checkout_url_tag: Uint8Array | null;
  checkout_created_at: number | null;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidRequest(message);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{15,24}$/.test(value)) invalidRequest(`${name} is invalid`);
  return value;
}

function optionalMetadataIdentifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    invalidRequest(`${name} is invalid`);
  }
  return value;
}

function auditIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^\d{15,24}$/.test(value) ? value : null;
}

function auditEventType(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;
}

function auditFields(rawBody: Buffer): Pick<PayNowPaymentLogRecord,
  "eventId" | "eventType" | "storeId" | "productId" | "checkoutId" | "subscriptionId" | "customerId"> {
  const empty = {
    eventId: null,
    eventType: null,
    storeId: null,
    productId: null,
    checkoutId: null,
    subscriptionId: null,
    customerId: null,
  };
  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty;
    const document = payload as Record<string, unknown>;
    const body = document.body && typeof document.body === "object" && !Array.isArray(document.body)
      ? document.body as Record<string, unknown>
      : undefined;
    const checkout = body?.checkout && typeof body.checkout === "object" && !Array.isArray(body.checkout)
      ? body.checkout as Record<string, unknown>
      : undefined;
    const customer = body?.customer && typeof body.customer === "object" && !Array.isArray(body.customer)
      ? body.customer as Record<string, unknown>
      : undefined;
    const eventType = auditEventType(document.event_type);
    return {
      eventId: auditIdentifier(document.event_id),
      eventType,
      storeId: auditIdentifier(body?.store_id),
      productId: auditIdentifier(body?.product_id),
      checkoutId: auditIdentifier(body?.checkout_id) ?? auditIdentifier(checkout?.id),
      subscriptionId: eventType?.startsWith("ON_SUBSCRIPTION_")
        ? auditIdentifier(body?.id)
        : auditIdentifier(body?.subscription_id),
      customerId: auditIdentifier(body?.customer_id) ?? auditIdentifier(customer?.id),
    };
  } catch {
    return empty;
  }
}

function safeLogText(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

function normalizeEmail(value: unknown, name: string): string {
  if (typeof value !== "string") invalidRequest(`${name} is invalid`);
  const email = value.trim();
  if (email.length < 3 || email.length > 254 || /[\u0000-\u001f\u007f\s]/.test(email) ||
      !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    invalidRequest(`${name} is invalid`);
  }
  return email;
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const maskedLocal = local.length <= 2
    ? `${local.at(0) ?? "*"}*`
    : `${local.at(0)}${"*".repeat(Math.min(6, local.length - 2))}${local.at(-1)}`;
  const [domainName = "", ...rest] = domain.split(".");
  const maskedDomain = domainName.length <= 2
    ? `${domainName.at(0) ?? "*"}*`
    : `${domainName.at(0)}${"*".repeat(Math.min(6, domainName.length - 2))}${domainName.at(-1)}`;
  return `${maskedLocal}@${[maskedDomain, ...rest].join(".")}`;
}

function paidPlan(value: unknown): Exclude<PlanId, "free"> {
  if (value !== "launch" && value !== "studio" && value !== "fleet" && value !== "grid") {
    invalidRequest("Plan is invalid");
  }
  return value;
}

function checkoutIntentId(): string {
  return `ci_${randomBytes(18).toString("base64url")}`;
}

function checkoutStatusToken(): string {
  return `cis_${randomBytes(32).toString("base64url")}`;
}

function normalizeIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length < 16 || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalidRequest("Idempotency key is invalid");
  }
  return value;
}

function checkoutStatusTokenForIdempotency(hmacKey: Buffer, idempotencyKey: string): string {
  return `cis_${createHmac("sha256", hmacKey)
    .update("checkout-status-token\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest("base64url")}`;
}

function checkoutIdempotencyHash(hmacKey: Buffer, idempotencyKey: string): Buffer {
  return createHmac("sha256", hmacKey)
    .update("checkout-idempotency-key\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function paymentLogRow(row: PaymentLogRow): PayNowPaymentLogRecord {
  return {
    logId: row.log_id,
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    outcome: row.outcome,
    processingResult: row.processing_result,
    httpStatus: row.http_status,
    verificationStatus: row.verification_status,
    durationMilliseconds: row.duration_ms,
    payloadBytes: row.payload_bytes,
    payloadSha256: row.payload_sha256,
    eventId: row.event_id,
    eventType: row.event_type,
    storeId: row.store_id,
    productId: row.product_id,
    checkoutId: row.checkout_id,
    subscriptionId: row.subscription_id,
    customerId: row.customer_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function checkoutIntentRow(row: CheckoutIntentRow, statusToken = "", checkoutUrl?: string): CheckoutIntentRecord {
  const plan = PLAN_CATALOG[row.plan];
  return {
    intentId: row.intent_id,
    statusToken,
    status: row.status,
    plan: row.plan,
    sku: plan.sku,
    planName: row.plan_name,
    monthlyPriceCents: row.monthly_price_cents,
    currency: row.currency,
    billingPeriod: row.billing_period,
    autoRenew: plan.autoRenew,
    concurrency: row.concurrency,
    maskedEmail: row.masked_email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.paynow_customer_id === null ? {} : { payNowCustomerId: row.paynow_customer_id }),
    ...(row.paynow_checkout_id === null ? {} : { payNowCheckoutId: row.paynow_checkout_id }),
    ...(checkoutUrl === undefined ? {} : { payNowCheckoutUrl: checkoutUrl }),
    ...(row.checkout_created_at === null ? {} : { checkoutCreatedAt: row.checkout_created_at }),
  };
}

function checkoutIntentStatusRow(row: CheckoutIntentRow): CheckoutIntentStatusRecord {
  const plan = PLAN_CATALOG[row.plan];
  return {
    intentId: row.intent_id,
    status: row.status,
    plan: row.plan,
    sku: plan.sku,
    planName: row.plan_name,
    monthlyPriceCents: row.monthly_price_cents,
    currency: row.currency,
    billingPeriod: row.billing_period,
    autoRenew: plan.autoRenew,
    concurrency: row.concurrency,
    maskedEmail: row.masked_email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.checkout_created_at === null ? {} : { checkoutCreatedAt: row.checkout_created_at }),
  };
}

function encryptCheckoutUrl(key: Buffer, intentId: string, checkoutUrl: string): {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
} {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`paynow-checkout-url:${intentId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(checkoutUrl, "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptCheckoutUrl(key: Buffer, row: CheckoutIntentRow): string | undefined {
  if (!row.paynow_checkout_url_ciphertext || !row.paynow_checkout_url_nonce || !row.paynow_checkout_url_tag) {
    return undefined;
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.paynow_checkout_url_nonce));
  decipher.setAAD(Buffer.from(`paynow-checkout-url:${row.intent_id}`, "utf8"));
  decipher.setAuthTag(Buffer.from(row.paynow_checkout_url_tag));
  return Buffer.concat([
    decipher.update(Buffer.from(row.paynow_checkout_url_ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

function timestamp(value: unknown, name: string, required = true): number | null {
  if ((value === undefined || value === null) && !required) return null;
  if (typeof value !== "string") invalidRequest(`${name} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalidRequest(`${name} is invalid`);
  return Math.floor(milliseconds / 1000);
}

function positiveMoney(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) {
    invalidRequest(`${name} is invalid`);
  }
  return value;
}

function supportedCurrency(value: unknown): string {
  if (value !== PLAN_CONTRACT.currency) invalidRequest("Currency is invalid");
  return value;
}

function optionalMoney(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  return positiveMoney(value, name);
}

function optionalSupportedCurrency(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return supportedCurrency(value);
}

function optionalPayNowIdentifier(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return identifier(value, name);
}

function validatePayNowProductId(productId: string): void {
  if (!PAYNOW_PRODUCT_PLANS[productId] && !PAYNOW_BILLING_TEST_PRODUCT_IDS.has(productId)) {
    invalidRequest("PayNow product is not mapped to a SlyBrowser plan or billing test");
  }
}

function optionalProductId(value: unknown): string | null {
  const productId = optionalPayNowIdentifier(value, "PayNow product ID");
  if (productId !== null) validatePayNowProductId(productId);
  return productId;
}

function validateOptionalLineProducts(value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) invalidRequest("PayNow order lines are invalid");
  for (const line of value) {
    const row = object(line, "PayNow order line is invalid");
    optionalProductId(row.product_id);
  }
}

function normalizePayload(value: unknown, expectedStoreId: string, nowSeconds: number): NormalizedPayNowEvent {
  const payload = object(value, "PayNow payload must be an object");
  const eventId = identifier(payload.event_id, "PayNow event ID");
  const supported = new Set<unknown>([
    "ON_ORDER_COMPLETED",
    "ON_PAYMENT_COMPLETED",
    "ON_REFUND",
    "ON_CHARGEBACK",
    "ON_CHARGEBACK_CLOSED",
    "ON_SUBSCRIPTION_ACTIVATED",
    "ON_SUBSCRIPTION_RENEWED",
    "ON_SUBSCRIPTION_CANCELED",
  ]);
  if (!supported.has(payload.event_type)) invalidRequest("PayNow event type is not supported");
  const eventType = payload.event_type as PayNowWebhookEventType;
  const body = object(payload.body, "PayNow event body must be an object");
  const storeId = identifier(body.store_id, "PayNow store ID");
  if (storeId !== expectedStoreId) throw new ServiceError("paynow_store_invalid", "PayNow store ID is invalid", 401);

  if (eventType === "ON_PAYMENT_COMPLETED") {
    if (body.status !== "completed") {
      invalidRequest("PayNow payment completion status is invalid");
    }
    return {
      eventId,
      eventType,
      subscription: null,
      paymentCompleted: {
        paymentId: identifier(body.id, "PayNow payment ID"),
        storeId,
        orderId: identifier(body.order_id, "PayNow order ID"),
        amount: positiveMoney(body.amount, "Payment amount"),
        currency: supportedCurrency(body.currency),
        completedAt: timestamp(body.completed_at, "Payment completed at")!,
      },
      eventOnly: null,
    };
  }

  if (
    eventType === "ON_ORDER_COMPLETED" ||
    eventType === "ON_REFUND" ||
    eventType === "ON_CHARGEBACK" ||
    eventType === "ON_CHARGEBACK_CLOSED"
  ) {
    const bodyId = identifier(body.id, "PayNow event body ID");
    const orderId = optionalPayNowIdentifier(body.order_id, "PayNow order ID");
    const paymentId = optionalPayNowIdentifier(body.payment_id, "PayNow payment ID");
    const subscriptionId = optionalPayNowIdentifier(body.subscription_id, "PayNow subscription ID");
    const customerId = optionalPayNowIdentifier(body.customer_id, "PayNow customer ID");
    const amount = optionalMoney(body.amount, "PayNow amount");
    const currency = optionalSupportedCurrency(body.currency);
    optionalProductId(body.product_id);
    validateOptionalLineProducts(body.lines);
    return {
      eventId,
      eventType,
      subscription: null,
      paymentCompleted: null,
      eventOnly: {
        id: bodyId,
        storeId,
        orderId,
        paymentId,
        subscriptionId,
        customerId,
        amount,
        currency,
      },
    };
  }

  const productId = identifier(body.product_id, "PayNow product ID");
  const plan = PAYNOW_PRODUCT_PLANS[productId];
  if (!plan) validatePayNowProductId(productId);
  const currentPeriodEnd = timestamp(body.current_period_end, "Current period end")!;
  if (eventType !== "ON_SUBSCRIPTION_CANCELED" && currentPeriodEnd <= nowSeconds) {
    invalidRequest("Current period end must be in the future");
  }
  const checkout = body.checkout === undefined || body.checkout === null
    ? undefined
    : object(body.checkout, "PayNow checkout is invalid");
  const metadata = checkout?.metadata === undefined || checkout.metadata === null
    ? undefined
    : object(checkout.metadata, "PayNow checkout metadata is invalid");

  if (!plan) {
    identifier(body.id, "PayNow subscription ID");
    identifier(body.customer_id, "PayNow customer ID");
    return { eventId, eventType, subscription: null, paymentCompleted: null, eventOnly: null };
  }

  return {
    eventId,
    eventType,
    eventOnly: null,
    subscription: {
      subscriptionId: identifier(body.id, "PayNow subscription ID"),
      storeId,
      customerId: identifier(body.customer_id, "PayNow customer ID"),
      productId,
      checkoutIntentId: optionalMetadataIdentifier(metadata?.sly_checkout_intent_id, "SlyBrowser checkout intent ID"),
      plan,
      status: eventType === "ON_SUBSCRIPTION_CANCELED" ? "canceled" : "active",
      currentPeriodStart: timestamp(body.current_period_start, "Current period start", false),
      currentPeriodEnd,
      canceledAt: timestamp(body.canceled_at, "Canceled at", false),
      accountId: optionalMetadataIdentifier(metadata?.sly_account_id, "SlyBrowser account ID"),
      licenseId: optionalMetadataIdentifier(metadata?.sly_license_id, "SlyBrowser license ID"),
    },
    paymentCompleted: null,
  };
}

function isRetryablePayNowApiError(error: unknown): error is ServiceError {
  return error instanceof ServiceError &&
    error.status === 502 &&
    (error.code === "paynow_api_unreachable" ||
      error.code === "paynow_api_error" ||
      error.code === "paynow_api_response_invalid");
}

function rowToRecord(row: SubscriptionRow): PayNowSubscriptionRecord {
  return {
    subscriptionId: row.subscription_id,
    storeId: row.store_id,
    customerId: row.customer_id,
    productId: row.product_id,
    plan: row.plan,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at,
    accountId: row.account_id,
    licenseId: row.license_id,
    lastEventId: row.last_event_id,
    updatedAt: row.updated_at,
  };
}

export class PayNowWebhookStore implements PayNowBillingStore {
  readonly #database: DatabaseSync;
  readonly #emailEncryptionKey: Buffer | undefined;
  readonly #emailHmacKey: Buffer | undefined;

  constructor(path: string, options: {
    emailEncryptionKey?: Uint8Array;
    emailHmacKey?: Uint8Array;
  } = {}) {
    if (options.emailEncryptionKey !== undefined && options.emailEncryptionKey.length !== 32) {
      throw new TypeError("Billing email encryption key must contain exactly 32 bytes");
    }
    if (options.emailHmacKey !== undefined && options.emailHmacKey.length < 32) {
      throw new TypeError("Billing email HMAC key must contain at least 32 bytes");
    }
    this.#emailEncryptionKey = options.emailEncryptionKey === undefined ? undefined : Buffer.from(options.emailEncryptionKey);
    this.#emailHmacKey = options.emailHmacKey === undefined ? this.#emailEncryptionKey : Buffer.from(options.emailHmacKey);
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS paynow_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paynow_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        current_period_start INTEGER,
        current_period_end INTEGER NOT NULL,
        canceled_at INTEGER,
        account_id TEXT,
        license_id TEXT,
        last_event_id TEXT NOT NULL REFERENCES paynow_webhook_events(event_id),
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS paynow_subscriptions_customer
        ON paynow_subscriptions(store_id, customer_id);
      CREATE TABLE IF NOT EXISTS paynow_payment_logs (
        log_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        processing_result TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        verification_status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        payload_bytes INTEGER NOT NULL,
        payload_sha256 TEXT NOT NULL,
        event_id TEXT,
        event_type TEXT,
        store_id TEXT,
        product_id TEXT,
        checkout_id TEXT,
        subscription_id TEXT,
        customer_id TEXT,
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS paynow_payment_logs_received
        ON paynow_payment_logs(received_at DESC);
      CREATE INDEX IF NOT EXISTS paynow_payment_logs_outcome
        ON paynow_payment_logs(outcome, received_at DESC);
      CREATE TABLE IF NOT EXISTS billing_checkout_intents (
        intent_id TEXT PRIMARY KEY,
        idempotency_key_hash BLOB,
        status_token_hash BLOB NOT NULL UNIQUE,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        monthly_price_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        billing_period TEXT NOT NULL,
        concurrency INTEGER NOT NULL,
        email_ciphertext BLOB NOT NULL,
        email_nonce BLOB NOT NULL,
        email_tag BLOB NOT NULL,
        email_hmac BLOB NOT NULL,
        masked_email TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        paynow_customer_id TEXT,
        paynow_checkout_id TEXT,
        paynow_checkout_token_hash BLOB,
        paynow_checkout_url_ciphertext BLOB,
        paynow_checkout_url_nonce BLOB,
        paynow_checkout_url_tag BLOB,
        checkout_created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS billing_checkout_intents_email
        ON billing_checkout_intents(email_hmac, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_intents_idempotency
        ON billing_checkout_intents(idempotency_key_hash)
        WHERE idempotency_key_hash IS NOT NULL;
    `);
    for (const statement of [
      "ALTER TABLE billing_checkout_intents ADD COLUMN idempotency_key_hash BLOB",
      "ALTER TABLE billing_checkout_intents ADD COLUMN paynow_customer_id TEXT",
      "ALTER TABLE billing_checkout_intents ADD COLUMN paynow_checkout_id TEXT",
      "ALTER TABLE billing_checkout_intents ADD COLUMN paynow_checkout_token_hash BLOB",
      "ALTER TABLE billing_checkout_intents ADD COLUMN paynow_checkout_url_ciphertext BLOB",
      "ALTER TABLE billing_checkout_intents ADD COLUMN paynow_checkout_url_nonce BLOB",
      "ALTER TABLE billing_checkout_intents ADD COLUMN paynow_checkout_url_tag BLOB",
      "ALTER TABLE billing_checkout_intents ADD COLUMN checkout_created_at INTEGER",
      "ALTER TABLE paynow_payment_logs ADD COLUMN checkout_id TEXT",
    ]) {
      try {
        this.#database.exec(statement);
      } catch {
        // Existing private-preview databases may already have these additive columns.
      }
    }
    this.#database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_intents_idempotency
        ON billing_checkout_intents(idempotency_key_hash)
        WHERE idempotency_key_hash IS NOT NULL;
    `);
  }

  close(): void {
    this.#database.close();
  }

  createCheckoutIntent(input: {
    planId: unknown;
    email: unknown;
    emailConfirmation: unknown;
    idempotencyKey?: unknown;
    now?: number;
  }): CheckoutIntentRecord {
    if (!this.#emailEncryptionKey || !this.#emailHmacKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const planId = paidPlan(input.planId);
    const email = normalizeEmail(input.email, "Email");
    const emailConfirmation = normalizeEmail(input.emailConfirmation, "Email confirmation");
    if (email.toLowerCase() !== emailConfirmation.toLowerCase()) {
      invalidRequest("Email confirmation does not match");
    }
    const plan = PLAN_CATALOG[planId];
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const expiresAt = now + 30 * 60;
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const idempotencyHash = idempotencyKey === null ? null : checkoutIdempotencyHash(this.#emailHmacKey, idempotencyKey);
    const intentId = checkoutIntentId();
    const statusToken = idempotencyKey === null
      ? checkoutStatusToken()
      : checkoutStatusTokenForIdempotency(this.#emailHmacKey, idempotencyKey);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#emailEncryptionKey, nonce);
    cipher.setAAD(Buffer.from(intentId, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const normalizedEmail = email.toLowerCase();
    const maskedEmail = maskEmail(normalizedEmail);
    const emailHmac = createHmac("sha256", this.#emailHmacKey).update(normalizedEmail, "utf8").digest();

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (idempotencyHash !== null) {
        const existing = this.#database.prepare(
          "SELECT * FROM billing_checkout_intents WHERE idempotency_key_hash=?",
        ).get(idempotencyHash) as CheckoutIntentRow | undefined;
        if (existing) {
          if (existing.expires_at <= now) {
            throw new ServiceError("checkout_idempotency_expired", "Checkout intent idempotency key is expired", 409);
          }
          if (existing.plan !== planId || Buffer.compare(Buffer.from(existing.email_hmac), emailHmac) !== 0) {
            throw new ServiceError("checkout_idempotency_conflict", "Idempotency key was already used for a different checkout", 409);
          }
          const existingCheckoutUrl = decryptCheckoutUrl(this.#emailEncryptionKey, existing);
          this.#database.exec("COMMIT");
          return checkoutIntentRow(existing, statusToken, existingCheckoutUrl);
        }
      }

      this.#database.prepare(`
        INSERT INTO billing_checkout_intents
          (intent_id, idempotency_key_hash, status_token_hash, status, plan, plan_name,
           monthly_price_cents, currency, billing_period, concurrency, email_ciphertext,
           email_nonce, email_tag, email_hmac, masked_email, created_at, expires_at)
        VALUES (?, ?, ?, 'pending_checkout', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        intentId,
        idempotencyHash,
        sha256(statusToken),
        plan.id,
        plan.name,
        plan.monthlyPriceCents,
        PLAN_CONTRACT.currency,
        PLAN_CONTRACT.billingPeriod,
        plan.concurrency,
        ciphertext,
        nonce,
        tag,
        emailHmac,
        maskedEmail,
        now,
        expiresAt,
      );
      this.#database.exec("COMMIT");
      return {
        intentId,
        statusToken,
        status: "pending_checkout",
        plan: planId,
        sku: plan.sku,
        planName: plan.name,
        monthlyPriceCents: plan.monthlyPriceCents,
        currency: PLAN_CONTRACT.currency,
        billingPeriod: PLAN_CONTRACT.billingPeriod,
        autoRenew: plan.autoRenew,
        concurrency: plan.concurrency,
        maskedEmail,
        createdAt: now,
        expiresAt,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  markCheckoutCreated(input: {
    intentId: string;
    statusToken: string;
    customerId: string;
    checkoutId: string;
    checkoutTokenHash: string;
    checkoutUrl: string;
    now?: number;
  }): CheckoutIntentRecord {
    if (!this.#emailEncryptionKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const encryptedCheckoutUrl = encryptCheckoutUrl(this.#emailEncryptionKey, input.intentId, input.checkoutUrl);
    const result = this.#database.prepare(`
      UPDATE billing_checkout_intents
      SET status='checkout_created',
          paynow_customer_id=?,
          paynow_checkout_id=?,
          paynow_checkout_token_hash=?,
          paynow_checkout_url_ciphertext=?,
          paynow_checkout_url_nonce=?,
          paynow_checkout_url_tag=?,
          checkout_created_at=?
      WHERE intent_id=? AND status='pending_checkout' AND expires_at>?
    `).run(
      input.customerId,
      input.checkoutId,
      Buffer.from(input.checkoutTokenHash, "hex"),
      encryptedCheckoutUrl.ciphertext,
      encryptedCheckoutUrl.nonce,
      encryptedCheckoutUrl.tag,
      now,
      input.intentId,
      now,
    );
    if (Number(result.changes) !== 1) {
      throw new ServiceError("checkout_intent_unavailable", "Checkout intent is no longer available", 409);
    }
    const row = this.#database.prepare(
      "SELECT * FROM billing_checkout_intents WHERE intent_id=?",
    ).get(input.intentId) as CheckoutIntentRow | undefined;
    if (!row) throw new ServiceError("checkout_intent_unavailable", "Checkout intent is no longer available", 409);
    return checkoutIntentRow(row, input.statusToken, input.checkoutUrl);
  }

  checkoutIntentStatus(input: {
    intentId: string;
    statusToken: string;
    now?: number;
  }): CheckoutIntentStatusRecord {
    if (!/^ci_[A-Za-z0-9_-]{16,128}$/.test(input.intentId) || !/^cis_[A-Za-z0-9_-]{32,128}$/.test(input.statusToken)) {
      throw new ServiceError("checkout_status_unavailable", "Checkout status is not available", 404);
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const row = this.#database.prepare(
      "SELECT * FROM billing_checkout_intents WHERE intent_id=?",
    ).get(input.intentId) as CheckoutIntentRow | undefined;
    if (!row || row.expires_at <= now) {
      throw new ServiceError("checkout_status_unavailable", "Checkout status is not available", 404);
    }
    const expected = sha256(input.statusToken);
    const actual = Buffer.from(row.status_token_hash);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ServiceError("checkout_status_unavailable", "Checkout status is not available", 404);
    }
    return checkoutIntentStatusRow(row);
  }

  apply(event: NormalizedPayNowEvent, payloadSha256: string, nowSeconds: number): "processed" | "duplicate" {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database.prepare(
        "SELECT payload_sha256 FROM paynow_webhook_events WHERE event_id=?",
      ).get(event.eventId) as { payload_sha256: string } | undefined;
      if (existing) {
        if (existing.payload_sha256 !== payloadSha256) {
          throw new ServiceError("paynow_event_conflict", "PayNow event ID conflicts with a previous payload", 409);
        }
        this.#database.exec("COMMIT");
        return "duplicate";
      }

      this.#database.prepare(`
        INSERT INTO paynow_webhook_events (event_id, event_type, payload_sha256, received_at)
        VALUES (?, ?, ?, ?)
      `).run(event.eventId, event.eventType, payloadSha256, nowSeconds);
      const value = event.subscription;
      if (value) {
        this.#database.prepare(`
        INSERT INTO paynow_subscriptions
          (subscription_id, store_id, customer_id, product_id, plan, status,
           current_period_start, current_period_end, canceled_at, account_id, license_id,
           last_event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          store_id=excluded.store_id,
          customer_id=excluded.customer_id,
          product_id=excluded.product_id,
          plan=excluded.plan,
          status=CASE
            WHEN paynow_subscriptions.status='canceled' AND excluded.status='active'
            THEN paynow_subscriptions.status
            ELSE excluded.status
          END,
          current_period_start=COALESCE(excluded.current_period_start, paynow_subscriptions.current_period_start),
          current_period_end=MAX(excluded.current_period_end, paynow_subscriptions.current_period_end),
          canceled_at=COALESCE(excluded.canceled_at, paynow_subscriptions.canceled_at),
          account_id=COALESCE(excluded.account_id, paynow_subscriptions.account_id),
          license_id=COALESCE(excluded.license_id, paynow_subscriptions.license_id),
          last_event_id=excluded.last_event_id,
          updated_at=excluded.updated_at
        `).run(
          value.subscriptionId,
          value.storeId,
          value.customerId,
          value.productId,
          value.plan,
          value.status,
          value.currentPeriodStart,
          value.currentPeriodEnd,
          value.canceledAt,
          value.accountId,
          value.licenseId,
          event.eventId,
          nowSeconds,
        );
      }
      this.#database.exec("COMMIT");
      return "processed";
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  subscription(subscriptionId: string): PayNowSubscriptionRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM paynow_subscriptions WHERE subscription_id=?",
    ).get(subscriptionId) as SubscriptionRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  recordPaymentLog(input: {
    rawBody: Buffer;
    receivedAt: number;
    outcome: PayNowPaymentLogOutcome;
    processingResult: string;
    httpStatus: number;
    verificationStatus: PayNowVerificationStatus;
    durationMilliseconds: number;
    errorCode?: string;
    errorMessage?: string;
  }): PayNowPaymentLogRecord {
    const identifiers = auditFields(input.rawBody);
    const record: PayNowPaymentLogRecord = {
      logId: randomUUID(),
      receivedAt: Math.max(0, Math.floor(input.receivedAt)),
      expiresAt: Math.max(0, Math.floor(input.receivedAt)) + PAYNOW_PAYMENT_LOG_RETENTION_SECONDS,
      outcome: input.outcome,
      processingResult: safeLogText(input.processingResult) ?? "unknown",
      httpStatus: Math.max(100, Math.min(599, Math.floor(input.httpStatus))),
      verificationStatus: input.verificationStatus,
      durationMilliseconds: Math.max(0, Math.floor(input.durationMilliseconds)),
      payloadBytes: input.rawBody.length,
      payloadSha256: createHash("sha256").update(input.rawBody).digest("hex"),
      ...identifiers,
      errorCode: safeLogText(input.errorCode),
      errorMessage: safeLogText(input.errorMessage),
    };
    this.#database.prepare(`
      INSERT INTO paynow_payment_logs
        (log_id, received_at, expires_at, outcome, processing_result, http_status,
         verification_status, duration_ms, payload_bytes, payload_sha256,
         event_id, event_type, store_id, product_id, checkout_id, subscription_id, customer_id,
         error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.logId,
      record.receivedAt,
      record.expiresAt,
      record.outcome,
      record.processingResult,
      record.httpStatus,
      record.verificationStatus,
      record.durationMilliseconds,
      record.payloadBytes,
      record.payloadSha256,
      record.eventId,
      record.eventType,
      record.storeId,
      record.productId,
      record.checkoutId,
      record.subscriptionId,
      record.customerId,
      record.errorCode,
      record.errorMessage,
    );
    return record;
  }

  paymentLogs(options: { limit?: number; outcome?: PayNowPaymentLogOutcome; since?: number } = {}): PayNowPaymentLogRecord[] {
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.outcome) {
      clauses.push("outcome=?");
      parameters.push(options.outcome);
    }
    if (options.since !== undefined) {
      clauses.push("received_at>=?");
      parameters.push(Math.max(0, Math.floor(options.since)));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database.prepare(`
      SELECT * FROM paynow_payment_logs ${where}
      ORDER BY received_at DESC, log_id DESC LIMIT ?
    `).all(...parameters, limit) as unknown as PaymentLogRow[];
    return rows.map(paymentLogRow);
  }

  prunePaymentLogs(nowSeconds = Math.floor(Date.now() / 1000)): number {
    return Number(this.#database.prepare(
      "DELETE FROM paynow_payment_logs WHERE expires_at<=?",
    ).run(Math.max(0, Math.floor(nowSeconds))).changes);
  }
}

export class PayNowWebhookReceiver {
  constructor(
    readonly store: PayNowBillingStore,
    readonly options: {
      signingSecrets: readonly string[];
      storeId: string;
      now?: () => number;
      toleranceMilliseconds?: number;
      firstPayment?: {
        verifier: PayNowFirstPaymentVerifier;
        recorder: PayNowFirstPaymentRecorder;
        pendingQueue?: PayNowPendingFirstPaymentQueue;
      };
      securityAlertSink?: (event: PayNowSecurityAlertEvent) => void;
    },
  ) {
    if (!options.signingSecrets.length || options.signingSecrets.some((secret) => !secret)) {
      throw new TypeError("At least one PayNow signing secret is required");
    }
    if (!/^\d{15,24}$/.test(options.storeId)) throw new TypeError("PayNow store ID is invalid");
  }

  async receive(rawBody: Buffer, timestampHeader: string | undefined, signatureHeader: string | undefined): Promise<{
    status: "processed" | "duplicate" | "pending";
    eventId: string;
  }> {
    if (!timestampHeader || !signatureHeader) {
      throw new ServiceError("paynow_signature_required", "PayNow signature headers are required", 401);
    }
    if (!/^\d{13}$/.test(timestampHeader)) {
      throw new ServiceError("paynow_timestamp_invalid", "PayNow timestamp is invalid", 401);
    }
    const requestTimestamp = Number(timestampHeader);
    const nowMilliseconds = Math.floor((this.options.now ?? Date.now)());
    const tolerance = this.options.toleranceMilliseconds ?? 5 * 60 * 1000;
    if (!Number.isSafeInteger(requestTimestamp) || Math.abs(nowMilliseconds - requestTimestamp) > tolerance) {
      throw new ServiceError("paynow_timestamp_invalid", "PayNow timestamp is outside the allowed tolerance", 401);
    }
    let actual: Buffer;
    try {
      actual = Buffer.from(signatureHeader, "base64");
    } catch {
      throw new ServiceError("paynow_signature_invalid", "PayNow signature is invalid", 401);
    }
    let signatureValid = false;
    for (const secret of this.options.signingSecrets) {
      const expected = createHmac("sha256", secret)
        .update(timestampHeader, "utf8")
        .update(".", "utf8")
        .update(rawBody)
        .digest();
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) signatureValid = true;
    }
    if (!signatureValid) {
      throw new ServiceError("paynow_signature_invalid", "PayNow signature is invalid", 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      invalidRequest("PayNow payload is not valid JSON");
    }
    const event = normalizePayload(payload, this.options.storeId, Math.floor(nowMilliseconds / 1000));
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const nowSeconds = Math.floor(nowMilliseconds / 1000);
    try {
      if (event.paymentCompleted) {
        const firstPayment = this.options.firstPayment;
        if (!firstPayment) {
          throw new ServiceError(
            "paynow_second_confirmation_required",
            "PayNow payment completion requires Management API second confirmation",
            503,
          );
        }
        let verified: PayNowVerifiedFirstPayment | undefined;
        try {
          verified = await firstPayment.verifier.verifyFirstPayment(event.paymentCompleted);
        } catch (error) {
          if (firstPayment.pendingQueue && isRetryablePayNowApiError(error)) {
            await firstPayment.pendingQueue.recordPendingFirstPayment({
              eventId: event.eventId,
              eventType: "ON_PAYMENT_COMPLETED",
              payloadSha256,
              payment: event.paymentCompleted,
              errorCode: error.code,
              errorMessage: error.message,
              now: nowSeconds,
              nextAttemptAt: nowSeconds + 60,
            });
            return {
              status: "pending",
              eventId: event.eventId,
            };
          }
          throw error;
        }
        if (verified) {
          const recorded = await firstPayment.recorder.recordVerifiedFirstPayment({
            ...verified,
            sourceEventId: event.eventId,
            sourceEventType: "ON_PAYMENT_COMPLETED",
            sourcePayloadSha256: payloadSha256,
            now: nowSeconds,
          });
          return {
            status: recorded.status,
            eventId: event.eventId,
          };
        }
        if (firstPayment.verifier.verifyRenewalPayment && firstPayment.recorder.recordVerifiedRenewalPayment) {
          let verifiedRenewal: PayNowVerifiedRenewalPayment | undefined;
          try {
            verifiedRenewal = await firstPayment.verifier.verifyRenewalPayment(event.paymentCompleted);
          } catch (error) {
            if (firstPayment.pendingQueue && isRetryablePayNowApiError(error)) {
              await firstPayment.pendingQueue.recordPendingFirstPayment({
                eventId: event.eventId,
                eventType: "ON_PAYMENT_COMPLETED",
                payloadSha256,
                payment: event.paymentCompleted,
                errorCode: error.code,
                errorMessage: error.message,
                now: nowSeconds,
                nextAttemptAt: nowSeconds + 60,
              });
              return {
                status: "pending",
                eventId: event.eventId,
              };
            }
            throw error;
          }
          if (verifiedRenewal) {
            const recorded = await firstPayment.recorder.recordVerifiedRenewalPayment({
              ...verifiedRenewal,
              sourceEventId: event.eventId,
              sourceEventType: "ON_PAYMENT_COMPLETED",
              sourcePayloadSha256: payloadSha256,
              now: nowSeconds,
            });
            return {
              status: recorded.status,
              eventId: event.eventId,
            };
          }
        }
      }
      return {
        status: await this.store.apply(event, payloadSha256, nowSeconds),
        eventId: event.eventId,
      };
    } catch (error) {
      if (error instanceof ServiceError && error.code === "paynow_event_conflict") {
        this.options.securityAlertSink?.({
          kind: "paynow_event_conflict",
          eventId: event.eventId,
          eventType: event.eventType,
          payloadSha256,
          errorCode: error.code,
        });
      }
      throw error;
    }
  }
}
