import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../src/errors.js";
import { PayNowManagementClient } from "../src/paynow-management.js";
import {
  reconcilePayNowBilling,
  type PayNowReconciledSubscriptionEvidence,
  type PayNowReconciliationEvidenceClient,
  type PayNowReconciliationStore,
} from "../src/paynow-reconciliation.js";
import type {
  PayNowPaymentCompletedEvent,
  PayNowVerifiedFirstPayment,
  PayNowVerifiedRenewalPayment,
} from "../src/paynow.js";

const firstPaymentEvent: PayNowPaymentCompletedEvent = {
  paymentId: "700000000000000101",
  storeId: "591304127884034048",
  orderId: "700000000000000201",
  amount: 1900,
  currency: "USD",
  completedAt: 2_000_000_100,
};

const renewalPaymentEvent: PayNowPaymentCompletedEvent = {
  paymentId: "700000000000000102",
  storeId: "591304127884034048",
  orderId: "700000000000000202",
  amount: 1900,
  currency: "USD",
  completedAt: 2_000_100_100,
};

const unmatchedPaymentEvent: PayNowPaymentCompletedEvent = {
  paymentId: "700000000000000103",
  storeId: "591304127884034048",
  orderId: "700000000000000203",
  amount: 1900,
  currency: "USD",
  completedAt: 2_000_200_100,
};

function verifiedFirst(payment: PayNowPaymentCompletedEvent): PayNowVerifiedFirstPayment {
  return {
    checkoutIntentId: "ci_reconcile_first_payment_0001",
    payNowCheckoutId: "700000000000000301",
    payNowOrderId: payment.orderId,
    payNowPaymentId: payment.paymentId,
    payNowSubscriptionId: "700000000000000401",
    payNowCustomerId: "700000000000000501",
    amount: payment.amount,
    currency: payment.currency,
    currentPeriodStart: 2_000_000_000,
    currentPeriodEnd: 2_002_592_000,
  };
}

function verifiedRenewal(payment: PayNowPaymentCompletedEvent): PayNowVerifiedRenewalPayment {
  return {
    checkoutIntentId: "ci_reconcile_first_payment_0001",
    payNowCheckoutId: "700000000000000301",
    payNowOrderId: payment.orderId,
    payNowPaymentId: payment.paymentId,
    payNowSubscriptionId: "700000000000000401",
    payNowCustomerId: "700000000000000501",
    amount: payment.amount,
    currency: payment.currency,
    currentPeriodStart: 2_002_592_000,
    currentPeriodEnd: 2_005_184_000,
  };
}

function subscription(status: PayNowReconciledSubscriptionEvidence["status"]): PayNowReconciledSubscriptionEvidence {
  return {
    payNowSubscriptionId: "700000000000000401",
    payNowCustomerId: "700000000000000501",
    storeId: "591304127884034048",
    productId: "592701767033036800",
    status,
    currentPeriodStart: 2_002_592_000,
    currentPeriodEnd: 2_005_184_000,
    nextAttemptAt: null,
    attemptCount: 0,
    observedAt: 2_000_000_000,
  };
}

