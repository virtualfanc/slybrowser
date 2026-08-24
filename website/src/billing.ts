import type { BillingCycle, PaidPlanId } from "./siteData";

type CheckoutMatrix = Record<PaidPlanId, Record<BillingCycle, string | undefined>>;

function validHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const checkoutUrls: CheckoutMatrix = {
  launch: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_LAUNCH_MONTHLY_URL),
  },
  studio: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_STUDIO_MONTHLY_URL),
  },
  fleet: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_FLEET_MONTHLY_URL),
  },
  grid: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_GRID_MONTHLY_URL),
  },
};

const slyApiOrigin = validHttpsUrl(import.meta.env.VITE_SLY_API_ORIGIN);

export function billingApiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("Billing API path must start with /.");
  }
  if (!slyApiOrigin) return path;
  return new URL(path, slyApiOrigin).toString();
}

export function billingApiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(billingApiUrl(path), init);
}

export const paidPreviewUrl = validHttpsUrl(import.meta.env.VITE_PAID_PREVIEW_URL)
  ?? "https://github.com/virtualfanc/slybrowser";

export const manageSubscriptionsUrl = validHttpsUrl(import.meta.env.VITE_PAYNOW_SUBSCRIPTIONS_URL)
  ?? "https://checkout.paynow.gg/subscriptions";

const billingQaEnabled = !import.meta.env.PROD && import.meta.env.VITE_ENABLE_BILLING_QA === "true";
export const recurringTestCheckoutUrl = billingQaEnabled
  ? validHttpsUrl(import.meta.env.VITE_PAYNOW_RECURRING_TEST_URL)
  : undefined;
export const recurringTestPrice = /^\$\d+(?:\.\d{2})? \/ month$/.test(import.meta.env.VITE_PAYNOW_RECURRING_TEST_PRICE ?? "")
  ? import.meta.env.VITE_PAYNOW_RECURRING_TEST_PRICE
  : "$0.10 / month";
export const recurringTestCoupon = /^[A-Z0-9_-]{3,32}$/.test(import.meta.env.VITE_PAYNOW_RECURRING_TEST_COUPON ?? "")
  ? import.meta.env.VITE_PAYNOW_RECURRING_TEST_COUPON
  : undefined;

export function getCheckoutUrl(plan: PaidPlanId, cycle: BillingCycle): string | undefined {
  return checkoutUrls[plan][cycle];
}

