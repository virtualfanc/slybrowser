import type { EmailAttachment, EmailTransport } from "./email.js";
import { PLAN_CATALOG } from "./plans.js";
import type { PlanId } from "./plans.js";

export interface LicenseEmailOutboxTask {
  outboxId: string;
  recipientEmail: string;
  payload: unknown;
}

export interface ClaimLicenseEmailOutboxOptions {
  limit?: number;
  now?: number;
  visibilityTimeoutSeconds?: number;
  maxAttempts?: number;
}

export interface MarkLicenseEmailSentInput {
  outboxId: string;
  provider: string;
  providerMessageId?: string;
  now?: number;
}

export interface MarkLicenseEmailFailedInput {
  outboxId: string;
  provider: string;
  errorCode: string;
  errorMessage: string;
  now?: number;
  maxAttempts?: number;
}

export type LicenseEmailDeliveryStatus = "delivered" | "bounced" | "failed";

export interface MarkLicenseEmailDeliveryStatusInput {
  provider: string;
  providerMessageId: string;
  status: LicenseEmailDeliveryStatus;
  providerEventId?: string;
  errorCode?: string;
  errorMessage?: string;
  now?: number;
}

export interface MarkLicenseEmailDeliveryStatusResult {
  outboxId: string;
  status: LicenseEmailDeliveryStatus;
}

export interface LicenseEmailOutboxStore {
  claimLicenseEmailOutbox(options?: ClaimLicenseEmailOutboxOptions): Promise<LicenseEmailOutboxTask[]>;
  markLicenseEmailOutboxSent(input: MarkLicenseEmailSentInput): Promise<void>;
  markLicenseEmailOutboxFailed(input: MarkLicenseEmailFailedInput): Promise<void>;
}

export interface LicenseEmailDeliveryStatusStore {
  markLicenseEmailDeliveryStatus(input: MarkLicenseEmailDeliveryStatusInput): Promise<MarkLicenseEmailDeliveryStatusResult>;
}

interface LicenseEmailPayload {
  schemaVersion: 1;
  kind: "first-license-file" | "renewed-license-file" | "replacement-license-file";
  plan: Exclude<PlanId, "free">;
  planName?: string;
  concurrency?: number;
  issuedAt?: number;
  paidThrough: number;
  publicOrderId?: string;
  customerAccessToken?: string;
  licenseFileName?: string;
  licenseFile: unknown;
}

export type BillingNoticeEmailKind =
  | "renewal-receipt"
  | "payment-retry"
  | "grace-period"
  | "subscription-canceled"
  | "refund-receipt"
  | "chargeback-hold"
  | "account-restored";

interface BillingNoticeEmailPayload {
  schemaVersion: 1;
  kind: BillingNoticeEmailKind;
  plan: Exclude<PlanId, "free">;
  planName?: string;
  concurrency?: number;
  publicOrderId?: string;
  publicSubscriptionId?: string;
  paidThrough?: number;
  amount?: number;
  currency?: string;
  occurredAt?: number;
  nextAttemptAt?: number;
  reason?: string;
}

type QueuedEmailPayload = LicenseEmailPayload | BillingNoticeEmailPayload;

export interface SendQueuedLicenseEmailOptions {
  limit?: number;
  now?: number;
  visibilityTimeoutSeconds?: number;
  maxAttempts?: number;
  supportEmail?: string;
  customerPortalUrl?: string;
}

export interface SendQueuedLicenseEmailResult {
  claimed: number;
  sent: number;
  failed: number;
}

