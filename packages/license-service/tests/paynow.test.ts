import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import { MemoryEmailTransport, type EmailMessage } from "../src/email.js";
import { sendQueuedLicenseEmails } from "../src/email-outbox.js";
import { ServiceError } from "../src/errors.js";
import { PAYNOW_PLAN_PRODUCT_IDS, PayNowManagementClient, type PayNowManagementApiAuditEvent } from "../src/paynow-management.js";
import { retryPendingFirstPayments } from "../src/paynow-retry.js";
import {
  PAYNOW_PAYMENT_LOG_RETENTION_SECONDS,
  PayNowWebhookReceiver,
  PayNowWebhookStore,
  type PayNowSecurityAlertEvent,
} from "../src/paynow.js";
import { PostgresPayNowWebhookStore } from "../src/paynow-postgres.js";
import {
  createPayNowBillingHttpServer,
  StaticBillingAdminAuthenticator,
  type BillingRateLimitEvent,
  type FeedbackRateLimitEvent,
} from "../src/paynow-server.js";

import type { Pool as PgPool } from "pg";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof import("pg");

const now = 2_000_000_000_000;
const secret = "paynow-test-signing-secret";
const storeId = "591304127884034048";
const emailKey = Buffer.alloc(32, 11);

function payload(
  eventType: string,
  eventId: string,
  periodEnd = "2033-05-19T03:33:20Z",
  productId = "592701920221593600",
  checkoutIntentId?: string,
): Buffer {
  return Buffer.from(JSON.stringify({
    event_type: eventType,
    event_id: eventId,
    body: {
      id: "700000000000000001",
      store_id: storeId,
      customer_id: "700000000000000002",
      product_id: productId,
      current_period_start: "2033-05-18T03:33:20Z",
      current_period_end: periodEnd,
      ...(eventType === "ON_SUBSCRIPTION_CANCELED" ? { canceled_at: "2033-05-18T05:33:20Z" } : {}),
      checkout: {
        id: "700000000000000010",
        metadata: {
          sly_account_id: "account-test",
          sly_license_id: "license-test",
          ...(checkoutIntentId === undefined ? {} : { sly_checkout_intent_id: checkoutIntentId }),
        },
      },
    },
  }), "utf8");
}

function paymentPayload(eventId: string, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    event_type: "ON_PAYMENT_COMPLETED",
    event_id: eventId,
    body: {
      id: "700000000000000020",
      store_id: storeId,
      order_id: "700000000000000021",
      gateway: "stripe",
      currency: "USD",
      tax_inclusive: false,
      amount: 4900,
      gateway_fee_amount: 0,
      tax_amount: 0,
      platform_fee_amount: 0,
      store_net_amount: 4900,
      status: "completed",
      created_at: "2033-05-18T03:30:00Z",
      completed_at: "2033-05-18T03:33:20Z",
      ...overrides,
    },
  }), "utf8");
}

function eventOnlyPayload(eventType: string, eventId: string, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    event_type: eventType,
    event_id: eventId,
    body: {
      id: "700000000000000040",
      store_id: storeId,
      order_id: "700000000000000021",
      payment_id: "700000000000000020",
      subscription_id: "700000000000000001",
      customer_id: "700000000000000002",
      amount: 4900,
      currency: "USD",
      ...overrides,
    },
  }), "utf8");
}

async function signed(receiver: PayNowWebhookReceiver, body: Buffer, at = now) {
  const timestamp = String(at);
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("base64");
  return receiver.receive(body, timestamp, signature);
}

