import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PayNowWebhookReceiver, PayNowWebhookStore } from "../src/paynow.js";
import { createPayNowBillingHttpServer } from "../src/paynow-server.js";

const now = 2_000_000_000_000;
const secret = "paynow-test-signing-secret";
const storeId = "591304127884034048";

function payload(eventType: string, eventId: string, periodEnd = "2033-05-19T03:33:20Z"): Buffer {
  return Buffer.from(JSON.stringify({
    event_type: eventType,
    event_id: eventId,
    body: {
      id: "700000000000000001",
      store_id: storeId,
      customer_id: "700000000000000002",
      product_id: "592701920221593600",
      current_period_start: "2033-05-18T03:33:20Z",
      current_period_end: periodEnd,
      ...(eventType === "ON_SUBSCRIPTION_CANCELED" ? { canceled_at: "2033-05-18T05:33:20Z" } : {}),
      checkout: { metadata: { sly_account_id: "account-test", sly_license_id: "license-test" } },
    },
  }), "utf8");
}

function signed(receiver: PayNowWebhookReceiver, body: Buffer, at = now) {
  const timestamp = String(at);
  const signature = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("base64");
  return receiver.receive(body, timestamp, signature);
}

describe("PayNow webhook receiver", () => {
  it("verifies, normalizes and deduplicates subscription activation", () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const body = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000003");
      expect(signed(receiver, body)).toEqual({ status: "processed", eventId: "700000000000000003" });
      expect(signed(receiver, body)).toEqual({ status: "duplicate", eventId: "700000000000000003" });
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

  it("extends the paid-through period and keeps it after cancellation", () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      signed(receiver, payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000004", "2033-05-19T03:33:20Z"));
      signed(receiver, payload("ON_SUBSCRIPTION_RENEWED", "700000000000000005", "2033-06-19T03:33:20Z"));
      const renewed = store.subscription("700000000000000001")!;
      signed(receiver, payload("ON_SUBSCRIPTION_CANCELED", "700000000000000006", "2033-06-19T03:33:20Z"));
      const canceled = store.subscription("700000000000000001")!;
      expect(canceled.currentPeriodEnd).toBe(renewed.currentPeriodEnd);
      expect(canceled.status).toBe("canceled");
      expect(canceled.canceledAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("rejects invalid signatures, stale timestamps and unknown products", () => {
    const store = new PayNowWebhookStore(":memory:");
    try {
      const receiver = new PayNowWebhookReceiver(store, { signingSecrets: [secret], storeId, now: () => now });
      const body = payload("ON_SUBSCRIPTION_ACTIVATED", "700000000000000007");
      expect(() => receiver.receive(body, String(now), Buffer.alloc(32).toString("base64")))
        .toThrowError(expect.objectContaining({ code: "paynow_signature_invalid", status: 401 }));
      expect(() => signed(receiver, body, now - 5 * 60 * 1000 - 1))
        .toThrowError(expect.objectContaining({ code: "paynow_timestamp_invalid", status: 401 }));
      const unknown = Buffer.from(body.toString("utf8").replace("592701920221593600", "700000000000000099"));
      expect(() => signed(receiver, unknown))
        .toThrowError(expect.objectContaining({ code: "invalid_request", status: 400 }));
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
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
      store.close();
    }
  });
});