function getPayNowSubscriptionAction(productUrl: string | undefined): string | undefined {
  if (!productUrl) return undefined;

  const url = new URL(productUrl);
  if (!url.hostname.endsWith(".paynow.store") || !/^\/products\/[^/]+\/?$/.test(url.pathname)) {
    return undefined;
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/checkout`;
  url.searchParams.set("subscription", "true");
  return url.toString();
}

export function getSubscriptionCheckoutAction(plan: PaidPlanId, cycle: BillingCycle): string | undefined {
  return getPayNowSubscriptionAction(getCheckoutUrl(plan, cycle));
}

export const recurringTestCheckoutAction = getPayNowSubscriptionAction(recurringTestCheckoutUrl);

export const hasConfiguredCheckout = Object.values(checkoutUrls)
  .some((cycles) => Object.values(cycles).some(Boolean));

export interface CustomerBillingStatusPayload {
  schemaVersion: 1;
  publicOrderId: string;
  publicSubscriptionId?: string;
  plan: PaidPlanId;
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

export interface CustomerLicenseResendPayload {
  schemaVersion: 1;
  status: "queued" | "duplicate";
  publicOrderId: string;
  outboxId: string;
  nextAttemptAt: number;
}

export interface CustomerSubscriptionCancellationPayload {
  schemaVersion: 1;
  status: "cancel_at_period_end" | "already_canceled";
  publicOrderId: string;
  publicSubscriptionId?: string;
  paidThrough: number;
  cancelAtPeriodEnd: true;
}

export type AdminRefundStatus = "requested" | "processing" | "completed" | "failed";

export interface AdminOrderSummaryPayload {
  publicOrderId: string;
  payNowOrderId?: string | null;
  plan: PaidPlanId;
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

export interface AdminOrdersPayload {
  schemaVersion: 1;
  orders: AdminOrderSummaryPayload[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AdminOrderRefundPayload {
  schemaVersion: 1;
  refundId: string;
  publicOrderId: string;
  payNowOrderId?: string;
  payNowPaymentId?: string;
  payNowRefundId?: string;
  status: AdminRefundStatus;
  amount: number;
  currency: string;
}

export function billingApiError(payload: unknown, fallback: string, response?: Response): Error {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return new Error(payload.error.message);
  }
  return new Error(response && response.status >= 400 ? `${fallback} (HTTP ${response.status})` : fallback);
}

function bearerHeaders(adminToken: string, actor: string | undefined): HeadersInit {
  return {
    authorization: `Bearer ${adminToken.trim()}`,
    ...(actor?.trim() ? { "x-sly-admin-actor": actor.trim() } : {}),
  };
}

function idempotencyKey(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isCustomerOrderId(value: string): boolean {
  return /^spo_[A-Za-z0-9_-]{16,128}$/.test(value.trim());
}

export function isCustomerAccessToken(value: string): boolean {
  return /^cst_[A-Za-z0-9_-]{32,160}$/.test(value.trim());
}

export async function fetchCustomerBillingStatus(
  publicOrderId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<CustomerBillingStatusPayload> {
  const response = await billingApiFetch(`/v1/billing/orders/${encodeURIComponent(publicOrderId.trim())}/status`, {
    cache: "no-store",
    headers: { "x-sly-customer-access-token": accessToken.trim() },
    signal,
  });
  const payload = await response.json().catch(() => ({})) as CustomerBillingStatusPayload | { error?: { message?: string } };
  if (!response.ok) {
    throw billingApiError(payload, "Customer billing status is not available.", response);
  }
  return payload as CustomerBillingStatusPayload;
}

export async function requestCustomerLicenseResend(
  publicOrderId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<CustomerLicenseResendPayload> {
  const response = await billingApiFetch(`/v1/billing/orders/${encodeURIComponent(publicOrderId.trim())}/license-resend`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: accessToken.trim() }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as CustomerLicenseResendPayload | { error?: { message?: string } };
  if (!response.ok) {
    throw billingApiError(payload, "License file resend is not available.", response);
  }
  return payload as CustomerLicenseResendPayload;
}

export async function requestCustomerSubscriptionCancel(
  publicOrderId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<CustomerSubscriptionCancellationPayload> {
  const response = await billingApiFetch(`/v1/billing/orders/${encodeURIComponent(publicOrderId.trim())}/cancel-subscription`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: accessToken.trim() }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as CustomerSubscriptionCancellationPayload | { error?: { message?: string } };
  if (!response.ok) {
    throw billingApiError(payload, "Subscription cancellation is not available.", response);
  }
  return payload as CustomerSubscriptionCancellationPayload;
}

export function isAdminBearerToken(value: string): boolean {
  const token = value.trim();
  return token.length >= 16 && token.length <= 512 && !/[\u0000-\u001f\u007f\s]/.test(token);
}

export function isAdminActor(value: string): boolean {
  const actor = value.trim();
  return actor === "" || (actor.length >= 3 && actor.length <= 160 && !/[\u0000-\u001f\u007f]/.test(actor));
}

export async function fetchAdminOrders(
  adminToken: string,
  actor: string | undefined,
  input: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<AdminOrdersPayload> {
  const params = new URLSearchParams({
    limit: String(input.limit),
    offset: String(input.offset),
  });
  const response = await billingApiFetch(`/v1/admin/orders?${params.toString()}`, {
    cache: "no-store",
    headers: bearerHeaders(adminToken, actor),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as AdminOrdersPayload | { error?: { message?: string } };
  if (!response.ok) {
    throw billingApiError(payload, "Admin order list is not available.", response);
  }
  return payload as AdminOrdersPayload;
}

export async function requestAdminOrderRefund(
  adminToken: string,
  actor: string | undefined,
  publicOrderId: string,
  reason: string,
  signal?: AbortSignal,
): Promise<AdminOrderRefundPayload> {
  const idempotency = idempotencyKey(`refund-${publicOrderId.trim()}`);
  const response = await billingApiFetch(`/v1/admin/orders/${encodeURIComponent(publicOrderId.trim())}/refunds`, {
    method: "POST",
    cache: "no-store",
    headers: {
      ...bearerHeaders(adminToken, actor),
      "content-type": "application/json",
      "idempotency-key": idempotency,
    },
    body: JSON.stringify({ reason: reason.trim(), idempotency_key: idempotency }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as AdminOrderRefundPayload | { error?: { message?: string } };
  if (!response.ok) {
    throw billingApiError(payload, "Manual refund could not be submitted.", response);
  }
  return payload as AdminOrderRefundPayload;
}