describe("PayNow webhook receiver", () => {
  it("sets bounded billing HTTP server timeouts by default and accepts explicit overrides", () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const defaultServer = createPayNowBillingHttpServer(receiver);
    try {
      expect(defaultServer.headersTimeout).toBe(15_000);
      expect(defaultServer.requestTimeout).toBe(30_000);
      expect(defaultServer.keepAliveTimeout).toBe(5_000);
    } finally {
      defaultServer.close();
      store.close();
    }

    const customStore = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const customReceiver = new PayNowWebhookReceiver(customStore, { signingSecrets: [secret], storeId, now: () => now });
    const customServer = createPayNowBillingHttpServer(customReceiver, {
      serverTimeouts: {
        headersTimeoutMs: 8_000,
        requestTimeoutMs: 22_000,
        keepAliveTimeoutMs: 4_000,
      },
    });
    try {
      expect(customServer.headersTimeout).toBe(8_000);
      expect(customServer.requestTimeout).toBe(22_000);
      expect(customServer.keepAliveTimeout).toBe(4_000);
    } finally {
      customServer.close();
      customStore.close();
    }
  });

  it("creates checkout intents with server-side plan snapshots and encrypted email", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    try {
      const intent = store.createCheckoutIntent({
        planId: "studio",
        email: "Buyer@example.com",
        emailConfirmation: "buyer@example.com",
        now: 2_000_000_000,
      });
      expect(intent).toMatchObject({
        status: "pending_checkout",
        plan: "studio",
        planName: "Studio",
        monthlyPriceCents: 4900,
        currency: "USD",
        billingPeriod: "month",
        concurrency: 20,
        maskedEmail: "b***r@e*****e.com",
      });
      expect(intent.intentId).toMatch(/^ci_[A-Za-z0-9_-]+$/);
      expect(intent.statusToken).toMatch(/^cis_[A-Za-z0-9_-]+$/);
      expect(JSON.stringify(intent)).not.toContain("Buyer@example.com");
    } finally {
      store.close();
    }
  });

  it("reuses checkout intents for the same idempotency key without storing public tokens", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    try {
      const first = store.createCheckoutIntent({
        planId: "studio",
        email: "buyer@example.com",
        emailConfirmation: "buyer@example.com",
        idempotencyKey: "same-checkout-click-0001",
        now: 2_000_000_000,
      });
      const second = store.createCheckoutIntent({
        planId: "studio",
        email: "buyer@example.com",
        emailConfirmation: "buyer@example.com",
        idempotencyKey: "same-checkout-click-0001",
        now: 2_000_000_001,
      });
      expect(second.intentId).toBe(first.intentId);
      expect(second.statusToken).toBe(first.statusToken);
      expect(second.status).toBe("pending_checkout");
      expect(() => store.createCheckoutIntent({
        planId: "fleet",
        email: "buyer@example.com",
        emailConfirmation: "buyer@example.com",
        idempotencyKey: "same-checkout-click-0001",
        now: 2_000_000_002,
      })).toThrowError(expect.objectContaining({ code: "checkout_idempotency_conflict", status: 409 }));
      expect(JSON.stringify(second)).not.toContain("buyer@example.com");
    } finally {
      store.close();
    }
  });

  it("serves checkout intent creation over HTTP and rejects client-side tampering", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const server = createPayNowBillingHttpServer(receiver);
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const created = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan_id: "launch",
          email: "buyer@example.com",
          email_confirmation: "buyer@example.com",
        }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        schemaVersion: 1,
        status: "pending_checkout",
        plan: {
          id: "launch",
          monthlyPriceCents: 1900,
          currency: "USD",
          billingPeriod: "month",
          concurrency: 5,
        },
        maskedEmail: "b***r@e*****e.com",
      });

      const mismatch = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan_id: "launch",
          email: "buyer@example.com",
          email_confirmation: "other@example.com",
        }),
      });
      expect(mismatch.status).toBe(400);

      const tampered = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan_id: "launch",
          email: "buyer@example.com",
          email_confirmation: "buyer@example.com",
          price: 1,
          checkout_url: "https://evil.example",
        }),
      });
      expect(tampered.status).toBe(400);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("rate limits checkout intent creation without exposing the email address", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const alerts: BillingRateLimitEvent[] = [];
    const server = createPayNowBillingHttpServer(receiver, {
      billingRateLimit: {
        rules: { checkout_intent: { limit: 1, windowSeconds: 60 } },
        now: () => 1234,
        alertSink: (event) => alerts.push(event),
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = {
      plan_id: "launch",
      email: "buyer@example.com",
      email_confirmation: "buyer@example.com",
    };
    try {
      const first = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(first.status).toBe(201);
      const limited = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(limited.status).toBe(429);
      const payload = await limited.json();
      expect(payload).toMatchObject({
        error: {
          code: "billing_rate_limited",
          message: "Too many billing requests. Please try again later.",
        },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ action: "checkout_intent", count: 2, limit: 1 });
      expect(JSON.stringify(payload)).not.toContain("buyer@example.com");
      expect(JSON.stringify(alerts)).not.toContain("buyer@example.com");
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("rate limits admin paths without exposing bearer tokens", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const alerts: BillingRateLimitEvent[] = [];
    const server = createPayNowBillingHttpServer(receiver, {
      billingRateLimit: {
        rules: { admin: { limit: 1, windowSeconds: 60 } },
        now: () => 1234,
        alertSink: (event) => alerts.push(event),
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    const token = "invalid-admin-token-with-enough-length";
    try {
      const first = await fetch(`${origin}/v1/admin/orders/lookup?publicOrderId=spo_abcdefghijklmnop`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(first.status).toBe(503);
      const limited = await fetch(`${origin}/v1/admin/orders/lookup?publicOrderId=spo_abcdefghijklmnop`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(limited.status).toBe(429);
      const payload = await limited.json();
      expect(payload).toMatchObject({ error: { code: "billing_rate_limited" } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ action: "admin", count: 2, limit: 1 });
      expect(JSON.stringify(payload)).not.toContain(token);
      expect(JSON.stringify(alerts)).not.toContain(token);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("collects user feedback through configured email delivery", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const transport = new MemoryEmailTransport();
    const server = createPayNowBillingHttpServer(receiver, {
      feedbackEmail: {
        transport,
        to: "feedback@slybrowser.com",
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/v1/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "Buyer@example.com",
          category: "license",
          message: "Please help me recover a license delivery email.",
          page: "https://slybrowser.com/pricing",
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ schemaVersion: 1, status: "received" });
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toMatchObject({
        to: "feedback@slybrowser.com",
        replyTo: "buyer@example.com",
        subject: "[SlyBrowser feedback] license",
      });
      expect(transport.sent[0]!.text).toContain("Please help me recover a license delivery email.");
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("rate limits feedback by IP, email and user-agent without leaking identifiers", async () => {
    const scenarios: Array<{
      dimension: FeedbackRateLimitEvent["dimension"];
      maxPerIp: number;
      maxPerEmail: number;
      maxPerUserAgent: number;
      first: { email: string; ip: string; userAgent: string };
      second: { email: string; ip: string; userAgent: string };
    }> = [
      {
        dimension: "ip",
        maxPerIp: 1,
        maxPerEmail: 99,
        maxPerUserAgent: 99,
        first: { email: "ip-a@example.com", ip: "203.0.113.10", userAgent: "FeedbackIP/1" },
        second: { email: "ip-b@example.com", ip: "203.0.113.10", userAgent: "FeedbackIP/2" },
      },
      {
        dimension: "email",
        maxPerIp: 99,
        maxPerEmail: 1,
        maxPerUserAgent: 99,
        first: { email: "same@example.com", ip: "203.0.113.11", userAgent: "FeedbackEmail/1" },
        second: { email: "same@example.com", ip: "203.0.113.12", userAgent: "FeedbackEmail/2" },
      },
      {
        dimension: "user_agent",
        maxPerIp: 99,
        maxPerEmail: 99,
        maxPerUserAgent: 1,
        first: { email: "ua-a@example.com", ip: "203.0.113.13", userAgent: "FeedbackUA/1" },
        second: { email: "ua-b@example.com", ip: "203.0.113.14", userAgent: "FeedbackUA/1" },
      },
    ];

    for (const scenario of scenarios) {
      const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const transport = new MemoryEmailTransport();
      const alerts: FeedbackRateLimitEvent[] = [];
      const server = createPayNowBillingHttpServer(receiver, {
        feedbackEmail: {
          transport,
          to: "feedback@slybrowser.com",
        },
        feedbackRateLimit: {
          windowSeconds: 60,
          maxPerIp: scenario.maxPerIp,
          maxPerEmail: scenario.maxPerEmail,
          maxPerUserAgent: scenario.maxPerUserAgent,
          now: () => 2_000_000_000,
          alertSink: (event) => alerts.push(event),
        },
      });
      await new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", accept);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server address is invalid");
      const origin = `http://127.0.0.1:${address.port}`;
      const send = (input: { email: string; ip: string; userAgent: string }) => fetch(`${origin}/v1/feedback`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": input.ip,
        },
        body: JSON.stringify({
          email: input.email,
          category: "general",
          message: "This message is long enough to count as real user feedback.",
          userAgent: input.userAgent,
        }),
      });

      try {
        const first = await send(scenario.first);
        expect(first.status).toBe(202);
        const second = await send(scenario.second);
        expect(second.status).toBe(429);
        await expect(second.json()).resolves.toMatchObject({
          error: { code: "feedback_rate_limited" },
        });
        expect(transport.sent).toHaveLength(1);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          dimension: scenario.dimension,
          limit: 1,
          windowSeconds: 60,
          retryAfterSeconds: 60,
        });
        const serializedAlert = JSON.stringify(alerts[0]);
        expect(serializedAlert).not.toContain("@example.com");
        expect(serializedAlert).not.toContain("Feedback");
      } finally {
        await new Promise<void>((accept) => server.close(() => accept()));
        store.close();
      }
    }
  });

  it("sends license emails with plan, concurrency, order and renewal guidance", async () => {
    const transport = new MemoryEmailTransport();
    const outboxStore = {
      claimLicenseEmailOutbox: vi.fn(async () => [{
        outboxId: "00000000-0000-4000-8000-000000000001",
        recipientEmail: "buyer@example.com",
        payload: {
          schemaVersion: 1,
          kind: "first-license-file",
          plan: "studio",
          planName: "Studio",
          concurrency: 20,
          issuedAt: 2_000_000_000,
          paidThrough: 2_002_678_400,
          publicOrderId: "spo_test_order",
          customerAccessToken: "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456",
          licenseFileName: "spo_test_order-slybrowser-license.json",
          licenseFile: {
            schemaVersion: 2,
            type: "slybrowser-license",
          },
        },
      }]),
      markLicenseEmailOutboxSent: vi.fn(async () => undefined),
      markLicenseEmailOutboxFailed: vi.fn(async () => undefined),
    };

    await expect(sendQueuedLicenseEmails(outboxStore, transport, {
      now: 2_000_000_100,
      supportEmail: "support@slybrowser.com",
      customerPortalUrl: "https://slybrowser.com/billing/order",
    })).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
    });

    expect(transport.sent).toHaveLength(1);
    const message = transport.sent[0]!;
    expect(message.to).toBe("buyer@example.com");
    expect(message.subject).toBe("Your SlyBrowser license file");
    expect(message.text).toContain("Plan: Studio");
    expect(message.text).toContain("Concurrency: 20");
    expect(message.text).toContain("Activated: 2033-05-18");
    expect(message.text).toContain("Paid through: 2033-06-18");
    expect(message.text).toContain("Order: spo_test_order");
    expect(message.text).toContain("Customer access token: cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456");
    expect(message.text).toContain("Customer order page: https://slybrowser.com/billing/order");
    expect(message.text).toContain("Use the order ID and customer access token above");
    expect(message.text).not.toContain("https://slybrowser.com/billing/order?token=");
    expect(message.text).toContain("Automatic renewal:");
    expect(message.text).toContain("Cancellation:");
    expect(message.attachments).toEqual([expect.objectContaining({
      filename: "spo_test_order-slybrowser-license.json",
      contentType: "application/json",
    })]);
    const attachment = message.attachments?.[0] as Record<string, unknown> | undefined;
    expect(Object.keys(attachment ?? {}).sort()).toEqual(["content", "contentType", "filename"]);
    expect(attachment?.content).toBe("{\n  \"schemaVersion\": 2,\n  \"type\": \"slybrowser-license\"\n}\n");
    expect(outboxStore.markLicenseEmailOutboxSent).toHaveBeenCalledWith({
      outboxId: "00000000-0000-4000-8000-000000000001",
      provider: "memory",
      providerMessageId: "memory-1",
      now: 2_000_000_100,
    });
    expect(outboxStore.markLicenseEmailOutboxFailed).not.toHaveBeenCalled();
  });

  it("redacts license files, license keys and customer tokens from failed email logs", async () => {
    const licenseKey = `sly_live_11111111-1111-4111-8111-111111111111.${"a".repeat(43)}`;
    const customerToken = "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456";
    const outboxStore = {
      claimLicenseEmailOutbox: vi.fn(async () => [{
        outboxId: "00000000-0000-4000-8000-000000000002",
        recipientEmail: "buyer@example.com",
        payload: {
          schemaVersion: 1,
          kind: "first-license-file",
          plan: "studio",
          planName: "Studio",
          concurrency: 20,
          issuedAt: 2_000_000_000,
          paidThrough: 2_002_678_400,
          publicOrderId: "spo_test_order",
          customerAccessToken: customerToken,
          licenseFileName: "spo_test_order-slybrowser-license.json",
          licenseFile: {
            schemaVersion: 2,
            type: "slybrowser-license",
            licenseKey,
            ciphertext: "private-license-file-ciphertext",
            tag: "private-license-file-tag",
          },
        },
      }]),
      markLicenseEmailOutboxSent: vi.fn(async () => undefined),
      markLicenseEmailOutboxFailed: vi.fn(async () => undefined),
    };
    const failingTransport = {
      provider: "smtp",
      send: vi.fn(async (message: EmailMessage) => {
        throw new Error([
          "smtp rejected message after DATA",
          message.text,
          String(message.attachments?.[0]?.content ?? ""),
        ].join("\n"));
      }),
    };

    await expect(sendQueuedLicenseEmails(outboxStore, failingTransport, {
      now: 2_000_000_100,
      supportEmail: "support@slybrowser.com",
      customerPortalUrl: "https://slybrowser.com/billing/order",
    })).resolves.toEqual({
      claimed: 1,
      sent: 0,
      failed: 1,
    });

    expect(outboxStore.markLicenseEmailOutboxSent).not.toHaveBeenCalled();
    expect(outboxStore.markLicenseEmailOutboxFailed).toHaveBeenCalledWith({
      outboxId: "00000000-0000-4000-8000-000000000002",
      provider: "smtp",
      errorCode: "license_email_send_failed",
      errorMessage: "email transport failed (sensitive content redacted)",
      now: 2_000_000_100,
    });
    const failurePayload = JSON.stringify(outboxStore.markLicenseEmailOutboxFailed.mock.calls[0]?.[0] ?? {});
    expect(failurePayload).not.toContain(licenseKey);
    expect(failurePayload).not.toContain(customerToken);
    expect(failurePayload).not.toContain("private-license-file-ciphertext");
    expect(failurePayload).not.toContain("Your SlyBrowser license file is attached");
    expect(failurePayload).not.toContain("Customer access token:");
  });

  it("sends billing notice emails with separate templates and no license attachment", async () => {
    const transport = new MemoryEmailTransport();
    const kinds = [
      "renewal-receipt",
      "payment-retry",
      "grace-period",
      "subscription-canceled",
      "refund-receipt",
      "chargeback-hold",
      "account-restored",
    ] as const;
    const outboxStore = {
      claimLicenseEmailOutbox: vi.fn(async () => kinds.map((kind, index) => ({
        outboxId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
        recipientEmail: "buyer@example.com",
        payload: {
          schemaVersion: 1,
          kind,
          plan: "studio",
          planName: "Studio",
          concurrency: 20,
          publicOrderId: "spo_test_order",
          publicSubscriptionId: "sps_test_subscription",
          paidThrough: 2_002_678_400,
          amount: 4900,
          currency: "USD",
          occurredAt: 2_000_000_000,
          nextAttemptAt: 2_000_086_400,
          reason: "Template coverage",
        },
      }))),
      markLicenseEmailOutboxSent: vi.fn(async () => undefined),
      markLicenseEmailOutboxFailed: vi.fn(async () => undefined),
    };

    await expect(sendQueuedLicenseEmails(outboxStore, transport, {
      now: 2_000_000_100,
      supportEmail: "support@slybrowser.com",
      customerPortalUrl: "https://slybrowser.com/billing/order",
    })).resolves.toEqual({
      claimed: kinds.length,
      sent: kinds.length,
      failed: 0,
    });

    expect(transport.sent.map((message) => message.subject)).toEqual([
      "Your SlyBrowser subscription renewed",
      "Action needed: SlyBrowser payment retry",
      "Your SlyBrowser subscription is in grace period",
      "SlyBrowser automatic renewal canceled",
      "Your SlyBrowser refund was recorded",
      "SlyBrowser license temporarily on hold",
      "SlyBrowser license restored",
    ]);
    for (const message of transport.sent) {
      expect(message.attachments).toBeUndefined();
      expect(message.text).toContain("Plan: Studio");
      expect(message.text).toContain("Concurrency: 20");
      expect(message.text).toContain("Order: spo_test_order");
      expect(message.text).toContain("Customer order page: https://slybrowser.com/billing/order");
      expect(message.text).toContain("Use the customer access token from your original license email");
      expect(message.text).not.toContain("Customer access token:");
      expect(message.text).not.toContain("licenseKey");
      expect(message.text).not.toContain("?token=");
    }
    expect(outboxStore.markLicenseEmailOutboxSent).toHaveBeenCalledTimes(kinds.length);
    expect(outboxStore.markLicenseEmailOutboxFailed).not.toHaveBeenCalled();
  });

  it("records protected license email delivery status callbacks", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const deliveryStatusStore = {
      markLicenseEmailDeliveryStatus: vi.fn(async () => ({
        outboxId: "00000000-0000-4000-8000-000000000001",
        status: "delivered" as const,
      })),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      emailDeliveryStatus: {
        store: deliveryStatusStore,
        token: "email-webhook-secret",
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const unauthorized = await fetch(`${origin}/v1/billing/email-deliveries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "smtp",
          provider_message_id: "msg_123",
          status: "delivered",
        }),
      });
      expect(unauthorized.status).toBe(401);
      expect(deliveryStatusStore.markLicenseEmailDeliveryStatus).not.toHaveBeenCalled();

      const response = await fetch(`${origin}/v1/billing/email-deliveries`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer email-webhook-secret",
        },
        body: JSON.stringify({
          provider: "smtp",
          provider_message_id: "msg_123",
          provider_event_id: "evt_123",
          status: "delivered",
        }),
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body).toEqual({
        schemaVersion: 1,
        status: "recorded",
        outboxId: "00000000-0000-4000-8000-000000000001",
        deliveryStatus: "delivered",
      });
      expect(JSON.stringify(body)).not.toContain("email-webhook-secret");
      expect(deliveryStatusStore.markLicenseEmailDeliveryStatus).toHaveBeenCalledWith({
        provider: "smtp",
        providerMessageId: "msg_123",
        providerEventId: "evt_123",
        status: "delivered",
      });
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("serves customer billing status and license resend only with an access token", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const customerStore = {
      customerBillingStatus: vi.fn(async (input: { publicOrderId: string; accessToken: string }) => {
        if (input.publicOrderId !== "spo_customer_test_123456" || input.accessToken !== "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456") {
          throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
        }
        return {
          publicOrderId: input.publicOrderId,
          publicSubscriptionId: "sps_customer_test",
          plan: "studio" as const,
          planName: "Studio",
          concurrency: 20,
          orderStatus: "completed" as const,
          subscriptionStatus: "active" as const,
          paidThrough: 2_002_678_400,
          remainingDays: 31,
          autoRenew: true,
          cancelAtPeriodEnd: false,
          licenseStatus: "active" as const,
          licenseFileDeliveryStatus: "delivered",
        };
      }),
      requestLicenseFileResend: vi.fn(async (input: { publicOrderId: string; accessToken: string }) => {
        if (input.publicOrderId !== "spo_customer_test_123456" || input.accessToken !== "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456") {
          throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
        }
        return {
          status: "queued" as const,
          publicOrderId: input.publicOrderId,
          outboxId: "00000000-0000-4000-8000-000000000099",
          nextAttemptAt: 2_000_000_100,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      customerPortal: { store: customerStore },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const queryTokenStatus = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/status?token=cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456`);
      expect(queryTokenStatus.status).toBe(404);

      const status = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/status`, {
        headers: { "x-sly-customer-access-token": "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456" },
      });
      expect(status.status).toBe(200);
      const statusBody = await status.json();
      expect(statusBody).toMatchObject({
        schemaVersion: 1,
        publicOrderId: "spo_customer_test_123456",
        plan: "studio",
        remainingDays: 31,
        autoRenew: true,
      });
      expect(JSON.stringify(statusBody)).not.toContain("700000000000000");
      expect(JSON.stringify(statusBody)).not.toContain("@example.com");

      const unauthorized = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/status`, {
        headers: { "x-sly-customer-access-token": "cst_wrong_token_abcdefghijklmnopqrstuvwxyz123456789" },
      });
      expect(unauthorized.status).toBe(404);

      const resend = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/license-resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456" }),
      });
      expect(resend.status).toBe(202);
      await expect(resend.json()).resolves.toMatchObject({
        schemaVersion: 1,
        status: "queued",
        publicOrderId: "spo_customer_test_123456",
      });

      const tampered = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/license-resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456",
          email: "attacker@example.com",
        }),
      });
      expect(tampered.status).toBe(400);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("cancels customer subscription renewal through verified order ownership", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const cancellationStore = {
      prepareCustomerSubscriptionCancellation: vi.fn(async (input: { publicOrderId: string; accessToken: string }) => {
        if (input.publicOrderId !== "spo_customer_test_123456" || input.accessToken !== "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456") {
          throw new ServiceError("customer_portal_unavailable", "Customer billing status is not available", 404);
        }
        return {
          publicOrderId: input.publicOrderId,
          publicSubscriptionId: "sps_customer_test",
          payNowSubscriptionId: "700000000000000444",
          paidThrough: 2_002_678_400,
          alreadyCanceled: false,
        };
      }),
      recordCustomerSubscriptionCanceled: vi.fn(async (input: { publicOrderId: string; payNowSubscriptionId: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          payNowSubscriptionId: "700000000000000444",
        });
        return {
          status: "cancel_at_period_end" as const,
          publicOrderId: input.publicOrderId,
          publicSubscriptionId: "sps_customer_test",
          paidThrough: 2_002_678_400,
          cancelAtPeriodEnd: true as const,
        };
      }),
    };
    const cancellationClient = {
      cancelSubscription: vi.fn(async (input: { subscriptionId: string; cancelAtPeriodEnd?: boolean }) => {
        expect(input).toEqual({
          subscriptionId: "700000000000000444",
          cancelAtPeriodEnd: true,
        });
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      customerSubscriptionCancellation: {
        store: cancellationStore,
        client: cancellationClient,
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const cancel = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/cancel-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456" }),
      });
      expect(cancel.status).toBe(202);
      const cancelBody = await cancel.json();
      expect(cancelBody).toMatchObject({
        schemaVersion: 1,
        status: "cancel_at_period_end",
        publicOrderId: "spo_customer_test_123456",
        publicSubscriptionId: "sps_customer_test",
        paidThrough: 2_002_678_400,
        cancelAtPeriodEnd: true,
      });
      expect(JSON.stringify(cancelBody)).not.toContain("700000000000000444");
      expect(cancellationClient.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(cancellationStore.recordCustomerSubscriptionCanceled).toHaveBeenCalledTimes(1);

      cancellationStore.prepareCustomerSubscriptionCancellation.mockResolvedValueOnce({
        publicOrderId: "spo_customer_test_123456",
        publicSubscriptionId: "sps_customer_test",
        payNowSubscriptionId: "700000000000000444",
        paidThrough: 2_002_678_400,
        alreadyCanceled: true,
      });
      const alreadyCanceled = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/cancel-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456" }),
      });
      expect(alreadyCanceled.status).toBe(202);
      await expect(alreadyCanceled.json()).resolves.toMatchObject({
        schemaVersion: 1,
        status: "already_canceled",
        publicOrderId: "spo_customer_test_123456",
        paidThrough: 2_002_678_400,
        cancelAtPeriodEnd: true,
      });
      expect(cancellationClient.cancelSubscription).toHaveBeenCalledTimes(1);

      const tampered = await fetch(`${origin}/v1/billing/orders/spo_customer_test_123456/cancel-subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "cst_customer_access_token_abcdefghijklmnopqrstuvwxyz123456",
          paynow_subscription_id: "700000000000000444",
        }),
      });
      expect(tampered.status).toBe(400);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("creates admin order refunds with authorization and idempotency", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const refundStore = {
      prepareAdminOrderRefund: vi.fn(async (input: { publicOrderId: string; idempotencyKey: string; requestedBy: string; reason: string }) => {
        expect(input).toMatchObject({
          publicOrderId: "spo_customer_test_123456",
          idempotencyKey: "refund-idempotency-key-001",
          requestedBy: "admin@example.com",
          reason: "Customer requested refund",
        });
        return {
          refundId: "00000000-0000-4000-8000-000000000123",
          orderId: "00000000-0000-4000-8000-000000000124",
          publicOrderId: input.publicOrderId,
          paymentId: "00000000-0000-4000-8000-000000000125",
          payNowOrderId: "700000000000000777",
          amount: 4900,
          currency: "USD",
          reason: input.reason,
          status: "requested" as const,
          alreadySubmitted: false,
        };
      }),
      recordAdminOrderRefundSubmitted: vi.fn(async () => ({
        refundId: "00000000-0000-4000-8000-000000000123",
        publicOrderId: "spo_customer_test_123456",
        payNowRefundId: "700000000000000778",
        status: "completed" as const,
        amount: 4900,
        currency: "USD",
      })),
    };
    const refundClient = {
      refundOrder: vi.fn(async (input: { orderId: string }) => {
        expect(input).toEqual({ orderId: "700000000000000777" });
        return {
          payNowRefundId: "700000000000000778",
          payNowPaymentId: "700000000000000779",
          payNowCustomerId: "700000000000000780",
          status: "completed" as const,
          amount: 4900,
          currency: "USD",
          createdAt: 2_000_000_000,
          completedAt: 2_000_000_001,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminRefunds: {
        store: refundStore,
        client: refundClient,
        token: "admin-refund-token-secret",
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const unauthorized = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/refunds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Customer requested refund" }),
      });
      expect(unauthorized.status).toBe(401);

      const missingIdempotency = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/refunds`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "Customer requested refund" }),
      });
      expect(missingIdempotency.status).toBe(400);

      const created = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/refunds`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-token-secret",
          "content-type": "application/json",
          "idempotency-key": "refund-idempotency-key-001",
          "x-sly-admin-actor": "admin@example.com",
        },
        body: JSON.stringify({ reason: "Customer requested refund" }),
      });
      expect(created.status).toBe(202);
      await expect(created.json()).resolves.toMatchObject({
        schemaVersion: 1,
        refundId: "00000000-0000-4000-8000-000000000123",
        publicOrderId: "spo_customer_test_123456",
        payNowRefundId: "700000000000000778",
        status: "completed",
        amount: 4900,
        currency: "USD",
      });
      expect(refundClient.refundOrder).toHaveBeenCalledTimes(1);

      refundStore.prepareAdminOrderRefund.mockResolvedValueOnce({
        refundId: "00000000-0000-4000-8000-000000000123",
        orderId: "00000000-0000-4000-8000-000000000124",
        publicOrderId: "spo_customer_test_123456",
        paymentId: "00000000-0000-4000-8000-000000000125",
        payNowOrderId: "700000000000000777",
        payNowRefundId: "700000000000000778",
        amount: 4900,
        currency: "USD",
        reason: "Customer requested refund",
        status: "completed",
        alreadySubmitted: true,
      });
      const repeated = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/refunds`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-token-secret",
          "content-type": "application/json",
          "idempotency-key": "refund-idempotency-key-001",
          "x-sly-admin-actor": "admin@example.com",
        },
        body: JSON.stringify({ reason: "Customer requested refund" }),
      });
      expect(repeated.status).toBe(202);
      await expect(repeated.json()).resolves.toMatchObject({
        schemaVersion: 1,
        payNowRefundId: "700000000000000778",
        status: "completed",
      });
      expect(refundClient.refundOrder).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("records admin refund failures with safe order and PayNow correlation IDs", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const refundStore = {
      prepareAdminOrderRefund: vi.fn(async () => ({
        refundId: "00000000-0000-4000-8000-000000000321",
        orderId: "00000000-0000-4000-8000-000000000322",
        publicOrderId: "spo_customer_test_123456",
        paymentId: "00000000-0000-4000-8000-000000000323",
        payNowOrderId: "700000000000000887",
        amount: 4900,
        currency: "USD",
        reason: "Customer requested refund",
        status: "requested" as const,
        alreadySubmitted: false,
      })),
      recordAdminOrderRefundSubmitted: vi.fn(),
      recordAdminOrderRefundFailed: vi.fn(async (input: {
        refundId: string;
        payNowOrderId: string;
        errorCode: string;
        errorMessage: string;
      }) => {
        expect(input).toMatchObject({
          refundId: "00000000-0000-4000-8000-000000000321",
          payNowOrderId: "700000000000000887",
          errorCode: "paynow_api_error",
          errorMessage: "PayNow API rejected the request",
        });
        return {
          refundId: input.refundId,
          publicOrderId: "spo_customer_test_123456",
          payNowOrderId: input.payNowOrderId,
          payNowPaymentId: "700000000000000888",
          status: "failed" as const,
          amount: 4900,
          currency: "USD",
          errorCode: input.errorCode,
          failureMessage: input.errorMessage,
        };
      }),
    };
    const refundClient = {
      refundOrder: vi.fn(async () => {
        throw new ServiceError("paynow_api_error", "PayNow API rejected the request", 502, {
          operation: "refund_order",
          status: 429,
          code: "rate_limited",
        });
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminRefunds: {
        store: refundStore,
        client: refundClient,
        token: "admin-refund-token-secret",
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const failed = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/refunds`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-token-secret",
          "content-type": "application/json",
          "idempotency-key": "refund-idempotency-key-001",
          "x-sly-admin-actor": "admin@example.com",
        },
        body: JSON.stringify({ reason: "Customer requested refund" }),
      });
      expect(failed.status).toBe(502);
      await expect(failed.json()).resolves.toMatchObject({
        error: {
          code: "paynow_api_error",
          refundId: "00000000-0000-4000-8000-000000000321",
          publicOrderId: "spo_customer_test_123456",
          payNowOrderId: "700000000000000887",
          status: "failed",
        },
      });
      expect(refundClient.refundOrder).toHaveBeenCalledTimes(1);
      expect(refundStore.recordAdminOrderRefundFailed).toHaveBeenCalledTimes(1);
      expect(refundStore.recordAdminOrderRefundSubmitted).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("rotates leaked license files through the protected admin API without exposing secrets", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const rotationStore = {
      rotateLeakedLicenseFile: vi.fn(async (input: { publicOrderId: string; idempotencyKey: string; requestedBy: string; reason: string }) => {
        expect(input).toMatchObject({
          publicOrderId: "spo_customer_test_123456",
          idempotencyKey: "rotation-idempotency-key-001",
          requestedBy: "admin@example.com",
          reason: "Customer reported leaked license file",
        });
        return {
          status: "queued" as const,
          publicOrderId: input.publicOrderId,
          oldEntitlementId: "00000000-0000-4000-8000-000000000201",
          oldLicenseId: "00000000-0000-4000-8000-000000000202",
          newEntitlementId: "00000000-0000-4000-8000-000000000203",
          newLicenseId: "00000000-0000-4000-8000-000000000204",
          outboxId: "00000000-0000-4000-8000-000000000205",
          nextAttemptAt: 2_000_000_100,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminLicenseRotations: {
        store: rotationStore,
        token: "admin-rotation-token-secret",
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const unauthorized = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-rotation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Customer reported leaked license file" }),
      });
      expect(unauthorized.status).toBe(401);

      const missingIdempotency = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-rotation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-rotation-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "Customer reported leaked license file" }),
      });
      expect(missingIdempotency.status).toBe(400);

      const tampered = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-rotation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-rotation-token-secret",
          "content-type": "application/json",
          "idempotency-key": "rotation-idempotency-key-001",
        },
        body: JSON.stringify({
          reason: "Customer reported leaked license file",
          license_key: `sly_live_11111111-1111-4111-8111-111111111111.${"a".repeat(43)}`,
        }),
      });
      expect(tampered.status).toBe(400);

      const rotated = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-rotation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-rotation-token-secret",
          "content-type": "application/json",
          "idempotency-key": "rotation-idempotency-key-001",
          "x-sly-admin-actor": "admin@example.com",
        },
        body: JSON.stringify({ reason: "Customer reported leaked license file" }),
      });
      expect(rotated.status).toBe(202);
      const rotatedBody = await rotated.json();
      expect(rotatedBody).toMatchObject({
        schemaVersion: 1,
        status: "queued",
        publicOrderId: "spo_customer_test_123456",
        oldEntitlementId: "00000000-0000-4000-8000-000000000201",
        oldLicenseId: "00000000-0000-4000-8000-000000000202",
        newEntitlementId: "00000000-0000-4000-8000-000000000203",
        newLicenseId: "00000000-0000-4000-8000-000000000204",
        outboxId: "00000000-0000-4000-8000-000000000205",
      });
      expect(JSON.stringify(rotatedBody)).not.toContain("sly_live_");
      expect(JSON.stringify(rotatedBody)).not.toContain("cst_");
      expect(JSON.stringify(rotatedBody)).not.toContain("licenseFile");
      expect(rotationStore.rotateLeakedLicenseFile).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("enforces billing admin RBAC credentials and audited actors", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-refund-rbac-token-secret",
        actor: "refunds@slybrowser.test",
        permissions: ["orders:refund"],
      },
      {
        token: "admin-rotation-rbac-token-secret",
        actor: "license-ops@slybrowser.test",
        permissions: ["licenses:rotate"],
      },
    ]);
    const refundStore = {
      prepareAdminOrderRefund: vi.fn(async (input: { publicOrderId: string; idempotencyKey: string; requestedBy: string; reason: string }) => {
        expect(input.requestedBy).toBe("refunds@slybrowser.test");
        return {
          refundId: "00000000-0000-4000-8000-000000000301",
          orderId: "00000000-0000-4000-8000-000000000302",
          publicOrderId: input.publicOrderId,
          paymentId: "00000000-0000-4000-8000-000000000303",
          payNowOrderId: "700000000000000881",
          amount: 1900,
          currency: "USD",
          reason: input.reason,
          status: "requested" as const,
          alreadySubmitted: false,
        };
      }),
      recordAdminOrderRefundSubmitted: vi.fn(async () => ({
        refundId: "00000000-0000-4000-8000-000000000301",
        publicOrderId: "spo_customer_test_123456",
        payNowRefundId: "700000000000000882",
        status: "completed" as const,
        amount: 1900,
        currency: "USD",
      })),
    };
    const refundClient = {
      refundOrder: vi.fn(async () => ({
        payNowRefundId: "700000000000000882",
        payNowPaymentId: "700000000000000883",
        payNowCustomerId: "700000000000000884",
        status: "completed" as const,
        amount: 1900,
        currency: "USD",
        createdAt: 2_000_000_000,
        completedAt: 2_000_000_001,
      })),
    };
    const rotationStore = {
      rotateLeakedLicenseFile: vi.fn(async (input: { publicOrderId: string; idempotencyKey: string; requestedBy: string; reason: string }) => {
        expect(input.requestedBy).toBe("license-ops@slybrowser.test");
        return {
          status: "queued" as const,
          publicOrderId: input.publicOrderId,
          oldEntitlementId: "00000000-0000-4000-8000-000000000391",
          oldLicenseId: "00000000-0000-4000-8000-000000000392",
          newEntitlementId: "00000000-0000-4000-8000-000000000393",
          newLicenseId: "00000000-0000-4000-8000-000000000394",
          outboxId: "00000000-0000-4000-8000-000000000395",
          nextAttemptAt: 2_000_000_100,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminRefunds: { store: refundStore, client: refundClient, adminAuth },
      adminLicenseRotations: { store: rotationStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const refund = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/refunds`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-rbac-token-secret",
          "content-type": "application/json",
          "idempotency-key": "rbac-refund-idempotency-001",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({ reason: "Customer requested refund" }),
      });
      expect(refund.status).toBe(202);

      const forbiddenRotation = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-rotation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-rbac-token-secret",
          "content-type": "application/json",
          "idempotency-key": "rbac-rotation-idempotency-001",
        },
        body: JSON.stringify({ reason: "Customer reported leaked license file" }),
      });
      expect(forbiddenRotation.status).toBe(403);
      await expect(forbiddenRotation.json()).resolves.toMatchObject({
        error: { code: "admin_authorization_forbidden" },
      });
      expect(rotationStore.rotateLeakedLicenseFile).not.toHaveBeenCalled();

      const rotation = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-rotation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-rotation-rbac-token-secret",
          "content-type": "application/json",
          "idempotency-key": "rbac-rotation-idempotency-001",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({ reason: "Customer reported leaked license file" }),
      });
      expect(rotation.status).toBe(202);
      expect(rotationStore.rotateLeakedLicenseFile).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("lists redacted admin orders through orders:read RBAC", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-read-rbac-token-secret",
        actor: "support@slybrowser.test",
        permissions: ["orders:read"],
      },
      {
        token: "admin-refund-rbac-token-secret",
        actor: "refunds@slybrowser.test",
        permissions: ["orders:refund"],
      },
    ]);
    const lookupStore = {
      adminBillingOrders: vi.fn(async (input: { requestedBy: string; limit?: number; offset?: number }) => {
        expect(input).toEqual({
          requestedBy: "support@slybrowser.test",
          limit: 25,
          offset: 50,
        });
        return {
          orders: [{
            publicOrderId: "spo_customer_test_123456",
            payNowOrderId: "700000000000000411",
            plan: "studio" as const,
            orderStatus: "completed",
            licenseId: "00000000-0000-4000-8000-000000000414",
            licenseStatus: "active",
            paidThrough: 2_002_678_400,
            createdAt: 2_000_000_000,
            latestPayment: {
              amount: 4900,
              currency: "USD",
              status: "completed",
              completedAt: 2_000_000_001,
            },
            latestRefund: {
              status: "failed" as const,
              requestedAt: 2_000_000_010,
            },
            refundCount: 1,
          }],
          limit: 25,
          offset: 50,
          hasMore: false,
        };
      }),
      adminBillingOrder: vi.fn(),
      adminBillingOrderLookup: vi.fn(),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminLookup: { store: lookupStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders?limit=25&offset=50`, {
        headers: { authorization: "Bearer admin-refund-rbac-token-secret" },
      });
      expect(forbidden.status).toBe(403);

      const invalid = await fetch(`${origin}/v1/admin/orders?limit=25&offset=50&email=customer@example.com`, {
        headers: { authorization: "Bearer admin-read-rbac-token-secret" },
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders?limit=25&offset=50`, {
        headers: {
          authorization: "Bearer admin-read-rbac-token-secret",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        schemaVersion: 1,
        limit: 25,
        offset: 50,
        hasMore: false,
        orders: [expect.objectContaining({
          publicOrderId: "spo_customer_test_123456",
          payNowOrderId: "700000000000000411",
          plan: "studio",
          orderStatus: "completed",
          latestPayment: expect.objectContaining({ amount: 4900, currency: "USD" }),
          latestRefund: expect.objectContaining({ status: "failed" }),
        })],
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("sly_live_");
      expect(serialized).not.toContain("cst_");
      expect(serialized).not.toContain("@example.com");
      expect(serialized).not.toContain("licenseFile");
      expect(lookupStore.adminBillingOrders).toHaveBeenCalledTimes(1);
      expect(lookupStore.adminBillingOrder).not.toHaveBeenCalled();
      expect(lookupStore.adminBillingOrderLookup).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("serves redacted admin order details through orders:read RBAC", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-read-rbac-token-secret",
        actor: "support@slybrowser.test",
        permissions: ["orders:read"],
      },
      {
        token: "admin-refund-rbac-token-secret",
        actor: "refunds@slybrowser.test",
        permissions: ["orders:refund"],
      },
    ]);
    const lookupStore = {
      adminBillingOrders: vi.fn(),
      adminBillingOrder: vi.fn(async (input: { publicOrderId: string; requestedBy: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          requestedBy: "support@slybrowser.test",
        });
        return {
          publicOrderId: input.publicOrderId,
          orderId: "00000000-0000-4000-8000-000000000411",
          payNowOrderId: "700000000000000411",
          payNowCheckoutId: "700000000000000412",
          plan: "studio" as const,
          orderStatus: "completed",
          entitlementId: "00000000-0000-4000-8000-000000000413",
          licenseId: "00000000-0000-4000-8000-000000000414",
          licenseStatus: "active",
          paidThrough: 2_002_678_400,
          payments: [{
            paymentId: "00000000-0000-4000-8000-000000000415",
            payNowPaymentId: "700000000000000415",
            amount: 4900,
            currency: "USD",
            status: "completed",
            createdAt: 2_000_000_000,
            completedAt: 2_000_000_001,
          }],
          subscriptions: [{
            publicSubscriptionId: "sps_customer_test_123456",
            payNowSubscriptionId: "700000000000000416",
            status: "active",
            paidThrough: 2_002_678_400,
            cancelAtPeriodEnd: false,
          }],
          refunds: [{
            refundId: "00000000-0000-4000-8000-000000000417",
            payNowRefundId: "700000000000000417",
            amount: 1900,
            currency: "USD",
            status: "completed" as const,
            requestedBy: "refunds@slybrowser.test",
            requestedAt: 2_000_000_010,
            completedAt: 2_000_000_020,
          }],
          auditLogs: [{
            auditId: "00000000-0000-4000-8000-000000000418",
            actor: "refunds@slybrowser.test",
            action: "admin_refund_submitted",
            targetType: "refund",
            targetId: "00000000-0000-4000-8000-000000000417",
            reason: "Customer requested refund",
            before: { status: "requested" },
            after: { status: "processing" },
            externalResult: { provider: "paynow", refundId: "700000000000000417" },
            createdAt: 2_000_000_020,
          }],
        };
      }),
      adminBillingOrderLookup: vi.fn(),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminLookup: { store: lookupStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456`, {
        headers: { authorization: "Bearer admin-refund-rbac-token-secret" },
      });
      expect(forbidden.status).toBe(403);

      const response = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456`, {
        headers: {
          authorization: "Bearer admin-read-rbac-token-secret",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        schemaVersion: 1,
        publicOrderId: "spo_customer_test_123456",
        payNowOrderId: "700000000000000411",
        plan: "studio",
        orderStatus: "completed",
        payments: [expect.objectContaining({ payNowPaymentId: "700000000000000415" })],
        subscriptions: [expect.objectContaining({ payNowSubscriptionId: "700000000000000416" })],
        refunds: [expect.objectContaining({ payNowRefundId: "700000000000000417" })],
        auditLogs: [expect.objectContaining({
          action: "admin_refund_submitted",
          before: { status: "requested" },
          after: { status: "processing" },
          externalResult: { provider: "paynow", refundId: "700000000000000417" },
        })],
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("sly_live_");
      expect(serialized).not.toContain("cst_");
      expect(serialized).not.toContain("@example.com");
      expect(serialized).not.toContain("licenseFile");
      expect(lookupStore.adminBillingOrder).toHaveBeenCalledTimes(1);
      expect(lookupStore.adminBillingOrderLookup).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("looks up redacted admin order details by PayNow order ID or license ID", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-read-rbac-token-secret",
        actor: "support@slybrowser.test",
        permissions: ["orders:read"],
      },
    ]);
    const lookupStore = {
      adminBillingOrders: vi.fn(),
      adminBillingOrder: vi.fn(),
      adminBillingOrderLookup: vi.fn(async (input: { publicOrderId?: string; payNowOrderId?: string; licenseId?: string; requestedBy: string }) => {
        expect(input).toEqual({
          payNowOrderId: "700000000000000411",
          requestedBy: "support@slybrowser.test",
        });
        return {
          publicOrderId: "spo_customer_test_123456",
          orderId: "00000000-0000-4000-8000-000000000411",
          payNowOrderId: input.payNowOrderId,
          plan: "studio" as const,
          orderStatus: "completed",
          entitlementId: "00000000-0000-4000-8000-000000000413",
          licenseId: "00000000-0000-4000-8000-000000000414",
          licenseStatus: "active",
          payments: [],
          subscriptions: [],
          refunds: [],
          auditLogs: [],
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminLookup: { store: lookupStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const invalid = await fetch(`${origin}/v1/admin/orders/lookup?payNowOrderId=700000000000000411&licenseId=00000000-0000-4000-8000-000000000414`, {
        headers: { authorization: "Bearer admin-read-rbac-token-secret" },
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders/lookup?payNowOrderId=700000000000000411`, {
        headers: {
          authorization: "Bearer admin-read-rbac-token-secret",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        publicOrderId: "spo_customer_test_123456",
        payNowOrderId: "700000000000000411",
        licenseId: "00000000-0000-4000-8000-000000000414",
      });
      expect(lookupStore.adminBillingOrder).not.toHaveBeenCalled();
      expect(lookupStore.adminBillingOrderLookup).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("adds admin order notes through orders:note RBAC", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-note-rbac-token-secret",
        actor: "support-notes@slybrowser.test",
        permissions: ["orders:note"],
      },
      {
        token: "admin-read-rbac-token-secret",
        actor: "support-read@slybrowser.test",
        permissions: ["orders:read"],
      },
    ]);
    const noteStore = {
      addAdminOrderNote: vi.fn(async (input: { publicOrderId: string; requestedBy: string; note: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          requestedBy: "support-notes@slybrowser.test",
          note: "Customer asked support to review renewal timing.",
        });
        return {
          noteId: "00000000-0000-4000-8000-000000000419",
          publicOrderId: input.publicOrderId,
          requestedBy: input.requestedBy,
          note: input.note,
          createdAt: 2_000_000_030,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminOrderNotes: { store: noteStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/notes`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-read-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ note: "Customer asked support to review renewal timing." }),
      });
      expect(forbidden.status).toBe(403);

      const invalid = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/notes`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-note-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ note: "ok", unexpected: true }),
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/notes`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-note-rbac-token-secret",
          "content-type": "application/json",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({ note: "Customer asked support to review renewal timing." }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        noteId: "00000000-0000-4000-8000-000000000419",
        publicOrderId: "spo_customer_test_123456",
        requestedBy: "support-notes@slybrowser.test",
        note: "Customer asked support to review renewal timing.",
      });
      expect(noteStore.addAdminOrderNote).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("changes admin customer email through orders:email RBAC without returning raw emails", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-email-rbac-token-secret",
        actor: "support-email@slybrowser.test",
        permissions: ["orders:email"],
      },
      {
        token: "admin-read-rbac-token-secret-2",
        actor: "support-read@slybrowser.test",
        permissions: ["orders:read"],
      },
    ]);
    const emailStore = {
      changeAdminCustomerEmail: vi.fn(async (input: {
        publicOrderId: string;
        requestedBy: string;
        email: string;
        reason: string;
        ownershipEvidence: string;
      }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          requestedBy: "support-email@slybrowser.test",
          email: "new.owner@example.com",
          reason: "Customer opened support ticket and verified order ownership.",
          ownershipEvidence: "ticket SUP-1234 confirmed original order token and invoice metadata",
        });
        return {
          publicOrderId: input.publicOrderId,
          requestedBy: input.requestedBy,
          previousMaskedEmail: "o*****r@e*****e.com",
          maskedEmail: "n*****r@e*****e.com",
          changed: true,
          updatedAt: 2_000_000_040,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminCustomerEmails: { store: emailStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/customer-email`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-read-rbac-token-secret-2",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "new.owner@example.com",
          email_confirmation: "new.owner@example.com",
          reason: "Customer opened support ticket and verified order ownership.",
          ownership_evidence: "ticket SUP-1234 confirmed original order token and invoice metadata",
        }),
      });
      expect(forbidden.status).toBe(403);

      const invalid = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/customer-email`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-email-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "new.owner@example.com",
          email_confirmation: "different@example.com",
          reason: "Customer opened support ticket and verified order ownership.",
          ownership_evidence: "ticket SUP-1234 confirmed original order token and invoice metadata",
          unexpected: true,
        }),
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/customer-email`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-email-rbac-token-secret",
          "content-type": "application/json",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({
          email: "new.owner@example.com",
          email_confirmation: "new.owner@example.com",
          reason: "Customer opened support ticket and verified order ownership.",
          ownership_evidence: "ticket SUP-1234 confirmed original order token and invoice metadata",
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        schemaVersion: 1,
        publicOrderId: "spo_customer_test_123456",
        requestedBy: "support-email@slybrowser.test",
        previousMaskedEmail: "o*****r@e*****e.com",
        maskedEmail: "n*****r@e*****e.com",
        changed: true,
      });
      expect(JSON.stringify(payload)).not.toContain("new.owner@example.com");
      expect(emailStore.changeAdminCustomerEmail).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("updates admin license status through licenses:update RBAC", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-status-rbac-token-secret",
        actor: "license-status@slybrowser.test",
        permissions: ["licenses:update"],
      },
      {
        token: "admin-rotation-rbac-token-secret",
        actor: "license-ops@slybrowser.test",
        permissions: ["licenses:rotate"],
      },
    ]);
    const statusStore = {
      updateAdminLicenseStatus: vi.fn(async (input: { publicOrderId: string; requestedBy: string; status: "active" | "hold" | "revoked"; reason: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          requestedBy: "license-status@slybrowser.test",
          status: "hold",
          reason: "Payment risk review while support investigates.",
        });
        return {
          publicOrderId: input.publicOrderId,
          entitlementId: "00000000-0000-4000-8000-000000000420",
          licenseId: "00000000-0000-4000-8000-000000000421",
          previousStatus: "active" as const,
          status: input.status,
          updatedAt: 2_000_000_040,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminLicenseStatus: { store: statusStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-status`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-rotation-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "hold", reason: "Payment risk review while support investigates." }),
      });
      expect(forbidden.status).toBe(403);

      const invalid = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-status`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-status-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "paused", reason: "Payment risk review while support investigates." }),
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-status`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-status-rbac-token-secret",
          "content-type": "application/json",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({ status: "hold", reason: "Payment risk review while support investigates." }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        publicOrderId: "spo_customer_test_123456",
        previousStatus: "active",
        status: "hold",
      });
      expect(statusStore.updateAdminLicenseStatus).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("cancels subscriptions through subscriptions:cancel RBAC", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-cancel-rbac-token-secret",
        actor: "billing-support@slybrowser.test",
        permissions: ["subscriptions:cancel"],
      },
      {
        token: "admin-refund-rbac-token-secret",
        actor: "refunds@slybrowser.test",
        permissions: ["orders:refund"],
      },
    ]);
    const cancellationStore = {
      prepareAdminSubscriptionCancellation: vi.fn(async (input: { publicOrderId: string; requestedBy: string; reason: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          requestedBy: "billing-support@slybrowser.test",
          reason: "Customer requested support-assisted cancellation.",
        });
        return {
          publicOrderId: input.publicOrderId,
          publicSubscriptionId: "sps_customer_test_123456",
          payNowSubscriptionId: "700000000000000430",
          paidThrough: 2_002_678_400,
          alreadyCanceled: false,
        };
      }),
      recordAdminSubscriptionCanceled: vi.fn(async (input: { publicOrderId: string; payNowSubscriptionId: string; requestedBy: string; reason: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          payNowSubscriptionId: "700000000000000430",
          requestedBy: "billing-support@slybrowser.test",
          reason: "Customer requested support-assisted cancellation.",
        });
        return {
          status: "cancel_at_period_end" as const,
          publicOrderId: input.publicOrderId,
          publicSubscriptionId: "sps_customer_test_123456",
          paidThrough: 2_002_678_400,
          cancelAtPeriodEnd: true as const,
          requestedBy: input.requestedBy,
        };
      }),
    };
    const cancellationClient = {
      cancelSubscription: vi.fn(async (input: { subscriptionId: string; cancelAtPeriodEnd?: boolean }) => {
        expect(input).toEqual({ subscriptionId: "700000000000000430", cancelAtPeriodEnd: true });
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminSubscriptionCancellations: { store: cancellationStore, client: cancellationClient, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/subscription-cancellation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-refund-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "Customer requested support-assisted cancellation." }),
      });
      expect(forbidden.status).toBe(403);

      const invalid = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/subscription-cancellation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-cancel-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "no", refund: true }),
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/subscription-cancellation`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-cancel-rbac-token-secret",
          "content-type": "application/json",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({ reason: "Customer requested support-assisted cancellation." }),
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        status: "cancel_at_period_end",
        publicOrderId: "spo_customer_test_123456",
        publicSubscriptionId: "sps_customer_test_123456",
        cancelAtPeriodEnd: true,
        requestedBy: "billing-support@slybrowser.test",
      });
      expect(cancellationClient.cancelSubscription).toHaveBeenCalledTimes(1);
      expect(cancellationStore.recordAdminSubscriptionCanceled).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("resends license files through licenses:resend RBAC", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const adminAuth = new StaticBillingAdminAuthenticator([
      {
        token: "admin-resend-rbac-token-secret",
        actor: "license-resend@slybrowser.test",
        permissions: ["licenses:resend"],
      },
      {
        token: "admin-rotation-rbac-token-secret",
        actor: "license-ops@slybrowser.test",
        permissions: ["licenses:rotate"],
      },
    ]);
    const resendStore = {
      requestAdminLicenseFileResend: vi.fn(async (input: { publicOrderId: string; requestedBy: string; reason: string }) => {
        expect(input).toEqual({
          publicOrderId: "spo_customer_test_123456",
          requestedBy: "license-resend@slybrowser.test",
          reason: "Customer lost the original license email.",
        });
        return {
          status: "queued" as const,
          publicOrderId: input.publicOrderId,
          outboxId: "00000000-0000-4000-8000-000000000431",
          nextAttemptAt: 2_000_000_050,
          requestedBy: input.requestedBy,
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      adminLicenseResends: { store: resendStore, adminAuth },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const forbidden = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-resend`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-rotation-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "Customer lost the original license email." }),
      });
      expect(forbidden.status).toBe(403);

      const invalid = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-resend`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-resend-rbac-token-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "no", rotate: true }),
      });
      expect(invalid.status).toBe(400);

      const response = await fetch(`${origin}/v1/admin/orders/spo_customer_test_123456/license-resend`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-resend-rbac-token-secret",
          "content-type": "application/json",
          "x-sly-admin-actor": "spoofed@slybrowser.test",
        },
        body: JSON.stringify({ reason: "Customer lost the original license email." }),
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({
        schemaVersion: 1,
        status: "queued",
        publicOrderId: "spo_customer_test_123456",
        outboxId: "00000000-0000-4000-8000-000000000431",
        requestedBy: "license-resend@slybrowser.test",
      });
      expect(resendStore.requestAdminLicenseFileResend).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("accepts feedback honeypot submissions without sending email", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const transport = new MemoryEmailTransport();
    const server = createPayNowBillingHttpServer(receiver, {
      feedbackEmail: {
        transport,
        to: "feedback@slybrowser.com",
      },
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/v1/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bot@example.com",
          category: "general",
          message: "This should look accepted but not send.",
          website: "https://spam.example",
        }),
      });
      expect(response.status).toBe(202);
      expect(transport.sent).toHaveLength(0);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("fails closed when feedback email delivery is not configured", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const server = createPayNowBillingHttpServer(receiver);
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/v1/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          category: "general",
          message: "A real user message that should require configured feedback delivery.",
        }),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "feedback_email_not_configured" },
      });
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("creates PayNow checkout sessions server-side from the canonical plan mapping", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId,
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          authorization: new Headers(init.headers).get("authorization"),
        });
        if (String(url).endsWith("/customers")) {
          return new Response(JSON.stringify({ id: "700000000000000010" }), { status: 200 });
        }
        if (String(url).endsWith("/checkouts")) {
          return new Response(JSON.stringify({
            id: "700000000000000011",
            token: "checkout-token-secret",
            url: "https://checkout.paynow.example/session/700000000000000011",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    });
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    try {
      const intent = store.createCheckoutIntent({
        planId: "studio",
        email: "buyer@example.com",
        emailConfirmation: "buyer@example.com",
        now: 2_000_000_000,
      });
      const checkout = await client.createCheckoutForIntent({
        intent,
        billingEmail: "buyer@example.com",
        returnUrl: "https://slybrowser.com/billing/result?intent_id=test",
        cancelUrl: "https://slybrowser.com/billing/result?intent_id=test&status=cancel",
      });
      expect(checkout).toMatchObject({
        customerId: "700000000000000010",
        checkoutId: "700000000000000011",
        checkoutTokenHash: "17eb0217bd352a4161816d32929eac1a9e7c46a76435ba17a9eabc9914f92c2c",
        checkoutUrl: "https://checkout.paynow.example/session/700000000000000011",
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.authorization === "APIKey pnapi_test_secret")).toBe(true);
      expect(calls[0]!.url).toBe(`https://api.paynow.gg/v1/stores/${storeId}/customers`);
      expect(calls[0]!.body).toEqual({
        name: "SlyBrowser customer",
        metadata: { sly_checkout_intent_id: intent.intentId },
      });
      expect(calls[1]!.url).toBe(`https://api.paynow.gg/v1/stores/${storeId}/checkouts`);
      expect(calls[1]!.body.metadata).toEqual({ sly_checkout_intent_id: intent.intentId });
      expect(calls[1]!.body.lines).toEqual([{
        product_id: "592701920221593600",
        quantity: 1,
        subscription: true,
      }]);
      expect(calls[1]!.body.customer_details).toEqual({ billing_email: "buyer@example.com" });
      expect(JSON.stringify(calls[1]!.body.metadata)).not.toContain("buyer@example.com");
      expect(JSON.stringify(calls[1]!.body.metadata)).not.toContain("studio");
    } finally {
      store.close();
    }
  });

  it("defaults every paid SKU checkout to automatic PayNow renewal", async () => {
    for (const planId of ["launch", "studio", "fleet", "grid"] as const) {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const client = new PayNowManagementClient({
        apiKey: "pnapi_test_secret",
        storeId,
        fetch: async (url, init) => {
          calls.push({
            url: String(url),
            body: JSON.parse(String(init.body)) as Record<string, unknown>,
          });
          if (String(url).endsWith("/customers")) {
            return new Response(JSON.stringify({ id: "700000000000000010" }), { status: 200 });
          }
          if (String(url).endsWith("/checkouts")) {
            return new Response(JSON.stringify({
              id: "700000000000000011",
              token: `checkout-token-${planId}`,
              url: `https://checkout.paynow.example/session/${planId}`,
            }), { status: 200 });
          }
          return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
        },
      });
      const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
      try {
        const intent = store.createCheckoutIntent({
          planId,
          email: "buyer@example.com",
          emailConfirmation: "buyer@example.com",
          now: 2_000_000_000,
        });
        expect(intent).toMatchObject({
          plan: planId,
          sku: planId,
          autoRenew: true,
          billingPeriod: "month",
        });
        await client.createCheckoutForIntent({
          intent,
          billingEmail: "buyer@example.com",
        });
        expect(calls[1]!.body.lines).toEqual([{
          product_id: PAYNOW_PLAN_PRODUCT_IDS[planId],
          quantity: 1,
          subscription: true,
        }]);
      } finally {
        store.close();
      }
    }
  });

  it("cancels PayNow subscriptions at period end through the Management API", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId,
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          authorization: new Headers(init.headers).get("authorization"),
        });
        return new Response(null, { status: 204 });
      },
    });

    await expect(client.cancelSubscription({
      subscriptionId: "700000000000000444",
      cancelAtPeriodEnd: true,
    })).resolves.toBeUndefined();

    expect(calls).toEqual([{
      url: `https://api.paynow.gg/v1/stores/${storeId}/subscriptions/700000000000000444/cancel`,
      body: { cancel_at_period_end: true },
      authorization: "APIKey pnapi_test_secret",
    }]);
  });

  it("refunds PayNow orders through the Management API", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId,
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          authorization: new Headers(init.headers).get("authorization"),
        });
        return new Response(JSON.stringify({
          id: "700000000000000778",
          store_id: storeId,
          payment_id: "700000000000000779",
          customer_id: "700000000000000780",
          status: "completed",
          currency: "USD",
          amount: 4900,
          amount_str: "$49.00",
          gateway_fee_amount: 0,
          gateway_fee_amount_str: "$0.00",
          tax_amount: 0,
          tax_amount_str: "$0.00",
          platform_fee_amount: 0,
          platform_fee_amount_str: "$0.00",
          store_net_amount: 4900,
          store_net_amount_str: "$49.00",
          store_refund_amount: 4900,
          store_refund_amount_str: "$49.00",
          refund_from_connected_user_balance: false,
          created_at: "2033-05-18T03:33:20Z",
          completed_at: "2033-05-18T03:34:20Z",
        }), { status: 200 });
      },
    });

    await expect(client.refundOrder({
      orderId: "700000000000000777",
    })).resolves.toMatchObject({
      payNowRefundId: "700000000000000778",
      payNowPaymentId: "700000000000000779",
      status: "completed",
      amount: 4900,
      currency: "USD",
      createdAt: 2_000_000_000,
      completedAt: 2_000_000_060,
    });
    expect(calls).toEqual([{
      url: `https://api.paynow.gg/v1/stores/${storeId}/orders/700000000000000777/refund`,
      body: {},
      authorization: "APIKey pnapi_test_secret",
    }]);
  });

  it("emits redacted PayNow Management API audit events without secrets or raw responses", async () => {
    const auditEvents: PayNowManagementApiAuditEvent[] = [];
    const client = new PayNowManagementClient({
      apiKey: "pnapi_super_secret",
      storeId,
      auditSink: (event) => auditEvents.push(event),
      fetch: async () => new Response(JSON.stringify({
        code: "rate_limited",
        api_key: "pnapi_super_secret",
        full_response_field_that_must_not_be_logged: "do-not-log-me",
      }), { status: 429 }),
    });
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    try {
      const intent = store.createCheckoutIntent({
        planId: "studio",
        email: "buyer@example.com",
        emailConfirmation: "buyer@example.com",
        now: 2_000_000_000,
      });
      await expect(client.createCheckoutForIntent({
        intent,
        billingEmail: "buyer@example.com",
      })).rejects.toMatchObject({
        code: "paynow_api_error",
        status: 502,
      });
      expect(auditEvents).toEqual([expect.objectContaining({
        operation: "create_customer",
        method: "POST",
        path: "/customers",
        outcome: "failure",
        status: 429,
        errorCode: "paynow_api_error",
        payNowCode: "rate_limited",
      })]);
      const serialized = JSON.stringify(auditEvents);
      expect(serialized).not.toContain("pnapi_super_secret");
      expect(serialized).not.toContain("api_key");
      expect(serialized).not.toContain("do-not-log-me");
      expect(serialized).not.toContain("buyer@example.com");
    } finally {
      store.close();
    }
  });

  it("rate limits PayNow Management API calls through one client queue", async () => {
    const sleeps: number[] = [];
    const calls: string[] = [];
    let fakeNow = 0;
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId,
      rateLimit: {
        requestsPerMinute: 60,
        now: () => fakeNow,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          fakeNow += milliseconds;
        },
      },
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/customers")) {
          return new Response(JSON.stringify({ id: "700000000000000010" }), { status: 200 });
        }
        if (String(url).endsWith("/checkouts")) {
          return new Response(JSON.stringify({
            id: "700000000000000011",
            token: "checkout-token-secret",
            url: "https://checkout.paynow.example/session/700000000000000011",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    });
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    try {
      const intent = store.createCheckoutIntent({
        planId: "studio",
        email: "buyer@example.com",
        emailConfirmation: "buyer@example.com",
        now: 2_000_000_000,
      });
      await expect(client.createCheckoutForIntent({
        intent,
        billingEmail: "buyer@example.com",
      })).resolves.toMatchObject({
        customerId: "700000000000000010",
        checkoutId: "700000000000000011",
      });
      expect(calls).toHaveLength(2);
      expect(sleeps).toEqual([1000]);
    } finally {
      store.close();
    }
  });

  it("verifies first payment facts against PayNow payment, order and subscription APIs", async () => {
    const calls: string[] = [];
    const checkoutIntentId = "ci_paymentverifiedintent0001";
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId,
      fetch: async (url, init) => {
        calls.push(`${init.method} ${String(url)}`);
        if (String(url).endsWith("/payments/700000000000000020")) {
          return new Response(JSON.stringify({
            id: "700000000000000020",
            store_id: storeId,
            order_id: "700000000000000021",
            customer_id: "700000000000000002",
            customer: {
              id: "700000000000000002",
              store_id: storeId,
              metadata: { sly_checkout_intent_id: checkoutIntentId },
              created_at: "2033-05-18T03:00:00Z",
            },
            gateway: "stripe",
            currency: "USD",
            amount: 4900,
            gateway_fee_amount: 0,
            tax_amount: 0,
            platform_fee_amount: 0,
            store_net_amount: 4900,
            status: "completed",
            completed_at: "2033-05-18T03:33:20Z",
          }), { status: 200 });
        }
        if (String(url).endsWith("/orders/700000000000000021")) {
          return new Response(JSON.stringify({
            id: "700000000000000021",
            store_id: storeId,
            customer_id: "700000000000000002",
            customer: {
              id: "700000000000000002",
              store_id: storeId,
              metadata: { sly_checkout_intent_id: checkoutIntentId },
              created_at: "2033-05-18T03:00:00Z",
            },
            checkout_id: "700000000000000010",
            subscription_id: "700000000000000001",
            type: "subscription_initial",
            status: "completed",
            is_subscription: true,
            currency: "USD",
            total_amount: 4900,
            lines: [{
              id: "700000000000000022",
              product_id: "592701920221593600",
              product_name: "Studio",
              quantity: 1,
              total_amount: 4900,
            }],
          }), { status: 200 });
        }
        if (String(url).endsWith("/subscriptions/700000000000000001")) {
          return new Response(JSON.stringify({
            id: "700000000000000001",
            store_id: storeId,
            customer: {
              id: "700000000000000002",
              store_id: storeId,
              metadata: { sly_checkout_intent_id: checkoutIntentId },
              created_at: "2033-05-18T03:00:00Z",
            },
            checkout_id: "700000000000000010",
            product_id: "592701920221593600",
            status: "active",
            current_period_start: "2033-05-18T03:33:20Z",
            current_period_end: "2033-06-18T03:33:20Z",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    });

    await expect(client.verifyFirstPayment({
      paymentId: "700000000000000020",
      storeId,
      orderId: "700000000000000021",
      amount: 4900,
      currency: "USD",
      completedAt: 2_000_000_000,
    })).resolves.toMatchObject({
      checkoutIntentId,
      payNowCheckoutId: "700000000000000010",
      payNowOrderId: "700000000000000021",
      payNowPaymentId: "700000000000000020",
      payNowSubscriptionId: "700000000000000001",
      payNowCustomerId: "700000000000000002",
      amount: 4900,
      currency: "USD",
      currentPeriodStart: 2_000_000_000,
      currentPeriodEnd: 2_002_678_400,
    });
    expect(calls).toEqual([
      `GET https://api.paynow.gg/v1/stores/${storeId}/payments/700000000000000020`,
      `GET https://api.paynow.gg/v1/stores/${storeId}/orders/700000000000000021`,
      `GET https://api.paynow.gg/v1/stores/${storeId}/subscriptions/700000000000000001`,
    ]);
  });

  it("fails closed for mismatched PayNow confirmation facts and isolated test products", async () => {
    const checkoutIntentId = "ci_paymentverifiedintent0002";
    const verifiedPaymentEvent = {
      paymentId: "700000000000000020",
      storeId,
      orderId: "700000000000000021",
      amount: 4900,
      currency: "USD",
      completedAt: 2_000_000_000,
    };
    const basePayment = {
      id: "700000000000000020",
      store_id: storeId,
      order_id: "700000000000000021",
      customer_id: "700000000000000002",
      customer: {
        id: "700000000000000002",
        store_id: storeId,
        metadata: { sly_checkout_intent_id: checkoutIntentId },
        created_at: "2033-05-18T03:00:00Z",
      },
      gateway: "stripe",
      currency: "USD",
      amount: 4900,
      status: "completed",
      completed_at: "2033-05-18T03:33:20Z",
    };
    const baseOrder = {
      id: "700000000000000021",
      store_id: storeId,
      customer_id: "700000000000000002",
      customer: {
        id: "700000000000000002",
        store_id: storeId,
        metadata: { sly_checkout_intent_id: checkoutIntentId },
        created_at: "2033-05-18T03:00:00Z",
      },
      checkout_id: "700000000000000010",
      subscription_id: "700000000000000001",
      type: "subscription_initial",
      status: "completed",
      is_subscription: true,
      currency: "USD",
      total_amount: 4900,
      lines: [{
        id: "700000000000000022",
        product_id: "592701920221593600",
        product_name: "Studio",
        quantity: 1,
        total_amount: 4900,
      }],
    };
    const baseSubscription = {
      id: "700000000000000001",
      store_id: storeId,
      customer: {
        id: "700000000000000002",
        store_id: storeId,
        metadata: { sly_checkout_intent_id: checkoutIntentId },
        created_at: "2033-05-18T03:00:00Z",
      },
      checkout_id: "700000000000000010",
      product_id: "592701920221593600",
      status: "active",
      current_period_start: "2033-05-18T03:33:20Z",
      current_period_end: "2033-06-18T03:33:20Z",
    };
    function clientWith(overrides: {
      payment?: Record<string, unknown>;
      order?: Record<string, unknown>;
      subscription?: Record<string, unknown>;
    }): PayNowManagementClient {
      return new PayNowManagementClient({
        apiKey: "pnapi_test_secret",
        storeId,
        fetch: async (url) => {
          if (String(url).endsWith("/payments/700000000000000020")) {
            return new Response(JSON.stringify({ ...basePayment, ...overrides.payment }), { status: 200 });
          }
          if (String(url).endsWith("/orders/700000000000000021")) {
            return new Response(JSON.stringify({ ...baseOrder, ...overrides.order }), { status: 200 });
          }
          if (String(url).endsWith("/subscriptions/700000000000000001")) {
            return new Response(JSON.stringify({ ...baseSubscription, ...overrides.subscription }), { status: 200 });
          }
          return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
        },
      });
    }

    await expect(clientWith({ payment: { amount: 5000 } }).verifyFirstPayment(verifiedPaymentEvent))
      .rejects.toMatchObject({ code: "paynow_second_confirmation_mismatch", status: 409 });
    await expect(clientWith({ payment: { currency: "EUR" } }).verifyFirstPayment(verifiedPaymentEvent))
      .rejects.toMatchObject({ code: "paynow_second_confirmation_mismatch", status: 409 });
    await expect(clientWith({ order: { total_amount: 5000 } }).verifyFirstPayment(verifiedPaymentEvent))
      .rejects.toMatchObject({ code: "paynow_second_confirmation_mismatch", status: 409 });
    await expect(clientWith({
      order: {
        lines: [{
          id: "700000000000000022",
          product_id: "700000000000000099",
          product_name: "Unknown",
          quantity: 1,
          total_amount: 4900,
        }],
      },
    }).verifyFirstPayment(verifiedPaymentEvent))
      .rejects.toMatchObject({ code: "paynow_product_unmapped", status: 400 });
    await expect(clientWith({
      order: {
        lines: [{
          id: "700000000000000022",
          product_id: "592719053055860736",
          product_name: "PayNow recurring billing test",
          quantity: 1,
          total_amount: 4900,
        }],
      },
      subscription: { product_id: "592719053055860736" },
    }).verifyFirstPayment(verifiedPaymentEvent)).resolves.toBeUndefined();
  });

  it("verifies renewal payment facts against PayNow payment, order and subscription APIs", async () => {
    const calls: string[] = [];
    const checkoutIntentId = "ci_renewalverifiedintent001";
    const renewalStart = Math.floor(Date.parse("2033-06-18T03:33:20Z") / 1000);
    const renewalEnd = Math.floor(Date.parse("2033-07-18T03:33:20Z") / 1000);
    const client = new PayNowManagementClient({
      apiKey: "pnapi_test_secret",
      storeId,
      fetch: async (url, init) => {
        calls.push(`${init.method} ${String(url)}`);
        if (String(url).endsWith("/payments/700000000000000030")) {
          return new Response(JSON.stringify({
            id: "700000000000000030",
            store_id: storeId,
            order_id: "700000000000000031",
            customer_id: "700000000000000002",
            customer: {
              id: "700000000000000002",
              store_id: storeId,
              metadata: { sly_checkout_intent_id: checkoutIntentId },
              created_at: "2033-05-18T03:00:00Z",
            },
            gateway: "stripe",
            currency: "USD",
            amount: 4900,
            status: "completed",
            completed_at: "2033-06-18T03:33:20Z",
          }), { status: 200 });
        }
        if (String(url).endsWith("/orders/700000000000000031")) {
          return new Response(JSON.stringify({
            id: "700000000000000031",
            store_id: storeId,
            customer_id: "700000000000000002",
            customer: {
              id: "700000000000000002",
              store_id: storeId,
              metadata: { sly_checkout_intent_id: checkoutIntentId },
              created_at: "2033-05-18T03:00:00Z",
            },
            checkout_id: "700000000000000010",
            subscription_id: "700000000000000001",
            type: "subscription_renewal",
            status: "completed",
            is_subscription: true,
            currency: "USD",
            total_amount: 4900,
            lines: [{
              id: "700000000000000032",
              product_id: "592701920221593600",
              product_name: "Studio",
              quantity: 1,
              total_amount: 4900,
            }],
          }), { status: 200 });
        }
        if (String(url).endsWith("/subscriptions/700000000000000001")) {
          return new Response(JSON.stringify({
            id: "700000000000000001",
            store_id: storeId,
            customer: {
              id: "700000000000000002",
              store_id: storeId,
              metadata: { sly_checkout_intent_id: checkoutIntentId },
              created_at: "2033-05-18T03:00:00Z",
            },
            checkout_id: "700000000000000010",
            product_id: "592701920221593600",
            status: "active",
            current_period_start: "2033-06-18T03:33:20Z",
            current_period_end: "2033-07-18T03:33:20Z",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    });

    const event = {
      paymentId: "700000000000000030",
      storeId,
      orderId: "700000000000000031",
      amount: 4900,
      currency: "USD",
      completedAt: renewalStart,
    };
    await expect(client.verifyFirstPayment(event)).resolves.toBeUndefined();
    await expect(client.verifyRenewalPayment!(event)).resolves.toMatchObject({
      checkoutIntentId,
      payNowCheckoutId: "700000000000000010",
      payNowOrderId: "700000000000000031",
      payNowPaymentId: "700000000000000030",
      payNowSubscriptionId: "700000000000000001",
      payNowCustomerId: "700000000000000002",
      amount: 4900,
      currency: "USD",
      currentPeriodStart: renewalStart,
      currentPeriodEnd: renewalEnd,
    });
    expect(calls).toHaveLength(5);
  });

  it("serves checkout URLs without exposing PayNow tokens when a checkout client is configured", async () => {
    const store = new PayNowWebhookStore(":memory:", { emailEncryptionKey: emailKey });
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const checkoutClient = {
      createCheckoutForIntent: vi.fn(async ({ intent, returnUrl, cancelUrl }) => {
        expect(returnUrl).toBe(`https://slybrowser.com/billing/result?intent_id=${encodeURIComponent(intent.intentId)}&status=return`);
        expect(cancelUrl).toBe(`https://slybrowser.com/billing/result?intent_id=${encodeURIComponent(intent.intentId)}&status=cancel`);
        return {
          customerId: "700000000000000012",
          checkoutId: "700000000000000013",
          checkoutToken: "secret-token-not-returned",
          checkoutTokenHash: "00".repeat(32),
          checkoutUrl: "https://checkout.paynow.example/session/700000000000000013",
        };
      }),
    };
    const server = createPayNowBillingHttpServer(receiver, {
      checkoutClient,
      publicOrigin: "https://slybrowser.com",
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "repeat-http-checkout-0001" },
        body: JSON.stringify({
          plan_id: "fleet",
          email: "buyer@example.com",
          email_confirmation: "buyer@example.com",
          idempotency_key: "repeat-http-checkout-0001",
        }),
      });
      expect(response.status).toBe(201);
      const payload = await response.json();
      expect(payload).toMatchObject({
        schemaVersion: 1,
        status: "checkout_created",
        plan: {
          id: "fleet",
          monthlyPriceCents: 19900,
          currency: "USD",
          billingPeriod: "month",
          concurrency: 200,
        },
        checkout: {
          id: "700000000000000013",
          url: "https://checkout.paynow.example/session/700000000000000013",
        },
      });
      expect(JSON.stringify(payload)).not.toContain("secret-token-not-returned");
      expect(JSON.stringify(payload)).not.toContain("buyer@example.com");
      expect(checkoutClient.createCheckoutForIntent).toHaveBeenCalledTimes(1);

      const repeated = await fetch(`${origin}/v1/billing/checkout-intents`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "repeat-http-checkout-0001" },
        body: JSON.stringify({
          plan_id: "fleet",
          email: "buyer@example.com",
          email_confirmation: "buyer@example.com",
          idempotency_key: "repeat-http-checkout-0001",
        }),
      });
      expect(repeated.status).toBe(201);
      const repeatedPayload = await repeated.json();
      expect(repeatedPayload.intentId).toBe(payload.intentId);
      expect(repeatedPayload.statusToken).toBe(payload.statusToken);
      expect(repeatedPayload.checkout).toEqual(payload.checkout);
      expect(checkoutClient.createCheckoutForIntent).toHaveBeenCalledTimes(1);

      const statusResponse = await fetch(
        `${origin}/v1/billing/checkout-intents/${encodeURIComponent(payload.intentId)}/status?status=success`,
        { headers: { "x-sly-checkout-status-token": payload.statusToken } },
      );
      expect(statusResponse.status).toBe(200);
      const statusPayload = await statusResponse.json();
      expect(statusPayload).toMatchObject({
        schemaVersion: 1,
        intentId: payload.intentId,
        status: "checkout_created",
        plan: {
          id: "fleet",
          monthlyPriceCents: 19900,
          currency: "USD",
          billingPeriod: "month",
          concurrency: 200,
        },
        maskedEmail: "b***r@e*****e.com",
      });
      expect(JSON.stringify(statusPayload)).not.toContain("700000000000000012");
      expect(JSON.stringify(statusPayload)).not.toContain("700000000000000013");
      expect(JSON.stringify(statusPayload)).not.toContain("secret-token-not-returned");

      const forgedStatus = await fetch(
        `${origin}/v1/billing/checkout-intents/${encodeURIComponent(payload.intentId)}/status?status=success`,
        { headers: { "x-sly-checkout-status-token": "cis_wrong" } },
      );
      expect(forgedStatus.status).toBe(404);
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("verifies, normalizes and deduplicates subscription activation", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const body = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000003");
      await expect(signed(receiver, body)).resolves.toEqual({ status: "processed", eventId: "700000000000000003" });
      await expect(signed(receiver, body)).resolves.toEqual({ status: "duplicate", eventId: "700000000000000003" });
      expect(store.subscription("700000000000000001")).toMatchObject({
        customerId: "700000000000000002",
        plan: "studio",
        status: "active",
        accountId: "account-test",
        licenseId: "license-test",
      });
    } finally {
      store.close();
    }
  });

  it("rejects the same PayNow event ID when the payload hash changes", async () => {
    const store = new PayNowWebhookStore(":memory:");
    const alerts: PayNowSecurityAlertEvent[] = [];
    try {
      const receiver = new PayNowWebhookReceiver(store, {
        signingSecrets: [secret],
        storeId,
        now: () => now,
        securityAlertSink: (event) => alerts.push(event),
      });
      const body = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000010", "2033-05-19T03:33:20Z");
      const conflicting = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000010", "2033-05-20T03:33:20Z");
      await expect(signed(receiver, body)).resolves.toEqual({ status: "processed", eventId: "700000000000000010" });
      await expect(signed(receiver, conflicting))
        .rejects.toMatchObject({ code: "paynow_event_conflict", status: 409 });
      expect(alerts).toEqual([expect.objectContaining({
        kind: "paynow_event_conflict",
        eventId: "700000000000000010",
        eventType: "ON_SUBSCRIPTION_ACTIVATED",
        payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        errorCode: "paynow_event_conflict",
      })]);
      expect(JSON.stringify(alerts)).not.toContain("current_period_end");
    } finally {
      store.close();
    }
  });

  it("fails closed for payment-completed webhooks without second confirmation", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      await expect(signed(receiver, paymentPayload("700000000000000030")))
        .rejects.toMatchObject({ code: "paynow_second_confirmation_required", status: 503 });
      expect(store.paymentLogs()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("accepts order, refund and chargeback event-only webhooks through the idempotent event ledger", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const cases = [
        ["ON_ORDER_COMPLETED", "700000000000000041"],
        ["ON_REFUND", "700000000000000042"],
        ["ON_CHARGEBACK", "700000000000000043"],
        ["ON_CHARGEBACK_CLOSED", "700000000000000044"],
      ] as const;
      for (const [eventType, eventId] of cases) {
        const body = eventOnlyPayload(eventType, eventId);
        await expect(signed(receiver, body)).resolves.toEqual({ status: "processed", eventId });
        await expect(signed(receiver, body)).resolves.toEqual({ status: "duplicate", eventId });
      }
      expect(store.subscription("700000000000000001")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("validates amount and currency fields when event-only PayNow webhooks include them", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      await expect(signed(receiver, eventOnlyPayload("ON_REFUND", "700000000000000045", { currency: "EUR" })))
        .rejects.toMatchObject({ code: "invalid_request", status: 400 });
      await expect(signed(receiver, eventOnlyPayload("ON_CHARGEBACK", "700000000000000046", { amount: -1 })))
        .rejects.toMatchObject({ code: "invalid_request", status: 400 });
      await expect(signed(receiver, eventOnlyPayload("ON_ORDER_COMPLETED", "700000000000000047", {
        lines: [{ product_id: "700000000000000099" }],
      })))
        .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    } finally {
      store.close();
    }
  });

  it("records a second-confirmed first payment instead of trusting the webhook directly", async () => {
    const store = new PayNowWebhookStore(":memory:");
    const apply = vi.spyOn(store, "apply");
    const verifier = {
      verifyFirstPayment: vi.fn(async () => ({
        payNowCheckoutId: "700000000000000010",
        payNowOrderId: "700000000000000021",
        payNowPaymentId: "700000000000000020",
        payNowSubscriptionId: "700000000000000001",
        payNowCustomerId: "700000000000000002",
        amount: 4900,
        currency: "USD",
        currentPeriodStart: 2_000_000_000,
        currentPeriodEnd: 2_002_678_400,
      })),
    };
    const recorder = {
      recordVerifiedFirstPayment: vi.fn(async () => ({ status: "processed" as const })),
    };
    try {
      const receiver = new PayNowWebhookReceiver(store, {
        signingSecrets: [secret],
        storeId,
        now: () => now,
        firstPayment: { verifier, recorder },
      });
      await expect(signed(receiver, paymentPayload("700000000000000031", {
        billing_email: "paynow-only@example.net",
      })))
        .resolves.toEqual({ status: "processed", eventId: "700000000000000031" });
      expect(verifier.verifyFirstPayment).toHaveBeenCalledWith(expect.objectContaining({
        paymentId: "700000000000000020",
        orderId: "700000000000000021",
        amount: 4900,
        currency: "USD",
      }));
      expect(JSON.stringify(verifier.verifyFirstPayment.mock.calls[0]![0])).not.toContain("paynow-only@example.net");
      expect(recorder.recordVerifiedFirstPayment).toHaveBeenCalledWith(expect.objectContaining({
        payNowCheckoutId: "700000000000000010",
        sourceEventId: "700000000000000031",
        sourceEventType: "ON_PAYMENT_COMPLETED",
        sourcePayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        now: 2_000_000_000,
      }));
      expect(JSON.stringify(recorder.recordVerifiedFirstPayment.mock.calls[0]![0])).not.toContain("paynow-only@example.net");
      expect(apply).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("queues payment-completed webhooks when PayNow second confirmation is temporarily unavailable", async () => {
    const store = new PayNowWebhookStore(":memory:");
    const apply = vi.spyOn(store, "apply");
    const verifier = {
      verifyFirstPayment: vi.fn(async () => {
        throw new ServiceError("paynow_api_unreachable", "PayNow Management API is unavailable", 502);
      }),
    };
    const recorder = {
      recordVerifiedFirstPayment: vi.fn(async () => ({ status: "processed" as const })),
    };
    const pendingQueue = {
      recordPendingFirstPayment: vi.fn(async () => "queued" as const),
      claimPendingFirstPayments: vi.fn(async () => []),
      markPendingFirstPaymentProcessed: vi.fn(async () => undefined),
      markPendingFirstPaymentFailed: vi.fn(async () => "pending" as const),
    };
    try {
      const receiver = new PayNowWebhookReceiver(store, {
        signingSecrets: [secret],
        storeId,
        now: () => now,
        firstPayment: { verifier, recorder, pendingQueue },
      });
      await expect(signed(receiver, paymentPayload("700000000000000032")))
        .resolves.toEqual({ status: "pending", eventId: "700000000000000032" });
      expect(pendingQueue.recordPendingFirstPayment).toHaveBeenCalledWith(expect.objectContaining({
        eventId: "700000000000000032",
        eventType: "ON_PAYMENT_COMPLETED",
        payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        errorCode: "paynow_api_unreachable",
        now: 2_000_000_000,
        nextAttemptAt: 2_000_000_060,
        payment: expect.objectContaining({
          paymentId: "700000000000000020",
          orderId: "700000000000000021",
          amount: 4900,
          currency: "USD",
        }),
      }));
      expect(recorder.recordVerifiedFirstPayment).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("records a second-confirmed renewal payment without creating a new license file", async () => {
    const store = new PayNowWebhookStore(":memory:");
    const apply = vi.spyOn(store, "apply");
    const verifier = {
      verifyFirstPayment: vi.fn(async () => undefined),
      verifyRenewalPayment: vi.fn(async () => ({
        payNowCheckoutId: "700000000000000010",
        payNowOrderId: "700000000000000041",
        payNowPaymentId: "700000000000000040",
        payNowSubscriptionId: "700000000000000001",
        payNowCustomerId: "700000000000000002",
        amount: 4900,
        currency: "USD",
        currentPeriodStart: 2_002_678_400,
        currentPeriodEnd: 2_005_270_400,
      })),
    };
    const recorder = {
      recordVerifiedFirstPayment: vi.fn(async () => ({ status: "processed" as const })),
      recordVerifiedRenewalPayment: vi.fn(async () => ({ status: "processed" as const })),
    };
    try {
      const receiver = new PayNowWebhookReceiver(store, {
        signingSecrets: [secret],
        storeId,
        now: () => now,
        firstPayment: { verifier, recorder },
      });
      await expect(signed(receiver, paymentPayload("700000000000000034")))
        .resolves.toEqual({ status: "processed", eventId: "700000000000000034" });
      expect(verifier.verifyFirstPayment).toHaveBeenCalled();
      expect(verifier.verifyRenewalPayment).toHaveBeenCalledWith(expect.objectContaining({
        paymentId: "700000000000000020",
        orderId: "700000000000000021",
      }));
      expect(recorder.recordVerifiedFirstPayment).not.toHaveBeenCalled();
      expect(recorder.recordVerifiedRenewalPayment).toHaveBeenCalledWith(expect.objectContaining({
        payNowPaymentId: "700000000000000040",
        sourceEventId: "700000000000000034",
        sourceEventType: "ON_PAYMENT_COMPLETED",
        sourcePayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      expect(apply).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("retries pending first payments and marks duplicate-safe completion", async () => {
    const task = {
      eventId: "700000000000000040",
      eventType: "ON_PAYMENT_COMPLETED" as const,
      payloadSha256: "cd".repeat(32),
      payment: {
        paymentId: "700000000000000020",
        storeId,
        orderId: "700000000000000021",
        amount: 4900,
        currency: "USD",
        completedAt: 2_000_000_000,
      },
      attempts: 0,
      lastErrorCode: "paynow_api_unreachable",
      lastErrorMessage: "PayNow Management API is unavailable",
      nextAttemptAt: 2_000_000_060,
      createdAt: 2_000_000_000,
      updatedAt: 2_000_000_000,
    };
    const queue = {
      recordPendingFirstPayment: vi.fn(async () => "queued" as const),
      claimPendingFirstPayments: vi.fn(async () => [task]),
      recordVerifiedFirstPayment: vi.fn(async () => ({ status: "processed" as const })),
      markPendingFirstPaymentProcessed: vi.fn(async () => undefined),
      markPendingFirstPaymentFailed: vi.fn(async () => "pending" as const),
    };
    const verifier = {
      verifyFirstPayment: vi.fn(async () => ({
        payNowCheckoutId: "700000000000000010",
        payNowOrderId: "700000000000000021",
        payNowPaymentId: "700000000000000020",
        payNowSubscriptionId: "700000000000000001",
        payNowCustomerId: "700000000000000002",
        amount: 4900,
        currency: "USD",
        currentPeriodStart: 2_000_000_000,
        currentPeriodEnd: 2_002_678_400,
      })),
    };

    await expect(retryPendingFirstPayments(queue, verifier, { now: 2_000_000_100, maxAttempts: 5 }))
      .resolves.toEqual({
        claimed: 1,
        processed: 1,
        duplicate: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
      });
    expect(queue.claimPendingFirstPayments).toHaveBeenCalledWith(expect.objectContaining({
      now: 2_000_000_100,
      maxAttempts: 5,
    }));
    expect(queue.recordVerifiedFirstPayment).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: task.eventId,
      sourceEventType: "ON_PAYMENT_COMPLETED",
      sourcePayloadSha256: task.payloadSha256,
      now: 2_000_000_100,
    }));
    expect(queue.markPendingFirstPaymentProcessed).toHaveBeenCalledWith({
      eventId: task.eventId,
      payloadSha256: task.payloadSha256,
      now: 2_000_000_100,
    });
    expect(queue.markPendingFirstPaymentFailed).not.toHaveBeenCalled();
  });

  it("retries pending renewal payments and records them through the renewal transaction", async () => {
    const task = {
      eventId: "700000000000000042",
      eventType: "ON_PAYMENT_COMPLETED" as const,
      payloadSha256: "ac".repeat(32),
      payment: {
        paymentId: "700000000000000030",
        storeId,
        orderId: "700000000000000031",
        amount: 4900,
        currency: "USD",
        completedAt: 2_002_678_400,
      },
      attempts: 0,
      lastErrorCode: "paynow_api_unreachable",
      lastErrorMessage: "PayNow Management API is unavailable",
      nextAttemptAt: 2_000_000_060,
      createdAt: 2_000_000_000,
      updatedAt: 2_000_000_000,
    };
    const queue = {
      recordPendingFirstPayment: vi.fn(async () => "queued" as const),
      claimPendingFirstPayments: vi.fn(async () => [task]),
      recordVerifiedFirstPayment: vi.fn(async () => ({ status: "processed" as const })),
      recordVerifiedRenewalPayment: vi.fn(async () => ({ status: "processed" as const })),
      markPendingFirstPaymentProcessed: vi.fn(async () => undefined),
      markPendingFirstPaymentFailed: vi.fn(async () => "pending" as const),
    };
    const verifier = {
      verifyFirstPayment: vi.fn(async () => undefined),
      verifyRenewalPayment: vi.fn(async () => ({
        payNowCheckoutId: "700000000000000010",
        payNowOrderId: "700000000000000031",
        payNowPaymentId: "700000000000000030",
        payNowSubscriptionId: "700000000000000001",
        payNowCustomerId: "700000000000000002",
        amount: 4900,
        currency: "USD",
        currentPeriodStart: 2_002_678_400,
        currentPeriodEnd: 2_005_270_400,
      })),
    };

    await expect(retryPendingFirstPayments(queue, verifier, { now: 2_000_000_100, maxAttempts: 5 }))
      .resolves.toEqual({
        claimed: 1,
        processed: 1,
        duplicate: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
      });
    expect(queue.recordVerifiedFirstPayment).not.toHaveBeenCalled();
    expect(queue.recordVerifiedRenewalPayment).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: task.eventId,
      sourceEventType: "ON_PAYMENT_COMPLETED",
      sourcePayloadSha256: task.payloadSha256,
      now: 2_000_000_100,
    }));
    expect(queue.markPendingFirstPaymentProcessed).toHaveBeenCalledWith({
      eventId: task.eventId,
      payloadSha256: task.payloadSha256,
      now: 2_000_000_100,
    });
    expect(queue.markPendingFirstPaymentFailed).not.toHaveBeenCalled();
  });

  it("keeps retryable pending first payments queued after temporary retry failures", async () => {
    const task = {
      eventId: "700000000000000041",
      eventType: "ON_PAYMENT_COMPLETED" as const,
      payloadSha256: "ef".repeat(32),
      payment: {
        paymentId: "700000000000000020",
        storeId,
        orderId: "700000000000000021",
        amount: 4900,
        currency: "USD",
        completedAt: 2_000_000_000,
      },
      attempts: 1,
      lastErrorCode: "paynow_api_unreachable",
      lastErrorMessage: "PayNow Management API is unavailable",
      nextAttemptAt: 2_000_000_060,
      createdAt: 2_000_000_000,
      updatedAt: 2_000_000_000,
    };
    const queue = {
      recordPendingFirstPayment: vi.fn(async () => "queued" as const),
      claimPendingFirstPayments: vi.fn(async () => [task]),
      recordVerifiedFirstPayment: vi.fn(async () => ({ status: "processed" as const })),
      markPendingFirstPaymentProcessed: vi.fn(async () => undefined),
      markPendingFirstPaymentFailed: vi.fn(async () => "pending" as const),
    };
    const verifier = {
      verifyFirstPayment: vi.fn(async () => {
        throw new ServiceError("paynow_api_unreachable", "PayNow Management API is unavailable", 502);
      }),
    };

    await expect(retryPendingFirstPayments(queue, verifier, { now: 2_000_000_100, maxAttempts: 5 }))
      .resolves.toEqual({
        claimed: 1,
        processed: 0,
        duplicate: 0,
        retried: 1,
        failed: 0,
        skipped: 0,
      });
    expect(queue.markPendingFirstPaymentFailed).toHaveBeenCalledWith(expect.objectContaining({
      eventId: task.eventId,
      payloadSha256: task.payloadSha256,
      errorCode: "paynow_api_unreachable",
      maxAttempts: 5,
    }));
    expect(queue.recordVerifiedFirstPayment).not.toHaveBeenCalled();
    expect(queue.markPendingFirstPaymentProcessed).not.toHaveBeenCalled();
  });

  it("extends the paid-through period and keeps canceled subscriptions closed against late active events", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      await signed(receiver, payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000004", "2033-05-19T03:33:20Z"));
      await signed(receiver, payload("ON_SUBSCRIPTION_RENEWED", "700000000000000005", "2033-06-19T03:33:20Z"));
      const renewed = store.subscription("700000000000000001")!;
      await signed(receiver, payload("ON_SUBSCRIPTION_RENEWED", "700000000000000011", "2033-05-25T03:33:20Z"));
      expect(store.subscription("700000000000000001")!.currentPeriodEnd).toBe(renewed.currentPeriodEnd);
      await signed(receiver, payload("ON_SUBSCRIPTION_CANCELED", "700000000000000006", "2033-06-19T03:33:20Z"));
      const canceled = store.subscription("700000000000000001")!;
      expect(canceled.currentPeriodEnd).toBe(renewed.currentPeriodEnd);
      expect(canceled.status).toBe("canceled");
      expect(canceled.canceledAt).not.toBeNull();
      await signed(receiver, payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000012", "2033-05-20T03:33:20Z"));
      expect(store.subscription("700000000000000001")).toMatchObject({
        currentPeriodEnd: renewed.currentPeriodEnd,
        status: "canceled",
        canceledAt: canceled.canceledAt,
      });
    } finally {
      store.close();
    }
  });

  it("accepts and deduplicates the isolated recurring billing test without granting a plan", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const body = payload(
        "ON_SUBSCRIPTION_ACTIVATED",
        "700000000000000009",
        "2033-05-19T03:33:20Z",
        "592719053055860736",
      );
      await expect(signed(receiver, body)).resolves.toEqual({ status: "processed", eventId: "700000000000000009" });
      await expect(signed(receiver, body)).resolves.toEqual({ status: "duplicate", eventId: "700000000000000009" });
      expect(store.subscription("700000000000000001")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects invalid signatures, stale timestamps and unknown products", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const body = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000007");
      await expect(receiver.receive(body, String(now), Buffer.alloc(32).toString("base64")))
        .rejects.toMatchObject({ code: "paynow_signature_invalid", status: 401 });
      await expect(signed(receiver, body, now - 5 * 60 * 1000 - 1))
        .rejects.toMatchObject({ code: "paynow_timestamp_invalid", status: 401 });
      const unknown = Buffer.from(body.toString("utf8").replace("592701920221593600", "700000000000000099"));
      await expect(signed(receiver, unknown))
        .rejects.toMatchObject({ code: "invalid_request", status: 400 });
    } finally {
      store.close();
    }
  });

  it("serves health and accepts the signed raw payload over HTTP", async () => {
    const store = new PayNowWebhookStore(":memory:");
    const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
    const server = createPayNowBillingHttpServer(receiver);
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server address is invalid");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${origin}/v1/billing/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok", service: "slybrowser-billing" });

      const body = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000008");
      const requestTimestamp = String(now);
      const signature = createHmac("sha256", secret)
        .update(`${requestTimestamp}.`)
        .update(body)
        .digest("base64");
      const response = await fetch(`${origin}/v1/billing/paynow/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "paynow-timestamp": requestTimestamp,
          "paynow-signature": signature,
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "processed", eventId: "700000000000000008" });
      expect(response.headers.get("cache-control")).toBe("no-store, private, max-age=0");

      const failed = await fetch(`${origin}/v1/billing/paynow/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "paynow-timestamp": requestTimestamp,
          "paynow-signature": Buffer.alloc(32).toString("base64"),
        },
        body,
      });
      expect(failed.status).toBe(401);

      const logs = store.paymentLogs();
      expect(logs).toHaveLength(2);
      expect(logs.find((entry) => entry.outcome === "success")).toMatchObject({
        processingResult: "processed",
        httpStatus: 200,
        verificationStatus: "verified",
        eventId: "700000000000000008",
        productId: "592701920221593600",
        checkoutId: "700000000000000010",
      });
      expect(logs.find((entry) => entry.outcome === "failure")).toMatchObject({
        processingResult: "rejected",
        httpStatus: 401,
        verificationStatus: "invalid",
        errorCode: "paynow_signature_invalid",
      });
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("account-test");
      expect(serialized).not.toContain("sly_account_id");
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });

  it("retains structured payment logs for 90 days and prunes only diagnostic rows", async () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      await expect(signed(receiver, payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000033")))
        .resolves.toEqual({ status: "processed", eventId: "700000000000000033" });
      const old = store.recordPaymentLog({
        rawBody: Buffer.from("{}"),
        receivedAt: 100,
        outcome: "failure",
        processingResult: "rejected",
        httpStatus: 400,
        verificationStatus: "unverified",
        durationMilliseconds: 3,
        errorCode: "invalid_request",
        errorMessage: "Invalid request",
      });
      const current = store.recordPaymentLog({
        rawBody: Buffer.from("{}"),
        receivedAt: 200,
        outcome: "success",
        processingResult: "processed",
        httpStatus: 200,
        verificationStatus: "verified",
        durationMilliseconds: 2,
      });
      expect(old.expiresAt - old.receivedAt).toBe(PAYNOW_PAYMENT_LOG_RETENTION_SECONDS);
      expect(store.prunePaymentLogs(old.expiresAt)).toBe(1);
      expect(store.paymentLogs()).toEqual([current]);
      expect(store.subscription("700000000000000001")).toMatchObject({
        status: "active",
        plan: "studio",
        lastEventId: "700000000000000033",
      });
    } finally {
      store.close();
    }
  });

  const postgresUrl = process.env.SLY_TEST_POSTGRES_URL;
  const describePostgres = postgresUrl ? describe : describe.skip;

  describePostgres("PostgreSQL PayNow webhook store", () => {
    it("revokes paid entitlements immediately when a full admin refund completes", async () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      const schema = `sly_refund_test_${randomUUID().replace(/-/g, "")}`;
      const adminPool = new Pool({
        connectionString: postgresUrl,
        max: 1,
      });
      let store: PostgresPayNowWebhookStore | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA "${schema}"`);
        store = await PostgresPayNowWebhookStore.connect({
          connectionString: postgresUrl!,
          max: 1,
          options: `-c search_path=${schema}`,
        }, {
          emailEncryptionKey: emailKey,
          licenseKeyPepper: Buffer.alloc(32, 13),
          licenseFile: {
            serviceUrl: "https://api.slybrowser.test",
            passphrase: "private-preview-passphrase",
            signingKeyId: "license-file-private-preview-v1",
            signingPrivateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
          },
        });
        const intent = await store.createCheckoutIntent({
          planId: "studio",
          email: "refund-buyer@example.com",
          emailConfirmation: "refund-buyer@example.com",
          idempotencyKey: `postgres-refund-checkout-${Date.now()}`,
          now: 2_000_010_000,
        });
        await store.markCheckoutCreated({
          intentId: intent.intentId,
          statusToken: intent.statusToken,
          customerId: "700000000000000212",
          checkoutId: "700000000000000213",
          checkoutTokenHash: "ba".repeat(32),
          checkoutUrl: "https://checkout.test/refund",
          now: 2_000_010_010,
        });
        const payment = await store.recordVerifiedFirstPayment({
          checkoutIntentId: intent.intentId,
          payNowCheckoutId: "700000000000000213",
          payNowOrderId: "700000000000000214",
          payNowPaymentId: "700000000000000215",
          payNowSubscriptionId: "700000000000000216",
          payNowCustomerId: "700000000000000212",
          amount: 4900,
          currency: "USD",
          currentPeriodStart: 2_000_010_000,
          currentPeriodEnd: 2_002_600_000,
          accountId: "refund-account-test",
          metadataLicenseId: "refund-license-test",
          sourceEventId: "700000000000000217",
          sourceEventType: "ON_PAYMENT_COMPLETED",
          sourcePayloadSha256: "be".repeat(32),
          now: 2_000_010_020,
        });
        await store.claimLicenseEmailOutbox({ now: 2_000_010_021, limit: 2 });

        const prepared = await store.prepareAdminOrderRefund({
          publicOrderId: payment.publicOrderId,
          idempotencyKey: "refund-completed-idempotency-key-001",
          requestedBy: "refunds@slybrowser.test",
          reason: "Customer requested full refund",
          now: 2_000_010_030,
        });
        const refundCompletedAt = 2_000_010_040;
        await expect(store.recordAdminOrderRefundSubmitted({
          refundId: prepared.refundId,
          payNowOrderId: prepared.payNowOrderId,
          result: {
            payNowRefundId: "700000000000000218",
            payNowPaymentId: "700000000000000215",
            payNowCustomerId: "700000000000000212",
            status: "completed",
            amount: 4900,
            currency: "USD",
            createdAt: 2_000_010_035,
            completedAt: refundCompletedAt,
          },
          now: 2_000_010_041,
        })).resolves.toMatchObject({
          publicOrderId: payment.publicOrderId,
          payNowRefundId: "700000000000000218",
          status: "completed",
          amount: 4900,
          currency: "USD",
        });
        await expect(store.customerBillingStatus({
          publicOrderId: payment.publicOrderId,
          accessToken: payment.customerAccessToken!,
          now: 2_000_010_050,
        })).resolves.toMatchObject({
          orderStatus: "refunded",
          subscriptionStatus: "suspended",
          paidThrough: refundCompletedAt,
          remainingDays: 0,
          autoRenew: false,
          licenseStatus: "revoked",
        });
        const refundNotice = (await store.claimLicenseEmailOutbox({ now: 2_000_010_050, limit: 2 }))
          .find((entry) => (entry.payload as { kind?: unknown }).kind === "refund-receipt");
        expect(refundNotice).toMatchObject({
          recipientEmail: "refund-buyer@example.com",
          payload: {
            kind: "refund-receipt",
            publicOrderId: payment.publicOrderId,
            paidThrough: refundCompletedAt,
          },
        });

        const pool = new Pool({
          connectionString: postgresUrl,
          max: 1,
          options: `-c search_path=${schema}`,
        }) as PgPool;
        try {
          await expect(pool.query<{ status: string; paid_through: Date }>(
            "SELECT status, paid_through FROM billing_entitlements WHERE entitlement_id=$1",
            [payment.entitlementId],
          )).resolves.toMatchObject({
            rows: [expect.objectContaining({ status: "revoked" })],
          });
          await expect(pool.query<{ status: string; paid_through: number }>(
            "SELECT status, paid_through FROM entitlements WHERE license_id=$1",
            [payment.entitlementLicenseId],
          )).resolves.toMatchObject({
            rows: [expect.objectContaining({ status: "revoked", paid_through: refundCompletedAt })],
          });
        } finally {
          await pool.end();
        }
      } finally {
        await store?.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await adminPool.end();
      }
    });

    it("persists checkout intents, subscriptions and webhook logs in PostgreSQL", async () => {
      const { privateKey } = generateKeyPairSync("ed25519");
      const schema = `sly_paynow_test_${randomUUID().replace(/-/g, "")}`;
      const adminPool = new Pool({
        connectionString: postgresUrl,
        max: 1,
      });
      let store: PostgresPayNowWebhookStore | undefined;
      try {
        await adminPool.query(`CREATE SCHEMA "${schema}"`);
        store = await PostgresPayNowWebhookStore.connect({
          connectionString: postgresUrl!,
          max: 1,
          options: `-c search_path=${schema}`,
        }, {
          emailEncryptionKey: emailKey,
          licenseKeyPepper: Buffer.alloc(32, 12),
          licenseFile: {
            serviceUrl: "https://api.slybrowser.test",
            passphrase: "private-preview-passphrase",
            signingKeyId: "license-file-private-preview-v1",
            signingPrivateKey: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
          },
          gracePeriodSeconds: 3 * 24 * 60 * 60,
        });
        const idempotencyKey = `postgres-checkout-${Date.now()}-${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
        const intent = await store.createCheckoutIntent({
          planId: "studio",
          email: "buyer@example.com",
          emailConfirmation: "buyer@example.com",
          idempotencyKey,
          now: 2_000_000_000,
        });
        const repeatedIntent = await store.createCheckoutIntent({
          planId: "studio",
          email: "buyer@example.com",
          emailConfirmation: "buyer@example.com",
          idempotencyKey,
          now: 2_000_000_001,
        });
        expect(repeatedIntent.intentId).toBe(intent.intentId);
        expect(await store.checkoutIntentStatus({ intentId: intent.intentId, statusToken: intent.statusToken }))
          .toMatchObject({ status: "pending_checkout", plan: "studio" });
        await expect(store.markCheckoutCreated({
          intentId: intent.intentId,
          statusToken: intent.statusToken,
          customerId: "700000000000000002",
          checkoutId: "700000000000000010",
          checkoutTokenHash: "aa".repeat(32),
          checkoutUrl: "https://checkout.test/sly",
          now: 2_000_000_010,
        })).resolves.toMatchObject({ status: "checkout_created", plan: "studio" });

        const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
        const eventId = `7${Date.now().toString().padStart(17, "0").slice(-17)}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
        const body = payload("ON_SUBSCRIPTION_ACTIVATED", eventId, "2033-05-19T03:33:20Z", "592701920221593600", intent.intentId);
        await expect(signed(receiver, body)).resolves.toEqual({ status: "processed", eventId });
        await expect(signed(receiver, body)).resolves.toEqual({ status: "duplicate", eventId });

        expect(await store.subscription("700000000000000001")).toMatchObject({
          customerId: "700000000000000002",
          plan: "studio",
          status: "active",
          checkoutIntentId: intent.intentId,
          accountId: "account-test",
          licenseId: "license-test",
        });
        const paymentEventId = `8${eventId.slice(1)}`;
        const firstPayNowOrderId = `6${eventId.slice(1)}`;
        const firstPayNowPaymentId = paymentEventId;
        const paymentPayloadHash = "ab".repeat(32);
        const firstPaymentInput = {
          checkoutIntentId: intent.intentId,
          payNowCheckoutId: "700000000000000010",
          payNowOrderId: firstPayNowOrderId,
          payNowPaymentId: firstPayNowPaymentId,
          payNowSubscriptionId: "700000000000000001",
          payNowCustomerId: "700000000000000002",
          amount: 4900,
          currency: "USD",
          currentPeriodStart: 1_999_999_000,
          currentPeriodEnd: 2_000_100_000,
          accountId: "account-test",
          metadataLicenseId: "license-test",
          sourceEventId: paymentEventId,
          sourceEventType: "ON_PAYMENT_COMPLETED" as const,
          sourcePayloadSha256: paymentPayloadHash,
          now: 2_000_000_020,
        };
        await expect(store.recordVerifiedFirstPayment({
          ...firstPaymentInput,
          payNowPaymentId: `wrong-amount-${firstPayNowPaymentId}`,
          sourceEventId: `wrong-amount-${paymentEventId}`,
          sourcePayloadSha256: "ac".repeat(32),
          amount: 1900,
        })).rejects.toMatchObject({ code: "payment_amount_mismatch", status: 409 });
        expect(await store.claimLicenseEmailOutbox({ now: 2_000_000_020 })).toEqual([]);
        await expect(store.recordVerifiedFirstPayment({
          ...firstPaymentInput,
          payNowPaymentId: `wrong-currency-${firstPayNowPaymentId}`,
          sourceEventId: `wrong-currency-${paymentEventId}`,
          sourcePayloadSha256: "ad".repeat(32),
          currency: "EUR",
        })).rejects.toMatchObject({ code: "invalid_request", status: 400 });
        expect(await store.claimLicenseEmailOutbox({ now: 2_000_000_020 })).toEqual([]);
        const firstPayment = await store.recordVerifiedFirstPayment(firstPaymentInput);
        expect(firstPayment).toMatchObject({
          status: "processed",
          plan: "studio",
          paidThrough: 2_000_100_000,
        });
        expect(firstPayment.publicOrderId).toMatch(/^spo_/);
        expect(firstPayment.customerAccessToken).toMatch(/^cst_[A-Za-z0-9_-]+$/);
        expect(firstPayment.entitlementLicenseId).toMatch(/^[0-9a-f-]{36}$/);
        const outbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_021 });
        expect(outbox).toHaveLength(1);
        expect(outbox[0]!.outboxId).toBe(firstPayment.outboxId);
        expect(outbox[0]!.recipientEmail).toBe("buyer@example.com");
        expect(outbox[0]!.payload).toMatchObject({
          schemaVersion: 1,
          kind: "first-license-file",
          plan: "studio",
          publicOrderId: firstPayment.publicOrderId,
          customerAccessToken: firstPayment.customerAccessToken,
          licenseFile: {
            schemaVersion: 2,
            type: "slybrowser-license",
            licenseId: firstPayment.entitlementLicenseId,
          },
        });
        const providerMessageId = `message-${eventId}`;
        const providerEventId = `email-event-${eventId}`;
        await store.markLicenseEmailOutboxSent({
          outboxId: firstPayment.outboxId,
          provider: "postmark",
          providerMessageId,
          now: 2_000_000_022,
        });
        await store.markLicenseEmailOutboxFailed({
          outboxId: firstPayment.outboxId,
          provider: "postmark",
          errorCode: "late_worker_send_failed",
          errorMessage: "old worker failed after a restarted worker already sent the message",
          now: 2_000_000_023,
          maxAttempts: 5,
        });
        const restartedOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_090, limit: 5 });
        expect(restartedOutbox.find((entry) => entry.outboxId === firstPayment.outboxId)).toBeUndefined();
        await expect(store.markLicenseEmailDeliveryStatus({
          provider: "postmark",
          providerMessageId,
          providerEventId,
          status: "bounced",
          errorCode: "mailbox_unavailable",
          errorMessage: "Mailbox unavailable",
          now: 2_000_000_091,
        })).resolves.toEqual({ outboxId: firstPayment.outboxId, status: "bounced" });
        await expect(store.markLicenseEmailDeliveryStatus({
          provider: "postmark",
          providerMessageId,
          providerEventId,
          status: "bounced",
          errorCode: "mailbox_unavailable",
          errorMessage: "Mailbox unavailable",
          now: 2_000_000_092,
        })).resolves.toEqual({ outboxId: firstPayment.outboxId, status: "bounced" });
        await store.markLicenseEmailOutboxFailed({
          outboxId: firstPayment.outboxId,
          provider: "postmark",
          errorCode: "late_worker_send_failed",
          errorMessage: "old worker failed after the provider reported a bounce",
          now: 2_000_000_093,
          maxAttempts: 5,
        });
        const postBounceOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_160, limit: 5 });
        expect(postBounceOutbox.find((entry) => entry.outboxId === firstPayment.outboxId)).toBeUndefined();
        await store.markLicenseEmailOutboxSent({
          outboxId: firstPayment.outboxId,
          provider: "postmark",
          providerMessageId: `late-${providerMessageId}`,
          now: 2_000_000_161,
        });
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_100,
        })).resolves.toMatchObject({
          publicOrderId: firstPayment.publicOrderId,
          plan: "studio",
          planName: "Studio",
          concurrency: 20,
          orderStatus: "completed",
          subscriptionStatus: "active",
          remainingDays: 2,
          autoRenew: true,
          cancelAtPeriodEnd: false,
          licenseStatus: "active",
          licenseFileDeliveryStatus: "bounced",
        });
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: "cst_wrong_customer_access_token_abcdefghijklmnopqrstuvwxyz",
          now: 2_000_000_100,
        })).rejects.toMatchObject({ code: "customer_portal_unavailable", status: 404 });
        const resend = await store.requestLicenseFileResend({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_200,
        });
        expect(resend).toMatchObject({
          status: "queued",
          publicOrderId: firstPayment.publicOrderId,
          nextAttemptAt: 2_000_000_200,
        });
        await expect(store.requestLicenseFileResend({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_210,
        })).resolves.toMatchObject({
          status: "duplicate",
          outboxId: resend.outboxId,
        });
        const resendOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_201, limit: 2 });
        expect(resendOutbox.find((entry) => entry.outboxId === resend.outboxId)?.payload).toMatchObject({
          kind: "replacement-license-file",
          publicOrderId: firstPayment.publicOrderId,
          customerAccessToken: firstPayment.customerAccessToken,
        });
        const pool = new Pool({
          connectionString: postgresUrl,
          max: 1,
          options: `-c search_path=${schema}`,
        }) as PgPool;
        try {
          const manualReviews = await pool.query<{
            reason: string;
            status: string;
            provider: string;
            provider_event_id: string;
          }>(
            `SELECT reason, status, provider, provider_event_id
             FROM billing_email_manual_reviews
             WHERE outbox_id=$1
             ORDER BY created_at`,
            [firstPayment.outboxId],
          );
          expect(manualReviews.rows).toEqual([{
            reason: "bounced",
            status: "open",
            provider: "postmark",
            provider_event_id: providerEventId,
          }]);
        } finally {
          await pool.end();
        }
        await expect(store.recordVerifiedFirstPayment({
          checkoutIntentId: intent.intentId,
          payNowCheckoutId: "700000000000000010",
          payNowOrderId: firstPayNowOrderId,
          payNowPaymentId: firstPayNowPaymentId,
          payNowSubscriptionId: "700000000000000001",
          payNowCustomerId: "700000000000000002",
          amount: 4900,
          currency: "USD",
          currentPeriodStart: 1_999_999_000,
          currentPeriodEnd: 2_000_100_000,
          accountId: "account-test",
          metadataLicenseId: "license-test",
          sourceEventId: paymentEventId,
          sourceEventType: "ON_PAYMENT_COMPLETED",
          sourcePayloadSha256: paymentPayloadHash,
          now: 2_000_000_021,
        })).resolves.toMatchObject({
          status: "duplicate",
          entitlementId: firstPayment.entitlementId,
          orderId: firstPayment.orderId,
          paymentId: firstPayment.paymentId,
          outboxId: firstPayment.outboxId,
        });
        const renewalEventId = `9${eventId.slice(1)}`;
        const renewalPayNowOrderId = renewalEventId;
        const renewalPayNowPaymentId = `5${eventId.slice(1)}`;
        const renewalPayloadHash = "bc".repeat(32);
        const renewalPaidThrough = 2_002_700_000;
        const renewal = await store.recordVerifiedRenewalPayment({
          checkoutIntentId: intent.intentId,
          payNowCheckoutId: "700000000000000010",
          payNowOrderId: renewalPayNowOrderId,
          payNowPaymentId: renewalPayNowPaymentId,
          payNowSubscriptionId: "700000000000000001",
          payNowCustomerId: "700000000000000002",
          amount: 4900,
          currency: "USD",
          currentPeriodStart: 2_000_100_000,
          currentPeriodEnd: renewalPaidThrough,
          sourceEventId: renewalEventId,
          sourceEventType: "ON_PAYMENT_COMPLETED",
          sourcePayloadSha256: renewalPayloadHash,
          now: 2_000_000_030,
        });
        expect(renewal).toMatchObject({
          status: "processed",
          entitlementId: firstPayment.entitlementId,
          entitlementLicenseId: firstPayment.entitlementLicenseId,
          subscriptionId: firstPayment.subscriptionId,
          plan: "studio",
          paidThrough: renewalPaidThrough,
        });
        await expect(store.recordVerifiedRenewalPayment({
          checkoutIntentId: intent.intentId,
          payNowCheckoutId: "700000000000000010",
          payNowOrderId: renewalPayNowOrderId,
          payNowPaymentId: renewalPayNowPaymentId,
          payNowSubscriptionId: "700000000000000001",
          payNowCustomerId: "700000000000000002",
          amount: 4900,
          currency: "USD",
          currentPeriodStart: 2_000_100_000,
          currentPeriodEnd: renewalPaidThrough,
          sourceEventId: renewalEventId,
          sourceEventType: "ON_PAYMENT_COMPLETED",
          sourcePayloadSha256: renewalPayloadHash,
          now: 2_000_000_031,
        })).resolves.toMatchObject({
          status: "duplicate",
          entitlementId: firstPayment.entitlementId,
          paymentId: renewal.paymentId,
          periodId: renewal.periodId,
          paidThrough: renewalPaidThrough,
        });
        const renewalNoticeOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_032, limit: 2 });
        const renewalNotice = renewalNoticeOutbox.find((entry) =>
          (entry.payload as { kind?: unknown }).kind === "renewal-receipt"
        );
        expect(renewalNotice).toMatchObject({
          recipientEmail: "buyer@example.com",
          payload: {
            schemaVersion: 1,
            kind: "renewal-receipt",
            plan: "studio",
            publicOrderId: renewal.publicOrderId,
            paidThrough: renewalPaidThrough,
            amount: 4900,
            currency: "USD",
          },
        });
        expect(JSON.stringify(renewalNotice?.payload)).not.toContain("licenseFile");
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_100,
        })).resolves.toMatchObject({
          paidThrough: renewalPaidThrough,
          subscriptionStatus: "active",
        });
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: renewalPaidThrough + 60 * 60,
        })).resolves.toMatchObject({
          paidThrough: renewalPaidThrough,
          subscriptionStatus: "grace_period",
          remainingDays: 0,
          autoRenew: true,
          cancelAtPeriodEnd: false,
        });
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: renewalPaidThrough + 3 * 24 * 60 * 60 + 1,
        })).resolves.toMatchObject({
          paidThrough: renewalPaidThrough,
          subscriptionStatus: "past_due",
          remainingDays: 0,
          autoRenew: true,
          cancelAtPeriodEnd: false,
        });
        const rotation = await store.rotateLeakedLicenseFile({
          publicOrderId: firstPayment.publicOrderId,
          idempotencyKey: "rotation-idempotency-key-001",
          requestedBy: "admin@example.com",
          reason: "Customer reported leaked license file",
          now: 2_000_000_300,
        });
        expect(rotation).toMatchObject({
          status: "queued",
          publicOrderId: firstPayment.publicOrderId,
          oldEntitlementId: firstPayment.entitlementId,
          oldLicenseId: firstPayment.entitlementLicenseId,
          nextAttemptAt: 2_000_000_300,
        });
        expect(rotation.newEntitlementId).toMatch(/^[0-9a-f-]{36}$/);
        expect(rotation.newLicenseId).toMatch(/^[0-9a-f-]{36}$/);
        expect(rotation.newEntitlementId).not.toBe(firstPayment.entitlementId);
        expect(rotation.newLicenseId).not.toBe(firstPayment.entitlementLicenseId);
        await expect(store.rotateLeakedLicenseFile({
          publicOrderId: firstPayment.publicOrderId,
          idempotencyKey: "rotation-idempotency-key-001",
          requestedBy: "admin@example.com",
          reason: "Customer reported leaked license file",
          now: 2_000_000_301,
        })).resolves.toMatchObject({
          status: "duplicate",
          outboxId: rotation.outboxId,
          newEntitlementId: rotation.newEntitlementId,
          newLicenseId: rotation.newLicenseId,
        });
        const rotationOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_302, limit: 3 });
        expect(rotationOutbox.find((entry) => entry.outboxId === rotation.outboxId)?.payload).toMatchObject({
          schemaVersion: 1,
          kind: "replacement-license-file",
          entitlementId: rotation.newEntitlementId,
          entitlementLicenseId: rotation.newLicenseId,
          rotatedFromEntitlementId: firstPayment.entitlementId,
          rotatedFromLicenseId: firstPayment.entitlementLicenseId,
          publicOrderId: firstPayment.publicOrderId,
          customerAccessToken: firstPayment.customerAccessToken,
          licenseFile: {
            schemaVersion: 2,
            type: "slybrowser-license",
            licenseId: rotation.newLicenseId,
          },
        });
        const postRotationResend = await store.requestLicenseFileResend({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_400,
        });
        expect(postRotationResend).toMatchObject({
          status: "queued",
          publicOrderId: firstPayment.publicOrderId,
        });
        expect(postRotationResend.outboxId).not.toBe(resend.outboxId);
        const postRotationResendOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_401, limit: 3 });
        expect(postRotationResendOutbox.find((entry) => entry.outboxId === postRotationResend.outboxId)?.payload)
          .toMatchObject({
            kind: "replacement-license-file",
            entitlementId: rotation.newEntitlementId,
            entitlementLicenseId: rotation.newLicenseId,
            publicOrderId: firstPayment.publicOrderId,
            customerAccessToken: firstPayment.customerAccessToken,
            licenseFile: {
              licenseId: rotation.newLicenseId,
            },
          });
        const rotationPool = new Pool({
          connectionString: postgresUrl,
          max: 1,
          options: `-c search_path=${schema}`,
        }) as PgPool;
        try {
          const entitlementRows = await rotationPool.query<{
            entitlement_id: string;
            license_id: string;
            status: string;
          }>(
            `SELECT entitlement_id, license_id, status
             FROM billing_entitlements
             WHERE entitlement_id = ANY($1::uuid[])
             ORDER BY created_at`,
            [[rotation.oldEntitlementId, rotation.newEntitlementId]],
          );
          expect(entitlementRows.rows).toEqual([
            expect.objectContaining({
              entitlement_id: rotation.oldEntitlementId,
              license_id: rotation.oldLicenseId,
              status: "revoked",
            }),
            expect.objectContaining({
              entitlement_id: rotation.newEntitlementId,
              license_id: rotation.newLicenseId,
              status: "active",
            }),
          ]);
          await expect(rotationPool.query<{ status: string }>(
            "SELECT status FROM entitlements WHERE license_id=$1",
            [rotation.oldLicenseId],
          )).resolves.toMatchObject({ rows: [{ status: "revoked" }] });
          await expect(rotationPool.query<{ status: string }>(
            "SELECT status FROM entitlements WHERE license_id=$1",
            [rotation.newLicenseId],
          )).resolves.toMatchObject({ rows: [{ status: "active" }] });
          await expect(rotationPool.query<{ entitlement_id: string }>(
            "SELECT entitlement_id FROM billing_orders WHERE public_order_id=$1",
            [firstPayment.publicOrderId],
          )).resolves.toMatchObject({ rows: [{ entitlement_id: rotation.newEntitlementId }] });
          await expect(rotationPool.query<{ entitlement_id: string }>(
            "SELECT entitlement_id FROM billing_subscriptions WHERE paynow_subscription_id=$1",
            ["700000000000000001"],
          )).resolves.toMatchObject({ rows: [{ entitlement_id: rotation.newEntitlementId }] });
        } finally {
          await rotationPool.end();
        }
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_500,
        })).resolves.toMatchObject({
          paidThrough: renewalPaidThrough,
          subscriptionStatus: "active",
          licenseStatus: "active",
        });
        const chargebackEventId = `4${eventId.slice(1)}`;
        await expect(signed(receiver, eventOnlyPayload("ON_CHARGEBACK", chargebackEventId, {
          order_id: firstPayNowOrderId,
          payment_id: firstPayNowPaymentId,
        }))).resolves.toEqual({ status: "processed", eventId: chargebackEventId });
        await expect(store.customerBillingStatus({
          publicOrderId: firstPayment.publicOrderId,
          accessToken: firstPayment.customerAccessToken!,
          now: 2_000_000_100,
        })).resolves.toMatchObject({
          orderStatus: "disputed",
          subscriptionStatus: "past_due",
          licenseStatus: "hold",
        });
        const chargebackNoticeOutbox = await store.claimLicenseEmailOutbox({ now: 2_000_000_033, limit: 2 });
        expect(chargebackNoticeOutbox.find((entry) =>
          (entry.payload as { kind?: unknown }).kind === "chargeback-hold"
        )).toMatchObject({
          recipientEmail: "buyer@example.com",
          payload: {
            schemaVersion: 1,
            kind: "chargeback-hold",
            plan: "studio",
            publicOrderId: firstPayment.publicOrderId,
            paidThrough: renewalPaidThrough,
          },
        });
        expect(await store.checkoutIntentStatus({ intentId: intent.intentId, statusToken: intent.statusToken }))
          .toMatchObject({ status: "paid", plan: "studio" });

        const log = await store.recordPaymentLog({
          rawBody: body,
          receivedAt: 2_000_000_000,
          outcome: "success",
          processingResult: "processed",
          httpStatus: 200,
          verificationStatus: "verified",
          durationMilliseconds: 8,
        });
        expect(log.expiresAt - log.receivedAt).toBe(PAYNOW_PAYMENT_LOG_RETENTION_SECONDS);
        expect(log.checkoutId).toBe("700000000000000010");
        expect((await store.paymentLogs({ since: 1_999_999_999 })).at(0)?.logId).toBeDefined();
        expect(await store.prunePaymentLogs(log.expiresAt)).toBeGreaterThanOrEqual(1);
      } finally {
        await store?.close();
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await adminPool.end();
      }
    });
  });
});
