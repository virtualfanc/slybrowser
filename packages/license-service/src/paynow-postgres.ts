import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

import { initializePostgresBillingDatabase } from "./billing-postgres-schema.js";
import type {
  PayNowReconciledSubscriptionEvidence,
  PayNowReconciliationStore,
  PayNowSubscriptionReconciliationResult,
} from "./paynow-reconciliation.js";
import type {
  BillingNoticeEmailKind,
  ClaimLicenseEmailOutboxOptions,
  LicenseEmailDeliveryStatus,
  LicenseEmailOutboxTask,
  MarkLicenseEmailDeliveryStatusInput,
  MarkLicenseEmailDeliveryStatusResult,
  MarkLicenseEmailFailedInput,
  MarkLicenseEmailSentInput,
} from "./email-outbox.js";
import { ServiceError, invalidRequest } from "./errors.js";
import { createPortableLicenseFile } from "./license-file.js";
import { PLAN_CATALOG, PLAN_CONTRACT, type PlanId } from "./plans.js";
import type {
  CheckoutIntentRecord,
  CheckoutIntentStatusRecord,
  AdminBillingAuditLogRecord,
  AdminBillingLookupStore,
  AdminBillingOrderListRecord,
  AdminBillingOrderRecord,
  AdminBillingOrderSummaryRecord,
  AdminBillingPaymentRecord,
  AdminBillingRefundSummaryRecord,
  AdminBillingSubscriptionRecord,
  AdminCustomerEmailChangeRecord,
  AdminCustomerEmailChangeStore,
  AdminLicenseFileResendRecord,
  AdminLicenseFileResendStore,
  AdminLicenseRotationRecord,
  AdminLicenseRotationStore,
  AdminLicenseStatusRecord,
  AdminLicenseStatusStore,
  AdminOrderNoteRecord,
  AdminOrderNoteStore,
  AdminRefundPrepareRecord,
  AdminRefundRecord,
  AdminRefundStatus,
  AdminRefundStore,
  AdminSubscriptionCancellationPrepareRecord,
  AdminSubscriptionCancellationRecord,
  AdminSubscriptionCancellationStore,
  CustomerBillingPortalStore,
  CustomerBillingStatusRecord,
  CustomerLicenseFileResendRecord,
  CustomerSubscriptionCancellationRecord,
  CustomerSubscriptionCancellationStore,
  CustomerSubscriptionCancellationPrepareRecord,
  NormalizedPayNowEvent,
  PayNowBillingStore,
  PayNowPaymentEventType,
  PayNowPendingFirstPaymentRecord,
  PayNowPendingFirstPaymentQueue,
  PayNowPaymentLogOutcome,
  PayNowPaymentLogRecord,
  PayNowRefundResult,
  PayNowSubscriptionRecord,
  PayNowVerifiedFirstPayment,
  PayNowVerifiedRenewalPayment,
  PayNowVerificationStatus,
  PayNowWebhookEventType,
} from "./paynow.js";
import {
  PAYNOW_BILLING_TEST_PRODUCT_IDS,
  PAYNOW_PAYMENT_LOG_RETENTION_SECONDS,
  PAYNOW_PRODUCT_PLANS,
} from "./paynow.js";

import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof import("pg");
const ADVISORY_LOCK_CLASS = 915_752_941;
const BILLING_PROVIDER = "paynow";
const LICENSE_FILE_ROTATION_SECONDS = 366 * 24 * 60 * 60;

export interface PaidLicenseFileOptions {
  serviceUrl: string;
  passphrase: string;
  signingKeyId: string;
  signingPrivateKey: string | Buffer;
}

interface BillingCheckoutIntentRow {
  intent_id: string;
  idempotency_key_hash: Buffer | null;
  status_token_hash: Buffer;
  status: "pending_checkout" | "checkout_created" | "paid";
  plan: Exclude<PlanId, "free">;
  plan_snapshot: unknown;
  delivery_email_ciphertext: Buffer;
  delivery_email_nonce: Buffer;
  delivery_email_tag: Buffer;
  delivery_email_hmac: Buffer;
  masked_email: string;
  paynow_customer_id: string | null;
  paynow_checkout_id: string | null;
  paynow_checkout_token_hash: Buffer | null;
  paynow_checkout_url_ciphertext: Buffer | null;
  paynow_checkout_url_nonce: Buffer | null;
  paynow_checkout_url_tag: Buffer | null;
  created_at: string | number | Date;
  expires_at: string | number | Date;
  updated_at: string | number | Date;
  checkout_created_at: string | number | Date | null;
}

interface EncryptedCheckoutEmailRow {
  intent_id: string;
  delivery_email_ciphertext: Buffer;
  delivery_email_nonce: Buffer;
  delivery_email_tag: Buffer;
}

interface BillingSubscriptionRow {
  subscription_id: string;
  public_subscription_id: string;
  paynow_subscription_id: string;
  paynow_customer_id: string;
  checkout_intent_id: string;
  store_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  plan: Exclude<PlanId, "free">;
  status: "active" | "canceled";
  current_period_start: string | number | Date | null;
  current_period_end: string | number | Date;
  paid_through: string | number | Date | null;
  next_attempt_at: string | number | Date | null;
  attempt_count: string | number;
  canceled_at: string | number | Date | null;
  cancel_reason: string | null;
  account_id: string | null;
  license_id: string | null;
  last_event_id: string | null;
  updated_at: string | number | Date;
}

interface BillingWebhookLogRow {
  log_id: string;
  received_at: string | number | Date;
  expires_at: string | number | Date;
  outcome: PayNowPaymentLogOutcome;
  processing_result: string;
  http_status: string | number;
  verification_status: PayNowVerificationStatus;
  duration_ms: string | number;
  payload_bytes: string | number;
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

interface BillingEmailOutboxRow {
  outbox_id: string;
  recipient_email_ciphertext: Buffer;
  recipient_email_nonce: Buffer;
  recipient_email_tag: Buffer;
  payload: unknown;
  attempts: string | number;
}

interface BillingEmailDeliveryStatusRow {
  outbox_id: string;
  status: LicenseEmailDeliveryStatus;
}

interface BillingPendingPayNowEventRow {
  event_id: string;
  event_type: PayNowPaymentEventType;
  payload_sha256: string;
  store_id: string;
  payment_id: string;
  order_id: string;
  amount: string | number;
  currency: string;
  completed_at: string | number | Date;
  attempts: string | number;
  last_error_code: string | null;
  last_error_message: string | null;
  next_attempt_at: string | number | Date;
  created_at: string | number | Date;
  updated_at: string | number | Date;
}

interface CustomerBillingStatusRow {
  public_order_id: string;
  public_subscription_id: string | null;
  plan: Exclude<PlanId, "free">;
  plan_snapshot: unknown;
  order_status: string;
  subscription_status: string | null;
  paid_through: string | number | Date | null;
  canceled_at: string | number | Date | null;
  entitlement_status: string | null;
  email_status: string | null;
}

interface CustomerLicenseResendSourceRow extends EncryptedCheckoutEmailRow {
  order_id: string;
  public_order_id: string;
  outbox_id: string;
  payload: unknown;
}

interface AdminCustomerEmailChangeRow {
  order_id: string;
  public_order_id: string;
  intent_id: string;
  delivery_email_hmac: Buffer;
  masked_email: string;
}

interface AdminLicenseRotationSourceRow extends EncryptedCheckoutEmailRow {
  order_id: string;
  public_order_id: string;
  order_status: string;
  checkout_intent_id: string;
  plan: Exclude<PlanId, "free">;
  plan_snapshot: unknown;
  old_entitlement_id: string;
  old_license_id: string;
  account_id: string | null;
  paid_through: string | number | Date | null;
  first_license_payload: unknown;
}

interface CustomerSubscriptionCancellationRow {
  order_id: string;
  public_order_id: string;
  subscription_id: string;
  public_subscription_id: string | null;
  paynow_subscription_id: string;
  subscription_status: string;
  paid_through: string | number | Date | null;
  plan: Exclude<PlanId, "free">;
  plan_snapshot: unknown;
  intent_id: string;
  delivery_email_ciphertext: Buffer;
  delivery_email_nonce: Buffer;
  delivery_email_tag: Buffer;
}

interface BillingRefundRow {
  refund_id: string;
  order_id: string;
  public_order_id: string;
  payment_id: string;
  paynow_order_id: string;
  paynow_payment_id: string;
  paynow_refund_id: string | null;
  amount: string | number;
  currency: string;
  reason: string;
  status: AdminRefundStatus;
  requested_by: string;
}

interface AdminBillingOrderRow {
  order_id: string;
  public_order_id: string;
  paynow_order_id: string | null;
  paynow_checkout_id: string | null;
  plan: Exclude<PlanId, "free">;
  order_status: string;
  entitlement_id: string;
  license_id: string;
  entitlement_status: string;
  paid_through: string | number | Date | null;
}

interface AdminBillingOrderSummaryRow {
  public_order_id: string;
  paynow_order_id: string | null;
  plan: Exclude<PlanId, "free">;
  order_status: string;
  license_id: string;
  entitlement_status: string;
  paid_through: string | number | Date | null;
  created_at: string | number | Date;
  latest_payment_amount: string | number | null;
  latest_payment_currency: string | null;
  latest_payment_status: string | null;
  latest_payment_completed_at: string | number | Date | null;
  refund_count: string | number;
  latest_refund_status: AdminRefundStatus | null;
  latest_refund_requested_at: string | number | Date | null;
  latest_refund_completed_at: string | number | Date | null;
}

interface AdminBillingPaymentRow {
  payment_id: string;
  paynow_payment_id: string | null;
  amount: string | number;
  currency: string;
  status: string;
  created_at: string | number | Date;
  completed_at: string | number | Date | null;
  refunded_at: string | number | Date | null;
}

interface AdminBillingSubscriptionRow {
  public_subscription_id: string | null;
  paynow_subscription_id: string;
  status: string;
  paid_through: string | number | Date;
  canceled_at: string | number | Date | null;
}

interface AdminBillingRefundSummaryRow {
  refund_id: string;
  paynow_refund_id: string | null;
  amount: string | number;
  currency: string;
  status: AdminRefundStatus;
  requested_by: string;
  requested_at: string | number | Date;
  completed_at: string | number | Date | null;
  failure_message: string | null;
}

interface AdminBillingAuditLogRow {
  audit_id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  old_value: unknown | null;
  new_value: unknown | null;
  before_json: unknown | null;
  after_json: unknown | null;
  external_result: unknown | null;
  created_at: string | number | Date;
}

interface BillingRenewalSubscriptionRow {
  subscription_id: string;
  public_subscription_id: string | null;
  entitlement_id: string;
  entitlement_license_id: string;
  checkout_intent_id: string;
  plan: Exclude<PlanId, "free">;
  plan_snapshot: unknown;
  paynow_checkout_id: string | null;
  paynow_customer_id: string | null;
  customer_access_token_hash: Buffer | null;
  paid_through: string | number | Date | null;
  intent_id: string;
  delivery_email_ciphertext: Buffer;
  delivery_email_nonce: Buffer;
  delivery_email_tag: Buffer;
}

interface BillingNoticeSourceRow extends EncryptedCheckoutEmailRow {
  public_order_id: string;
  public_subscription_id: string | null;
  plan: Exclude<PlanId, "free">;
  plan_snapshot: unknown;
  paid_through: string | number | Date | null;
}

interface BillingReconciliationSubscriptionRow extends BillingSubscriptionRow {
  entitlement_status: string | null;
  entitlement_license_id: string | null;
  entitlement_paid_through: string | number | Date | null;
  public_order_id: string | null;
  plan_snapshot: unknown | null;
  intent_id: string | null;
  delivery_email_ciphertext: Buffer | null;
  delivery_email_nonce: Buffer | null;
  delivery_email_tag: Buffer | null;
}

export interface VerifiedFirstPaymentInput extends PayNowVerifiedFirstPayment {
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
  sourceEventId?: string | null;
  sourceEventType?: PayNowPaymentEventType | null;
  sourcePayloadSha256?: string | null;
  now?: number;
}

export interface VerifiedRenewalPaymentInput extends PayNowVerifiedRenewalPayment {
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
  sourceEventId?: string | null;
  sourceEventType?: PayNowPaymentEventType | null;
  sourcePayloadSha256?: string | null;
  now?: number;
}

export interface VerifiedFirstPaymentRecord {
  status: "processed" | "duplicate";
  entitlementId: string;
  entitlementLicenseId: string;
  orderId: string;
  publicOrderId: string;
  paymentId: string;
  subscriptionId: string;
  periodId: string;
  outboxId: string;
  plan: Exclude<PlanId, "free">;
  paidThrough: number;
  customerAccessToken?: string;
}

export interface VerifiedRenewalPaymentRecord {
  status: "processed" | "duplicate";
  entitlementId: string;
  entitlementLicenseId: string;
  orderId: string;
  publicOrderId: string;
  paymentId: string;
  subscriptionId: string;
  periodId: string;
  plan: Exclude<PlanId, "free">;
  paidThrough: number;
}

type RecordPendingFirstPaymentInput = Parameters<PayNowPendingFirstPaymentQueue["recordPendingFirstPayment"]>[0];
type ClaimPendingFirstPaymentsOptions = NonNullable<Parameters<PayNowPendingFirstPaymentQueue["claimPendingFirstPayments"]>[0]>;
type MarkPendingFirstPaymentProcessedInput = Parameters<PayNowPendingFirstPaymentQueue["markPendingFirstPaymentProcessed"]>[0];
type MarkPendingFirstPaymentFailedInput = Parameters<PayNowPendingFirstPaymentQueue["markPendingFirstPaymentFailed"]>[0];

function integer(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new ServiceError("store_corrupt", "Stored integer value is invalid", 500);
  return result;
}

function epochSeconds(value: unknown): number {
  if (value instanceof Date) {
    const seconds = Math.floor(value.getTime() / 1000);
    if (!Number.isSafeInteger(seconds)) throw new ServiceError("store_corrupt", "Stored timestamp value is invalid", 500);
    return seconds;
  }
  if (typeof value === "string" && !/^-?\d+$/.test(value)) {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw new ServiceError("store_corrupt", "Stored timestamp value is invalid", 500);
    return Math.floor(milliseconds / 1000);
  }
  return integer(value);
}

function postgresTimestamp(seconds: number | null): Date | null {
  if (seconds === null) return null;
  const normalized = Math.max(0, Math.floor(seconds));
  return new Date(normalized * 1000);
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
    return {
      eventId: auditIdentifier(document.event_id),
      eventType: auditEventType(document.event_type),
      storeId: auditIdentifier(body?.store_id),
      productId: auditIdentifier(body?.product_id),
      checkoutId: auditIdentifier(body?.checkout_id) ?? auditIdentifier(checkout?.id),
      subscriptionId: auditIdentifier(body?.id),
      customerId: auditIdentifier(body?.customer_id),
    };
  } catch {
    return empty;
  }
}

function safeLogText(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

function safeRequiredLogText(value: unknown, name: string): string {
  if (typeof value !== "string") invalidRequest(`${name} is invalid`);
  const sanitized = safeLogText(value.trim());
  if (!sanitized) invalidRequest(`${name} is invalid`);
  return sanitized;
}

function safeOptionalLogText(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") invalidRequest(`${name} is invalid`);
  return safeLogText(value.trim());
}

function licenseEmailDeliveryStatus(value: unknown): LicenseEmailDeliveryStatus {
  if (value !== "delivered" && value !== "bounced" && value !== "failed") {
    invalidRequest("Email delivery status is invalid");
  }
  return value;
}

async function queueLicenseEmailManualReview(client: PoolClient, input: {
  outboxId: string;
  reason: "send_failed" | "bounced" | "delivery_failed";
  provider?: string | null;
  providerMessageId?: string | null;
  providerEventId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  now: number;
}): Promise<void> {
  const provider = input.provider ? safeLogText(input.provider) : null;
  const providerMessageId = input.providerMessageId ? safeLogText(input.providerMessageId) : null;
  const providerEventId = input.providerEventId ? safeLogText(input.providerEventId) : null;
  const errorCode = input.errorCode ? safeLogText(input.errorCode) : null;
  const errorMessage = input.errorMessage ? safeLogText(input.errorMessage) : null;
  const deduplicationKey = `email-review:${createHash("sha256").update(JSON.stringify({
    outboxId: input.outboxId,
    reason: input.reason,
    provider,
    providerMessageId,
    providerEventId,
  })).digest("hex")}`;
  await client.query(`
    INSERT INTO billing_email_manual_reviews
      (review_id, deduplication_key, outbox_id, reason, status,
       provider, provider_message_id, provider_event_id,
       error_code, error_message, created_at, updated_at, resolved_at)
    VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $10, NULL)
    ON CONFLICT(deduplication_key) DO UPDATE SET
      error_code=excluded.error_code,
      error_message=excluded.error_message,
      updated_at=excluded.updated_at
    WHERE billing_email_manual_reviews.status='open'
  `, [
    randomUUID(),
    deduplicationKey,
    input.outboxId,
    input.reason,
    provider,
    providerMessageId,
    providerEventId,
    errorCode,
    errorMessage,
    postgresTimestamp(input.now),
  ]);
}

function boundedOutboxLimit(value: number | undefined): number {
  const limit = value === undefined ? 20 : Math.floor(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ServiceError("invalid_request", "Outbox batch size is invalid", 400);
  }
  return limit;
}

function boundedPendingPaymentLimit(value: number | undefined): number {
  const limit = value === undefined ? 20 : Math.floor(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ServiceError("invalid_request", "Pending payment batch size is invalid", 400);
  }
  return limit;
}

function boundedOutboxAttempts(value: number | undefined): number {
  const attempts = value === undefined ? 5 : Math.floor(value);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new ServiceError("invalid_request", "Outbox attempt limit is invalid", 400);
  }
  return attempts;
}

function licenseEmailRetryDelaySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 5 * 60;
  if (attempts === 3) return 30 * 60;
  return 2 * 60 * 60;
}

