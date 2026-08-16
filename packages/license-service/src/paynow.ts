import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { ServiceError, invalidRequest } from "./errors.js";
import type { PlanId } from "./plans.js";

export const PAYNOW_PRODUCT_PLANS: Readonly<Record<string, Exclude<PlanId, "free">>> = Object.freeze({
  "592701767033036800": "launch",
  "592701920221593600": "studio",
  "592702024412299264": "fleet",
  "592702180452990976": "grid",
});

export type PayNowSubscriptionEventType =
  | "ON_SUBSCRIPTION_ACTIVATED"
  | "ON_SUBSCRIPTION_RENEWED"
  | "ON_SUBSCRIPTION_CANCELED";

export interface PayNowSubscriptionRecord {
  subscriptionId: string;
  storeId: string;
  customerId: string;
  productId: string;
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

interface NormalizedPayNowEvent {
  eventId: string;
  eventType: PayNowSubscriptionEventType;
  subscription: Omit<PayNowSubscriptionRecord, "lastEventId" | "updatedAt">;
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

function timestamp(value: unknown, name: string, required = true): number | null {
  if ((value === undefined || value === null) && !required) return null;
  if (typeof value !== "string") invalidRequest(`${name} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalidRequest(`${name} is invalid`);
  return Math.floor(milliseconds / 1000);
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
  const eventType = payload.event_type as PayNowSubscriptionEventType;
  const body = object(payload.body, "PayNow event body must be an object");
  const storeId = identifier(body.store_id, "PayNow store ID");
  if (storeId !== expectedStoreId) throw new ServiceError("paynow_store_invalid", "PayNow store ID is invalid", 401);
  const productId = identifier(body.product_id, "PayNow product ID");
  const plan = PAYNOW_PRODUCT_PLANS[productId];
  if (!plan) invalidRequest("PayNow product is not mapped to a SlyBrowser plan");
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
  };
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

export class PayNowWebhookStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
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
    `);
  }

  close(): void {
    this.#database.close();
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
          status=excluded.status,
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
}

export class PayNowWebhookReceiver {
  constructor(
    readonly store: PayNowWebhookStore,
    readonly options: {
      signingSecrets: readonly string[];
      storeId: string;
      now?: () => number;
      toleranceMilliseconds?: number;
    },
  ) {
    if (!options.signingSecrets.length || options.signingSecrets.some((secret) => !secret)) {
      throw new TypeError("At least one PayNow signing secret is required");
    }
    if (!/^\d{15,24}$/.test(options.storeId)) throw new TypeError("PayNow store ID is invalid");
  }

  receive(rawBody: Buffer, timestampHeader: string | undefined, signatureHeader: string | undefined): {
    status: "processed" | "duplicate";
    eventId: string;
  } {
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
    return {
      status: this.store.apply(event, payloadSha256, Math.floor(nowMilliseconds / 1000)),
      eventId: event.eventId,
    };
  }
}
