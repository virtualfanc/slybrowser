import { createRequire } from "node:module";

import type { Pool as PgPool, PoolConfig } from "pg";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof import("pg");

export const POSTGRES_BILLING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS billing_checkout_intents (
  intent_id TEXT PRIMARY KEY,
  idempotency_key_hash BYTEA UNIQUE,
  status_token_hash BYTEA NOT NULL UNIQUE,
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  plan_snapshot JSONB NOT NULL,
  delivery_email_ciphertext BYTEA NOT NULL,
  delivery_email_nonce BYTEA NOT NULL,
  delivery_email_tag BYTEA NOT NULL,
  delivery_email_hmac BYTEA NOT NULL,
  masked_email TEXT NOT NULL,
  paynow_customer_id TEXT,
  paynow_checkout_id TEXT UNIQUE,
  paynow_checkout_token_hash BYTEA,
  paynow_checkout_url_ciphertext BYTEA,
  paynow_checkout_url_nonce BYTEA,
  paynow_checkout_url_tag BYTEA,
  checkout_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS paynow_customer_id TEXT;
ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS paynow_checkout_id TEXT;
ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS paynow_checkout_token_hash BYTEA;
ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS paynow_checkout_url_ciphertext BYTEA;
ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS paynow_checkout_url_nonce BYTEA;
ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS paynow_checkout_url_tag BYTEA;
ALTER TABLE billing_checkout_intents ADD COLUMN IF NOT EXISTS checkout_created_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'billing_checkout_intents'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[
        (
          SELECT attnum
          FROM pg_attribute
          WHERE attrelid = 'billing_checkout_intents'::regclass
            AND attname = 'paynow_checkout_id'
        )
      ]::smallint[]
  ) THEN
    ALTER TABLE billing_checkout_intents
      ADD CONSTRAINT billing_checkout_intents_paynow_checkout_id_unique UNIQUE (paynow_checkout_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS billing_checkout_intents_email
  ON billing_checkout_intents(delivery_email_hmac, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_checkout_intents_status
  ON billing_checkout_intents(status, expires_at);

CREATE TABLE IF NOT EXISTS billing_entitlements (
  entitlement_id UUID PRIMARY KEY,
  license_id UUID UNIQUE,
  account_id TEXT,
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  paid_through TIMESTAMPTZ,
  source_checkout_intent_id TEXT REFERENCES billing_checkout_intents(intent_id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_orders (
  order_id UUID PRIMARY KEY,
  public_order_id TEXT NOT NULL UNIQUE,
  paynow_order_id TEXT UNIQUE,
  paynow_checkout_id TEXT REFERENCES billing_checkout_intents(paynow_checkout_id),
  paynow_subscription_id TEXT,
  customer_access_token_hash BYTEA,
  checkout_intent_id TEXT NOT NULL REFERENCES billing_checkout_intents(intent_id),
  entitlement_id UUID REFERENCES billing_entitlements(entitlement_id),
  plan TEXT NOT NULL,
  plan_snapshot JSONB NOT NULL,
  currency TEXT NOT NULL,
  subtotal_amount INTEGER NOT NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  total_amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE billing_orders ADD COLUMN IF NOT EXISTS customer_access_token_hash BYTEA;

CREATE INDEX IF NOT EXISTS billing_orders_checkout_intent
  ON billing_orders(checkout_intent_id);
CREATE INDEX IF NOT EXISTS billing_orders_subscription
  ON billing_orders(paynow_subscription_id);
CREATE INDEX IF NOT EXISTS billing_orders_customer_access
  ON billing_orders(public_order_id, customer_access_token_hash);

CREATE TABLE IF NOT EXISTS billing_payments (
  payment_id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES billing_orders(order_id),
  paynow_payment_id TEXT UNIQUE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  gateway TEXT NOT NULL DEFAULT 'paynow',
  failure_code TEXT,
  failure_message TEXT,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_payments_order
  ON billing_payments(order_id);
CREATE INDEX IF NOT EXISTS billing_payments_status
  ON billing_payments(status, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  subscription_id UUID PRIMARY KEY,
  public_subscription_id TEXT NOT NULL UNIQUE,
  paynow_subscription_id TEXT NOT NULL UNIQUE,
  paynow_customer_id TEXT NOT NULL,
  checkout_intent_id TEXT NOT NULL REFERENCES billing_checkout_intents(intent_id),
  entitlement_id UUID REFERENCES billing_entitlements(entitlement_id),
  plan TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  paid_through TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  canceled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  store_id TEXT,
  customer_id TEXT,
  product_id TEXT,
  account_id TEXT,
  license_id TEXT,
  last_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS store_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS customer_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS product_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS license_id TEXT;
ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS last_event_id TEXT;

CREATE INDEX IF NOT EXISTS billing_subscriptions_entitlement
  ON billing_subscriptions(entitlement_id);
CREATE INDEX IF NOT EXISTS billing_subscriptions_paid_through
  ON billing_subscriptions(status, paid_through);

CREATE TABLE IF NOT EXISTS billing_subscription_periods (
  period_id UUID PRIMARY KEY,
  subscription_id UUID NOT NULL REFERENCES billing_subscriptions(subscription_id),
  order_id UUID REFERENCES billing_orders(order_id),
  payment_id UUID REFERENCES billing_payments(payment_id),
  cycle_sequence INTEGER NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(subscription_id, cycle_sequence)
);

CREATE TABLE IF NOT EXISTS billing_refunds (
  refund_id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES billing_orders(order_id),
  payment_id UUID REFERENCES billing_payments(payment_id),
  paynow_refund_id TEXT UNIQUE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key_hash BYTEA NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failure_message TEXT
);

CREATE TABLE IF NOT EXISTS billing_email_outbox (
  outbox_id UUID PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  recipient_email_ciphertext BYTEA NOT NULL,
  recipient_email_nonce BYTEA NOT NULL,
  recipient_email_tag BYTEA NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_email_outbox_ready
  ON billing_email_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS billing_email_deliveries (
  delivery_id UUID PRIMARY KEY,
  outbox_id UUID NOT NULL REFERENCES billing_email_outbox(outbox_id),
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  provider_event_id TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE billing_email_deliveries ADD COLUMN IF NOT EXISTS provider_event_id TEXT;

CREATE INDEX IF NOT EXISTS billing_email_deliveries_message
  ON billing_email_deliveries(provider, provider_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS billing_email_deliveries_provider_event
  ON billing_email_deliveries(provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_email_manual_reviews (
  review_id UUID PRIMARY KEY,
  deduplication_key TEXT NOT NULL UNIQUE,
  outbox_id UUID NOT NULL REFERENCES billing_email_outbox(outbox_id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_message_id TEXT,
  provider_event_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS billing_email_manual_reviews_open
  ON billing_email_manual_reviews(status, created_at);
CREATE INDEX IF NOT EXISTS billing_email_manual_reviews_outbox
  ON billing_email_manual_reviews(outbox_id, status);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(provider, event_id)
);

CREATE TABLE IF NOT EXISTS billing_webhook_logs (
  log_id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS billing_webhook_logs_expires
  ON billing_webhook_logs(expires_at);
CREATE INDEX IF NOT EXISTS billing_webhook_logs_received
  ON billing_webhook_logs(received_at DESC);

CREATE TABLE IF NOT EXISTS billing_pending_paynow_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  store_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  locked_until TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(provider, event_id)
);

CREATE INDEX IF NOT EXISTS billing_pending_paynow_events_ready
  ON billing_pending_paynow_events(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS billing_pending_paynow_events_payment
  ON billing_pending_paynow_events(payment_id);

CREATE TABLE IF NOT EXISTS billing_admin_audit_logs (
  audit_id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  before_json JSONB,
  after_json JSONB,
  external_result JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE billing_admin_audit_logs ADD COLUMN IF NOT EXISTS before_json JSONB;
ALTER TABLE billing_admin_audit_logs ADD COLUMN IF NOT EXISTS after_json JSONB;

CREATE INDEX IF NOT EXISTS billing_admin_audit_logs_target
  ON billing_admin_audit_logs(target_type, target_id, created_at DESC);
`;

export const POSTGRES_BILLING_TIMESTAMP_MIGRATION_SQL = `
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('billing_checkout_intents', 'checkout_created_at'),
      ('billing_checkout_intents', 'created_at'),
      ('billing_checkout_intents', 'expires_at'),
      ('billing_checkout_intents', 'updated_at'),
      ('billing_entitlements', 'paid_through'),
      ('billing_entitlements', 'created_at'),
      ('billing_entitlements', 'updated_at'),
      ('billing_orders', 'completed_at'),
      ('billing_orders', 'created_at'),
      ('billing_orders', 'updated_at'),
      ('billing_payments', 'completed_at'),
      ('billing_payments', 'failed_at'),
      ('billing_payments', 'refunded_at'),
      ('billing_payments', 'created_at'),
      ('billing_payments', 'updated_at'),
      ('billing_subscriptions', 'current_period_start'),
      ('billing_subscriptions', 'current_period_end'),
      ('billing_subscriptions', 'paid_through'),
      ('billing_subscriptions', 'next_attempt_at'),
      ('billing_subscriptions', 'canceled_at'),
      ('billing_subscriptions', 'created_at'),
      ('billing_subscriptions', 'updated_at'),
      ('billing_subscription_periods', 'period_start'),
      ('billing_subscription_periods', 'period_end'),
      ('billing_subscription_periods', 'created_at'),
      ('billing_refunds', 'requested_at'),
      ('billing_refunds', 'completed_at'),
      ('billing_email_outbox', 'next_attempt_at'),
      ('billing_email_outbox', 'created_at'),
      ('billing_email_outbox', 'updated_at'),
      ('billing_email_deliveries', 'created_at'),
      ('billing_email_deliveries', 'updated_at'),
      ('billing_email_manual_reviews', 'created_at'),
      ('billing_email_manual_reviews', 'updated_at'),
      ('billing_email_manual_reviews', 'resolved_at'),
      ('billing_webhook_events', 'processed_at'),
      ('billing_webhook_logs', 'received_at'),
      ('billing_webhook_logs', 'expires_at'),
      ('billing_pending_paynow_events', 'completed_at'),
      ('billing_pending_paynow_events', 'next_attempt_at'),
      ('billing_pending_paynow_events', 'locked_until'),
      ('billing_pending_paynow_events', 'processed_at'),
      ('billing_pending_paynow_events', 'created_at'),
      ('billing_pending_paynow_events', 'updated_at'),
      ('billing_admin_audit_logs', 'created_at')
    ) AS columns(table_name, column_name)
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = target.table_name
        AND column_name = target.column_name
        AND data_type IN ('bigint', 'integer', 'numeric')
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING to_timestamp(%I)',
        target.table_name,
        target.column_name,
        target.column_name
      );
    END IF;
  END LOOP;
END
$$;
`;

export async function initializePostgresBillingSchema(pool: PgPool): Promise<void> {
  await pool.query(POSTGRES_BILLING_SCHEMA_SQL);
  await pool.query(POSTGRES_BILLING_TIMESTAMP_MIGRATION_SQL);
}

export async function initializePostgresBillingDatabase(config: PoolConfig | string): Promise<PgPool> {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  try {
    await initializePostgresBillingSchema(pool);
    return pool;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