function pendingPaymentRetryDelaySeconds(attempts: number): number {
  if (attempts <= 1) return 60;
  if (attempts === 2) return 5 * 60;
  if (attempts === 3) return 30 * 60;
  if (attempts === 4) return 2 * 60 * 60;
  return 6 * 60 * 60;
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

function publicOrderId(): string {
  return `spo_${randomBytes(18).toString("base64url")}`;
}

function customerAccessToken(): string {
  return `cst_${randomBytes(32).toString("base64url")}`;
}

function customerAccessTokenHash(hmacKey: Buffer, token: string): Buffer {
  return createHmac("sha256", hmacKey)
    .update("customer-access-token\0", "utf8")
    .update(token, "utf8")
    .digest();
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

function encryptCheckoutEmail(key: Buffer, intentId: string, email: string): {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
} {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(intentId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptCheckoutEmail(key: Buffer, row: EncryptedCheckoutEmailRow): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.delivery_email_nonce));
  decipher.setAAD(Buffer.from(row.intent_id, "utf8"));
  decipher.setAuthTag(Buffer.from(row.delivery_email_tag));
  return Buffer.concat([
    decipher.update(Buffer.from(row.delivery_email_ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

function deliveryEmailHmac(key: Buffer, email: string): Buffer {
  return createHmac("sha256", key).update(email.toLowerCase(), "utf8").digest();
}

function emailHashPrefix(value: Buffer): string {
  return Buffer.from(value).toString("hex").slice(0, 24);
}

function redactedAdminAuditText(value: string): string {
  return value
    .replace(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g, "[redacted_email]")
    .replace(/\bcst_[A-Za-z0-9_-]{16,}\b/g, "cst_[redacted]")
    .replace(/\bsly_(?:live|test|dev)_[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{16,}\b/g, "sly_[redacted_license_key]")
    .slice(0, 512);
}

function planSnapshotObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function billingNoticePlanName(plan: Exclude<PlanId, "free">, snapshot: unknown): string {
  const value = planSnapshotObject(snapshot).name;
  return typeof value === "string" && value.length <= 64 ? value : PLAN_CATALOG[plan].name;
}

function billingNoticeConcurrency(plan: Exclude<PlanId, "free">, snapshot: unknown): number {
  const value = planSnapshotObject(snapshot).concurrency;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000
    ? value
    : PLAN_CATALOG[plan].concurrency;
}

async function queueBillingNoticeEmail(client: PoolClient, key: Buffer | undefined, input: {
  deduplicationKey: string;
  recipientEmail: string;
  kind: BillingNoticeEmailKind;
  plan: Exclude<PlanId, "free">;
  planSnapshot: unknown;
  publicOrderId?: string;
  publicSubscriptionId?: string | null;
  paidThrough?: number | null;
  amount?: number | null;
  currency?: string | null;
  occurredAt?: number;
  nextAttemptAt?: number | null;
  reason?: string | null;
  now: number;
}): Promise<void> {
  if (!key) return;
  const outboxId = randomUUID();
  const encryptedRecipient = encryptOutboxEmail(key, outboxId, input.recipientEmail);
  const payload = {
    schemaVersion: 1,
    kind: input.kind,
    plan: input.plan,
    planName: billingNoticePlanName(input.plan, input.planSnapshot),
    concurrency: billingNoticeConcurrency(input.plan, input.planSnapshot),
    ...(input.publicOrderId === undefined ? {} : { publicOrderId: input.publicOrderId }),
    ...(input.publicSubscriptionId === undefined || input.publicSubscriptionId === null ? {} : { publicSubscriptionId: input.publicSubscriptionId }),
    ...(input.paidThrough === undefined || input.paidThrough === null || input.paidThrough <= 0 ? {} : { paidThrough: input.paidThrough }),
    ...(input.amount === undefined || input.amount === null ? {} : { amount: input.amount }),
    ...(input.currency === undefined || input.currency === null ? {} : { currency: input.currency }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.nextAttemptAt === undefined || input.nextAttemptAt === null ? {} : { nextAttemptAt: input.nextAttemptAt }),
    ...(input.reason === undefined || input.reason === null ? {} : { reason: input.reason }),
  };
  await client.query(`
    INSERT INTO billing_email_outbox
      (outbox_id, deduplication_key, kind, recipient_email_ciphertext,
       recipient_email_nonce, recipient_email_tag, payload, status, attempts,
       next_attempt_at, created_at, updated_at)
    VALUES ($1, $2, 'billing_notice', $3, $4, $5, $6::jsonb, 'queued', 0, $7, $7, $7)
    ON CONFLICT(deduplication_key) DO NOTHING
  `, [
    outboxId,
    input.deduplicationKey,
    encryptedRecipient.ciphertext,
    encryptedRecipient.nonce,
    encryptedRecipient.tag,
    JSON.stringify(payload),
    postgresTimestamp(input.now),
  ]);
}

function encryptOutboxEmail(key: Buffer, outboxId: string, email: string): {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
} {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`billing-email-outbox:${outboxId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(email, "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

function decryptOutboxEmail(key: Buffer, row: BillingEmailOutboxRow): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.recipient_email_nonce));
  decipher.setAAD(Buffer.from(`billing-email-outbox:${row.outbox_id}`, "utf8"));
  decipher.setAuthTag(Buffer.from(row.recipient_email_tag));
  return Buffer.concat([
    decipher.update(Buffer.from(row.recipient_email_ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

function decryptCheckoutUrl(key: Buffer, row: BillingCheckoutIntentRow): string | undefined {
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
  const currency = value === undefined ? PLAN_CONTRACT.currency : value;
  if (currency !== PLAN_CONTRACT.currency) invalidRequest("Currency is invalid");
  return currency;
}

function verifiedPaymentIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 6 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalidRequest(`${name} is invalid`);
  }
  return value;
}

function normalizedOptionalMetadata(value: string | null | undefined, name: string): string | null {
  return optionalMetadataIdentifier(value, name);
}

function normalizedPaymentEventType(value: PayNowPaymentEventType | null | undefined): PayNowPaymentEventType | null {
  if (value === undefined || value === null) return null;
  if (value !== "ON_PAYMENT_COMPLETED") {
    invalidRequest("PayNow source event type is invalid");
  }
  return value;
}

function normalizedPayloadSha256(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!/^[a-f0-9]{64}$/i.test(value)) invalidRequest("PayNow source payload hash is invalid");
  return value.toLowerCase();
}

function normalizedReconciliationStatus(value: PayNowReconciledSubscriptionEvidence["status"]): PayNowReconciledSubscriptionEvidence["status"] {
  if (value === "invalid" || value === "created" || value === "active" || value === "canceled") return value;
  invalidRequest("PayNow subscription reconciliation status is invalid");
}

function normalizedOptionalEpochSeconds(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  const normalized = Math.max(0, Math.floor(value));
  if (!Number.isSafeInteger(normalized)) invalidRequest(`${name} is invalid`);
  return normalized;
}

function normalizedOptionalAttemptCount(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const normalized = Math.floor(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 10_000) {
    invalidRequest("PayNow subscription attempt count is invalid");
  }
  return normalized;
}

function normalizedGracePeriodSeconds(value: number | undefined): number {
  if (value === undefined) return 0;
  const normalized = Math.floor(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 31 * 24 * 60 * 60) {
    throw new TypeError("Billing grace period must be between 0 and 2678400 seconds");
  }
  return normalized;
}

function normalizedPublicOrderId(value: string): string {
  if (!/^spo_[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
  }
  return value;
}

function normalizedLicenseId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    invalidRequest("License ID is invalid");
  }
  return value.toLowerCase();
}

function normalizedCustomerAccessToken(value: string): string {
  if (!/^cst_[A-Za-z0-9_-]{32,160}$/.test(value)) {
    throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
  }
  return value;
}

function normalizedAdminText(value: string, name: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") invalidRequest(`${name} is invalid`);
  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    invalidRequest(`${name} is invalid`);
  }
  return trimmed;
}

function refundIdempotencyHash(value: string): Buffer {
  const idempotencyKey = normalizedAdminText(value, "Refund idempotency key", 16, 160);
  return createHash("sha256")
    .update("slybrowser-admin-refund\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
}

function licenseRotationIdempotencyHash(value: string): Buffer {
  const idempotencyKey = normalizedAdminText(value, "License rotation idempotency key", 16, 160);
  return createHash("sha256")
    .update("slybrowser-admin-license-rotation\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest();
}

function localRefundStatus(status: PayNowRefundResult["status"]): AdminRefundStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "canceled") return "failed";
  return "processing";
}

function boundedFailureMessage(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512);
}

function customerOrderStatus(value: string): CustomerBillingStatusRecord["orderStatus"] {
  if (value === "completed" || value === "refunded" || value === "disputed" || value === "canceled") return value;
  return "completed";
}

function customerSubscriptionStatus(
  row: CustomerBillingStatusRow,
  paidThrough: number,
  now: number,
  gracePeriodSeconds: number,
): CustomerBillingStatusRecord["subscriptionStatus"] {
  if (row.entitlement_status === "revoked") return "suspended";
  if (row.entitlement_status === "hold") return "past_due";
  if (row.subscription_status === "canceled") return paidThrough > now ? "cancel_at_period_end" : "canceled";
  if (paidThrough <= now && gracePeriodSeconds > 0 && paidThrough + gracePeriodSeconds > now) return "grace_period";
  if (paidThrough <= now) return "past_due";
  return "active";
}

function customerStatusRow(row: CustomerBillingStatusRow, now: number, gracePeriodSeconds: number): CustomerBillingStatusRecord {
  const snapshot = row.plan_snapshot && typeof row.plan_snapshot === "object" && !Array.isArray(row.plan_snapshot)
    ? row.plan_snapshot as { name?: unknown; concurrency?: unknown }
    : {};
  const paidThrough = row.paid_through === null ? now : epochSeconds(row.paid_through);
  const subscriptionStatus = customerSubscriptionStatus(row, paidThrough, now, gracePeriodSeconds);
  const cancelAtPeriodEnd = subscriptionStatus === "cancel_at_period_end";
  const canceled = subscriptionStatus === "cancel_at_period_end" || subscriptionStatus === "canceled";
  return {
    publicOrderId: row.public_order_id,
    ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
    plan: row.plan,
    planName: typeof snapshot.name === "string" ? snapshot.name : PLAN_CATALOG[row.plan].name,
    concurrency: typeof snapshot.concurrency === "number" && Number.isSafeInteger(snapshot.concurrency)
      ? snapshot.concurrency
      : PLAN_CATALOG[row.plan].concurrency,
    orderStatus: customerOrderStatus(row.order_status),
    subscriptionStatus,
    paidThrough,
    remainingDays: Math.max(0, Math.ceil((paidThrough - now) / 86_400)),
    autoRenew: !canceled && subscriptionStatus !== "suspended",
    cancelAtPeriodEnd,
    licenseStatus: row.entitlement_status === "hold" || row.entitlement_status === "revoked"
      ? row.entitlement_status
      : "active",
    ...(row.email_status === null ? {} : { licenseFileDeliveryStatus: row.email_status }),
  };
}

function normalizePayload(value: unknown, expectedStoreId: string, nowSeconds: number): NormalizedPayNowEvent {
  const payload = object(value, "PayNow payload must be an object");
  const eventId = identifier(payload.event_id, "PayNow event ID");
  const supported = new Set<unknown>([
    "ON_SUBSCRIPTION_ACTIVATED",
    "ON_SUBSCRIPTION_RENEWED",
    "ON_SUBSCRIPTION_CANCELED",
  ]);
  if (!supported.has(payload.event_type)) invalidRequest("PayNow event type is not supported");
  const eventType = payload.event_type as PayNowWebhookEventType;
  const body = object(payload.body, "PayNow event body must be an object");
  const storeId = identifier(body.store_id, "PayNow store ID");
  if (storeId !== expectedStoreId) throw new ServiceError("paynow_store_invalid", "PayNow store ID is invalid", 401);
  const productId = identifier(body.product_id, "PayNow product ID");
  const plan = PAYNOW_PRODUCT_PLANS[productId];
  if (!plan && !PAYNOW_BILLING_TEST_PRODUCT_IDS.has(productId)) {
    invalidRequest("PayNow product is not mapped to a SlyBrowser plan or billing test");
  }
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
    subscription: {
      subscriptionId: identifier(body.id, "PayNow subscription ID"),
      storeId,
      customerId: identifier(body.customer_id, "PayNow customer ID"),
      productId,
      plan,
      status: eventType === "ON_SUBSCRIPTION_CANCELED" ? "canceled" : "active",
      currentPeriodStart: timestamp(body.current_period_start, "Current period start", false),
      currentPeriodEnd,
      canceledAt: timestamp(body.canceled_at, "Canceled at", false),
      accountId: optionalMetadataIdentifier(metadata?.sly_account_id, "SlyBrowser account ID"),
      licenseId: optionalMetadataIdentifier(metadata?.sly_license_id, "SlyBrowser license ID"),
    },
    paymentCompleted: null,
    eventOnly: null,
  };
}

function paymentLogRow(row: BillingWebhookLogRow): PayNowPaymentLogRecord {
  return {
    logId: row.log_id,
    receivedAt: epochSeconds(row.received_at),
    expiresAt: epochSeconds(row.expires_at),
    outcome: row.outcome,
    processingResult: row.processing_result,
    httpStatus: integer(row.http_status),
    verificationStatus: row.verification_status,
    durationMilliseconds: integer(row.duration_ms),
    payloadBytes: integer(row.payload_bytes),
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

function checkoutIntentRow(row: BillingCheckoutIntentRow, statusToken = "", checkoutUrl?: string): CheckoutIntentRecord {
  const snapshot = row.plan_snapshot as {
    sku?: string;
    name: string;
    monthly_price_cents: number;
    currency: string;
    billing_period: string;
    auto_renew?: boolean;
    concurrency: number;
  } | undefined;
  const plan = PLAN_CATALOG[row.plan];
  return {
    intentId: row.intent_id,
    statusToken,
    status: row.status,
    plan: row.plan,
    sku: snapshot?.sku ?? plan.sku,
    planName: snapshot?.name ?? plan.name,
    monthlyPriceCents: snapshot?.monthly_price_cents ?? 0,
    currency: snapshot?.currency ?? PLAN_CONTRACT.currency,
    billingPeriod: snapshot?.billing_period ?? PLAN_CONTRACT.billingPeriod,
    autoRenew: snapshot?.auto_renew ?? plan.autoRenew,
    concurrency: snapshot?.concurrency ?? plan.concurrency,
    maskedEmail: row.masked_email,
    createdAt: epochSeconds(row.created_at),
    expiresAt: epochSeconds(row.expires_at),
    ...(row.paynow_customer_id === null ? {} : { payNowCustomerId: row.paynow_customer_id }),
    ...(row.paynow_checkout_id === null ? {} : { payNowCheckoutId: row.paynow_checkout_id }),
    ...(checkoutUrl === undefined ? {} : { payNowCheckoutUrl: checkoutUrl }),
    ...(row.checkout_created_at == null ? {} : { checkoutCreatedAt: epochSeconds(row.checkout_created_at) }),
  };
}

function checkoutIntentStatusRow(row: BillingCheckoutIntentRow): CheckoutIntentStatusRecord {
  const snapshot = row.plan_snapshot as {
    sku?: string;
    name: string;
    monthly_price_cents: number;
    currency: string;
    billing_period: string;
    auto_renew?: boolean;
    concurrency: number;
  } | undefined;
  const plan = PLAN_CATALOG[row.plan];
  return {
    intentId: row.intent_id,
    status: row.status,
    plan: row.plan,
    sku: snapshot?.sku ?? plan.sku,
    planName: snapshot?.name ?? plan.name,
    monthlyPriceCents: snapshot?.monthly_price_cents ?? 0,
    currency: snapshot?.currency ?? PLAN_CONTRACT.currency,
    billingPeriod: snapshot?.billing_period ?? PLAN_CONTRACT.billingPeriod,
    autoRenew: snapshot?.auto_renew ?? plan.autoRenew,
    concurrency: snapshot?.concurrency ?? plan.concurrency,
    maskedEmail: row.masked_email,
    createdAt: epochSeconds(row.created_at),
    expiresAt: epochSeconds(row.expires_at),
    ...(row.checkout_created_at == null ? {} : { checkoutCreatedAt: epochSeconds(row.checkout_created_at) }),
  };
}

function rowToRecord(row: BillingSubscriptionRow): PayNowSubscriptionRecord {
  return {
    subscriptionId: row.paynow_subscription_id,
    storeId: row.store_id ?? "",
    customerId: row.customer_id ?? row.paynow_customer_id,
    productId: row.product_id ?? "",
    checkoutIntentId: row.checkout_intent_id,
    plan: row.plan,
    status: row.status,
    currentPeriodStart: row.current_period_start === null ? null : epochSeconds(row.current_period_start),
    currentPeriodEnd: epochSeconds(row.current_period_end),
    canceledAt: row.canceled_at === null ? null : epochSeconds(row.canceled_at),
    accountId: row.account_id,
    licenseId: row.license_id,
    lastEventId: row.last_event_id ?? "",
    updatedAt: epochSeconds(row.updated_at),
  };
}

function pendingPaymentRow(row: BillingPendingPayNowEventRow): PayNowPendingFirstPaymentRecord {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    payloadSha256: row.payload_sha256,
    payment: {
      paymentId: row.payment_id,
      storeId: row.store_id,
      orderId: row.order_id,
      amount: integer(row.amount),
      currency: row.currency,
      completedAt: epochSeconds(row.completed_at),
    },
    attempts: integer(row.attempts),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    nextAttemptAt: epochSeconds(row.next_attempt_at),
    createdAt: epochSeconds(row.created_at),
    updatedAt: epochSeconds(row.updated_at),
  };
}

async function initializeLicenseEntitlementTables(pool: PgPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entitlements (
      license_id UUID PRIMARY KEY,
      account_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      paid_through BIGINT,
      key_hash BYTEA NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
}

export class PostgresPayNowWebhookStore implements PayNowBillingStore, PayNowPendingFirstPaymentQueue, CustomerBillingPortalStore, CustomerSubscriptionCancellationStore, AdminSubscriptionCancellationStore, AdminBillingLookupStore, AdminOrderNoteStore, AdminCustomerEmailChangeStore, AdminRefundStore, AdminLicenseFileResendStore, AdminLicenseRotationStore, AdminLicenseStatusStore, PayNowReconciliationStore {
  readonly #pool: PgPool;
  readonly #emailEncryptionKey: Buffer | undefined;
  readonly #emailHmacKey: Buffer | undefined;
  readonly #licenseKeyPepper: Buffer | undefined;
  readonly #licenseFileOptions: PaidLicenseFileOptions | undefined;
  readonly #gracePeriodSeconds: number;

  private constructor(pool: PgPool, options: {
    emailEncryptionKey?: Uint8Array;
    emailHmacKey?: Uint8Array;
    licenseKeyPepper?: Uint8Array;
    licenseFile?: PaidLicenseFileOptions;
    gracePeriodSeconds?: number;
  } = {}) {
    if (options.emailEncryptionKey !== undefined && options.emailEncryptionKey.length !== 32) {
      throw new TypeError("Billing email encryption key must contain exactly 32 bytes");
    }
    if (options.emailHmacKey !== undefined && options.emailHmacKey.length < 32) {
      throw new TypeError("Billing email HMAC key must contain at least 32 bytes");
    }
    if (options.licenseKeyPepper !== undefined && options.licenseKeyPepper.length < 32) {
      throw new TypeError("License key pepper must contain at least 32 bytes");
    }
    if ((options.licenseKeyPepper === undefined) !== (options.licenseFile === undefined)) {
      throw new TypeError("Paid license file generation requires both a license key pepper and license-file options");
    }
    this.#emailEncryptionKey = options.emailEncryptionKey === undefined ? undefined : Buffer.from(options.emailEncryptionKey);
    this.#emailHmacKey = options.emailHmacKey === undefined ? this.#emailEncryptionKey : Buffer.from(options.emailHmacKey);
    this.#licenseKeyPepper = options.licenseKeyPepper === undefined ? undefined : Buffer.from(options.licenseKeyPepper);
    this.#licenseFileOptions = options.licenseFile;
    this.#gracePeriodSeconds = normalizedGracePeriodSeconds(options.gracePeriodSeconds);
    this.#pool = pool;
  }

  static async connect(config: PoolConfig | string, options: {
    emailEncryptionKey?: Uint8Array;
    emailHmacKey?: Uint8Array;
    licenseKeyPepper?: Uint8Array;
    licenseFile?: PaidLicenseFileOptions;
    gracePeriodSeconds?: number;
  } = {}): Promise<PostgresPayNowWebhookStore> {
    const pool = await initializePostgresBillingDatabase(typeof config === "string" ? { connectionString: config } : config);
    if (options.licenseKeyPepper !== undefined && options.licenseFile !== undefined) {
      await initializeLicenseEntitlementTables(pool);
    }
    return new PostgresPayNowWebhookStore(pool, options);
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  #licenseSecretHash(secret: string): Buffer {
    if (!this.#licenseKeyPepper) {
      throw new ServiceError("paid_license_file_config_required", "Paid license generation is not configured", 503);
    }
    return createHmac("sha256", this.#licenseKeyPepper).update(secret, "utf8").digest();
  }

  async createCheckoutIntent(input: {
    planId: unknown;
    email: unknown;
    emailConfirmation: unknown;
    idempotencyKey?: unknown;
    now?: number;
  }): Promise<CheckoutIntentRecord> {
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
    const normalizedEmail = email.toLowerCase();
    const maskedEmail = maskEmail(normalizedEmail);
    const encryptedEmail = encryptCheckoutEmail(this.#emailEncryptionKey, intentId, email);
    const emailHmac = deliveryEmailHmac(this.#emailHmacKey, normalizedEmail);

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      if (idempotencyKey !== null) {
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `checkout:${idempotencyKey}`]);
        const existing = await client.query<BillingCheckoutIntentRow>(
          "SELECT * FROM billing_checkout_intents WHERE idempotency_key_hash=$1 FOR UPDATE",
          [idempotencyHash],
        );
        const row = existing.rows[0];
        if (row) {
          if (epochSeconds(row.expires_at) <= now) {
            throw new ServiceError("checkout_idempotency_expired", "Checkout intent idempotency key is expired", 409);
          }
          const existingEmailHmac = Buffer.from(row.delivery_email_hmac);
          if (row.plan !== planId || existingEmailHmac.length !== emailHmac.length || !timingSafeEqual(existingEmailHmac, emailHmac)) {
            throw new ServiceError("checkout_idempotency_conflict", "Idempotency key was already used for a different checkout", 409);
          }
          const existingCheckoutUrl = this.#emailEncryptionKey ? decryptCheckoutUrl(this.#emailEncryptionKey, row) : undefined;
          await client.query("COMMIT");
          return checkoutIntentRow(row, statusToken, existingCheckoutUrl);
        }
      }

      await client.query(`
        INSERT INTO billing_checkout_intents
          (intent_id, idempotency_key_hash, status_token_hash, status, plan, plan_snapshot,
           delivery_email_ciphertext, delivery_email_nonce, delivery_email_tag, delivery_email_hmac,
           masked_email, created_at, expires_at, updated_at)
        VALUES ($1, $2, $3, 'pending_checkout', $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        intentId,
        idempotencyHash,
        sha256(statusToken),
        planId,
        JSON.stringify({
          id: planId,
          sku: plan.sku,
          name: plan.name,
          monthly_price_cents: plan.monthlyPriceCents,
          currency: PLAN_CONTRACT.currency,
          billing_period: PLAN_CONTRACT.billingPeriod,
          auto_renew: plan.autoRenew,
          concurrency: plan.concurrency,
        }),
        encryptedEmail.ciphertext,
        encryptedEmail.nonce,
        encryptedEmail.tag,
        emailHmac,
        maskedEmail,
        postgresTimestamp(now),
        postgresTimestamp(expiresAt),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
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
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markCheckoutCreated(input: {
    intentId: string;
    statusToken: string;
    customerId: string;
    checkoutId: string;
    checkoutTokenHash: string;
    checkoutUrl: string;
    now?: number;
  }): Promise<CheckoutIntentRecord> {
    if (!this.#emailEncryptionKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const encryptedCheckoutUrl = encryptCheckoutUrl(this.#emailEncryptionKey, input.intentId, input.checkoutUrl);
    const result = await this.#pool.query<BillingCheckoutIntentRow>(`
      UPDATE billing_checkout_intents
      SET status='checkout_created',
          paynow_customer_id=$1,
          paynow_checkout_id=$2,
          paynow_checkout_token_hash=$3,
          paynow_checkout_url_ciphertext=$4,
          paynow_checkout_url_nonce=$5,
          paynow_checkout_url_tag=$6,
          checkout_created_at=$7,
          updated_at=$7
      WHERE intent_id=$8 AND status='pending_checkout' AND expires_at>$9
      RETURNING *
    `, [
      input.customerId,
      input.checkoutId,
      Buffer.from(input.checkoutTokenHash, "hex"),
      encryptedCheckoutUrl.ciphertext,
      encryptedCheckoutUrl.nonce,
      encryptedCheckoutUrl.tag,
      postgresTimestamp(now),
      input.intentId,
      postgresTimestamp(now),
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new ServiceError("checkout_intent_unavailable", "Checkout intent is no longer available", 409);
    }
    return checkoutIntentRow(row, input.statusToken, input.checkoutUrl);
  }

  async checkoutIntentStatus(input: {
    intentId: string;
    statusToken: string;
    now?: number;
  }): Promise<CheckoutIntentStatusRecord> {
    if (!/^ci_[A-Za-z0-9_-]{16,128}$/.test(input.intentId) || !/^cis_[A-Za-z0-9_-]{32,128}$/.test(input.statusToken)) {
      throw new ServiceError("checkout_status_unavailable", "Checkout status is not available", 404);
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const result = await this.#pool.query<BillingCheckoutIntentRow>(
      "SELECT * FROM billing_checkout_intents WHERE intent_id=$1",
      [input.intentId],
    );
    const row = result.rows[0];
    if (!row || epochSeconds(row.expires_at) <= now) {
      throw new ServiceError("checkout_status_unavailable", "Checkout status is not available", 404);
    }
    const expected = sha256(input.statusToken);
    const actual = Buffer.from(row.status_token_hash);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ServiceError("checkout_status_unavailable", "Checkout status is not available", 404);
    }
    return checkoutIntentStatusRow(row);
  }

  async apply(event: NormalizedPayNowEvent, payloadSha256: string, nowSeconds: number): Promise<"processed" | "duplicate"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `paynow:${event.eventId}`]);
      const existing = await client.query<{ payload_sha256: string }>(
        "SELECT payload_sha256 FROM billing_webhook_events WHERE provider=$1 AND event_id=$2 FOR UPDATE",
        [BILLING_PROVIDER, event.eventId],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.payload_sha256 !== payloadSha256) {
          throw new ServiceError("paynow_event_conflict", "PayNow event ID conflicts with a previous payload", 409);
        }
        await client.query("COMMIT");
        return "duplicate";
      }

      await client.query(`
        INSERT INTO billing_webhook_events (provider, event_id, event_type, payload_sha256, processed_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [BILLING_PROVIDER, event.eventId, event.eventType, payloadSha256, postgresTimestamp(nowSeconds)]);
      const value = event.subscription;
      if (value) {
        if (!value.checkoutIntentId) {
          throw new ServiceError("paynow_checkout_intent_missing", "PayNow checkout intent is missing", 400);
        }
        await client.query(`
          INSERT INTO billing_subscriptions
            (subscription_id, public_subscription_id, paynow_subscription_id, paynow_customer_id,
             checkout_intent_id, entitlement_id, plan, status, current_period_start, current_period_end,
             paid_through, next_attempt_at, attempt_count, canceled_at, cancel_reason, store_id,
             customer_id, product_id, account_id, license_id, last_event_id, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
          ON CONFLICT(paynow_subscription_id) DO UPDATE SET
            checkout_intent_id=excluded.checkout_intent_id,
            paynow_customer_id=excluded.paynow_customer_id,
            entitlement_id=excluded.entitlement_id,
            store_id=excluded.store_id,
            customer_id=excluded.customer_id,
            product_id=excluded.product_id,
            plan=excluded.plan,
            status=CASE
              WHEN billing_subscriptions.status='canceled' AND excluded.status='active'
              THEN billing_subscriptions.status
              ELSE excluded.status
            END,
            current_period_start=COALESCE(excluded.current_period_start, billing_subscriptions.current_period_start),
            current_period_end=GREATEST(excluded.current_period_end, billing_subscriptions.current_period_end),
            paid_through=GREATEST(
              COALESCE(excluded.paid_through, '-infinity'::timestamptz),
              COALESCE(billing_subscriptions.paid_through, '-infinity'::timestamptz)
            ),
            next_attempt_at=excluded.next_attempt_at,
            attempt_count=excluded.attempt_count,
            canceled_at=COALESCE(excluded.canceled_at, billing_subscriptions.canceled_at),
            cancel_reason=COALESCE(excluded.cancel_reason, billing_subscriptions.cancel_reason),
            account_id=COALESCE(excluded.account_id, billing_subscriptions.account_id),
            license_id=COALESCE(excluded.license_id, billing_subscriptions.license_id),
            last_event_id=excluded.last_event_id,
            updated_at=excluded.updated_at
        `, [
          randomUUID(),
          `sps_${randomBytes(18).toString("base64url")}`,
          value.subscriptionId,
          value.customerId,
          value.checkoutIntentId,
          null,
          value.plan,
          value.status,
          postgresTimestamp(value.currentPeriodStart),
          postgresTimestamp(value.currentPeriodEnd),
          postgresTimestamp(value.currentPeriodEnd),
          null,
          0,
          postgresTimestamp(value.canceledAt),
          null,
          value.storeId,
          value.customerId,
          value.productId,
          value.accountId,
          value.licenseId,
          event.eventId,
          postgresTimestamp(nowSeconds),
          postgresTimestamp(nowSeconds),
        ]);
      }
      if (event.eventType === "ON_CHARGEBACK" && event.eventOnly && (event.eventOnly.orderId !== null || event.eventOnly.paymentId !== null)) {
        const affectedOrders = await client.query<{ order_id: string; entitlement_id: string | null }>(`
          UPDATE billing_orders o
          SET status='disputed',
              updated_at=$3
          WHERE ($1::text IS NOT NULL AND o.paynow_order_id=$1)
             OR ($2::text IS NOT NULL AND EXISTS (
               SELECT 1 FROM billing_payments p
               WHERE p.order_id=o.order_id AND p.paynow_payment_id=$2
             ))
          RETURNING o.order_id, o.entitlement_id
        `, [
          event.eventOnly.orderId,
          event.eventOnly.paymentId,
          postgresTimestamp(nowSeconds),
        ]);
        if (event.eventOnly.paymentId !== null || event.eventOnly.orderId !== null) {
          await client.query(`
            UPDATE billing_payments p
            SET status='chargeback',
                updated_at=$3
            WHERE ($1::text IS NOT NULL AND p.paynow_payment_id=$1)
               OR ($2::text IS NOT NULL AND EXISTS (
                 SELECT 1 FROM billing_orders o
                 WHERE o.order_id=p.order_id AND o.paynow_order_id=$2
               ))
          `, [
            event.eventOnly.paymentId,
            event.eventOnly.orderId,
            postgresTimestamp(nowSeconds),
          ]);
        }
        const entitlementIds = [...new Set(
          affectedOrders.rows
            .map((affected) => affected.entitlement_id)
            .filter((value): value is string => value !== null),
        )];
        if (entitlementIds.length > 0) {
          await client.query(`
            UPDATE billing_entitlements
            SET status='hold',
                updated_at=$2
            WHERE entitlement_id=ANY($1::uuid[])
              AND status<>'revoked'
          `, [entitlementIds, postgresTimestamp(nowSeconds)]);
        }
        if (affectedOrders.rows.length > 0 && this.#emailEncryptionKey) {
          const noticeSources = await client.query<BillingNoticeSourceRow>(`
            SELECT DISTINCT ON (o.order_id)
                   o.public_order_id,
                   s.public_subscription_id,
                   o.plan,
                   o.plan_snapshot,
                   COALESCE(s.paid_through, e.paid_through) AS paid_through,
                   ci.intent_id,
                   ci.delivery_email_ciphertext,
                   ci.delivery_email_nonce,
                   ci.delivery_email_tag
            FROM billing_orders o
            JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
            JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
            LEFT JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
            WHERE o.order_id=ANY($1::uuid[])
            ORDER BY o.order_id, s.created_at DESC NULLS LAST
          `, [affectedOrders.rows.map((affected) => affected.order_id)]);
          for (const notice of noticeSources.rows) {
            await queueBillingNoticeEmail(client, this.#emailEncryptionKey, {
              deduplicationKey: `chargeback-hold:${event.eventId}:${notice.public_order_id}`,
              recipientEmail: decryptCheckoutEmail(this.#emailEncryptionKey, notice),
              kind: "chargeback-hold",
              plan: notice.plan,
              planSnapshot: notice.plan_snapshot,
              publicOrderId: notice.public_order_id,
              publicSubscriptionId: notice.public_subscription_id,
              paidThrough: notice.paid_through === null ? null : epochSeconds(notice.paid_through),
              occurredAt: nowSeconds,
              reason: "Payment dispute",
              now: nowSeconds,
            });
          }
        }
        await client.query(`
          INSERT INTO billing_admin_audit_logs
            (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
          VALUES ($1, 'system:paynow-webhook', 'chargeback_hold_applied',
                  'paynow_event', $2, 'paynow_chargeback', $3::jsonb, $4::jsonb, $5)
        `, [
          randomUUID(),
          event.eventId,
          JSON.stringify({
            eventType: event.eventType,
            orderId: event.eventOnly.orderId,
            paymentId: event.eventOnly.paymentId,
          }),
          JSON.stringify({
            affectedOrderCount: affectedOrders.rowCount,
            entitlementHoldCount: entitlementIds.length,
          }),
          postgresTimestamp(nowSeconds),
        ]);
      }
      await client.query("COMMIT");
      return "processed";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async subscription(subscriptionId: string): Promise<PayNowSubscriptionRecord | undefined> {
    const result = await this.#pool.query<BillingSubscriptionRow>(
      "SELECT * FROM billing_subscriptions WHERE paynow_subscription_id=$1",
      [subscriptionId],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async recordPendingFirstPayment(input: RecordPendingFirstPaymentInput): Promise<"queued" | "duplicate"> {
    const eventId = identifier(input.eventId, "PayNow event ID");
    const eventType = normalizedPaymentEventType(input.eventType);
    if (eventType === null) invalidRequest("PayNow source event type is invalid");
    const payloadSha256 = normalizedPayloadSha256(input.payloadSha256);
    if (payloadSha256 === null) invalidRequest("PayNow source payload hash is invalid");
    const payment = {
      paymentId: identifier(input.payment.paymentId, "PayNow payment ID"),
      storeId: identifier(input.payment.storeId, "PayNow store ID"),
      orderId: identifier(input.payment.orderId, "PayNow order ID"),
      amount: positiveMoney(input.payment.amount, "Payment amount"),
      currency: supportedCurrency(input.payment.currency),
      completedAt: Math.max(0, Math.floor(input.payment.completedAt)),
    };
    if (!Number.isSafeInteger(payment.completedAt) || payment.completedAt <= 0) {
      invalidRequest("Payment completed at is invalid");
    }
    const now = Math.max(0, Math.floor(input.now));
    const nextAttemptAt = Math.max(now, Math.floor(input.nextAttemptAt ?? now + 60));
    const errorCode = safeLogText(input.errorCode) ?? "paynow_api_unavailable";
    const errorMessage = safeLogText(input.errorMessage);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `paynow-pending:${eventId}`]);
      const existing = await client.query<{ payload_sha256: string; status: string }>(
        "SELECT payload_sha256, status FROM billing_pending_paynow_events WHERE provider=$1 AND event_id=$2 FOR UPDATE",
        [BILLING_PROVIDER, eventId],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        if (existingRow.payload_sha256 !== payloadSha256) {
          throw new ServiceError("paynow_event_conflict", "PayNow pending event ID conflicts with a previous payload", 409);
        }
        if (existingRow.status !== "processed") {
          await client.query(`
            UPDATE billing_pending_paynow_events
            SET last_error_code=$3,
                last_error_message=$4,
                updated_at=$5
            WHERE provider=$1 AND event_id=$2 AND status='pending'
          `, [
            BILLING_PROVIDER,
            eventId,
            errorCode,
            errorMessage,
            postgresTimestamp(now),
          ]);
        }
        await client.query("COMMIT");
        return "duplicate";
      }
      await client.query(`
        INSERT INTO billing_pending_paynow_events
          (provider, event_id, event_type, payload_sha256,
           store_id, payment_id, order_id, amount, currency, completed_at,
           status, attempts, last_error_code, last_error_message,
           next_attempt_at, locked_until, processed_at, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           'pending', 0, $11, $12, $13, NULL, NULL, $14, $14)
      `, [
        BILLING_PROVIDER,
        eventId,
        eventType,
        payloadSha256,
        payment.storeId,
        payment.paymentId,
        payment.orderId,
        payment.amount,
        payment.currency,
        postgresTimestamp(payment.completedAt),
        errorCode,
        errorMessage,
        postgresTimestamp(nextAttemptAt),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return "queued";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimPendingFirstPayments(options: ClaimPendingFirstPaymentsOptions = {}): Promise<PayNowPendingFirstPaymentRecord[]> {
    const now = Math.max(0, Math.floor(options.now ?? Date.now() / 1000));
    const limit = boundedPendingPaymentLimit(options.limit);
    const maxAttempts = boundedOutboxAttempts(options.maxAttempts);
    const visibilityTimeoutSeconds = Math.max(30, Math.min(30 * 60, Math.floor(options.visibilityTimeoutSeconds ?? 5 * 60)));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<BillingPendingPayNowEventRow>(`
        SELECT event_id, event_type, payload_sha256,
               store_id, payment_id, order_id, amount, currency, completed_at,
               attempts, last_error_code, last_error_message, next_attempt_at,
               created_at, updated_at
        FROM billing_pending_paynow_events
        WHERE provider=$1
          AND status IN ('pending', 'processing')
          AND attempts < $2
          AND next_attempt_at <= $3
          AND (locked_until IS NULL OR locked_until <= $3)
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $4
        FOR UPDATE SKIP LOCKED
      `, [BILLING_PROVIDER, maxAttempts, postgresTimestamp(now), limit]);
      const eventIds = result.rows.map((row) => row.event_id);
      if (eventIds.length > 0) {
        await client.query(`
          UPDATE billing_pending_paynow_events
          SET status='processing',
              locked_until=$3,
              updated_at=$4
          WHERE provider=$1 AND event_id=ANY($2::text[])
        `, [
          BILLING_PROVIDER,
          eventIds,
          postgresTimestamp(now + visibilityTimeoutSeconds),
          postgresTimestamp(now),
        ]);
      }
      await client.query("COMMIT");
      return result.rows.map(pendingPaymentRow);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markPendingFirstPaymentProcessed(input: MarkPendingFirstPaymentProcessedInput): Promise<void> {
    const eventId = identifier(input.eventId, "PayNow event ID");
    const payloadSha256 = normalizedPayloadSha256(input.payloadSha256);
    if (payloadSha256 === null) invalidRequest("PayNow source payload hash is invalid");
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const result = await this.#pool.query(`
      UPDATE billing_pending_paynow_events
      SET status='processed',
          locked_until=NULL,
          processed_at=$4,
          updated_at=$4
      WHERE provider=$1 AND event_id=$2 AND payload_sha256=$3
    `, [BILLING_PROVIDER, eventId, payloadSha256, postgresTimestamp(now)]);
    if ((result.rowCount ?? 0) === 0) {
      throw new ServiceError("paynow_pending_event_unavailable", "PayNow pending event is not available", 404);
    }
  }

  async markPendingFirstPaymentFailed(input: MarkPendingFirstPaymentFailedInput): Promise<"pending" | "failed"> {
    const eventId = identifier(input.eventId, "PayNow event ID");
    const payloadSha256 = normalizedPayloadSha256(input.payloadSha256);
    if (payloadSha256 === null) invalidRequest("PayNow source payload hash is invalid");
    const errorCode = safeLogText(input.errorCode) ?? "paynow_retry_failed";
    const errorMessage = safeLogText(input.errorMessage);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const maxAttempts = boundedOutboxAttempts(input.maxAttempts);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ payload_sha256: string; status: string; attempts: string | number }>(
        "SELECT payload_sha256, status, attempts FROM billing_pending_paynow_events WHERE provider=$1 AND event_id=$2 FOR UPDATE",
        [BILLING_PROVIDER, eventId],
      );
      const row = result.rows[0];
      if (!row || row.payload_sha256 !== payloadSha256 || row.status === "processed") {
        throw new ServiceError("paynow_pending_event_unavailable", "PayNow pending event is not available", 404);
      }
      const attempts = integer(row.attempts) + 1;
      const status = attempts >= maxAttempts ? "failed" : "pending";
      const nextAttemptAt = status === "failed" ? now : now + pendingPaymentRetryDelaySeconds(attempts);
      await client.query(`
        UPDATE billing_pending_paynow_events
        SET status=$3,
            attempts=$4,
            last_error_code=$5,
            last_error_message=$6,
            next_attempt_at=$7,
            locked_until=NULL,
            updated_at=$8
        WHERE provider=$1 AND event_id=$2
      `, [
        BILLING_PROVIDER,
        eventId,
        status,
        attempts,
        errorCode,
        errorMessage,
        postgresTimestamp(nextAttemptAt),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return status;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordVerifiedFirstPayment(input: VerifiedFirstPaymentInput): Promise<VerifiedFirstPaymentRecord> {
    if (!this.#emailEncryptionKey || !this.#emailHmacKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const checkoutIntentId = input.checkoutIntentId === undefined || input.checkoutIntentId === null || input.checkoutIntentId === ""
      ? null
      : input.checkoutIntentId;
    if (checkoutIntentId !== null && !/^ci_[A-Za-z0-9_-]{16,128}$/.test(checkoutIntentId)) {
      invalidRequest("Checkout intent is invalid");
    }
    const payNowCheckoutId = identifier(input.payNowCheckoutId, "PayNow checkout ID");
    const payNowOrderId = verifiedPaymentIdentifier(input.payNowOrderId, "PayNow order ID");
    const payNowPaymentId = verifiedPaymentIdentifier(input.payNowPaymentId, "PayNow payment ID");
    const payNowSubscriptionId = identifier(input.payNowSubscriptionId, "PayNow subscription ID");
    const payNowCustomerId = identifier(input.payNowCustomerId, "PayNow customer ID");
    const amount = positiveMoney(input.amount, "Payment amount");
    const currency = supportedCurrency(input.currency);
    const currentPeriodStart = Math.max(0, Math.floor(input.currentPeriodStart));
    const currentPeriodEnd = Math.max(0, Math.floor(input.currentPeriodEnd));
    if (!Number.isSafeInteger(currentPeriodStart) || !Number.isSafeInteger(currentPeriodEnd) ||
        currentPeriodEnd <= currentPeriodStart) {
      invalidRequest("Subscription period is invalid");
    }
    const accountId = normalizedOptionalMetadata(input.accountId, "SlyBrowser account ID");
    const metadataLicenseId = normalizedOptionalMetadata(input.metadataLicenseId, "SlyBrowser license ID");
    const sourceEventId = normalizedOptionalMetadata(input.sourceEventId, "PayNow event ID");
    const sourceEventType = normalizedPaymentEventType(input.sourceEventType);
    const sourcePayloadSha256 = normalizedPayloadSha256(input.sourcePayloadSha256);
    if ((sourceEventId === null) !== (sourceEventType === null) ||
        (sourceEventId === null) !== (sourcePayloadSha256 === null)) {
      invalidRequest("PayNow source event identity is incomplete");
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      let sourceEventAlreadyProcessed = false;
      if (sourceEventId !== null && sourceEventType !== null && sourcePayloadSha256 !== null) {
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `paynow:${sourceEventId}`]);
        const existingEvent = await client.query<{ payload_sha256: string }>(
          "SELECT payload_sha256 FROM billing_webhook_events WHERE provider=$1 AND event_id=$2 FOR UPDATE",
          [BILLING_PROVIDER, sourceEventId],
        );
        const existingEventRow = existingEvent.rows[0];
        if (existingEventRow) {
          if (existingEventRow.payload_sha256 !== sourcePayloadSha256) {
            throw new ServiceError("paynow_event_conflict", "PayNow event ID conflicts with a previous payload", 409);
          }
          sourceEventAlreadyProcessed = true;
        } else {
          await client.query(`
            INSERT INTO billing_webhook_events (provider, event_id, event_type, payload_sha256, processed_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [BILLING_PROVIDER, sourceEventId, sourceEventType, sourcePayloadSha256, postgresTimestamp(now)]);
        }
      }
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `first-payment:${payNowPaymentId}`]);

      const existing = await client.query<{
        entitlement_id: string;
        entitlement_license_id: string;
        order_id: string;
        public_order_id: string;
        payment_id: string;
        subscription_id: string;
        period_id: string;
        outbox_id: string;
        plan: Exclude<PlanId, "free">;
        paid_through: string | number | Date;
      }>(`
        SELECT e.entitlement_id,
               e.license_id AS entitlement_license_id,
               o.order_id,
               o.public_order_id,
               p.payment_id,
               s.subscription_id,
               sp.period_id,
               eo.outbox_id,
               e.plan,
               e.paid_through
        FROM billing_payments p
        JOIN billing_orders o ON o.order_id=p.order_id
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        JOIN billing_subscription_periods sp ON sp.payment_id=p.payment_id
        JOIN billing_email_outbox eo ON eo.deduplication_key=('first-license:' || e.entitlement_id::text)
        WHERE p.paynow_payment_id=$1
        LIMIT 1
      `, [payNowPaymentId]);
      const duplicate = existing.rows[0];
      if (duplicate) {
        await client.query("COMMIT");
        return {
          status: "duplicate",
          entitlementId: duplicate.entitlement_id,
          entitlementLicenseId: duplicate.entitlement_license_id,
          orderId: duplicate.order_id,
          publicOrderId: duplicate.public_order_id,
          paymentId: duplicate.payment_id,
          subscriptionId: duplicate.subscription_id,
          periodId: duplicate.period_id,
          outboxId: duplicate.outbox_id,
          plan: duplicate.plan,
          paidThrough: epochSeconds(duplicate.paid_through),
        };
      }
      if (sourceEventAlreadyProcessed) {
        throw new ServiceError("paynow_event_replay_incomplete", "PayNow event was already consumed without a completed first payment", 409);
      }
      if (!this.#licenseKeyPepper || !this.#licenseFileOptions) {
        throw new ServiceError("paid_license_file_config_required", "Paid license generation is not configured", 503);
      }

      const checkout = checkoutIntentId === null
        ? await client.query<BillingCheckoutIntentRow>(
          "SELECT * FROM billing_checkout_intents WHERE paynow_checkout_id=$1 FOR UPDATE",
          [payNowCheckoutId],
        )
        : await client.query<BillingCheckoutIntentRow>(
          "SELECT * FROM billing_checkout_intents WHERE intent_id=$1 FOR UPDATE",
          [checkoutIntentId],
        );
      const checkoutRow = checkout.rows[0];
      if (!checkoutRow || checkoutRow.status !== "checkout_created" ||
          checkoutRow.paynow_checkout_id !== payNowCheckoutId || checkoutRow.paynow_customer_id !== payNowCustomerId) {
        throw new ServiceError("checkout_intent_unavailable", "Checkout intent is not ready for payment activation", 409);
      }
      const snapshot = checkoutRow.plan_snapshot as {
        monthly_price_cents?: number;
        currency?: string;
        billing_period?: string;
        concurrency?: number;
        name?: string;
      };
      if (snapshot.monthly_price_cents !== amount || (snapshot.currency ?? PLAN_CONTRACT.currency) !== currency) {
        throw new ServiceError("payment_amount_mismatch", "Verified payment amount does not match the checkout plan", 409);
      }

      const entitlementId = randomUUID();
      const entitlementLicenseId = randomUUID();
      const licenseSecret = randomBytes(32).toString("base64url");
      const licenseKey = `sly_live_${entitlementLicenseId}.${licenseSecret}`;
      const orderId = randomUUID();
      const generatedPublicOrderId = publicOrderId();
      const generatedCustomerAccessToken = customerAccessToken();
      const generatedCustomerAccessTokenHash = customerAccessTokenHash(this.#emailHmacKey, generatedCustomerAccessToken);
      const paymentId = randomUUID();
      const subscriptionId = randomUUID();
      const periodId = randomUUID();
      const outboxId = randomUUID();
      const recipientEmail = decryptCheckoutEmail(this.#emailEncryptionKey, checkoutRow);
      const encryptedRecipient = encryptOutboxEmail(this.#emailEncryptionKey, outboxId, recipientEmail);
      const licenseFileExpiresAt = now + LICENSE_FILE_ROTATION_SECONDS;
      const licenseFile = createPortableLicenseFile({
        licenseId: entitlementLicenseId,
        licenseKey,
        serviceUrl: this.#licenseFileOptions.serviceUrl,
        issuedAt: new Date(now * 1000),
        expiresAt: new Date(licenseFileExpiresAt * 1000),
        passphrase: this.#licenseFileOptions.passphrase,
        signingKeyId: this.#licenseFileOptions.signingKeyId,
        signingPrivateKey: this.#licenseFileOptions.signingPrivateKey,
      });
      const outboxPayload = {
        schemaVersion: 1,
        kind: "first-license-file",
        entitlementId,
        entitlementLicenseId,
        orderId,
        publicOrderId: generatedPublicOrderId,
        plan: checkoutRow.plan,
        planName: snapshot.name ?? PLAN_CATALOG[checkoutRow.plan].name,
        concurrency: snapshot.concurrency ?? PLAN_CATALOG[checkoutRow.plan].concurrency,
        issuedAt: now,
        paidThrough: currentPeriodEnd,
        licenseFileName: `${generatedPublicOrderId}-slybrowser-license.json`,
        customerAccessToken: generatedCustomerAccessToken,
        licenseFile,
      };

      await client.query(`
        INSERT INTO entitlements
          (license_id, account_id, plan, status, paid_through, key_hash, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', $4, $5, $6, $6)
      `, [
        entitlementLicenseId,
        accountId ?? `paynow:${payNowCustomerId}`,
        checkoutRow.plan,
        currentPeriodEnd,
        this.#licenseSecretHash(licenseSecret),
        now,
      ]);

      await client.query(`
        INSERT INTO billing_entitlements
          (entitlement_id, license_id, account_id, plan, status, paid_through,
           source_checkout_intent_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $7)
      `, [
        entitlementId,
        entitlementLicenseId,
        accountId,
        checkoutRow.plan,
        postgresTimestamp(currentPeriodEnd),
        checkoutRow.intent_id,
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_orders
          (order_id, public_order_id, paynow_order_id, paynow_checkout_id,
           paynow_subscription_id, customer_access_token_hash, checkout_intent_id, entitlement_id, plan,
           plan_snapshot, currency, subtotal_amount, discount_amount, tax_amount,
           total_amount, status, completed_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, 0, 0, $12,
                'completed', $13, $13, $13)
      `, [
        orderId,
        generatedPublicOrderId,
        payNowOrderId,
        checkoutRow.paynow_checkout_id,
        payNowSubscriptionId,
        generatedCustomerAccessTokenHash,
        checkoutRow.intent_id,
        entitlementId,
        checkoutRow.plan,
        JSON.stringify(checkoutRow.plan_snapshot),
        currency,
        amount,
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_payments
          (payment_id, order_id, paynow_payment_id, amount, currency, status,
           gateway, completed_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'completed', 'paynow', $6, $6, $6)
      `, [
        paymentId,
        orderId,
        payNowPaymentId,
        amount,
        currency,
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_subscriptions
          (subscription_id, public_subscription_id, paynow_subscription_id,
           paynow_customer_id, checkout_intent_id, entitlement_id, plan, status,
           current_period_start, current_period_end, paid_through, attempt_count,
           customer_id, account_id, license_id, last_event_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $9, 0, $4, $10, $11, $12, $13, $13)
        ON CONFLICT(paynow_subscription_id) DO UPDATE SET
          checkout_intent_id=excluded.checkout_intent_id,
          entitlement_id=excluded.entitlement_id,
          plan=excluded.plan,
          status=CASE
            WHEN billing_subscriptions.status='canceled'
            THEN billing_subscriptions.status
            ELSE 'active'
          END,
          current_period_start=COALESCE(excluded.current_period_start, billing_subscriptions.current_period_start),
          current_period_end=GREATEST(excluded.current_period_end, billing_subscriptions.current_period_end),
          paid_through=GREATEST(
            COALESCE(excluded.paid_through, '-infinity'::timestamptz),
            COALESCE(billing_subscriptions.paid_through, '-infinity'::timestamptz)
          ),
          account_id=COALESCE(excluded.account_id, billing_subscriptions.account_id),
          license_id=COALESCE(excluded.license_id, billing_subscriptions.license_id),
          last_event_id=COALESCE(excluded.last_event_id, billing_subscriptions.last_event_id),
          updated_at=excluded.updated_at
      `, [
        subscriptionId,
        `sps_${randomBytes(18).toString("base64url")}`,
        payNowSubscriptionId,
        payNowCustomerId,
        checkoutRow.intent_id,
        entitlementId,
        checkoutRow.plan,
        postgresTimestamp(currentPeriodStart),
        postgresTimestamp(currentPeriodEnd),
        accountId,
        metadataLicenseId,
        sourceEventId,
        postgresTimestamp(now),
      ]);
      const subscription = await client.query<{ subscription_id: string }>(
        "SELECT subscription_id FROM billing_subscriptions WHERE paynow_subscription_id=$1",
        [payNowSubscriptionId],
      );
      const persistedSubscriptionId = subscription.rows[0]?.subscription_id ?? subscriptionId;

      await client.query(`
        INSERT INTO billing_subscription_periods
          (period_id, subscription_id, order_id, payment_id, cycle_sequence,
           period_start, period_end, status, created_at)
        VALUES ($1, $2, $3, $4, 1, $5, $6, 'paid', $7)
      `, [
        periodId,
        persistedSubscriptionId,
        orderId,
        paymentId,
        postgresTimestamp(currentPeriodStart),
        postgresTimestamp(currentPeriodEnd),
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_email_outbox
          (outbox_id, deduplication_key, kind, recipient_email_ciphertext,
           recipient_email_nonce, recipient_email_tag, payload, status, attempts,
           next_attempt_at, created_at, updated_at)
        VALUES ($1, $2, 'license_file', $3, $4, $5, $6::jsonb, 'queued', 0, $7, $7, $7)
      `, [
        outboxId,
        `first-license:${entitlementId}`,
        encryptedRecipient.ciphertext,
        encryptedRecipient.nonce,
        encryptedRecipient.tag,
        JSON.stringify(outboxPayload),
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, 'system:paynow', 'first_payment_entitlement_created',
                'entitlement', $2, 'verified_paynow_payment', NULL, $3::jsonb, $4::jsonb, $5)
      `, [
        randomUUID(),
        entitlementId,
        JSON.stringify({ plan: checkoutRow.plan, paidThrough: currentPeriodEnd, orderId, paymentId }),
        JSON.stringify({ provider: BILLING_PROVIDER, orderId: payNowOrderId, paymentId: payNowPaymentId }),
        postgresTimestamp(now),
      ]);

      await client.query(
        "UPDATE billing_checkout_intents SET status='paid', updated_at=$1 WHERE intent_id=$2",
        [postgresTimestamp(now), checkoutRow.intent_id],
      );
      await client.query("COMMIT");
      return {
        status: "processed",
        entitlementId,
        entitlementLicenseId,
        orderId,
        publicOrderId: generatedPublicOrderId,
        paymentId,
        subscriptionId: persistedSubscriptionId,
        periodId,
        outboxId,
        plan: checkoutRow.plan,
        paidThrough: currentPeriodEnd,
        customerAccessToken: generatedCustomerAccessToken,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordVerifiedRenewalPayment(input: VerifiedRenewalPaymentInput): Promise<VerifiedRenewalPaymentRecord> {
    const payNowCheckoutId = verifiedPaymentIdentifier(input.payNowCheckoutId, "PayNow checkout ID");
    const payNowOrderId = verifiedPaymentIdentifier(input.payNowOrderId, "PayNow order ID");
    const payNowPaymentId = verifiedPaymentIdentifier(input.payNowPaymentId, "PayNow payment ID");
    const payNowSubscriptionId = verifiedPaymentIdentifier(input.payNowSubscriptionId, "PayNow subscription ID");
    const payNowCustomerId = verifiedPaymentIdentifier(input.payNowCustomerId, "PayNow customer ID");
    const amount = positiveMoney(input.amount, "Payment amount");
    const currency = supportedCurrency(input.currency);
    const currentPeriodStart = Math.max(0, Math.floor(input.currentPeriodStart));
    const currentPeriodEnd = Math.max(0, Math.floor(input.currentPeriodEnd));
    if (!Number.isSafeInteger(currentPeriodStart) || !Number.isSafeInteger(currentPeriodEnd) ||
        currentPeriodEnd <= currentPeriodStart) {
      invalidRequest("Subscription period is invalid");
    }
    const sourceEventId = normalizedOptionalMetadata(input.sourceEventId, "PayNow event ID");
    const sourceEventType = normalizedPaymentEventType(input.sourceEventType);
    const sourcePayloadSha256 = normalizedPayloadSha256(input.sourcePayloadSha256);
    if ((sourceEventId === null) !== (sourceEventType === null) ||
        (sourceEventId === null) !== (sourcePayloadSha256 === null)) {
      invalidRequest("PayNow source event identity is incomplete");
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      let sourceEventAlreadyProcessed = false;
      if (sourceEventId !== null && sourceEventType !== null && sourcePayloadSha256 !== null) {
        await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `paynow:${sourceEventId}`]);
        const existingEvent = await client.query<{ payload_sha256: string }>(
          "SELECT payload_sha256 FROM billing_webhook_events WHERE provider=$1 AND event_id=$2 FOR UPDATE",
          [BILLING_PROVIDER, sourceEventId],
        );
        const existingEventRow = existingEvent.rows[0];
        if (existingEventRow) {
          if (existingEventRow.payload_sha256 !== sourcePayloadSha256) {
            throw new ServiceError("paynow_event_conflict", "PayNow event ID conflicts with a previous payload", 409);
          }
          sourceEventAlreadyProcessed = true;
        } else {
          await client.query(`
            INSERT INTO billing_webhook_events (provider, event_id, event_type, payload_sha256, processed_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [BILLING_PROVIDER, sourceEventId, sourceEventType, sourcePayloadSha256, postgresTimestamp(now)]);
        }
      }
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `renewal-payment:${payNowPaymentId}`]);

      const existing = await client.query<{
        entitlement_id: string;
        entitlement_license_id: string;
        order_id: string;
        public_order_id: string;
        payment_id: string;
        subscription_id: string;
        period_id: string;
        plan: Exclude<PlanId, "free">;
        paid_through: string | number | Date;
      }>(`
        SELECT e.entitlement_id,
               e.license_id AS entitlement_license_id,
               o.order_id,
               o.public_order_id,
               p.payment_id,
               s.subscription_id,
               sp.period_id,
               s.plan,
               COALESCE(s.paid_through, e.paid_through, sp.period_end) AS paid_through
        FROM billing_payments p
        JOIN billing_orders o ON o.order_id=p.order_id
        JOIN billing_subscriptions s ON s.paynow_subscription_id=o.paynow_subscription_id
        JOIN billing_entitlements e ON e.entitlement_id=s.entitlement_id
        JOIN billing_subscription_periods sp ON sp.payment_id=p.payment_id
        WHERE p.paynow_payment_id=$1
        LIMIT 1
      `, [payNowPaymentId]);
      const duplicate = existing.rows[0];
      if (duplicate) {
        await client.query("COMMIT");
        return {
          status: "duplicate",
          entitlementId: duplicate.entitlement_id,
          entitlementLicenseId: duplicate.entitlement_license_id,
          orderId: duplicate.order_id,
          publicOrderId: duplicate.public_order_id,
          paymentId: duplicate.payment_id,
          subscriptionId: duplicate.subscription_id,
          periodId: duplicate.period_id,
          plan: duplicate.plan,
          paidThrough: epochSeconds(duplicate.paid_through),
        };
      }
      if (sourceEventAlreadyProcessed) {
        throw new ServiceError("paynow_event_replay_incomplete", "PayNow event was already consumed without a completed renewal payment", 409);
      }

      const subscription = await client.query<BillingRenewalSubscriptionRow>(`
        SELECT s.subscription_id,
               s.public_subscription_id,
               s.entitlement_id,
               e.license_id AS entitlement_license_id,
               s.checkout_intent_id,
               s.plan,
               ci.plan_snapshot,
               ci.paynow_checkout_id,
               ci.paynow_customer_id,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag,
               (
                 SELECT o.customer_access_token_hash
                 FROM billing_orders o
                 WHERE o.entitlement_id=s.entitlement_id
                   AND o.customer_access_token_hash IS NOT NULL
                 ORDER BY o.completed_at ASC NULLS LAST, o.created_at ASC
                 LIMIT 1
               ) AS customer_access_token_hash,
               COALESCE(s.paid_through, e.paid_through, s.current_period_end) AS paid_through
        FROM billing_subscriptions s
        JOIN billing_entitlements e ON e.entitlement_id=s.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=s.checkout_intent_id
        WHERE s.paynow_subscription_id=$1
        FOR UPDATE OF s, e
      `, [payNowSubscriptionId]);
      const subscriptionRow = subscription.rows[0];
      if (!subscriptionRow ||
          subscriptionRow.paynow_checkout_id !== payNowCheckoutId ||
          subscriptionRow.paynow_customer_id !== payNowCustomerId) {
        throw new ServiceError("paynow_second_confirmation_mismatch", "Verified renewal does not match an active SlyBrowser subscription", 409);
      }
      const snapshot = subscriptionRow.plan_snapshot as {
        monthly_price_cents?: number;
        currency?: string;
      };
      if (snapshot.monthly_price_cents !== amount || (snapshot.currency ?? PLAN_CONTRACT.currency) !== currency) {
        throw new ServiceError("payment_amount_mismatch", "Verified renewal amount does not match the subscription plan", 409);
      }

      const orderId = randomUUID();
      const generatedPublicOrderId = publicOrderId();
      const paymentId = randomUUID();
      const periodId = randomUUID();
      const sequence = await client.query<{ next_sequence: string | number }>(
        "SELECT COALESCE(MAX(cycle_sequence), 0) + 1 AS next_sequence FROM billing_subscription_periods WHERE subscription_id=$1",
        [subscriptionRow.subscription_id],
      );
      const cycleSequence = integer(sequence.rows[0]?.next_sequence ?? 1);

      await client.query(`
        INSERT INTO billing_orders
          (order_id, public_order_id, paynow_order_id, paynow_checkout_id,
           paynow_subscription_id, customer_access_token_hash, checkout_intent_id, entitlement_id, plan,
           plan_snapshot, currency, subtotal_amount, discount_amount, tax_amount,
           total_amount, status, completed_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, 0, 0, $12,
                'completed', $13, $13, $13)
      `, [
        orderId,
        generatedPublicOrderId,
        payNowOrderId,
        payNowCheckoutId,
        payNowSubscriptionId,
        subscriptionRow.customer_access_token_hash,
        subscriptionRow.checkout_intent_id,
        subscriptionRow.entitlement_id,
        subscriptionRow.plan,
        JSON.stringify(subscriptionRow.plan_snapshot),
        currency,
        amount,
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_payments
          (payment_id, order_id, paynow_payment_id, amount, currency, status,
           gateway, completed_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'completed', 'paynow', $6, $6, $6)
      `, [
        paymentId,
        orderId,
        payNowPaymentId,
        amount,
        currency,
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_subscription_periods
          (period_id, subscription_id, order_id, payment_id, cycle_sequence,
           period_start, period_end, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'paid', $8)
      `, [
        periodId,
        subscriptionRow.subscription_id,
        orderId,
        paymentId,
        cycleSequence,
        postgresTimestamp(currentPeriodStart),
        postgresTimestamp(currentPeriodEnd),
        postgresTimestamp(now),
      ]);

      await client.query(`
        UPDATE billing_subscriptions
        SET status='active',
            current_period_start=$2,
            current_period_end=GREATEST(COALESCE(current_period_end, '-infinity'::timestamptz), $3),
            paid_through=GREATEST(COALESCE(paid_through, '-infinity'::timestamptz), $3),
            next_attempt_at=NULL,
            attempt_count=0,
            last_event_id=COALESCE($4, last_event_id),
            updated_at=$5
        WHERE subscription_id=$1
      `, [
        subscriptionRow.subscription_id,
        postgresTimestamp(currentPeriodStart),
        postgresTimestamp(currentPeriodEnd),
        sourceEventId,
        postgresTimestamp(now),
      ]);

      await client.query(`
        UPDATE billing_entitlements
        SET paid_through=GREATEST(COALESCE(paid_through, '-infinity'::timestamptz), $2),
            status=CASE WHEN status='revoked' THEN status ELSE 'active' END,
            updated_at=$3
        WHERE entitlement_id=$1
      `, [
        subscriptionRow.entitlement_id,
        postgresTimestamp(currentPeriodEnd),
        postgresTimestamp(now),
      ]);

      await client.query(`
        UPDATE entitlements
        SET paid_through=GREATEST(COALESCE(paid_through, 0), $2),
            status=CASE WHEN status='revoked' THEN status ELSE 'active' END,
            updated_at=$3
        WHERE license_id=$1
      `, [
        subscriptionRow.entitlement_license_id,
        currentPeriodEnd,
        now,
      ]);

      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, 'system:paynow', 'renewal_payment_applied',
                'subscription', $2, 'verified_paynow_renewal', $3::jsonb, $4::jsonb, $5::jsonb, $6)
      `, [
        randomUUID(),
        subscriptionRow.subscription_id,
        JSON.stringify({ paidThrough: subscriptionRow.paid_through === null ? null : epochSeconds(subscriptionRow.paid_through) }),
        JSON.stringify({ paidThrough: currentPeriodEnd, orderId, paymentId, periodId, cycleSequence }),
        JSON.stringify({ provider: BILLING_PROVIDER, orderId: payNowOrderId, paymentId: payNowPaymentId }),
        postgresTimestamp(now),
      ]);

      const nextPaidThrough = Math.max(
        subscriptionRow.paid_through === null ? 0 : epochSeconds(subscriptionRow.paid_through),
        currentPeriodEnd,
      );
      if (this.#emailEncryptionKey) {
        await queueBillingNoticeEmail(client, this.#emailEncryptionKey, {
          deduplicationKey: `renewal-receipt:${paymentId}`,
          recipientEmail: decryptCheckoutEmail(this.#emailEncryptionKey, subscriptionRow),
          kind: "renewal-receipt",
          plan: subscriptionRow.plan,
          planSnapshot: subscriptionRow.plan_snapshot,
          publicOrderId: generatedPublicOrderId,
          publicSubscriptionId: subscriptionRow.public_subscription_id,
          paidThrough: nextPaidThrough,
          amount,
          currency,
          occurredAt: now,
          now,
        });
      }

      await client.query("COMMIT");
      return {
        status: "processed",
        entitlementId: subscriptionRow.entitlement_id,
        entitlementLicenseId: subscriptionRow.entitlement_license_id,
        orderId,
        publicOrderId: generatedPublicOrderId,
        paymentId,
        subscriptionId: subscriptionRow.subscription_id,
        periodId,
        plan: subscriptionRow.plan,
        paidThrough: nextPaidThrough,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcilePayNowSubscription(
    input: PayNowReconciledSubscriptionEvidence,
  ): Promise<PayNowSubscriptionReconciliationResult> {
    const payNowSubscriptionId = verifiedPaymentIdentifier(input.payNowSubscriptionId, "PayNow subscription ID");
    const payNowCustomerId = verifiedPaymentIdentifier(input.payNowCustomerId, "PayNow customer ID");
    const storeId = verifiedPaymentIdentifier(input.storeId, "PayNow store ID");
    const productId = verifiedPaymentIdentifier(input.productId, "PayNow product ID");
    const status = normalizedReconciliationStatus(input.status);
    const plan = PAYNOW_PRODUCT_PLANS[productId];
    if (!plan || PAYNOW_BILLING_TEST_PRODUCT_IDS.has(productId)) {
      invalidRequest("PayNow product is not mapped to a SlyBrowser plan");
    }
    const currentPeriodStart = normalizedOptionalEpochSeconds(input.currentPeriodStart, "PayNow subscription current period start");
    const currentPeriodEnd = normalizedOptionalEpochSeconds(input.currentPeriodEnd, "PayNow subscription current period end");
    if (currentPeriodStart !== null && currentPeriodEnd !== null && currentPeriodEnd <= currentPeriodStart) {
      invalidRequest("PayNow subscription period is invalid");
    }
    const nextAttemptAt = normalizedOptionalEpochSeconds(input.nextAttemptAt, "PayNow subscription next attempt at");
    const attemptCount = normalizedOptionalAttemptCount(input.attemptCount);
    const now = Math.max(0, Math.floor(input.observedAt));
    if (!Number.isSafeInteger(now)) invalidRequest("PayNow subscription observed time is invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `subscription-reconcile:${payNowSubscriptionId}`]);
      const existing = await client.query<BillingReconciliationSubscriptionRow>(`
        SELECT s.*,
               e.status AS entitlement_status,
               e.license_id AS entitlement_license_id,
               e.paid_through AS entitlement_paid_through,
               o.public_order_id,
               o.plan_snapshot,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag
        FROM billing_subscriptions s
        LEFT JOIN billing_entitlements e ON e.entitlement_id=s.entitlement_id
        LEFT JOIN billing_checkout_intents ci ON ci.intent_id=s.checkout_intent_id
        LEFT JOIN LATERAL (
          SELECT bo.public_order_id, bo.plan_snapshot
          FROM billing_orders bo
          WHERE bo.entitlement_id=s.entitlement_id
          ORDER BY bo.completed_at ASC NULLS LAST, bo.created_at ASC
          LIMIT 1
        ) o ON TRUE
        WHERE s.paynow_subscription_id=$1
        FOR UPDATE OF s
      `, [payNowSubscriptionId]);
      const row = existing.rows[0];
      if (!row) {
        await client.query(`
          INSERT INTO billing_admin_audit_logs
            (audit_id, actor, action, target_type, target_id, reason, old_value,
             new_value, external_result, created_at)
          VALUES ($1, 'system:paynow', 'subscription_reconciliation_missing',
                  'paynow_subscription', $2, 'paynow_subscription_not_found', NULL,
                  $3::jsonb, $4::jsonb, $5)
        `, [
          randomUUID(),
          payNowSubscriptionId,
          JSON.stringify({ status, currentPeriodStart, currentPeriodEnd, nextAttemptAt, attemptCount }),
          JSON.stringify({ provider: BILLING_PROVIDER, storeId, customerId: payNowCustomerId, productId }),
          postgresTimestamp(now),
        ]);
        await client.query("COMMIT");
        return "missing";
      }
      if ((row.store_id !== null && row.store_id !== storeId) ||
          row.paynow_customer_id !== payNowCustomerId ||
          (row.customer_id !== null && row.customer_id !== payNowCustomerId) ||
          (row.product_id !== null && row.product_id !== productId) ||
          row.plan !== plan) {
        throw new ServiceError("paynow_reconciliation_mismatch", "PayNow subscription evidence does not match local billing state", 409);
      }

      const oldCurrentPeriodStart = row.current_period_start === null ? null : epochSeconds(row.current_period_start);
      const oldCurrentPeriodEnd = row.current_period_end === null ? null : epochSeconds(row.current_period_end);
      const oldNextAttemptAt = row.next_attempt_at === null ? null : epochSeconds(row.next_attempt_at);
      const oldCanceledAt = row.canceled_at === null ? null : epochSeconds(row.canceled_at);
      let nextStatus = row.status;
      let reconciledCanceledAt = oldCanceledAt;
      let cancelReason = row.cancel_reason;
      if (status === "canceled" || status === "invalid") {
        nextStatus = "canceled";
        reconciledCanceledAt ??= now;
        cancelReason ??= status === "invalid" ? "paynow_reconciliation_invalid" : "paynow_reconciliation_canceled";
      } else if (status === "active" && row.status !== "canceled") {
        nextStatus = "active";
      }

      const reconciledCurrentPeriodEnd = currentPeriodEnd === null
        ? oldCurrentPeriodEnd
        : Math.max(oldCurrentPeriodEnd ?? 0, currentPeriodEnd);
      const reconciledCurrentPeriodStart = currentPeriodStart === null
        ? oldCurrentPeriodStart
        : currentPeriodStart;
      const reconciledNextAttemptAt = nextAttemptAt;
      const reconciledAttemptCount = attemptCount ?? 0;
      const before = {
        status: row.status,
        currentPeriodStart: oldCurrentPeriodStart,
        currentPeriodEnd: oldCurrentPeriodEnd,
        paidThrough: row.paid_through === null ? null : epochSeconds(row.paid_through),
        nextAttemptAt: oldNextAttemptAt,
        attemptCount: integer(row.attempt_count),
        canceledAt: oldCanceledAt,
        cancelReason: row.cancel_reason,
      };
      const after = {
        status: nextStatus,
        currentPeriodStart: reconciledCurrentPeriodStart,
        currentPeriodEnd: reconciledCurrentPeriodEnd,
        paidThrough: before.paidThrough,
        nextAttemptAt: reconciledNextAttemptAt,
        attemptCount: reconciledAttemptCount,
        canceledAt: reconciledCanceledAt,
        cancelReason,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) {
        await client.query("COMMIT");
        return "unchanged";
      }

      await client.query(`
        UPDATE billing_subscriptions
        SET status=$2,
            current_period_start=$3,
            current_period_end=$4,
            next_attempt_at=$5,
            attempt_count=$6,
            canceled_at=$7,
            cancel_reason=$8,
            store_id=COALESCE(store_id, $9),
            customer_id=COALESCE(customer_id, $10),
            product_id=COALESCE(product_id, $11),
            updated_at=$12
        WHERE subscription_id=$1
      `, [
        row.subscription_id,
        nextStatus,
        postgresTimestamp(reconciledCurrentPeriodStart),
        postgresTimestamp(reconciledCurrentPeriodEnd),
        postgresTimestamp(reconciledNextAttemptAt),
        reconciledAttemptCount,
        postgresTimestamp(reconciledCanceledAt),
        cancelReason,
        storeId,
        payNowCustomerId,
        productId,
        postgresTimestamp(now),
      ]);

      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, 'system:paynow', 'subscription_reconciled',
                'subscription', $2, 'paynow_subscription_evidence', $3::jsonb, $4::jsonb, $5::jsonb, $6)
      `, [
        randomUUID(),
        row.subscription_id,
        JSON.stringify(before),
        JSON.stringify(after),
        JSON.stringify({ provider: BILLING_PROVIDER, storeId, customerId: payNowCustomerId, productId, subscriptionStatus: status }),
        postgresTimestamp(now),
      ]);

      const canQueueNotice = this.#emailEncryptionKey &&
        row.intent_id !== null &&
        row.delivery_email_ciphertext !== null &&
        row.delivery_email_nonce !== null &&
        row.delivery_email_tag !== null;
      if (canQueueNotice) {
        const recipientEmail = decryptCheckoutEmail(this.#emailEncryptionKey!, {
          intent_id: row.intent_id!,
          delivery_email_ciphertext: row.delivery_email_ciphertext!,
          delivery_email_nonce: row.delivery_email_nonce!,
          delivery_email_tag: row.delivery_email_tag!,
        });
        const queueSubscriptionNotice = async (
          kind: BillingNoticeEmailKind,
          suffix: string,
          fields: { nextAttemptAt?: number | null; reason?: string | null } = {},
        ): Promise<void> => {
          await queueBillingNoticeEmail(client, this.#emailEncryptionKey!, {
            deduplicationKey: `${kind}:${row.subscription_id}:${suffix}`,
            recipientEmail,
            kind,
            plan: row.plan,
            planSnapshot: row.plan_snapshot ?? {},
            ...(row.public_order_id === null ? {} : { publicOrderId: row.public_order_id }),
            publicSubscriptionId: row.public_subscription_id,
            paidThrough: before.paidThrough,
            occurredAt: now,
            ...fields,
            now,
          });
        };
        if (after.status === "canceled" && before.status !== "canceled") {
          await queueSubscriptionNotice("subscription-canceled", "reconciled", {
            reason: cancelReason,
          });
        }
        if (after.nextAttemptAt !== null && after.attemptCount > before.attemptCount) {
          await queueSubscriptionNotice("payment-retry", `attempt-${after.attemptCount}`, {
            nextAttemptAt: after.nextAttemptAt,
            reason: "Payment retry scheduled by PayNow",
          });
          if (this.#gracePeriodSeconds > 0 &&
              before.paidThrough !== null &&
              now > before.paidThrough &&
              now <= before.paidThrough + this.#gracePeriodSeconds) {
            await queueSubscriptionNotice("grace-period", `attempt-${after.attemptCount}`, {
              nextAttemptAt: after.nextAttemptAt,
              reason: "Subscription is past the paid-through date but inside the configured grace period",
            });
          }
        }
        if (after.status === "active" &&
            (before.status !== "active" || before.attemptCount > 0 || before.nextAttemptAt !== null) &&
            after.attemptCount === 0 &&
            after.nextAttemptAt === null) {
          await queueSubscriptionNotice("account-restored", "active", {
            reason: "PayNow subscription evidence is active again",
          });
        }
      }

      await client.query("COMMIT");
      return "updated";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareAdminOrderRefund(input: {
    publicOrderId: string;
    idempotencyKey: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Promise<AdminRefundPrepareRecord> {
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const idempotencyKeyHash = refundIdempotencyHash(input.idempotencyKey);
    const requestedBy = normalizedAdminText(input.requestedBy, "Refund requester", 3, 160);
    const reason = normalizedAdminText(input.reason, "Refund reason", 4, 512);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        ADVISORY_LOCK_CLASS,
        `admin-refund:${idempotencyKeyHash.toString("hex")}`,
      ]);
      const existing = await client.query<BillingRefundRow>(`
        SELECT r.refund_id,
               r.order_id,
               o.public_order_id,
               r.payment_id,
               o.paynow_order_id,
               p.paynow_payment_id,
               r.paynow_refund_id,
               r.amount,
               r.currency,
               r.reason,
               r.status,
               r.requested_by
        FROM billing_refunds r
        JOIN billing_orders o ON o.order_id=r.order_id
        LEFT JOIN billing_payments p ON p.payment_id=r.payment_id
        WHERE r.idempotency_key_hash=$1
        FOR UPDATE OF r
      `, [idempotencyKeyHash]);
      const existingRow = existing.rows[0];
      if (existingRow) {
        if (existingRow.public_order_id !== publicOrderId || existingRow.reason !== reason || existingRow.requested_by !== requestedBy) {
          throw new ServiceError("idempotency_conflict", "Refund idempotency key was already used for a different request", 409);
        }
        await client.query("COMMIT");
        return {
          refundId: existingRow.refund_id,
          orderId: existingRow.order_id,
          publicOrderId: existingRow.public_order_id,
          paymentId: existingRow.payment_id,
          payNowOrderId: existingRow.paynow_order_id,
          ...(existingRow.paynow_refund_id === null ? {} : { payNowRefundId: existingRow.paynow_refund_id }),
          amount: integer(existingRow.amount),
          currency: existingRow.currency,
          reason: existingRow.reason,
          status: existingRow.status,
          alreadySubmitted: existingRow.paynow_refund_id !== null || existingRow.status !== "requested",
        };
      }

      const order = await client.query<BillingRefundRow & { order_status: string; payment_status: string }>(`
        SELECT o.order_id,
               o.public_order_id,
               p.payment_id,
               o.paynow_order_id,
               p.paynow_payment_id,
               NULL::text AS paynow_refund_id,
               p.amount,
               p.currency,
               $2::text AS reason,
               'requested'::text AS status,
               $3::text AS requested_by,
               o.status AS order_status,
               p.status AS payment_status
        FROM billing_orders o
        JOIN billing_payments p ON p.order_id=o.order_id
        WHERE o.public_order_id=$1
        ORDER BY p.completed_at DESC NULLS LAST, p.created_at DESC
        LIMIT 1
        FOR UPDATE OF o, p
      `, [publicOrderId, reason, requestedBy]);
      const orderRow = order.rows[0];
      if (!orderRow || orderRow.order_status !== "completed" || orderRow.payment_status !== "completed") {
        throw new ServiceError("customer_portal_unavailable", "Refundable order is not available", 404);
      }
      const amount = positiveMoney(integer(orderRow.amount), "Refund amount");
      const currency = supportedCurrency(orderRow.currency);
      const refundId = randomUUID();
      await client.query(`
        INSERT INTO billing_refunds
          (refund_id, order_id, payment_id, amount, currency, reason, status,
           idempotency_key_hash, requested_by, requested_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9)
      `, [
        refundId,
        orderRow.order_id,
        orderRow.payment_id,
        amount,
        currency,
        reason,
        idempotencyKeyHash,
        requestedBy,
        postgresTimestamp(now),
      ]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, 'admin_refund_requested', 'order', $3, $4, $5::jsonb, $6::jsonb, $7)
      `, [
        randomUUID(),
        requestedBy,
        orderRow.order_id,
        reason,
        JSON.stringify({ status: orderRow.order_status, paymentStatus: orderRow.payment_status }),
        JSON.stringify({ refundId, amount, currency, publicOrderId }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        refundId,
        orderId: orderRow.order_id,
        publicOrderId: orderRow.public_order_id,
        paymentId: orderRow.payment_id,
        payNowOrderId: orderRow.paynow_order_id,
        amount,
        currency,
        reason,
        status: "requested",
        alreadySubmitted: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAdminOrderRefundSubmitted(input: {
    refundId: string;
    payNowOrderId: string;
    result: PayNowRefundResult;
    now?: number;
  }): Promise<AdminRefundRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(input.refundId)) invalidRequest("Refund ID is invalid");
    const payNowOrderId = verifiedPaymentIdentifier(input.payNowOrderId, "PayNow order ID");
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const status = localRefundStatus(input.result.status);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const refund = await client.query<BillingRefundRow & BillingNoticeSourceRow & {
        entitlement_id: string;
        license_id: string;
      }>(`
        SELECT r.refund_id,
               r.order_id,
               o.public_order_id,
               e.entitlement_id,
               e.license_id,
               r.payment_id,
               o.paynow_order_id,
               p.paynow_payment_id,
               r.paynow_refund_id,
               r.amount,
               r.currency,
               r.reason,
               r.status,
               r.requested_by,
               s.public_subscription_id,
               o.plan,
               o.plan_snapshot,
               COALESCE(s.paid_through, e.paid_through) AS paid_through,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag
        FROM billing_refunds r
        JOIN billing_orders o ON o.order_id=r.order_id
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        LEFT JOIN billing_payments p ON p.payment_id=r.payment_id
        LEFT JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        WHERE r.refund_id=$1
        FOR UPDATE OF r
      `, [input.refundId]);
      const refundRow = refund.rows[0];
      if (!refundRow) {
        throw new ServiceError("customer_portal_unavailable", "Refund request is not available", 404);
      }
      if (refundRow.paynow_order_id !== payNowOrderId ||
          refundRow.paynow_payment_id !== input.result.payNowPaymentId ||
          integer(refundRow.amount) !== input.result.amount ||
          refundRow.currency !== input.result.currency) {
        throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow refund does not match the local billing record", 409);
      }
      if (refundRow.paynow_refund_id !== null && refundRow.paynow_refund_id !== input.result.payNowRefundId) {
        throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow refund ID conflicts with the local billing record", 409);
      }
      const refundEffectiveAtSeconds = status === "completed"
        ? input.result.completedAt ?? now
        : undefined;
      const completedAt = refundEffectiveAtSeconds === undefined
        ? null
        : postgresTimestamp(refundEffectiveAtSeconds);
      await client.query(`
        UPDATE billing_refunds
        SET paynow_refund_id=$2,
            status=$3,
            completed_at=COALESCE($4, completed_at),
            failure_message=$5
        WHERE refund_id=$1
      `, [
        refundRow.refund_id,
        input.result.payNowRefundId,
        status,
        completedAt,
        boundedFailureMessage(input.result.failureReason),
      ]);
      if (status === "completed") {
        const refundEffectiveAt = completedAt ?? postgresTimestamp(now);
        await client.query(`
          UPDATE billing_orders
          SET status='refunded',
              updated_at=$2
          WHERE order_id=$1
        `, [refundRow.order_id, postgresTimestamp(now)]);
        await client.query(`
          UPDATE billing_payments
          SET status='refunded',
              refunded_at=COALESCE($2, $3),
              updated_at=$3
          WHERE payment_id=$1
        `, [refundRow.payment_id, completedAt, postgresTimestamp(now)]);
        await client.query(`
          UPDATE billing_subscriptions
          SET status='canceled',
              current_period_end=LEAST(COALESCE(current_period_end, $2), $2),
              paid_through=LEAST(COALESCE(paid_through, $2), $2),
              canceled_at=COALESCE(canceled_at, $2),
              updated_at=$3
          WHERE entitlement_id=$1
        `, [refundRow.entitlement_id, refundEffectiveAt, postgresTimestamp(now)]);
        await client.query(`
          UPDATE billing_entitlements
          SET status='revoked',
              paid_through=LEAST(COALESCE(paid_through, $2), $2),
              updated_at=$3
          WHERE entitlement_id=$1
        `, [refundRow.entitlement_id, refundEffectiveAt, postgresTimestamp(now)]);
        await client.query(`
          UPDATE entitlements
          SET status='revoked',
              paid_through=LEAST(COALESCE(paid_through, $2), $2),
              updated_at=$3
          WHERE license_id=$1
        `, [refundRow.license_id, refundEffectiveAtSeconds ?? now, now]);
        const sessionTable = await client.query<{ exists: boolean }>(
          "SELECT to_regclass('license_sessions') IS NOT NULL AS exists",
        );
        if (sessionTable.rows[0]?.exists) {
          await client.query(`
            UPDATE license_sessions
            SET state='closing',
                closing_at=$2,
                last_seen_at=$2,
                lease_generation=COALESCE(lease_generation, 0) + 1
            WHERE license_id=$1
              AND released_at IS NULL
              AND (state IS NULL OR state IN ('reserved', 'active', 'closing'))
          `, [refundRow.license_id, now]);
        }
      }
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, 'admin_refund_submitted', 'refund', $3, $4, $5::jsonb, $6::jsonb, $7)
      `, [
        randomUUID(),
        refundRow.requested_by,
        refundRow.refund_id,
        refundRow.reason,
        JSON.stringify({ status: refundRow.status, payNowRefundId: refundRow.paynow_refund_id }),
        JSON.stringify({
          status,
          payNowRefundId: input.result.payNowRefundId,
          ...(refundEffectiveAtSeconds === undefined
            ? {}
            : { entitlementStatus: "revoked", paidThrough: refundEffectiveAtSeconds }),
        }),
        postgresTimestamp(now),
      ]);
      if (status === "completed" && this.#emailEncryptionKey) {
        await queueBillingNoticeEmail(client, this.#emailEncryptionKey, {
          deduplicationKey: `refund-receipt:${refundRow.refund_id}`,
          recipientEmail: decryptCheckoutEmail(this.#emailEncryptionKey, refundRow),
          kind: "refund-receipt",
          plan: refundRow.plan,
          planSnapshot: refundRow.plan_snapshot,
          publicOrderId: refundRow.public_order_id,
          publicSubscriptionId: refundRow.public_subscription_id,
          paidThrough: refundEffectiveAtSeconds ?? now,
          amount: input.result.amount,
          currency: input.result.currency,
          occurredAt: input.result.completedAt ?? now,
          reason: refundRow.reason,
          now,
        });
      }
      await client.query("COMMIT");
      return {
        refundId: refundRow.refund_id,
        publicOrderId: refundRow.public_order_id,
        payNowRefundId: input.result.payNowRefundId,
        status,
        amount: input.result.amount,
        currency: input.result.currency,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAdminOrderRefundFailed(input: {
    refundId: string;
    payNowOrderId: string;
    errorCode: string;
    errorMessage: string;
    now?: number;
  }): Promise<AdminRefundRecord> {
    if (!/^[0-9a-f-]{36}$/i.test(input.refundId)) invalidRequest("Refund ID is invalid");
    const payNowOrderId = verifiedPaymentIdentifier(input.payNowOrderId, "PayNow order ID");
    const errorCode = safeLogText(input.errorCode) ?? "paynow_api_error";
    const failureMessage = boundedFailureMessage(input.errorMessage) ?? "PayNow refund failed";
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const refund = await client.query<BillingRefundRow>(`
        SELECT r.refund_id,
               r.order_id,
               o.public_order_id,
               r.payment_id,
               o.paynow_order_id,
               p.paynow_payment_id,
               r.paynow_refund_id,
               r.amount,
               r.currency,
               r.reason,
               r.status,
               r.requested_by
        FROM billing_refunds r
        JOIN billing_orders o ON o.order_id=r.order_id
        LEFT JOIN billing_payments p ON p.payment_id=r.payment_id
        WHERE r.refund_id=$1
        FOR UPDATE OF r
      `, [input.refundId]);
      const refundRow = refund.rows[0];
      if (!refundRow) {
        throw new ServiceError("customer_portal_unavailable", "Refund request is not available", 404);
      }
      if (refundRow.paynow_order_id !== payNowOrderId) {
        throw new ServiceError("paynow_second_confirmation_mismatch", "PayNow refund failure does not match the local billing record", 409);
      }
      await client.query(`
        UPDATE billing_refunds
        SET status='failed',
            failure_message=$2
        WHERE refund_id=$1
      `, [
        refundRow.refund_id,
        failureMessage,
      ]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, 'admin_refund_failed', 'refund', $3, $4, $5::jsonb, $6::jsonb, $7)
      `, [
        randomUUID(),
        refundRow.requested_by,
        refundRow.refund_id,
        refundRow.reason,
        JSON.stringify({
          status: refundRow.status,
          payNowOrderId: refundRow.paynow_order_id,
          payNowPaymentId: refundRow.paynow_payment_id,
          payNowRefundId: refundRow.paynow_refund_id,
        }),
        JSON.stringify({
          status: "failed",
          publicOrderId: refundRow.public_order_id,
          payNowOrderId,
          payNowPaymentId: refundRow.paynow_payment_id,
          errorCode,
        }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        refundId: refundRow.refund_id,
        publicOrderId: refundRow.public_order_id,
        payNowOrderId,
        payNowPaymentId: refundRow.paynow_payment_id,
        status: "failed",
        amount: integer(refundRow.amount),
        currency: refundRow.currency,
        errorCode,
        failureMessage,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async addAdminOrderNote(input: {
    publicOrderId: string;
    requestedBy: string;
    note: string;
    now?: number;
  }): Promise<AdminOrderNoteRecord> {
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin note requester", 3, 160);
    const note = normalizedAdminText(input.note, "Admin order note", 4, 2000);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<{ order_id: string; public_order_id: string }>(
        "SELECT order_id, public_order_id FROM billing_orders WHERE public_order_id=$1 LIMIT 1",
        [publicOrderId],
      );
      const order = orderResult.rows[0];
      if (!order) {
        throw new ServiceError("customer_portal_unavailable", "Billing order is not available", 404);
      }
      const noteId = randomUUID();
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, 'admin_order_note_added', 'order', $3, $4, '{}'::jsonb, $5::jsonb, $6)
      `, [
        noteId,
        requestedBy,
        order.order_id,
        note,
        JSON.stringify({ publicOrderId: order.public_order_id, noteLength: note.length }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        noteId,
        publicOrderId: order.public_order_id,
        requestedBy,
        note,
        createdAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async changeAdminCustomerEmail(input: {
    publicOrderId: string;
    requestedBy: string;
    email: string;
    reason: string;
    ownershipEvidence: string;
    now?: number;
  }): Promise<AdminCustomerEmailChangeRecord> {
    if (!this.#emailEncryptionKey || !this.#emailHmacKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin customer email requester", 3, 160);
    const email = normalizeEmail(input.email, "Admin customer email");
    const reason = normalizedAdminText(input.reason, "Admin customer email reason", 4, 512);
    const ownershipEvidence = normalizedAdminText(input.ownershipEvidence, "Admin customer email ownership evidence", 8, 2000);
    const normalizedEmail = email.toLowerCase();
    const maskedEmail = maskEmail(normalizedEmail);
    const newEmailHmac = deliveryEmailHmac(this.#emailHmacKey, normalizedEmail);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `admin-customer-email:${publicOrderId}`]);
      const orderResult = await client.query<AdminCustomerEmailChangeRow>(`
        SELECT o.order_id,
               o.public_order_id,
               ci.intent_id,
               ci.delivery_email_hmac,
               ci.masked_email
        FROM billing_orders o
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        WHERE o.public_order_id=$1
        FOR UPDATE OF ci
      `, [publicOrderId]);
      const order = orderResult.rows[0];
      if (!order) {
        throw new ServiceError("customer_portal_unavailable", "Billing order is not available", 404);
      }
      const previousEmailHmac = Buffer.from(order.delivery_email_hmac);
      const changed = previousEmailHmac.length !== newEmailHmac.length || !timingSafeEqual(previousEmailHmac, newEmailHmac);
      const before = {
        publicOrderId: order.public_order_id,
        maskedEmail: order.masked_email,
        emailHashPrefix: emailHashPrefix(previousEmailHmac),
      };
      const after = {
        publicOrderId: order.public_order_id,
        maskedEmail,
        emailHashPrefix: emailHashPrefix(newEmailHmac),
        ownershipEvidence: redactedAdminAuditText(ownershipEvidence),
      };
      if (changed) {
        const encryptedEmail = encryptCheckoutEmail(this.#emailEncryptionKey, order.intent_id, email);
        await client.query(`
          UPDATE billing_checkout_intents
          SET delivery_email_ciphertext=$2,
              delivery_email_nonce=$3,
              delivery_email_tag=$4,
              delivery_email_hmac=$5,
              masked_email=$6,
              updated_at=$7
          WHERE intent_id=$1
        `, [
          order.intent_id,
          encryptedEmail.ciphertext,
          encryptedEmail.nonce,
          encryptedEmail.tag,
          newEmailHmac,
          maskedEmail,
          postgresTimestamp(now),
        ]);
      }
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, $3, 'order', $4, $5, $6::jsonb, $7::jsonb, $8)
      `, [
        randomUUID(),
        requestedBy,
        changed ? "admin_customer_email_changed" : "admin_customer_email_change_noop",
        order.order_id,
        reason,
        JSON.stringify(before),
        JSON.stringify(after),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        publicOrderId: order.public_order_id,
        requestedBy,
        previousMaskedEmail: order.masked_email,
        maskedEmail,
        changed,
        updatedAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAdminLicenseStatus(input: {
    publicOrderId: string;
    requestedBy: string;
    status: "active" | "hold" | "revoked";
    reason: string;
    now?: number;
  }): Promise<AdminLicenseStatusRecord> {
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin license status requester", 3, 160);
    const reason = normalizedAdminText(input.reason, "Admin license status reason", 4, 512);
    const status = input.status;
    if (status !== "active" && status !== "hold" && status !== "revoked") {
      invalidRequest("Admin license status is invalid");
    }
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<{
        order_id: string;
        public_order_id: string;
        entitlement_id: string;
        license_id: string;
        status: "active" | "hold" | "revoked";
      }>(`
        SELECT o.order_id,
               o.public_order_id,
               e.entitlement_id,
               e.license_id,
               e.status
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        WHERE o.public_order_id=$1
        LIMIT 1
        FOR UPDATE OF o, e
      `, [publicOrderId]);
      const order = orderResult.rows[0];
      if (!order) {
        throw new ServiceError("customer_portal_unavailable", "Billing order is not available", 404);
      }
      if (order.status === "revoked" && status !== "revoked") {
        throw new ServiceError("license_revoked", "Revoked licenses cannot be restored by status update", 409);
      }
      await client.query(`
        UPDATE billing_entitlements
        SET status=$1,
            updated_at=$2
        WHERE entitlement_id=$3
      `, [status, postgresTimestamp(now), order.entitlement_id]);
      await client.query(`
        UPDATE entitlements
        SET status=$1,
            updated_at=$2
        WHERE license_id=$3
      `, [status, now, order.license_id]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, 'admin_license_status_changed', 'entitlement', $3, $4, $5::jsonb, $6::jsonb, $7)
      `, [
        randomUUID(),
        requestedBy,
        order.entitlement_id,
        reason,
        JSON.stringify({ publicOrderId: order.public_order_id, licenseId: order.license_id, status: order.status }),
        JSON.stringify({ publicOrderId: order.public_order_id, licenseId: order.license_id, status }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        publicOrderId: order.public_order_id,
        entitlementId: order.entitlement_id,
        licenseId: order.license_id,
        previousStatus: order.status,
        status,
        updatedAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareAdminSubscriptionCancellation(input: {
    publicOrderId: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Promise<AdminSubscriptionCancellationPrepareRecord> {
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    normalizedAdminText(input.requestedBy, "Admin subscription cancellation requester", 3, 160);
    normalizedAdminText(input.reason, "Admin subscription cancellation reason", 4, 512);
    const result = await this.#pool.query<CustomerSubscriptionCancellationRow>(`
        SELECT o.order_id,
               o.public_order_id,
               s.subscription_id,
               s.public_subscription_id,
               s.paynow_subscription_id,
               s.status AS subscription_status,
               COALESCE(s.paid_through, e.paid_through) AS paid_through,
               o.plan,
               o.plan_snapshot,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        WHERE o.public_order_id=$1
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [publicOrderId]);
    const row = result.rows[0];
    if (!row) {
      throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
    }
    return {
      publicOrderId: row.public_order_id,
      ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
      payNowSubscriptionId: row.paynow_subscription_id,
      paidThrough: row.paid_through === null ? 0 : epochSeconds(row.paid_through),
      alreadyCanceled: row.subscription_status === "canceled",
    };
  }

  async recordAdminSubscriptionCanceled(input: {
    publicOrderId: string;
    payNowSubscriptionId: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Promise<AdminSubscriptionCancellationRecord> {
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const payNowSubscriptionId = verifiedPaymentIdentifier(input.payNowSubscriptionId, "PayNow subscription ID");
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin subscription cancellation requester", 3, 160);
    const reason = normalizedAdminText(input.reason, "Admin subscription cancellation reason", 4, 512);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `admin-cancel:${publicOrderId}`]);
      const existing = await client.query<CustomerSubscriptionCancellationRow>(`
        SELECT o.order_id,
               o.public_order_id,
               s.subscription_id,
               s.public_subscription_id,
               s.paynow_subscription_id,
               s.status AS subscription_status,
               COALESCE(s.paid_through, e.paid_through) AS paid_through,
               o.plan,
               o.plan_snapshot,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        WHERE o.public_order_id=$1
          AND s.paynow_subscription_id=$2
        LIMIT 1
        FOR UPDATE OF s
      `, [publicOrderId, payNowSubscriptionId]);
      const row = existing.rows[0];
      if (!row) {
        throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
      }
      const paidThrough = row.paid_through === null ? 0 : epochSeconds(row.paid_through);
      if (row.subscription_status === "canceled") {
        await client.query(`
          INSERT INTO billing_admin_audit_logs
            (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, external_result, created_at)
          VALUES ($1, $2, 'admin_subscription_cancel_already_canceled',
                  'subscription', $3, $4, $5::jsonb, $5::jsonb, $6::jsonb, $7)
        `, [
          randomUUID(),
          requestedBy,
          row.subscription_id,
          reason,
          JSON.stringify({ status: "canceled", paidThrough, cancelAtPeriodEnd: true }),
          JSON.stringify({ provider: BILLING_PROVIDER, subscriptionId: payNowSubscriptionId, alreadyCanceled: true }),
          postgresTimestamp(now),
        ]);
        await client.query("COMMIT");
        return {
          status: "already_canceled",
          publicOrderId: row.public_order_id,
          ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
          paidThrough,
          cancelAtPeriodEnd: true,
          requestedBy,
        };
      }
      await client.query(`
        UPDATE billing_subscriptions
        SET status='canceled',
            canceled_at=COALESCE(canceled_at, $2),
            cancel_reason=COALESCE(cancel_reason, 'admin_requested'),
            updated_at=$2
        WHERE subscription_id=$1
      `, [row.subscription_id, postgresTimestamp(now)]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, $2, 'admin_subscription_cancel_at_period_end',
                'subscription', $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
      `, [
        randomUUID(),
        requestedBy,
        row.subscription_id,
        reason,
        JSON.stringify({ status: row.subscription_status, paidThrough }),
        JSON.stringify({ status: "canceled", paidThrough, cancelAtPeriodEnd: true }),
        JSON.stringify({ provider: BILLING_PROVIDER, subscriptionId: payNowSubscriptionId }),
        postgresTimestamp(now),
      ]);
      if (this.#emailEncryptionKey) {
        await queueBillingNoticeEmail(client, this.#emailEncryptionKey, {
          deduplicationKey: `subscription-canceled:${row.subscription_id}:admin`,
          recipientEmail: decryptCheckoutEmail(this.#emailEncryptionKey, row),
          kind: "subscription-canceled",
          plan: row.plan,
          planSnapshot: row.plan_snapshot,
          publicOrderId: row.public_order_id,
          publicSubscriptionId: row.public_subscription_id,
          paidThrough,
          occurredAt: now,
          reason: "Support canceled automatic renewal at period end",
          now,
        });
      }
      await client.query("COMMIT");
      return {
        status: "cancel_at_period_end",
        publicOrderId: row.public_order_id,
        ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
        paidThrough,
        cancelAtPeriodEnd: true,
        requestedBy,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async adminBillingOrder(input: {
    publicOrderId: string;
    requestedBy: string;
    now?: number;
  }): Promise<AdminBillingOrderRecord> {
    return this.adminBillingOrderLookup({
      publicOrderId: input.publicOrderId,
      requestedBy: input.requestedBy,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  async adminBillingOrders(input: {
    requestedBy: string;
    limit?: number;
    offset?: number;
    now?: number;
  }): Promise<AdminBillingOrderListRecord> {
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin order list requester", 3, 160);
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
    const offset = Math.min(1_000_000, Math.max(0, Math.floor(input.offset ?? 0)));
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const rows = await this.#pool.query<AdminBillingOrderSummaryRow>(`
      SELECT o.public_order_id,
             o.paynow_order_id,
             o.plan,
             o.status AS order_status,
             o.created_at,
             e.license_id,
             e.status AS entitlement_status,
             e.paid_through,
             p.amount AS latest_payment_amount,
             p.currency AS latest_payment_currency,
             p.status AS latest_payment_status,
             p.completed_at AS latest_payment_completed_at,
             COALESCE(r.refund_count, 0) AS refund_count,
             r.latest_refund_status,
             r.latest_refund_requested_at,
             r.latest_refund_completed_at
      FROM billing_orders o
      JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
      LEFT JOIN LATERAL (
        SELECT amount,
               currency,
               status,
               completed_at
        FROM billing_payments
        WHERE order_id=o.order_id
        ORDER BY created_at DESC, payment_id DESC
        LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS refund_count,
               (ARRAY_AGG(status ORDER BY requested_at DESC, refund_id DESC))[1] AS latest_refund_status,
               (ARRAY_AGG(requested_at ORDER BY requested_at DESC, refund_id DESC))[1] AS latest_refund_requested_at,
               (ARRAY_AGG(completed_at ORDER BY requested_at DESC, refund_id DESC))[1] AS latest_refund_completed_at
        FROM billing_refunds
        WHERE order_id=o.order_id
      ) r ON true
      ORDER BY o.created_at DESC, o.order_id DESC
      LIMIT $1 OFFSET $2
    `, [limit + 1, offset]);
    await this.#pool.query(`
      INSERT INTO billing_admin_audit_logs
        (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
      VALUES ($1, $2, 'admin_orders_listed', 'orders', 'list', 'billing support order list', '{}'::jsonb, $3::jsonb, $4)
    `, [
      randomUUID(),
      requestedBy,
      JSON.stringify({ limit, offset, returned: Math.min(rows.rows.length, limit) }),
      postgresTimestamp(now),
    ]);
    const pageRows = rows.rows.slice(0, limit);
    const orders: AdminBillingOrderSummaryRecord[] = pageRows.map((row) => ({
      publicOrderId: row.public_order_id,
      ...(row.paynow_order_id === null ? {} : { payNowOrderId: row.paynow_order_id }),
      plan: row.plan,
      orderStatus: row.order_status,
      licenseId: row.license_id,
      licenseStatus: row.entitlement_status,
      ...(row.paid_through === null ? {} : { paidThrough: epochSeconds(row.paid_through) }),
      createdAt: epochSeconds(row.created_at),
      ...(row.latest_payment_amount === null || row.latest_payment_currency === null || row.latest_payment_status === null
        ? {}
        : {
            latestPayment: {
              amount: integer(row.latest_payment_amount),
              currency: row.latest_payment_currency,
              status: row.latest_payment_status,
              ...(row.latest_payment_completed_at === null ? {} : { completedAt: epochSeconds(row.latest_payment_completed_at) }),
            },
          }),
      ...(row.latest_refund_status === null || row.latest_refund_requested_at === null
        ? {}
        : {
            latestRefund: {
              status: row.latest_refund_status,
              requestedAt: epochSeconds(row.latest_refund_requested_at),
              ...(row.latest_refund_completed_at === null ? {} : { completedAt: epochSeconds(row.latest_refund_completed_at) }),
            },
          }),
      refundCount: integer(row.refund_count),
    }));
    return {
      orders,
      limit,
      offset,
      hasMore: rows.rows.length > limit,
    };
  }

  async adminBillingOrderLookup(input: {
    publicOrderId?: string;
    payNowOrderId?: string;
    licenseId?: string;
    requestedBy: string;
    now?: number;
  }): Promise<AdminBillingOrderRecord> {
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin lookup requester", 3, 160);
    const publicOrderId = input.publicOrderId === undefined ? undefined : normalizedPublicOrderId(input.publicOrderId);
    const payNowOrderId = input.payNowOrderId === undefined ? undefined : verifiedPaymentIdentifier(input.payNowOrderId, "PayNow order ID");
    const licenseId = input.licenseId === undefined ? undefined : normalizedLicenseId(input.licenseId);
    const lookupCount = [publicOrderId, payNowOrderId, licenseId].filter((value) => value !== undefined).length;
    if (lookupCount !== 1) {
      invalidRequest("Exactly one admin order lookup key is required");
    }
    const lookup = publicOrderId !== undefined
      ? { clause: "o.public_order_id=$1", values: [publicOrderId], audit: { lookup: "publicOrderId", publicOrderId } }
      : payNowOrderId !== undefined
        ? { clause: "o.paynow_order_id=$1", values: [payNowOrderId], audit: { lookup: "payNowOrderId", payNowOrderId } }
        : { clause: "e.license_id=$1", values: [licenseId!], audit: { lookup: "licenseId", licenseId } };
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<AdminBillingOrderRow>(`
        SELECT o.order_id,
               o.public_order_id,
               o.paynow_order_id,
               o.paynow_checkout_id,
               o.plan,
               o.status AS order_status,
               e.entitlement_id,
               e.license_id,
               e.status AS entitlement_status,
               e.paid_through
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        WHERE ${lookup.clause}
        LIMIT 1
      `, lookup.values);
      const order = orderResult.rows[0];
      if (!order) {
        throw new ServiceError("customer_portal_unavailable", "Billing order is not available", 404);
      }
      const payments = await client.query<AdminBillingPaymentRow>(`
        SELECT payment_id,
               paynow_payment_id,
               amount,
               currency,
               status,
               created_at,
               completed_at,
               refunded_at
        FROM billing_payments
        WHERE order_id=$1
        ORDER BY created_at DESC, payment_id DESC
      `, [order.order_id]);
      const subscriptions = await client.query<AdminBillingSubscriptionRow>(`
        SELECT public_subscription_id,
               paynow_subscription_id,
               status,
               paid_through,
               canceled_at
        FROM billing_subscriptions
        WHERE entitlement_id=$1
        ORDER BY created_at DESC, subscription_id DESC
      `, [order.entitlement_id]);
      const refunds = await client.query<AdminBillingRefundSummaryRow>(`
        SELECT refund_id,
               paynow_refund_id,
               amount,
               currency,
               status,
               requested_by,
               requested_at,
               completed_at,
               failure_message
        FROM billing_refunds
        WHERE order_id=$1
        ORDER BY requested_at DESC, refund_id DESC
      `, [order.order_id]);
      const auditTargetIds = [
        order.order_id,
        ...refunds.rows.map((row) => row.refund_id),
        ...subscriptions.rows.map((row) => row.paynow_subscription_id),
      ];
      const auditLogs = auditTargetIds.length === 0
        ? { rows: [] as AdminBillingAuditLogRow[] }
        : await client.query<AdminBillingAuditLogRow>(`
          SELECT audit_id,
                 actor,
                 action,
                 target_type,
                 target_id,
                 reason,
                 old_value,
                 new_value,
                 before_json,
                 after_json,
                 external_result,
                 created_at
          FROM billing_admin_audit_logs
          WHERE target_id=ANY($1::uuid[])
          ORDER BY created_at DESC, audit_id DESC
          LIMIT 100
        `, [auditTargetIds.filter((value) => /^[0-9a-f-]{36}$/i.test(value))]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, before_json, after_json, created_at)
        VALUES ($1, $2, 'admin_order_viewed', 'order', $3, 'billing support lookup', '{}'::jsonb, $4::jsonb, $5)
      `, [
        randomUUID(),
        requestedBy,
        order.order_id,
        JSON.stringify({ ...lookup.audit, publicOrderId: order.public_order_id }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      const paymentRecords: AdminBillingPaymentRecord[] = payments.rows.map((row) => ({
        paymentId: row.payment_id,
        ...(row.paynow_payment_id === null ? {} : { payNowPaymentId: row.paynow_payment_id }),
        amount: integer(row.amount),
        currency: row.currency,
        status: row.status,
        createdAt: epochSeconds(row.created_at),
        ...(row.completed_at === null ? {} : { completedAt: epochSeconds(row.completed_at) }),
        ...(row.refunded_at === null ? {} : { refundedAt: epochSeconds(row.refunded_at) }),
      }));
      const subscriptionRecords: AdminBillingSubscriptionRecord[] = subscriptions.rows.map((row) => ({
        ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
        payNowSubscriptionId: row.paynow_subscription_id,
        status: row.status,
        paidThrough: epochSeconds(row.paid_through),
        cancelAtPeriodEnd: row.status === "cancel_at_period_end" || row.canceled_at !== null,
        ...(row.canceled_at === null ? {} : { canceledAt: epochSeconds(row.canceled_at) }),
      }));
      const refundRecords: AdminBillingRefundSummaryRecord[] = refunds.rows.map((row) => ({
        refundId: row.refund_id,
        ...(row.paynow_refund_id === null ? {} : { payNowRefundId: row.paynow_refund_id }),
        amount: integer(row.amount),
        currency: row.currency,
        status: row.status,
        requestedBy: row.requested_by,
        requestedAt: epochSeconds(row.requested_at),
        ...(row.completed_at === null ? {} : { completedAt: epochSeconds(row.completed_at) }),
        ...(row.failure_message === null ? {} : { failureMessage: row.failure_message }),
      }));
      const auditRecords: AdminBillingAuditLogRecord[] = auditLogs.rows.map((row) => ({
        auditId: row.audit_id,
        actor: row.actor,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        ...(row.reason === null ? {} : { reason: row.reason }),
        ...(row.before_json === null && row.old_value === null ? {} : { before: row.before_json ?? row.old_value }),
        ...(row.after_json === null && row.new_value === null ? {} : { after: row.after_json ?? row.new_value }),
        ...(row.external_result === null ? {} : { externalResult: row.external_result }),
        createdAt: epochSeconds(row.created_at),
      }));
      return {
        publicOrderId: order.public_order_id,
        orderId: order.order_id,
        ...(order.paynow_order_id === null ? {} : { payNowOrderId: order.paynow_order_id }),
        ...(order.paynow_checkout_id === null ? {} : { payNowCheckoutId: order.paynow_checkout_id }),
        plan: order.plan,
        orderStatus: order.order_status,
        entitlementId: order.entitlement_id,
        licenseId: order.license_id,
        licenseStatus: order.entitlement_status,
        ...(order.paid_through === null ? {} : { paidThrough: epochSeconds(order.paid_through) }),
        payments: paymentRecords,
        subscriptions: subscriptionRecords,
        refunds: refundRecords,
        auditLogs: auditRecords,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async customerBillingStatus(input: {
    publicOrderId: string;
    accessToken: string;
    now?: number;
  }): Promise<CustomerBillingStatusRecord> {
    if (!this.#emailHmacKey) {
      throw new ServiceError("billing_email_key_required", "Billing email HMAC is not configured", 503);
    }
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const accessToken = normalizedCustomerAccessToken(input.accessToken);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const result = await this.#pool.query<CustomerBillingStatusRow>(`
      SELECT o.public_order_id,
             s.public_subscription_id,
             o.plan,
             o.plan_snapshot,
             o.status AS order_status,
             s.status AS subscription_status,
             COALESCE(s.paid_through, e.paid_through) AS paid_through,
             s.canceled_at,
             e.status AS entitlement_status,
             eo.status AS email_status
      FROM billing_orders o
      JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
      LEFT JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
      LEFT JOIN LATERAL (
        SELECT status,
               created_at
        FROM billing_email_outbox
        WHERE kind='license_file'
          AND (
            deduplication_key=('first-license:' || e.entitlement_id::text) OR
            payload->>'entitlementId'=e.entitlement_id::text
          )
        ORDER BY created_at DESC
        LIMIT 1
      ) eo ON true
      WHERE o.public_order_id=$1
        AND o.customer_access_token_hash=$2
      ORDER BY eo.created_at ASC NULLS LAST
      LIMIT 1
    `, [publicOrderId, customerAccessTokenHash(this.#emailHmacKey, accessToken)]);
    const row = result.rows[0];
    if (!row) {
      throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
    }
      return customerStatusRow(row, now, this.#gracePeriodSeconds);
  }

  async requestAdminLicenseFileResend(input: {
    publicOrderId: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Promise<AdminLicenseFileResendRecord> {
    if (!this.#emailEncryptionKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const requestedBy = normalizedAdminText(input.requestedBy, "Admin license resend requester", 3, 160);
    const reason = normalizedAdminText(input.reason, "Admin license resend reason", 4, 512);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `admin-license-resend:${publicOrderId}`]);
      const source = await client.query<CustomerLicenseResendSourceRow>(`
        SELECT o.order_id,
               o.public_order_id,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag,
               eo.outbox_id,
               eo.payload
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        JOIN LATERAL (
          SELECT outbox_id,
                 payload,
                 created_at
          FROM billing_email_outbox
          WHERE kind='license_file'
            AND deduplication_key NOT LIKE 'resend-license:%'
            AND (
              deduplication_key=('first-license:' || e.entitlement_id::text) OR
              payload->>'entitlementId'=e.entitlement_id::text
            )
          ORDER BY created_at DESC
          LIMIT 1
        ) eo ON true
        WHERE o.public_order_id=$1
          AND e.status='active'
        ORDER BY eo.created_at ASC
        LIMIT 1
      `, [publicOrderId]);
      const row = source.rows[0];
      if (!row) {
        throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
      }
      if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload) || !("licenseFile" in row.payload)) {
        throw new ServiceError("license_resend_unavailable", "License file resend is not available", 409);
      }
      const resendWindow = Math.floor(now / 3600);
      const deduplicationKey = `resend-license:${row.order_id}:${row.outbox_id}:admin:${resendWindow}`;
      const existing = await client.query<{ outbox_id: string; next_attempt_at: string | number | Date }>(
        "SELECT outbox_id, next_attempt_at FROM billing_email_outbox WHERE deduplication_key=$1",
        [deduplicationKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        await client.query("COMMIT");
        return {
          status: "duplicate",
          publicOrderId: row.public_order_id,
          outboxId: existingRow.outbox_id,
          nextAttemptAt: epochSeconds(existingRow.next_attempt_at),
          requestedBy,
        };
      }
      const outboxId = randomUUID();
      const recipientEmail = decryptCheckoutEmail(this.#emailEncryptionKey, row);
      const encryptedRecipient = encryptOutboxEmail(this.#emailEncryptionKey, outboxId, recipientEmail);
      const payload = {
        ...(row.payload as Record<string, unknown>),
        kind: "replacement-license-file",
      };
      await client.query(`
        INSERT INTO billing_email_outbox
          (outbox_id, deduplication_key, kind, recipient_email_ciphertext,
           recipient_email_nonce, recipient_email_tag, payload, status, attempts,
           next_attempt_at, created_at, updated_at)
        VALUES ($1, $2, 'license_file', $3, $4, $5, $6::jsonb, 'queued', 0, $7, $7, $7)
      `, [
        outboxId,
        deduplicationKey,
        encryptedRecipient.ciphertext,
        encryptedRecipient.nonce,
        encryptedRecipient.tag,
        JSON.stringify(payload),
        postgresTimestamp(now),
      ]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, $2, 'admin_license_file_resend_requested',
                'order', $3, $4, NULL, $5::jsonb, NULL, $6)
      `, [
        randomUUID(),
        requestedBy,
        row.order_id,
        reason,
        JSON.stringify({ publicOrderId: row.public_order_id, outboxId }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        status: "queued",
        publicOrderId: row.public_order_id,
        outboxId,
        nextAttemptAt: now,
        requestedBy,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async requestLicenseFileResend(input: {
    publicOrderId: string;
    accessToken: string;
    now?: number;
  }): Promise<CustomerLicenseFileResendRecord> {
    if (!this.#emailEncryptionKey || !this.#emailHmacKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const accessToken = normalizedCustomerAccessToken(input.accessToken);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const accessTokenHash = customerAccessTokenHash(this.#emailHmacKey, accessToken);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `license-resend:${publicOrderId}`]);
      const source = await client.query<CustomerLicenseResendSourceRow>(`
        SELECT o.order_id,
               o.public_order_id,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag,
               eo.outbox_id,
               eo.payload
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        JOIN LATERAL (
          SELECT outbox_id,
                 payload,
                 created_at
          FROM billing_email_outbox
          WHERE kind='license_file'
            AND deduplication_key NOT LIKE 'resend-license:%'
            AND (
              deduplication_key=('first-license:' || e.entitlement_id::text) OR
              payload->>'entitlementId'=e.entitlement_id::text
            )
          ORDER BY created_at DESC
          LIMIT 1
        ) eo ON true
        WHERE o.public_order_id=$1
          AND o.customer_access_token_hash=$2
          AND e.status='active'
        ORDER BY eo.created_at ASC
        LIMIT 1
      `, [publicOrderId, accessTokenHash]);
      const row = source.rows[0];
      if (!row) {
        throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
      }
      if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload) || !("licenseFile" in row.payload)) {
        throw new ServiceError("license_resend_unavailable", "License file resend is not available", 409);
      }
      const resendWindow = Math.floor(now / 3600);
      const deduplicationKey = `resend-license:${row.order_id}:${row.outbox_id}:${resendWindow}`;
      const existing = await client.query<{ outbox_id: string; next_attempt_at: string | number | Date }>(
        "SELECT outbox_id, next_attempt_at FROM billing_email_outbox WHERE deduplication_key=$1",
        [deduplicationKey],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        await client.query("COMMIT");
        return {
          status: "duplicate",
          publicOrderId: row.public_order_id,
          outboxId: existingRow.outbox_id,
          nextAttemptAt: epochSeconds(existingRow.next_attempt_at),
        };
      }

      const outboxId = randomUUID();
      const recipientEmail = decryptCheckoutEmail(this.#emailEncryptionKey, row);
      const encryptedRecipient = encryptOutboxEmail(this.#emailEncryptionKey, outboxId, recipientEmail);
      const payload = {
        ...(row.payload as Record<string, unknown>),
        kind: "replacement-license-file",
      };
      await client.query(`
        INSERT INTO billing_email_outbox
          (outbox_id, deduplication_key, kind, recipient_email_ciphertext,
           recipient_email_nonce, recipient_email_tag, payload, status, attempts,
           next_attempt_at, created_at, updated_at)
        VALUES ($1, $2, 'license_file', $3, $4, $5, $6::jsonb, 'queued', 0, $7, $7, $7)
      `, [
        outboxId,
        deduplicationKey,
        encryptedRecipient.ciphertext,
        encryptedRecipient.nonce,
        encryptedRecipient.tag,
        JSON.stringify(payload),
        postgresTimestamp(now),
      ]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, 'system:customer-portal', 'license_file_resend_requested',
                'order', $2, 'customer_verified_token', NULL, $3::jsonb, NULL, $4)
      `, [
        randomUUID(),
        row.order_id,
        JSON.stringify({ publicOrderId: row.public_order_id, outboxId }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        status: "queued",
        publicOrderId: row.public_order_id,
        outboxId,
        nextAttemptAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateLeakedLicenseFile(input: {
    publicOrderId: string;
    idempotencyKey: string;
    requestedBy: string;
    reason: string;
    now?: number;
  }): Promise<AdminLicenseRotationRecord> {
    if (!this.#emailEncryptionKey || !this.#licenseKeyPepper || !this.#licenseFileOptions) {
      throw new ServiceError("paid_license_file_config_required", "Paid license generation is not configured", 503);
    }
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const idempotencyKeyHash = licenseRotationIdempotencyHash(input.idempotencyKey);
    const requestedBy = normalizedAdminText(input.requestedBy, "License rotation requester", 3, 160);
    const reason = normalizedAdminText(input.reason, "License rotation reason", 4, 512);
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const deduplicationKey = `license-rotation:${publicOrderId}:${idempotencyKeyHash.toString("hex")}`;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
        ADVISORY_LOCK_CLASS,
        `license-rotation:${publicOrderId}:${idempotencyKeyHash.toString("hex")}`,
      ]);
      const duplicate = await client.query<{
        outbox_id: string;
        next_attempt_at: string | number | Date;
        payload: unknown;
      }>(
        "SELECT outbox_id, next_attempt_at, payload FROM billing_email_outbox WHERE deduplication_key=$1 FOR UPDATE",
        [deduplicationKey],
      );
      const duplicateRow = duplicate.rows[0];
      if (duplicateRow) {
        const payload = duplicateRow.payload && typeof duplicateRow.payload === "object" && !Array.isArray(duplicateRow.payload)
          ? duplicateRow.payload as Record<string, unknown>
          : {};
        const oldEntitlementId = typeof payload.rotatedFromEntitlementId === "string" ? payload.rotatedFromEntitlementId : "";
        const oldLicenseId = typeof payload.rotatedFromLicenseId === "string" ? payload.rotatedFromLicenseId : "";
        const newEntitlementId = typeof payload.entitlementId === "string" ? payload.entitlementId : "";
        const newLicenseId = typeof payload.entitlementLicenseId === "string" ? payload.entitlementLicenseId : "";
        if (!oldEntitlementId || !oldLicenseId || !newEntitlementId || !newLicenseId) {
          throw new ServiceError("license_rotation_unavailable", "License rotation result is not available", 409);
        }
        await client.query("COMMIT");
        return {
          status: "duplicate",
          publicOrderId,
          oldEntitlementId,
          oldLicenseId,
          newEntitlementId,
          newLicenseId,
          outboxId: duplicateRow.outbox_id,
          nextAttemptAt: epochSeconds(duplicateRow.next_attempt_at),
        };
      }

      const source = await client.query<AdminLicenseRotationSourceRow>(`
        SELECT o.order_id,
               o.public_order_id,
               o.status AS order_status,
               o.checkout_intent_id,
               o.plan,
               o.plan_snapshot,
               e.entitlement_id AS old_entitlement_id,
               e.license_id AS old_license_id,
               e.account_id,
               COALESCE(s.paid_through, e.paid_through) AS paid_through,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag,
               eo.payload AS first_license_payload
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        LEFT JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        LEFT JOIN LATERAL (
          SELECT payload,
                 created_at
          FROM billing_email_outbox
          WHERE kind='license_file'
            AND deduplication_key NOT LIKE 'resend-license:%'
            AND (
              deduplication_key=('first-license:' || e.entitlement_id::text) OR
              payload->>'entitlementId'=e.entitlement_id::text
            )
          ORDER BY created_at DESC
          LIMIT 1
        ) eo ON true
        WHERE o.public_order_id=$1
          AND o.status='completed'
          AND e.status='active'
        ORDER BY s.created_at DESC NULLS LAST
        LIMIT 1
        FOR UPDATE OF o, e
      `, [publicOrderId]);
      const row = source.rows[0];
      if (!row || row.paid_through === null) {
        throw new ServiceError("license_rotation_unavailable", "Rotatable paid license is not available", 404);
      }
      const paidThrough = epochSeconds(row.paid_through);
      if (paidThrough <= now) {
        throw new ServiceError("license_rotation_unavailable", "Rotatable paid license is not active", 409);
      }
      const firstPayload = row.first_license_payload && typeof row.first_license_payload === "object" && !Array.isArray(row.first_license_payload)
        ? row.first_license_payload as Record<string, unknown>
        : {};
      if (typeof firstPayload.customerAccessToken !== "string") {
        throw new ServiceError("license_rotation_unavailable", "Original customer access token is not available for rotation", 409);
      }
      const customerAccessToken = normalizedCustomerAccessToken(firstPayload.customerAccessToken);
      const snapshot = row.plan_snapshot as {
        name?: string;
        concurrency?: number;
      };
      const newEntitlementId = randomUUID();
      const newLicenseId = randomUUID();
      const licenseSecret = randomBytes(32).toString("base64url");
      const licenseKey = `sly_live_${newLicenseId}.${licenseSecret}`;
      const outboxId = randomUUID();
      const recipientEmail = decryptCheckoutEmail(this.#emailEncryptionKey, row);
      const encryptedRecipient = encryptOutboxEmail(this.#emailEncryptionKey, outboxId, recipientEmail);
      const licenseFileExpiresAt = now + LICENSE_FILE_ROTATION_SECONDS;
      const licenseFile = createPortableLicenseFile({
        licenseId: newLicenseId,
        licenseKey,
        serviceUrl: this.#licenseFileOptions.serviceUrl,
        issuedAt: new Date(now * 1000),
        expiresAt: new Date(licenseFileExpiresAt * 1000),
        passphrase: this.#licenseFileOptions.passphrase,
        signingKeyId: this.#licenseFileOptions.signingKeyId,
        signingPrivateKey: this.#licenseFileOptions.signingPrivateKey,
      });
      const outboxPayload = {
        schemaVersion: 1,
        kind: "replacement-license-file",
        entitlementId: newEntitlementId,
        entitlementLicenseId: newLicenseId,
        rotatedFromEntitlementId: row.old_entitlement_id,
        rotatedFromLicenseId: row.old_license_id,
        orderId: row.order_id,
        publicOrderId: row.public_order_id,
        plan: row.plan,
        planName: snapshot.name ?? PLAN_CATALOG[row.plan].name,
        concurrency: snapshot.concurrency ?? PLAN_CATALOG[row.plan].concurrency,
        issuedAt: now,
        paidThrough,
        licenseFileName: `${row.public_order_id}-slybrowser-license.json`,
        customerAccessToken,
        licenseFile,
      };

      await client.query(`
        UPDATE billing_entitlements
        SET status='revoked',
            updated_at=$2
        WHERE entitlement_id=$1
      `, [row.old_entitlement_id, postgresTimestamp(now)]);
      await client.query(`
        UPDATE entitlements
        SET status='revoked',
            updated_at=$2
        WHERE license_id=$1
      `, [row.old_license_id, now]);
      const sessionTable = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('license_sessions') IS NOT NULL AS exists",
      );
      if (sessionTable.rows[0]?.exists) {
        await client.query(`
          UPDATE license_sessions
          SET state='closing',
              closing_at=$2,
              last_seen_at=$2,
              lease_generation=COALESCE(lease_generation, 0) + 1
          WHERE license_id=$1
            AND (state IS NULL OR state IN ('reserved', 'active'))
        `, [row.old_license_id, now]);
      }
      await client.query(`
        INSERT INTO entitlements
          (license_id, account_id, plan, status, paid_through, key_hash, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', $4, $5, $6, $6)
      `, [
        newLicenseId,
        row.account_id ?? `paynow:${row.public_order_id}`,
        row.plan,
        paidThrough,
        this.#licenseSecretHash(licenseSecret),
        now,
      ]);
      await client.query(`
        INSERT INTO billing_entitlements
          (entitlement_id, license_id, account_id, plan, status, paid_through,
           source_checkout_intent_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $7)
      `, [
        newEntitlementId,
        newLicenseId,
        row.account_id,
        row.plan,
        postgresTimestamp(paidThrough),
        row.checkout_intent_id,
        postgresTimestamp(now),
      ]);
      await client.query(`
        UPDATE billing_orders
        SET entitlement_id=$2,
            updated_at=$3
        WHERE order_id=$1
      `, [row.order_id, newEntitlementId, postgresTimestamp(now)]);
      await client.query(`
        UPDATE billing_subscriptions
        SET entitlement_id=$2,
            updated_at=$3
        WHERE entitlement_id=$1
      `, [row.old_entitlement_id, newEntitlementId, postgresTimestamp(now)]);
      await client.query(`
        INSERT INTO billing_email_outbox
          (outbox_id, deduplication_key, kind, recipient_email_ciphertext,
           recipient_email_nonce, recipient_email_tag, payload, status, attempts,
           next_attempt_at, created_at, updated_at)
        VALUES ($1, $2, 'license_file', $3, $4, $5, $6::jsonb, 'queued', 0, $7, $7, $7)
      `, [
        outboxId,
        deduplicationKey,
        encryptedRecipient.ciphertext,
        encryptedRecipient.nonce,
        encryptedRecipient.tag,
        JSON.stringify(outboxPayload),
        postgresTimestamp(now),
      ]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, $2, 'license_file_rotated_after_leak',
                'entitlement', $3, $4, $5::jsonb, $6::jsonb, NULL, $7)
      `, [
        randomUUID(),
        requestedBy,
        row.old_entitlement_id,
        reason,
        JSON.stringify({
          publicOrderId: row.public_order_id,
          entitlementId: row.old_entitlement_id,
          licenseId: row.old_license_id,
          status: "revoked",
        }),
        JSON.stringify({
          publicOrderId: row.public_order_id,
          entitlementId: newEntitlementId,
          licenseId: newLicenseId,
          outboxId,
          status: "active",
        }),
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
      return {
        status: "queued",
        publicOrderId: row.public_order_id,
        oldEntitlementId: row.old_entitlement_id,
        oldLicenseId: row.old_license_id,
        newEntitlementId,
        newLicenseId,
        outboxId,
        nextAttemptAt: now,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async prepareCustomerSubscriptionCancellation(input: {
    publicOrderId: string;
    accessToken: string;
    now?: number;
  }): Promise<CustomerSubscriptionCancellationPrepareRecord> {
    if (!this.#emailHmacKey) {
      throw new ServiceError("billing_email_key_required", "Billing email HMAC is not configured", 503);
    }
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const accessToken = normalizedCustomerAccessToken(input.accessToken);
    const result = await this.#pool.query<CustomerSubscriptionCancellationRow>(`
        SELECT o.order_id,
               o.public_order_id,
               s.subscription_id,
               s.public_subscription_id,
               s.paynow_subscription_id,
               s.status AS subscription_status,
               COALESCE(s.paid_through, e.paid_through) AS paid_through,
               o.plan,
               o.plan_snapshot,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        WHERE o.public_order_id=$1
          AND o.customer_access_token_hash=$2
          AND e.status='active'
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [publicOrderId, customerAccessTokenHash(this.#emailHmacKey, accessToken)]);
    const row = result.rows[0];
    if (!row) {
      throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
    }
    return {
      publicOrderId: row.public_order_id,
      ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
      payNowSubscriptionId: row.paynow_subscription_id,
      paidThrough: row.paid_through === null ? 0 : epochSeconds(row.paid_through),
      alreadyCanceled: row.subscription_status === "canceled",
    };
  }

  async recordCustomerSubscriptionCanceled(input: {
    publicOrderId: string;
    payNowSubscriptionId: string;
    now?: number;
  }): Promise<CustomerSubscriptionCancellationRecord> {
    const publicOrderId = normalizedPublicOrderId(input.publicOrderId);
    const payNowSubscriptionId = verifiedPaymentIdentifier(input.payNowSubscriptionId, "PayNow subscription ID");
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [ADVISORY_LOCK_CLASS, `customer-cancel:${publicOrderId}`]);
      const existing = await client.query<CustomerSubscriptionCancellationRow>(`
        SELECT o.order_id,
               o.public_order_id,
               s.subscription_id,
               s.public_subscription_id,
               s.paynow_subscription_id,
               s.status AS subscription_status,
               COALESCE(s.paid_through, e.paid_through) AS paid_through,
               o.plan,
               o.plan_snapshot,
               ci.intent_id,
               ci.delivery_email_ciphertext,
               ci.delivery_email_nonce,
               ci.delivery_email_tag
        FROM billing_orders o
        JOIN billing_entitlements e ON e.entitlement_id=o.entitlement_id
        JOIN billing_subscriptions s ON s.entitlement_id=e.entitlement_id
        JOIN billing_checkout_intents ci ON ci.intent_id=o.checkout_intent_id
        WHERE o.public_order_id=$1
          AND s.paynow_subscription_id=$2
        LIMIT 1
        FOR UPDATE OF s
      `, [publicOrderId, payNowSubscriptionId]);
      const row = existing.rows[0];
      if (!row) {
        throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
      }
      const paidThrough = row.paid_through === null ? 0 : epochSeconds(row.paid_through);
      if (row.subscription_status === "canceled") {
        await client.query("COMMIT");
        return {
          status: "already_canceled",
          publicOrderId: row.public_order_id,
          ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
          paidThrough,
          cancelAtPeriodEnd: true,
        };
      }
      await client.query(`
        UPDATE billing_subscriptions
        SET status='canceled',
            canceled_at=COALESCE(canceled_at, $2),
            cancel_reason=COALESCE(cancel_reason, 'customer_requested'),
            updated_at=$2
        WHERE subscription_id=$1
      `, [row.subscription_id, postgresTimestamp(now)]);
      await client.query(`
        INSERT INTO billing_admin_audit_logs
          (audit_id, actor, action, target_type, target_id, reason, old_value,
           new_value, external_result, created_at)
        VALUES ($1, 'system:customer-portal', 'subscription_cancel_at_period_end',
                'subscription', $2, 'customer_verified_token', $3::jsonb, $4::jsonb, $5::jsonb, $6)
      `, [
        randomUUID(),
        row.subscription_id,
        JSON.stringify({ status: row.subscription_status, paidThrough }),
        JSON.stringify({ status: "canceled", paidThrough, cancelAtPeriodEnd: true }),
        JSON.stringify({ provider: BILLING_PROVIDER, subscriptionId: payNowSubscriptionId }),
        postgresTimestamp(now),
      ]);
      if (this.#emailEncryptionKey) {
        await queueBillingNoticeEmail(client, this.#emailEncryptionKey, {
          deduplicationKey: `subscription-canceled:${row.subscription_id}:reconciled`,
          recipientEmail: decryptCheckoutEmail(this.#emailEncryptionKey, row),
          kind: "subscription-canceled",
          plan: row.plan,
          planSnapshot: row.plan_snapshot,
          publicOrderId: row.public_order_id,
          publicSubscriptionId: row.public_subscription_id,
          paidThrough,
          occurredAt: now,
          reason: "Customer requested cancellation at period end",
          now,
        });
      }
      await client.query("COMMIT");
      return {
        status: "cancel_at_period_end",
        publicOrderId: row.public_order_id,
        ...(row.public_subscription_id === null ? {} : { publicSubscriptionId: row.public_subscription_id }),
        paidThrough,
        cancelAtPeriodEnd: true,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimLicenseEmailOutbox(options: ClaimLicenseEmailOutboxOptions = {}): Promise<LicenseEmailOutboxTask[]> {
    if (!this.#emailEncryptionKey) {
      throw new ServiceError("billing_email_key_required", "Billing email encryption is not configured", 503);
    }
    const now = Math.max(0, Math.floor(options.now ?? Date.now() / 1000));
    const limit = boundedOutboxLimit(options.limit);
    const maxAttempts = boundedOutboxAttempts(options.maxAttempts);
    const visibilityTimeoutSeconds = Math.max(30, Math.min(30 * 60, Math.floor(options.visibilityTimeoutSeconds ?? 5 * 60)));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<BillingEmailOutboxRow>(`
        SELECT outbox_id, recipient_email_ciphertext, recipient_email_nonce,
               recipient_email_tag, payload, attempts
        FROM billing_email_outbox
        WHERE kind IN ('license_file', 'billing_notice')
          AND status IN ('queued', 'sending')
          AND next_attempt_at <= $1
          AND attempts < $2
          AND (
            (kind='license_file' AND payload ? 'licenseFile')
            OR
            (kind='billing_notice' AND NOT (payload ? 'licenseFile'))
          )
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      `, [postgresTimestamp(now), maxAttempts, limit]);
      const ids = result.rows.map((row) => row.outbox_id);
      if (ids.length > 0) {
        await client.query(`
          UPDATE billing_email_outbox
          SET status='sending',
              attempts=attempts + 1,
              next_attempt_at=$2,
              updated_at=$3
          WHERE outbox_id=ANY($1::uuid[])
        `, [
          ids,
          postgresTimestamp(now + visibilityTimeoutSeconds),
          postgresTimestamp(now),
        ]);
      }
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        outboxId: row.outbox_id,
        recipientEmail: decryptOutboxEmail(this.#emailEncryptionKey!, row),
        payload: row.payload,
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markLicenseEmailOutboxSent(input: MarkLicenseEmailSentInput): Promise<void> {
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const providerMessageId = safeLogText(input.providerMessageId);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ status: string }>(
        "SELECT status FROM billing_email_outbox WHERE outbox_id=$1 FOR UPDATE",
        [input.outboxId],
      );
      const row = current.rows[0];
      if (!row) {
        throw new ServiceError("license_email_delivery_unavailable", "License email outbox entry is not available", 404);
      }
      if (row.status === "sent" || row.status === "delivered" || row.status === "bounced" || row.status === "failed") {
        await client.query("COMMIT");
        return;
      }
      await client.query(`
        UPDATE billing_email_outbox
        SET status='sent',
            next_attempt_at=$2,
            updated_at=$2
        WHERE outbox_id=$1
      `, [input.outboxId, postgresTimestamp(now)]);
      await client.query(`
        INSERT INTO billing_email_deliveries
          (delivery_id, outbox_id, provider, provider_message_id, status,
           error_code, error_message, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'sent', NULL, NULL, $5, $5)
      `, [
        randomUUID(),
        input.outboxId,
        safeLogText(input.provider) ?? "smtp",
        providerMessageId,
        postgresTimestamp(now),
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markLicenseEmailOutboxFailed(input: MarkLicenseEmailFailedInput): Promise<void> {
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const maxAttempts = boundedOutboxAttempts(input.maxAttempts);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ attempts: string | number; status: string }>(
        "SELECT attempts, status FROM billing_email_outbox WHERE outbox_id=$1 FOR UPDATE",
        [input.outboxId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ServiceError("license_email_delivery_unavailable", "License email outbox entry is not available", 404);
      }
      if (row.status === "sent" || row.status === "delivered" || row.status === "bounced" || row.status === "failed") {
        await client.query("COMMIT");
        return;
      }
      const attempts = integer(row.attempts);
      const finalFailure = attempts >= maxAttempts;
      const nextAttemptAt = finalFailure
        ? now
        : now + licenseEmailRetryDelaySeconds(attempts);
      const provider = safeLogText(input.provider) ?? "smtp";
      const errorCode = safeLogText(input.errorCode) ?? "license_email_send_failed";
      const errorMessage = safeLogText(input.errorMessage);
      await client.query(`
        UPDATE billing_email_outbox
        SET status=$2,
            next_attempt_at=$3,
            updated_at=$4
        WHERE outbox_id=$1
      `, [
        input.outboxId,
        finalFailure ? "failed" : "queued",
        postgresTimestamp(nextAttemptAt),
        postgresTimestamp(now),
      ]);
      await client.query(`
        INSERT INTO billing_email_deliveries
          (delivery_id, outbox_id, provider, provider_message_id, status,
           error_code, error_message, created_at, updated_at)
        VALUES ($1, $2, $3, NULL, 'failed', $4, $5, $6, $6)
      `, [
        randomUUID(),
        input.outboxId,
        provider,
        errorCode,
        errorMessage,
        postgresTimestamp(now),
      ]);
      if (finalFailure) {
        await queueLicenseEmailManualReview(client, {
          outboxId: input.outboxId,
          reason: "send_failed",
          provider,
          errorCode,
          errorMessage,
          now,
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markLicenseEmailDeliveryStatus(input: MarkLicenseEmailDeliveryStatusInput): Promise<MarkLicenseEmailDeliveryStatusResult> {
    const provider = safeRequiredLogText(input.provider, "Email provider");
    const providerMessageId = safeRequiredLogText(input.providerMessageId, "Provider message ID");
    const providerEventId = safeOptionalLogText(input.providerEventId, "Provider event ID");
    const status = licenseEmailDeliveryStatus(input.status);
    const errorCode = safeOptionalLogText(input.errorCode, "Email delivery error code");
    const errorMessage = safeOptionalLogText(input.errorMessage, "Email delivery error message");
    const now = Math.max(0, Math.floor(input.now ?? Date.now() / 1000));
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      if (providerEventId !== null) {
        const duplicate = await client.query<BillingEmailDeliveryStatusRow>(
          "SELECT outbox_id, status FROM billing_email_deliveries WHERE provider=$1 AND provider_event_id=$2 FOR UPDATE",
          [provider, providerEventId],
        );
        const duplicateRow = duplicate.rows[0];
        if (duplicateRow) {
          await client.query("COMMIT");
          return {
            outboxId: duplicateRow.outbox_id,
            status: duplicateRow.status,
          };
        }
      }

      const sent = await client.query<{ outbox_id: string }>(`
        SELECT eo.outbox_id
        FROM billing_email_deliveries d
        JOIN billing_email_outbox eo ON eo.outbox_id=d.outbox_id
        WHERE d.provider=$1
          AND d.provider_message_id=$2
        ORDER BY d.created_at DESC, d.delivery_id DESC
        LIMIT 1
        FOR UPDATE OF eo
      `, [provider, providerMessageId]);
      const outboxId = sent.rows[0]?.outbox_id;
      if (!outboxId) {
        throw new ServiceError("license_email_delivery_unavailable", "License email delivery is not available", 404);
      }

      const outboxStatus = status === "delivered" ? "delivered" : status;
      await client.query(`
        UPDATE billing_email_outbox
        SET status=CASE
              WHEN status IN ('bounced', 'failed') AND $2='delivered' THEN status
              ELSE $2
            END,
            next_attempt_at=$3,
            updated_at=$3
        WHERE outbox_id=$1
      `, [
        outboxId,
        outboxStatus,
        postgresTimestamp(now),
      ]);
      await client.query(`
        INSERT INTO billing_email_deliveries
          (delivery_id, outbox_id, provider, provider_message_id, provider_event_id,
           status, error_code, error_message, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      `, [
        randomUUID(),
        outboxId,
        provider,
        providerMessageId,
        providerEventId,
        status,
        errorCode,
        errorMessage,
        postgresTimestamp(now),
      ]);
      if (status === "bounced" || status === "failed") {
        await queueLicenseEmailManualReview(client, {
          outboxId,
          reason: status === "bounced" ? "bounced" : "delivery_failed",
          provider,
          providerMessageId,
          providerEventId,
          errorCode: errorCode ?? status,
          errorMessage,
          now,
        });
      }
      await client.query("COMMIT");
      return { outboxId, status };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPaymentLog(input: {
    rawBody: Buffer;
    receivedAt: number;
    outcome: PayNowPaymentLogOutcome;
    processingResult: string;
    httpStatus: number;
    verificationStatus: PayNowVerificationStatus;
    durationMilliseconds: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<PayNowPaymentLogRecord> {
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
    await this.#pool.query(`
      INSERT INTO billing_webhook_logs
        (log_id, provider, received_at, expires_at, outcome, processing_result, http_status,
         verification_status, duration_ms, payload_bytes, payload_sha256,
         event_id, event_type, store_id, product_id, checkout_id, subscription_id,
         customer_id, error_code, error_message)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    `, [
      record.logId,
      BILLING_PROVIDER,
      postgresTimestamp(record.receivedAt),
      postgresTimestamp(record.expiresAt),
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
    ]);
    return record;
  }

  async paymentLogs(options: { limit?: number; outcome?: PayNowPaymentLogOutcome; since?: number } = {}): Promise<PayNowPaymentLogRecord[]> {
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 100)));
    const clauses: string[] = ["provider=$1"];
    const parameters: Array<string | number | Date> = [BILLING_PROVIDER];
    if (options.outcome) {
      clauses.push(`outcome=$${parameters.length + 1}`);
      parameters.push(options.outcome);
    }
    if (options.since !== undefined) {
      clauses.push(`received_at>=$${parameters.length + 1}`);
      parameters.push(postgresTimestamp(Math.max(0, Math.floor(options.since)))!);
    }
    const result = await this.#pool.query<BillingWebhookLogRow>(`
      SELECT * FROM billing_webhook_logs
      WHERE ${clauses.join(" AND ")}
      ORDER BY received_at DESC, log_id DESC
      LIMIT ${limit}
    `, parameters);
    return result.rows.map(paymentLogRow);
  }

  async prunePaymentLogs(nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
    const result = await this.#pool.query(
      "DELETE FROM billing_webhook_logs WHERE provider=$1 AND expires_at<=$2",
      [BILLING_PROVIDER, postgresTimestamp(Math.max(0, Math.floor(nowSeconds)))],
    );
    return result.rowCount ?? 0;
  }
}