function epochDate(seconds: number): string {
  return new Date(Math.max(0, Math.floor(seconds)) * 1000).toISOString().slice(0, 10);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\u0000-\u001f\u007f]/g, " ");
  const containsSensitiveEmailMaterial =
    /Your SlyBrowser license file is attached/i.test(normalized) ||
    /Customer access token:/i.test(normalized) ||
    /\bslybrowser-license\b/i.test(normalized) ||
    /\blicenseFile\b/i.test(normalized) ||
    /\blicenseKey\b/i.test(normalized) ||
    /\bcst_[A-Za-z0-9_-]{16,}\b/.test(normalized) ||
    /\bsly_(?:live|test|dev)_[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{16,}\b/.test(normalized);
  if (containsSensitiveEmailMaterial) {
    return "email transport failed (sensitive content redacted)";
  }
  return normalized
    .replace(/\bcst_[A-Za-z0-9_-]{16,}\b/g, "cst_[redacted]")
    .replace(/\bsly_(?:live|test|dev)_[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{16,}\b/g, "sly_[redacted_license_key]")
    .replace(/("customerAccessToken"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("licenseKey"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("ciphertext"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .replace(/("tag"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2")
    .slice(0, 512);
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("License email payload must be an object");
  }
  return value as Record<string, unknown>;
}

function isLicenseFileKind(value: unknown): value is LicenseEmailPayload["kind"] {
  return value === "first-license-file" || value === "renewed-license-file" || value === "replacement-license-file";
}

function isBillingNoticeKind(value: unknown): value is BillingNoticeEmailKind {
  return value === "renewal-receipt" ||
    value === "payment-retry" ||
    value === "grace-period" ||
    value === "subscription-canceled" ||
    value === "refund-receipt" ||
    value === "chargeback-hold" ||
    value === "account-restored";
}

function optionalPublicId(value: unknown, prefix: string): string | undefined {
  return typeof value === "string" && value.startsWith(prefix) && value.length <= 160 ? value : undefined;
}

function optionalEpoch(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000 ? value : undefined;
}

function optionalCurrency(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : undefined;
}

function optionalReason(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function normalizePlanFields(payload: Record<string, unknown>): {
  plan: Exclude<PlanId, "free">;
  planName?: string;
  concurrency: number;
} {
  if (payload.plan !== "launch" && payload.plan !== "studio" && payload.plan !== "fleet" && payload.plan !== "grid") {
    throw new Error("License email plan is invalid");
  }
  const planName = typeof payload.planName === "string" && payload.planName.length <= 64
    ? payload.planName
    : undefined;
  const concurrency = typeof payload.concurrency === "number" &&
      Number.isSafeInteger(payload.concurrency) &&
      payload.concurrency > 0 &&
      payload.concurrency <= 10_000
    ? payload.concurrency
    : PLAN_CATALOG[payload.plan].concurrency;
  return {
    plan: payload.plan,
    concurrency,
    ...(planName === undefined ? {} : { planName }),
  };
}

function normalizePayload(value: unknown): QueuedEmailPayload {
  const payload = payloadObject(value);
  if (payload.schemaVersion !== 1) throw new Error("License email payload version is unsupported");
  if (!isLicenseFileKind(payload.kind) && !isBillingNoticeKind(payload.kind)) {
    throw new Error("License email kind is unsupported");
  }
  const planFields = normalizePlanFields(payload);
  if (isBillingNoticeKind(payload.kind)) {
    if ("licenseFile" in payload) {
      throw new Error("Billing notice email payload must not contain a license file");
    }
    const publicOrderId = optionalPublicId(payload.publicOrderId, "spo_");
    const publicSubscriptionId = optionalPublicId(payload.publicSubscriptionId, "sps_");
    const paidThrough = optionalEpoch(payload.paidThrough);
    const amount = optionalAmount(payload.amount);
    const currency = optionalCurrency(payload.currency);
    const occurredAt = optionalEpoch(payload.occurredAt);
    const nextAttemptAt = optionalEpoch(payload.nextAttemptAt);
    const reason = optionalReason(payload.reason);
    return {
      schemaVersion: 1,
      kind: payload.kind,
      ...planFields,
      ...(publicOrderId === undefined ? {} : { publicOrderId }),
      ...(publicSubscriptionId === undefined ? {} : { publicSubscriptionId }),
      ...(paidThrough === undefined ? {} : { paidThrough }),
      ...(amount === undefined ? {} : { amount }),
      ...(currency === undefined ? {} : { currency }),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
  if (typeof payload.paidThrough !== "number" || !Number.isSafeInteger(payload.paidThrough) || payload.paidThrough <= 0) {
    throw new Error("License email paid-through timestamp is invalid");
  }
  if (!("licenseFile" in payload)) {
    throw new Error("License email payload does not contain a license file");
  }
  const publicOrderId = optionalPublicId(payload.publicOrderId, "spo_");
  const customerAccessToken = typeof payload.customerAccessToken === "string" && /^cst_[A-Za-z0-9_-]{32,160}$/.test(payload.customerAccessToken)
    ? payload.customerAccessToken
    : undefined;
  const issuedAt = typeof payload.issuedAt === "number" &&
      Number.isSafeInteger(payload.issuedAt) &&
      payload.issuedAt > 0
    ? payload.issuedAt
    : undefined;
  const licenseFileName = typeof payload.licenseFileName === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(payload.licenseFileName)
    ? payload.licenseFileName
    : undefined;
  return {
    schemaVersion: 1,
    kind: payload.kind,
    ...planFields,
    paidThrough: payload.paidThrough,
    licenseFile: payload.licenseFile,
    ...(issuedAt === undefined ? {} : { issuedAt }),
    ...(publicOrderId === undefined ? {} : { publicOrderId }),
    ...(customerAccessToken === undefined ? {} : { customerAccessToken }),
    ...(licenseFileName === undefined ? {} : { licenseFileName }),
  };
}

function licenseAttachment(payload: LicenseEmailPayload): EmailAttachment {
  const filename = payload.licenseFileName ?? "slybrowser-license.json";
  const content = typeof payload.licenseFile === "string"
    ? payload.licenseFile
    : `${JSON.stringify(payload.licenseFile, null, 2)}\n`;
  return {
    filename,
    contentType: "application/json",
    content,
  };
}

function licenseEmailText(payload: LicenseEmailPayload, supportEmail: string, customerPortalUrl?: string): string {
  return [
    "Your SlyBrowser license file is attached.",
    "",
    `Plan: ${payload.planName ?? payload.plan}`,
    `Concurrency: ${payload.concurrency}`,
    ...(payload.issuedAt === undefined ? [] : [`Activated: ${epochDate(payload.issuedAt)}`]),
    `Paid through: ${epochDate(payload.paidThrough)}`,
    ...(payload.publicOrderId === undefined ? [] : [`Order: ${payload.publicOrderId}`]),
    ...(payload.customerAccessToken === undefined ? [] : [`Customer access token: ${payload.customerAccessToken}`]),
    ...(payload.publicOrderId === undefined || payload.customerAccessToken === undefined
      ? []
      : [
          `Customer order page: ${customerPortalUrl ?? "/billing/order"}`,
          "Use the order ID and customer access token above to check status or request a license-file resend.",
        ]),
    "Automatic renewal: handled by the PayNow subscription until the customer cancels it.",
    "Cancellation: access remains active until the paid-through date above.",
    "",
    "Keep this file private. The file is encrypted and signed for your entitlement, and it should not be posted in public repositories or support tickets.",
    `If you need help, contact ${supportEmail}.`,
    "",
    "SlyBrowser",
  ].join("\n");
}

function amountText(payload: BillingNoticeEmailPayload): string | undefined {
  if (payload.amount === undefined || payload.currency === undefined) return undefined;
  return `${payload.currency} ${(payload.amount / 100).toFixed(2)}`;
}

function billingNoticeSubject(payload: BillingNoticeEmailPayload): string {
  switch (payload.kind) {
    case "renewal-receipt":
      return "Your SlyBrowser subscription renewed";
    case "payment-retry":
      return "Action needed: SlyBrowser payment retry";
    case "grace-period":
      return "Your SlyBrowser subscription is in grace period";
    case "subscription-canceled":
      return "SlyBrowser automatic renewal canceled";
    case "refund-receipt":
      return "Your SlyBrowser refund was recorded";
    case "chargeback-hold":
      return "SlyBrowser license temporarily on hold";
    case "account-restored":
      return "SlyBrowser license restored";
  }
}

function billingNoticeIntro(payload: BillingNoticeEmailPayload): string {
  switch (payload.kind) {
    case "renewal-receipt":
      return "Your SlyBrowser subscription renewed successfully.";
    case "payment-retry":
      return "We could not confirm your latest SlyBrowser renewal payment.";
    case "grace-period":
      return "Your SlyBrowser subscription is in its configured grace period.";
    case "subscription-canceled":
      return "Automatic renewal for your SlyBrowser subscription has been canceled.";
    case "refund-receipt":
      return "A SlyBrowser refund has been recorded for your order.";
    case "chargeback-hold":
      return "Your SlyBrowser license has been temporarily placed on hold because of a payment dispute.";
    case "account-restored":
      return "Your SlyBrowser license has been restored.";
  }
}

function billingNoticeAction(payload: BillingNoticeEmailPayload): string {
  switch (payload.kind) {
    case "renewal-receipt":
      return "No action is needed. Your existing encrypted license file remains valid.";
    case "payment-retry":
      return "Please check the payment method in PayNow or contact support if the payment should have succeeded.";
    case "grace-period":
      return "Please resolve the payment issue before the grace period ends to avoid interruption.";
    case "subscription-canceled":
      return "You can continue using the paid plan until the paid-through date. This cancellation does not create a refund by itself.";
    case "refund-receipt":
      return "A completed full refund immediately ends the paid entitlement for that order. Free-plan access remains available.";
    case "chargeback-hold":
      return "Please contact support if this dispute was opened by mistake. New runtime leases remain blocked while the hold is active.";
    case "account-restored":
      return "No action is needed. You may start SlyBrowser again and it will re-check your entitlement online.";
  }
}

function billingNoticeEmailText(payload: BillingNoticeEmailPayload, supportEmail: string, customerPortalUrl?: string): string {
  const amount = amountText(payload);
  return [
    billingNoticeIntro(payload),
    "",
    `Plan: ${payload.planName ?? payload.plan}`,
    `Concurrency: ${payload.concurrency}`,
    ...(payload.publicOrderId === undefined ? [] : [`Order: ${payload.publicOrderId}`]),
    ...(payload.publicSubscriptionId === undefined ? [] : [`Subscription: ${payload.publicSubscriptionId}`]),
    ...(amount === undefined ? [] : [`Amount: ${amount}`]),
    ...(payload.occurredAt === undefined ? [] : [`Event date: ${epochDate(payload.occurredAt)}`]),
    ...(payload.paidThrough === undefined ? [] : [`Paid through: ${epochDate(payload.paidThrough)}`]),
    ...(payload.nextAttemptAt === undefined ? [] : [`Next payment attempt: ${epochDate(payload.nextAttemptAt)}`]),
    ...(payload.reason === undefined ? [] : [`Reason: ${payload.reason}`]),
    ...(payload.publicOrderId === undefined
      ? []
      : [
          `Customer order page: ${customerPortalUrl ?? "/billing/order"}`,
          "Use the customer access token from your original license email to check status or request a license-file resend.",
        ]),
    "",
    billingNoticeAction(payload),
    `If you need help, contact ${supportEmail}.`,
    "",
    "SlyBrowser",
  ].join("\n");
}

function queuedEmailMessage(payload: QueuedEmailPayload, supportEmail: string, customerPortalUrl?: string): {
  subject: string;
  text: string;
  attachments?: EmailAttachment[];
} {
  if ("licenseFile" in payload) {
    return {
      subject: payload.kind === "replacement-license-file"
        ? "Your replacement SlyBrowser license file"
        : "Your SlyBrowser license file",
      text: licenseEmailText(payload, supportEmail, customerPortalUrl),
      attachments: [licenseAttachment(payload)],
    };
  }
  return {
    subject: billingNoticeSubject(payload),
    text: billingNoticeEmailText(payload, supportEmail, customerPortalUrl),
  };
}

export async function sendQueuedLicenseEmails(
  store: LicenseEmailOutboxStore,
  transport: EmailTransport,
  options: SendQueuedLicenseEmailOptions = {},
): Promise<SendQueuedLicenseEmailResult> {
  const tasks = await store.claimLicenseEmailOutbox({
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.visibilityTimeoutSeconds === undefined ? {} : { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  let sent = 0;
  let failed = 0;
  const supportEmail = options.supportEmail ?? "support@slybrowser.com";
  const customerPortalUrl = options.customerPortalUrl;
  for (const task of tasks) {
    try {
      const payload = normalizePayload(task.payload);
      const message = queuedEmailMessage(payload, supportEmail, customerPortalUrl);
      const result = await transport.send({
        to: task.recipientEmail,
        subject: message.subject,
        text: message.text,
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
      });
      await store.markLicenseEmailOutboxSent({
        outboxId: task.outboxId,
        provider: transport.provider,
        ...(result.providerMessageId === undefined ? {} : { providerMessageId: result.providerMessageId }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      sent += 1;
    } catch (error) {
      await store.markLicenseEmailOutboxFailed({
        outboxId: task.outboxId,
        provider: transport.provider,
        errorCode: "license_email_send_failed",
        errorMessage: safeErrorMessage(error),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      });
      failed += 1;
    }
  }
  return { claimed: tasks.length, sent, failed };
}
