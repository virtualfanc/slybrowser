import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import {
  initializePostgresBillingSchema,
  POSTGRES_BILLING_SCHEMA_SQL,
  POSTGRES_BILLING_TIMESTAMP_MIGRATION_SQL,
} from "../src/billing-postgres-schema.js";

import type { Pool as PgPool } from "pg";

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as typeof import("pg");

describe("PostgreSQL commercial billing schema", () => {
  it("declares every long-lived billing, entitlement and audit table required for launch", () => {
    for (const table of [
      "billing_checkout_intents",
      "billing_entitlements",
      "billing_orders",
      "billing_payments",
      "billing_pending_paynow_events",
      "billing_subscriptions",
      "billing_subscription_periods",
      "billing_refunds",
      "billing_email_deliveries",
      "billing_email_manual_reviews",
      "billing_email_outbox",
      "billing_webhook_events",
      "billing_webhook_logs",
      "billing_admin_audit_logs",
    ]) {
      expect(POSTGRES_BILLING_SCHEMA_SQL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("delivery_email_ciphertext BYTEA NOT NULL");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("delivery_email_hmac BYTEA NOT NULL");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("paynow_checkout_token_hash BYTEA");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("provider_event_id TEXT");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("billing_email_deliveries_provider_event");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("billing_email_manual_reviews_open");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("expires_at TIMESTAMPTZ NOT NULL");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("created_at TIMESTAMPTZ NOT NULL");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("paid_through TIMESTAMPTZ");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("total_amount INTEGER NOT NULL");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("before_json JSONB");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("after_json JSONB");
    expect(POSTGRES_BILLING_SCHEMA_SQL).toContain("ALTER TABLE billing_admin_audit_logs ADD COLUMN IF NOT EXISTS before_json JSONB");
    expect(POSTGRES_BILLING_SCHEMA_SQL).not.toContain("created_at BIGINT");
    expect(POSTGRES_BILLING_SCHEMA_SQL).not.toContain("expires_at BIGINT");
    expect(POSTGRES_BILLING_TIMESTAMP_MIGRATION_SQL).toContain("billing_checkout_intents");
    expect(POSTGRES_BILLING_TIMESTAMP_MIGRATION_SQL).toContain("to_timestamp");
  });

  it.skipIf(!process.env.SLY_TEST_POSTGRES_URL)(
    "runs on an empty PostgreSQL schema",
    async () => {
      const schema = `sly_billing_test_${randomUUID().replace(/-/g, "")}`;
      const pool = new Pool({
        connectionString: process.env.SLY_TEST_POSTGRES_URL,
        max: 1,
      }) as PgPool;
      try {
        await pool.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(`SET search_path TO "${schema}"`);
        await initializePostgresBillingSchema(pool);
        const tables = await pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename",
          [schema],
        );
        expect(tables.rows.map((row) => row.tablename)).toEqual([
          "billing_admin_audit_logs",
          "billing_checkout_intents",
          "billing_email_deliveries",
          "billing_email_manual_reviews",
          "billing_email_outbox",
          "billing_entitlements",
          "billing_orders",
          "billing_payments",
          "billing_pending_paynow_events",
          "billing_refunds",
          "billing_subscription_periods",
          "billing_subscriptions",
          "billing_webhook_events",
          "billing_webhook_logs",
        ]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await pool.end();
      }
    },
  );

  it.skipIf(!process.env.SLY_TEST_POSTGRES_URL)(
    "upgrades legacy epoch-second billing timestamps to PostgreSQL timestamptz",
    async () => {
      const schema = `sly_billing_legacy_${randomUUID().replace(/-/g, "")}`;
      const pool = new Pool({
        connectionString: process.env.SLY_TEST_POSTGRES_URL,
        max: 1,
      }) as PgPool;
      try {
        await pool.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(`SET search_path TO "${schema}"`);
        await pool.query(`
          CREATE TABLE billing_checkout_intents (
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
            created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
          )
        `);
        await pool.query(`
          INSERT INTO billing_checkout_intents
            (intent_id, status_token_hash, status, plan, plan_snapshot, delivery_email_ciphertext,
             delivery_email_nonce, delivery_email_tag, delivery_email_hmac, masked_email,
             created_at, expires_at, updated_at)
          VALUES
            ('ci_legacytimestamp0001', decode('00', 'hex'), 'pending_checkout', 'studio',
             '{"id":"studio"}'::jsonb, decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'),
             decode('00', 'hex'), 'b***@example.com', 2000000000, 2000001800, 2000000000)
        `);
        await initializePostgresBillingSchema(pool);
        const column = await pool.query<{ data_type: string }>(`
          SELECT data_type
          FROM information_schema.columns
          WHERE table_schema=$1 AND table_name='billing_checkout_intents' AND column_name='created_at'
        `, [schema]);
        expect(column.rows[0]?.data_type).toBe("timestamp with time zone");
        const row = await pool.query<{ iso: string }>(`
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS iso
          FROM billing_checkout_intents
          WHERE intent_id='ci_legacytimestamp0001'
        `);
        expect(row.rows[0]?.iso).toBe("2033-05-18T03:33:20Z");
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await pool.end();
      }
    },
  );
});
