import { ServiceError } from "./errors.js";
import type {
  Awaitable,
  PayNowFirstPaymentRecorder,
  PayNowFirstPaymentVerifier,
  PayNowPaymentCompletedEvent,
} from "./paynow.js";

export type PayNowReconciledSubscriptionStatus = "invalid" | "created" | "active" | "canceled";

export interface PayNowReconciliationListOptions {
  limit?: number;
  after?: string;
  before?: string;
  asc?: boolean;
}

export interface PayNowReconciledSubscriptionEvidence {
  payNowSubscriptionId: string;
  payNowCustomerId: string;
  storeId: string;
  productId: string;
  status: PayNowReconciledSubscriptionStatus;
  currentPeriodStart?: number | null;
  currentPeriodEnd?: number | null;
  nextAttemptAt?: number | null;
  attemptCount?: number | null;
  observedAt: number;
}

export type PayNowSubscriptionReconciliationResult = "updated" | "unchanged" | "missing";

export interface PayNowReconciliationEvidenceClient extends PayNowFirstPaymentVerifier {
  listCompletedPayments(options?: PayNowReconciliationListOptions): Awaitable<PayNowPaymentCompletedEvent[]>;
  listSubscriptions(options?: PayNowReconciliationListOptions & {
    status?: PayNowReconciledSubscriptionStatus;
  }): Awaitable<PayNowReconciledSubscriptionEvidence[]>;
}

export interface PayNowReconciliationStore extends PayNowFirstPaymentRecorder {
  reconcilePayNowSubscription(input: PayNowReconciledSubscriptionEvidence): Awaitable<PayNowSubscriptionReconciliationResult>;
}

export interface ReconcilePayNowBillingOptions {
  now?: number;
  paymentLimit?: number;
  paymentAfter?: string;
  paymentBefore?: string;
  subscriptionLimit?: number;
  subscriptionAfter?: string;
  subscriptionBefore?: string;
  subscriptionStatus?: PayNowReconciledSubscriptionStatus;
  asc?: boolean;
  strict?: boolean;
}

export interface ReconcilePayNowBillingResult {
  paymentsScanned: number;
  paymentsProcessed: number;
  paymentDuplicates: number;
  paymentsSkipped: number;
  paymentFailures: number;
  subscriptionsScanned: number;
  subscriptionsUpdated: number;
  subscriptionsUnchanged: number;
  subscriptionsMissing: number;
  subscriptionFailures: number;
}

function boundedLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) {
    throw new ServiceError("invalid_request", `${name} must be between 1 and 250`, 400);
  }
  return limit;
}

function normalizedNow(value: number | undefined): number {
  const now = Math.max(0, Math.floor(value ?? Date.now() / 1000));
  if (!Number.isSafeInteger(now)) {
    throw new ServiceError("invalid_request", "Reconciliation time is invalid", 400);
  }
  return now;
}

async function reconcilePayment(
  store: PayNowReconciliationStore,
  client: PayNowReconciliationEvidenceClient,
  payment: PayNowPaymentCompletedEvent,
  now: number,
): Promise<"processed" | "duplicate" | "skipped"> {
  const firstPayment = await client.verifyFirstPayment(payment);
  if (firstPayment) {
    const recorded = await store.recordVerifiedFirstPayment({
      ...firstPayment,
      now,
    });
    return recorded.status === "duplicate" ? "duplicate" : "processed";
  }

  if (!client.verifyRenewalPayment || !store.recordVerifiedRenewalPayment) {
    return "skipped";
  }

  const renewalPayment = await client.verifyRenewalPayment(payment);
  if (!renewalPayment) return "skipped";
  const recorded = await store.recordVerifiedRenewalPayment({
    ...renewalPayment,
    now,
  });
  return recorded.status === "duplicate" ? "duplicate" : "processed";
}

export async function reconcilePayNowBilling(
  store: PayNowReconciliationStore,
  client: PayNowReconciliationEvidenceClient,
  options: ReconcilePayNowBillingOptions = {},
): Promise<ReconcilePayNowBillingResult> {
  const now = normalizedNow(options.now);
  const paymentLimit = boundedLimit(options.paymentLimit, 100, "paymentLimit");
  const subscriptionLimit = boundedLimit(options.subscriptionLimit, 100, "subscriptionLimit");
  const paymentListOptions: PayNowReconciliationListOptions = { limit: paymentLimit };
  if (options.paymentAfter !== undefined) paymentListOptions.after = options.paymentAfter;
  if (options.paymentBefore !== undefined) paymentListOptions.before = options.paymentBefore;
  if (options.asc !== undefined) paymentListOptions.asc = options.asc;
  const subscriptionListOptions: PayNowReconciliationListOptions & { status?: PayNowReconciledSubscriptionStatus } = {
    limit: subscriptionLimit,
  };
  if (options.subscriptionAfter !== undefined) subscriptionListOptions.after = options.subscriptionAfter;
  if (options.subscriptionBefore !== undefined) subscriptionListOptions.before = options.subscriptionBefore;
  if (options.asc !== undefined) subscriptionListOptions.asc = options.asc;
  if (options.subscriptionStatus !== undefined) subscriptionListOptions.status = options.subscriptionStatus;
  const result: ReconcilePayNowBillingResult = {
    paymentsScanned: 0,
    paymentsProcessed: 0,
    paymentDuplicates: 0,
    paymentsSkipped: 0,
    paymentFailures: 0,
    subscriptionsScanned: 0,
    subscriptionsUpdated: 0,
    subscriptionsUnchanged: 0,
    subscriptionsMissing: 0,
    subscriptionFailures: 0,
  };

  const [payments, subscriptions] = await Promise.all([
    client.listCompletedPayments(paymentListOptions),
    client.listSubscriptions(subscriptionListOptions),
  ]);

  result.paymentsScanned = payments.length;
  for (const payment of payments) {
    try {
      const status = await reconcilePayment(store, client, payment, now);
      if (status === "processed") result.paymentsProcessed += 1;
      if (status === "duplicate") result.paymentDuplicates += 1;
      if (status === "skipped") result.paymentsSkipped += 1;
    } catch (error) {
      result.paymentFailures += 1;
      if (options.strict) throw error;
    }
  }

  result.subscriptionsScanned = subscriptions.length;
  for (const subscription of subscriptions) {
    try {
      const status = await store.reconcilePayNowSubscription({
        ...subscription,
        observedAt: now,
      });
      if (status === "updated") result.subscriptionsUpdated += 1;
      if (status === "unchanged") result.subscriptionsUnchanged += 1;
      if (status === "missing") result.subscriptionsMissing += 1;
    } catch (error) {
      result.subscriptionFailures += 1;
      if (options.strict) throw error;
    }
  }

  return result;
}