describe("PayNow reconciliation worker", () => {
  it("loads reconciliation evidence from PayNow Management list APIs", async () => {
    const calls: string[] = [];
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId: "591304127884034048",
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).includes("/payments?")) {
          return new Response(JSON.stringify([{
            id: firstPaymentEvent.paymentId,
            store_id: firstPaymentEvent.storeId,
            order_id: firstPaymentEvent.orderId,
            customer_id: "700000000000000501",
            status: "completed",
            currency: "USD",
            amount: firstPaymentEvent.amount,
            completed_at: "2033-05-18T03:33:20Z",
          }, {
            id: unmatchedPaymentEvent.paymentId,
            store_id: unmatchedPaymentEvent.storeId,
            order_id: unmatchedPaymentEvent.orderId,
            customer_id: "700000000000000502",
            status: "pending",
            currency: "USD",
            amount: unmatchedPaymentEvent.amount,
            completed_at: null,
          }]), { status: 200 });
        }
        if (String(url).includes("/subscriptions?")) {
          return new Response(JSON.stringify([{
            id: "700000000000000401",
            store_id: "591304127884034048",
            customer: { id: "700000000000000501" },
            product_id: "592701767033036800",
            status: "active",
            current_period_start: "2033-05-18T03:33:20Z",
            current_period_end: "2033-06-17T03:33:20Z",
            next_attempt_at: "2033-05-19T03:33:20Z",
            attempt_count: 1,
          }, {
            id: "700000000000000402",
            store_id: "591304127884034048",
            customer: { id: "700000000000000502" },
            product_id: "592719053055860736",
            status: "active",
            current_period_start: "2033-05-18T03:33:20Z",
            current_period_end: "2033-06-17T03:33:20Z",
            next_attempt_at: null,
            attempt_count: 0,
          }]), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    });

    await expect(client.listCompletedPayments({
      limit: 2,
      after: "700000000000000001",
      asc: false,
    })).resolves.toEqual([{
      ...firstPaymentEvent,
      completedAt: 2_000_000_000,
    }]);
    await expect(client.listSubscriptions({
      limit: 2,
      status: "active",
    })).resolves.toMatchObject([{
      payNowSubscriptionId: "700000000000000401",
      payNowCustomerId: "700000000000000501",
      productId: "592701767033036800",
      status: "active",
      currentPeriodStart: 2_000_000_000,
      currentPeriodEnd: 2_002_592_000,
      nextAttemptAt: 2_000_086_400,
      attemptCount: 1,
    }]);
    expect(calls[0]).toContain("/v1/stores/591304127884034048/payments?limit=2&after=700000000000000001&asc=false&status=completed");
    expect(calls[1]).toContain("/v1/stores/591304127884034048/subscriptions?limit=2&status=active");
  });

  it("records verified first and renewal payments and reconciles subscriptions", async () => {
    const client: PayNowReconciliationEvidenceClient = {
      listCompletedPayments: vi.fn(async () => [firstPaymentEvent, renewalPaymentEvent, unmatchedPaymentEvent]),
      listSubscriptions: vi.fn(async () => [subscription("active"), subscription("canceled"), {
        ...subscription("active"),
        payNowSubscriptionId: "700000000000000499",
      }]),
      verifyFirstPayment: vi.fn(async (payment) => payment.paymentId === firstPaymentEvent.paymentId
        ? verifiedFirst(payment)
        : undefined),
      verifyRenewalPayment: vi.fn(async (payment) => payment.paymentId === renewalPaymentEvent.paymentId
        ? verifiedRenewal(payment)
        : undefined),
    };
    const store: PayNowReconciliationStore = {
      recordVerifiedFirstPayment: vi.fn(async (input) => {
        expect(input.sourceEventId).toBeUndefined();
        return { status: "processed" };
      }),
      recordVerifiedRenewalPayment: vi.fn(async (input) => {
        expect(input.sourceEventId).toBeUndefined();
        return { status: "duplicate" };
      }),
      reconcilePayNowSubscription: vi.fn(async (input) => (
        input.payNowSubscriptionId.endsWith("499") ? "missing" : input.status === "canceled" ? "updated" : "unchanged"
      )),
    };

    await expect(reconcilePayNowBilling(store, client, {
      now: 2_000_000_333,
      paymentLimit: 10,
      subscriptionLimit: 10,
    })).resolves.toEqual({
      paymentsScanned: 3,
      paymentsProcessed: 1,
      paymentDuplicates: 1,
      paymentsSkipped: 1,
      paymentFailures: 0,
      subscriptionsScanned: 3,
      subscriptionsUpdated: 1,
      subscriptionsUnchanged: 1,
      subscriptionsMissing: 1,
      subscriptionFailures: 0,
    });

    expect(client.listCompletedPayments).toHaveBeenCalledWith({
      limit: 10,
      after: undefined,
      before: undefined,
      asc: undefined,
    });
    expect(client.listSubscriptions).toHaveBeenCalledWith({
      limit: 10,
      after: undefined,
      before: undefined,
      asc: undefined,
      status: undefined,
    });
    expect(store.recordVerifiedFirstPayment).toHaveBeenCalledTimes(1);
    expect(store.recordVerifiedRenewalPayment).toHaveBeenCalledTimes(1);
    expect(store.reconcilePayNowSubscription).toHaveBeenCalledTimes(3);
  });

  it("treats replayed PayNow evidence as duplicates and unchanged after recovery", async () => {
    const client: PayNowReconciliationEvidenceClient = {
      listCompletedPayments: vi.fn(async () => [firstPaymentEvent, renewalPaymentEvent]),
      listSubscriptions: vi.fn(async () => [subscription("active")]),
      verifyFirstPayment: vi.fn(async (payment) => payment.paymentId === firstPaymentEvent.paymentId
        ? verifiedFirst(payment)
        : undefined),
      verifyRenewalPayment: vi.fn(async (payment) => payment.paymentId === renewalPaymentEvent.paymentId
        ? verifiedRenewal(payment)
        : undefined),
    };
    const recordedPayments = new Set<string>();
    const reconciledSubscriptions = new Set<string>();
    const store: PayNowReconciliationStore = {
      recordVerifiedFirstPayment: vi.fn(async (input) => {
        const status = recordedPayments.has(input.payNowPaymentId) ? "duplicate" : "processed";
        recordedPayments.add(input.payNowPaymentId);
        return { status };
      }),
      recordVerifiedRenewalPayment: vi.fn(async (input) => {
        const status = recordedPayments.has(input.payNowPaymentId) ? "duplicate" : "processed";
        recordedPayments.add(input.payNowPaymentId);
        return { status };
      }),
      reconcilePayNowSubscription: vi.fn(async (input) => {
        const status = reconciledSubscriptions.has(input.payNowSubscriptionId) ? "unchanged" : "updated";
        reconciledSubscriptions.add(input.payNowSubscriptionId);
        return status;
      }),
    };

    await expect(reconcilePayNowBilling(store, client, {
      now: 2_000_000_333,
    })).resolves.toMatchObject({
      paymentsProcessed: 2,
      paymentDuplicates: 0,
      subscriptionsUpdated: 1,
      subscriptionsUnchanged: 0,
    });
    await expect(reconcilePayNowBilling(store, client, {
      now: 2_000_000_444,
    })).resolves.toMatchObject({
      paymentsProcessed: 0,
      paymentDuplicates: 2,
      subscriptionsUpdated: 0,
      subscriptionsUnchanged: 1,
      paymentFailures: 0,
      subscriptionFailures: 0,
    });
  });

  it("continues by default when one PayNow evidence row fails", async () => {
    const client: PayNowReconciliationEvidenceClient = {
      listCompletedPayments: vi.fn(async () => [firstPaymentEvent, renewalPaymentEvent]),
      listSubscriptions: vi.fn(async () => [subscription("active")]),
      verifyFirstPayment: vi.fn(async (payment) => {
        if (payment.paymentId === firstPaymentEvent.paymentId) {
          throw new ServiceError("paynow_api_response_invalid", "PayNow response was invalid", 502);
        }
        return undefined;
      }),
      verifyRenewalPayment: vi.fn(async (payment) => verifiedRenewal(payment)),
    };
    const store: PayNowReconciliationStore = {
      recordVerifiedFirstPayment: vi.fn(),
      recordVerifiedRenewalPayment: vi.fn(async () => ({ status: "processed" })),
      reconcilePayNowSubscription: vi.fn(async () => "updated"),
    };

    await expect(reconcilePayNowBilling(store, client, {
      now: 2_000_000_333,
    })).resolves.toMatchObject({
      paymentsScanned: 2,
      paymentsProcessed: 1,
      paymentFailures: 1,
      subscriptionsUpdated: 1,
    });
  });

  it("throws in strict mode on the first failed evidence row", async () => {
    const client: PayNowReconciliationEvidenceClient = {
      listCompletedPayments: vi.fn(async () => [firstPaymentEvent]),
      listSubscriptions: vi.fn(async () => []),
      verifyFirstPayment: vi.fn(async () => {
        throw new ServiceError("paynow_api_response_invalid", "PayNow response was invalid", 502);
      }),
    };
    const store: PayNowReconciliationStore = {
      recordVerifiedFirstPayment: vi.fn(),
      reconcilePayNowSubscription: vi.fn(),
    };

    await expect(reconcilePayNowBilling(store, client, {
      now: 2_000_000_333,
      strict: true,
    })).rejects.toMatchObject({
      code: "paynow_api_response_invalid",
    });
  });
});
