#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "redis";

import { issueAuthorizationFile, issuePortableLicenseFile, issueTestLicenseFile } from "./authorization.js";
import {
  assertSeparatedSigningKeys,
  loadServiceComponents,
  selectLicenseStoreBackend,
  type LicenseStoreBackend,
} from "./config.js";
import { sendQueuedLicenseEmails } from "./email-outbox.js";
import { loadSmtpEmailTransportFromEnv } from "./email.js";
import { isPlanId } from "./plans.js";
import { PayNowManagementClient, type PayNowManagementApiAuditEvent } from "./paynow-management.js";
import { reconcilePayNowBilling } from "./paynow-reconciliation.js";
import { retryPendingFirstPayments } from "./paynow-retry.js";
import {
  PayNowWebhookReceiver,
  PayNowWebhookStore,
  type PayNowBillingStore,
  type PayNowPaymentLogOutcome,
  type PayNowSecurityAlertEvent,
} from "./paynow.js";
import {
  createPayNowBillingHttpServer,
  StaticBillingAdminAuthenticator,
  type BillingAdminPermission,
  type BillingRateLimitEvent,
  type BillingRateLimitOptions,
  type FeedbackRateLimitEvent,
  type FeedbackRateLimitOptions,
  type StaticBillingAdminCredential,
} from "./paynow-server.js";
import { PostgresPayNowWebhookStore } from "./paynow-postgres.js";
import {
  createLicenseHttpServer,
  RedisFixedWindowRateLimiter,
  StaticLicenseAdminAuthenticator,
  type LicenseAdminPermission,
  type RedisRateLimitClient,
  type StaticLicenseAdminCredential,
} from "./server.js";
import { EntitlementService } from "./service.js";

function option(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function requiredOption(arguments_: string[], name: string): string {
  const value = option(arguments_, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePaidThrough(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const numeric = /^\d+$/.test(value) ? Number(value) : Math.floor(Date.parse(value) / 1000);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error("--paid-through must be a Unix time or ISO date");
  return numeric;
}

async function serve(): Promise<void> {
  const components = await loadServiceComponents();
  const rateLimit = await licenseRateLimiterFromEnv();
  const service = new EntitlementService(components.store, components.catalog, components.signer, {
    sessionTtlSeconds: Number(process.env.SLY_LICENSE_SESSION_TTL_SECONDS ?? 660),
    heartbeatAfterSeconds: Number(process.env.SLY_LICENSE_HEARTBEAT_SECONDS ?? 300),
  });
  const adminAuth = licenseAdminAuthenticator();
  const server = createLicenseHttpServer({
    service,
    catalog: components.catalog,
    artifactRoot: components.artifactRoot,
    ...(adminAuth === undefined
      ? components.adminToken === undefined ? {} : { adminToken: components.adminToken }
      : { adminAuth }),
    ...(rateLimit.rateLimiter === undefined ? {} : { rateLimiter: rateLimit.rateLimiter }),
  });
  const host = process.env.SLY_LICENSE_HOST ?? "127.0.0.1";
  const port = Number(process.env.SLY_LICENSE_PORT ?? 8787);
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, host, accept);
  });
  console.log(`SlyBrowser license service listening on ${host}:${port}`);
  const stop = (): void => {
    server.close(() => {
      void Promise.resolve(rateLimit.close?.())
        .finally(() => Promise.resolve(components.store.close()))
        .finally(() => {
          process.exitCode = 0;
        });
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function licenseAdminAuthenticator(): StaticLicenseAdminAuthenticator | undefined {
  const raw = process.env.SLY_LICENSE_ADMIN_CREDENTIALS_JSON;
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("SLY_LICENSE_ADMIN_CREDENTIALS_JSON must be an array");
  }
  const credentials: StaticLicenseAdminCredential[] = parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`SLY_LICENSE_ADMIN_CREDENTIALS_JSON[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.token !== "string" || typeof record.actor !== "string" || !Array.isArray(record.permissions)) {
      throw new Error(`SLY_LICENSE_ADMIN_CREDENTIALS_JSON[${index}] must include token, actor and permissions`);
    }
    return {
      token: record.token,
      actor: record.actor,
      permissions: record.permissions as LicenseAdminPermission[],
    };
  });
  return new StaticLicenseAdminAuthenticator(credentials);
}

async function licenseRateLimiterFromEnv(): Promise<{
  rateLimiter?: RedisFixedWindowRateLimiter;
  close?: () => Promise<void>;
}> {
  const redisUrl = process.env.SLY_REDIS_URL;
  if (!redisUrl) return {};
  const client = createClient({ url: redisUrl });
  client.on("error", (error) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "slybrowser-license-service",
      kind: "redis_rate_limit_error",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "Redis rate-limit backend error",
    }));
  });
  await client.connect();
  return {
    rateLimiter: new RedisFixedWindowRateLimiter(undefined, client as RedisRateLimitClient, {
      prefix: process.env.SLY_LICENSE_RATE_LIMIT_REDIS_PREFIX ?? "slybrowser:license-rate-limit",
    }),
    close: async () => {
      await client.quit();
    },
  };
}

async function issue(arguments_: string[]): Promise<void> {
  const plan = requiredOption(arguments_, "--plan");
  if (!isPlanId(plan)) throw new Error("--plan must be free, launch, studio, fleet, or grid");
  const backend = selectLicenseStoreBackend();
  const pepper = Buffer.from(requiredEnvironment("SLY_LICENSE_KEY_PEPPER"), "base64url");
  const paidThrough = parsePaidThrough(option(arguments_, "--paid-through"));
  const issued = await issueAuthorizationFile({
    database: licenseDatabase(arguments_, backend),
    backend,
    pepper,
    accountId: requiredOption(arguments_, "--account"),
    plan,
    ...(paidThrough === undefined ? {} : { paidThrough }),
    serviceUrl: requiredOption(arguments_, "--service-url"),
    output: requiredOption(arguments_, "--output"),
  });
  console.log(JSON.stringify(issued, null, 2));
}

async function issueTestV2(arguments_: string[]): Promise<void> {
  const plan = requiredOption(arguments_, "--plan");
  if (!isPlanId(plan)) throw new Error("--plan must be free, launch, studio, fleet, or grid");
  const backend = selectLicenseStoreBackend();
  const pepper = Buffer.from(requiredEnvironment("SLY_LICENSE_KEY_PEPPER"), "base64url");
  const passphrase = process.env.SLY_LICENSE_FILE_TEST_PASSPHRASE;
  if (!passphrase) throw new Error("SLY_LICENSE_FILE_TEST_PASSPHRASE is required for test v2 license files");
  const paidThrough = parsePaidThrough(option(arguments_, "--paid-through"));
  const signingKeyPath = resolve(requiredOption(arguments_, "--file-signing-key"));
  const signingPrivateKey = await readFile(signingKeyPath);
  const issued = await issueTestLicenseFile({
    database: licenseDatabase(arguments_, backend),
    backend,
    pepper,
    accountId: requiredOption(arguments_, "--account"),
    plan,
    ...(paidThrough === undefined ? {} : { paidThrough }),
    serviceUrl: requiredOption(arguments_, "--service-url"),
    output: requiredOption(arguments_, "--output"),
    passphrase,
    signingKeyId: option(arguments_, "--file-signing-key-id") ?? "license-file-test-v1",
    signingPrivateKey,
  });
  console.log(JSON.stringify(issued, null, 2));
}

async function issuePortableV2(arguments_: string[]): Promise<void> {
  const plan = requiredOption(arguments_, "--plan");
  if (!isPlanId(plan)) throw new Error("--plan must be free, launch, studio, fleet, or grid");
  const backend = selectLicenseStoreBackend();
  const pepper = Buffer.from(requiredEnvironment("SLY_LICENSE_KEY_PEPPER"), "base64url");
  const passphrase = requiredEnvironment("SLY_LICENSE_FILE_PRIVATE_PREVIEW_PASSPHRASE");
  const paidThrough = parsePaidThrough(option(arguments_, "--paid-through"));
  const signingKeyPath = resolve(option(arguments_, "--file-signing-key") ?? requiredEnvironment("SLY_LICENSE_FILE_SIGNING_KEY_FILE"));
  const signingKeyId = option(arguments_, "--file-signing-key-id") ?? requiredEnvironment("SLY_LICENSE_FILE_SIGNING_KEY_ID");
  assertSeparatedSigningKeys({
    onlineSigningKeyFile: process.env.SLY_LICENSE_SIGNING_KEY_FILE,
    onlineKeyId: process.env.SLY_LICENSE_KEY_ID,
    licenseFileSigningKeyFile: signingKeyPath,
    licenseFileKeyId: signingKeyId,
  });
  const signingPrivateKey = await readFile(signingKeyPath);
  const issued = await issuePortableLicenseFile({
    database: licenseDatabase(arguments_, backend),
    backend,
    pepper,
    accountId: requiredOption(arguments_, "--account"),
    plan,
    ...(paidThrough === undefined ? {} : { paidThrough }),
    serviceUrl: option(arguments_, "--service-url") ?? requiredEnvironment("SLY_LICENSE_FILE_SERVICE_URL"),
    output: requiredOption(arguments_, "--output"),
    passphrase,
    signingKeyId,
    signingPrivateKey,
  });
  console.log(JSON.stringify(issued, null, 2));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function licenseDatabase(arguments_: string[], backend: LicenseStoreBackend): string {
  const value = option(arguments_, "--db");
  if (backend === "postgres") {
    return value ?? requiredEnvironment("SLY_LICENSE_POSTGRES_URL");
  }
  return resolve(value ?? requiredEnvironment("SLY_LICENSE_DB"));
}

type BillingStoreBackend = "sqlite" | "postgres";

function selectBillingStoreBackend(environment: NodeJS.ProcessEnv = process.env): BillingStoreBackend {
  const backend = environment.SLY_BILLING_STORE ?? "sqlite";
  if (backend !== "sqlite" && backend !== "postgres") {
    throw new Error("SLY_BILLING_STORE must be sqlite or postgres");
  }
  const deploymentMode = environment.SLY_BILLING_DEPLOYMENT_MODE ?? environment.NODE_ENV;
  if (deploymentMode === "production" && backend === "sqlite") {
    throw new Error("Production billing service requires SLY_BILLING_STORE=postgres; SQLite is local/private-preview only");
  }
  return backend;
}

function billingDatabase(arguments_: string[], backend: BillingStoreBackend): string {
  const value = option(arguments_, "--db");
  if (backend === "postgres") {
    return value ?? requiredEnvironment("SLY_BILLING_POSTGRES_URL");
  }
  return resolve(value ?? requiredEnvironment("SLY_PAYNOW_DB"));
}

function billingEmailKeys(): ConstructorParameters<typeof PayNowWebhookStore>[1] {
  return {
    emailEncryptionKey: Buffer.from(requiredEnvironment("SLY_BILLING_EMAIL_ENCRYPTION_KEY"), "base64url"),
    ...(process.env.SLY_BILLING_EMAIL_HMAC_KEY === undefined
      ? {}
      : { emailHmacKey: Buffer.from(process.env.SLY_BILLING_EMAIL_HMAC_KEY, "base64url") }),
  };
}

function optionalBillingGracePeriodSeconds(): number | undefined {
  const value = process.env.SLY_BILLING_GRACE_PERIOD_SECONDS;
  if (value === undefined || value === "") return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 31 * 24 * 60 * 60) {
    throw new Error("SLY_BILLING_GRACE_PERIOD_SECONDS must be an integer between 0 and 2678400");
  }
  return numeric;
}

async function postgresBillingOptions(): Promise<Parameters<typeof PostgresPayNowWebhookStore.connect>[1]> {
  const signingKeyPath = resolve(requiredEnvironment("SLY_LICENSE_FILE_SIGNING_KEY_FILE"));
  const signingKeyId = requiredEnvironment("SLY_LICENSE_FILE_SIGNING_KEY_ID");
  assertSeparatedSigningKeys({
    onlineSigningKeyFile: process.env.SLY_LICENSE_SIGNING_KEY_FILE,
    onlineKeyId: process.env.SLY_LICENSE_KEY_ID,
    licenseFileSigningKeyFile: signingKeyPath,
    licenseFileKeyId: signingKeyId,
  });
  const signingPrivateKey = await readFile(signingKeyPath);
  const gracePeriodSeconds = optionalBillingGracePeriodSeconds();
  return {
    ...billingEmailKeys(),
    licenseKeyPepper: Buffer.from(requiredEnvironment("SLY_LICENSE_KEY_PEPPER"), "base64url"),
    licenseFile: {
      serviceUrl: requiredEnvironment("SLY_LICENSE_FILE_SERVICE_URL"),
      passphrase: requiredEnvironment("SLY_LICENSE_FILE_PRIVATE_PREVIEW_PASSPHRASE"),
      signingKeyId,
      signingPrivateKey,
    },
    ...(gracePeriodSeconds === undefined ? {} : { gracePeriodSeconds }),
  };
}

function boundedInteger(value: string | undefined, fallback: number, name: string, maximum: number): number {
  const numeric = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return numeric;
}

function payNowManagementApiAuditSink(event: PayNowManagementApiAuditEvent): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "slybrowser-license-service",
    kind: "paynow_management_api",
    ...event,
  }));
}

function feedbackRateLimitAlertSink(event: FeedbackRateLimitEvent): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "slybrowser-license-service",
    kind: "feedback_rate_limit",
    ...event,
  }));
}

function billingRateLimitAlertSink(event: BillingRateLimitEvent): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "slybrowser-license-service",
    kind: "billing_rate_limit",
    ...event,
  }));
}

function payNowSecurityAlertSink(event: PayNowSecurityAlertEvent): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "slybrowser-license-service",
    kind: event.kind,
    eventId: event.eventId,
    eventType: event.eventType,
    payloadSha256: event.payloadSha256,
    errorCode: event.errorCode,
  }));
}

function feedbackRateLimitOptions(): FeedbackRateLimitOptions {
  return {
    windowSeconds: boundedInteger(
      process.env.SLY_FEEDBACK_RATE_LIMIT_WINDOW_SECONDS,
      15 * 60,
      "SLY_FEEDBACK_RATE_LIMIT_WINDOW_SECONDS",
      24 * 60 * 60,
    ),
    maxPerIp: boundedInteger(
      process.env.SLY_FEEDBACK_RATE_LIMIT_MAX_PER_IP,
      10,
      "SLY_FEEDBACK_RATE_LIMIT_MAX_PER_IP",
      10_000,
    ),
    maxPerEmail: boundedInteger(
      process.env.SLY_FEEDBACK_RATE_LIMIT_MAX_PER_EMAIL,
      3,
      "SLY_FEEDBACK_RATE_LIMIT_MAX_PER_EMAIL",
      10_000,
    ),
    maxPerUserAgent: boundedInteger(
      process.env.SLY_FEEDBACK_RATE_LIMIT_MAX_PER_USER_AGENT,
      20,
      "SLY_FEEDBACK_RATE_LIMIT_MAX_PER_USER_AGENT",
      10_000,
    ),
    alertSink: feedbackRateLimitAlertSink,
  };
}

function billingRateLimitOptions(): BillingRateLimitOptions {
  return {
    alertSink: billingRateLimitAlertSink,
  };
}

function payNowManagementClient(storeId: string): PayNowManagementClient {
  return new PayNowManagementClient({
    apiKey: requiredEnvironment("SLY_PAYNOW_API_KEY"),
    storeId,
    ...(process.env.SLY_PAYNOW_API_BASE_URL === undefined
      ? {}
      : { apiBaseUrl: process.env.SLY_PAYNOW_API_BASE_URL }),
    timeoutMilliseconds: boundedInteger(
      process.env.SLY_PAYNOW_API_TIMEOUT_MS,
      20_000,
      "SLY_PAYNOW_API_TIMEOUT_MS",
      60_000,
    ),
    rateLimit: {
      requestsPerMinute: boundedInteger(
        process.env.SLY_PAYNOW_API_RATE_LIMIT_PER_MINUTE,
        120,
        "SLY_PAYNOW_API_RATE_LIMIT_PER_MINUTE",
        6000,
      ),
      maxQueue: boundedInteger(
        process.env.SLY_PAYNOW_API_RATE_LIMIT_MAX_QUEUE,
        100,
        "SLY_PAYNOW_API_RATE_LIMIT_MAX_QUEUE",
        1000,
      ),
    },
    auditSink: payNowManagementApiAuditSink,
  });
}

function billingAdminAuthenticator(): StaticBillingAdminAuthenticator | undefined {
  const raw = process.env.SLY_BILLING_ADMIN_CREDENTIALS_JSON;
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SLY_BILLING_ADMIN_CREDENTIALS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SLY_BILLING_ADMIN_CREDENTIALS_JSON must be an array");
  }
  const credentials: StaticBillingAdminCredential[] = parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`SLY_BILLING_ADMIN_CREDENTIALS_JSON[${index}] must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (typeof record.token !== "string" || typeof record.actor !== "string" || !Array.isArray(record.permissions)) {
      throw new Error(`SLY_BILLING_ADMIN_CREDENTIALS_JSON[${index}] must include token, actor and permissions`);
    }
    return {
      token: record.token,
      actor: record.actor,
      permissions: record.permissions as BillingAdminPermission[],
    };
  });
  return new StaticBillingAdminAuthenticator(credentials);
}

async function billingServe(): Promise<void> {
  const backend = selectBillingStoreBackend();
  const storeOptions = backend === "postgres" ? await postgresBillingOptions() : billingEmailKeys();
  const postgresStore = backend === "postgres"
    ? await PostgresPayNowWebhookStore.connect(billingDatabase([], backend), storeOptions)
    : undefined;
  const store: PayNowBillingStore = postgresStore ?? new PayNowWebhookStore(billingDatabase([], backend), storeOptions);
  void Promise.resolve(store.prunePaymentLogs());
  const pruneTimer = setInterval(() => void Promise.resolve(store.prunePaymentLogs()).catch(() => undefined), 6 * 60 * 60 * 1000);
  pruneTimer.unref();
  const storeId = requiredEnvironment("SLY_PAYNOW_STORE_ID");
  const checkoutClient = payNowManagementClient(storeId);
  const receiver = new PayNowWebhookReceiver(store, {
    signingSecrets: requiredEnvironment("SLY_PAYNOW_WEBHOOK_SECRETS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    storeId,
    ...(postgresStore === undefined
      ? {}
      : { firstPayment: { verifier: checkoutClient, recorder: postgresStore, pendingQueue: postgresStore } }),
    securityAlertSink: payNowSecurityAlertSink,
  });
  const serverOptions: NonNullable<Parameters<typeof createPayNowBillingHttpServer>[1]> = {
    checkoutClient,
    feedbackRateLimit: feedbackRateLimitOptions(),
    billingRateLimit: billingRateLimitOptions(),
    ...(process.env.SLY_BILLING_PUBLIC_ORIGIN === undefined
      ? {}
      : { publicOrigin: process.env.SLY_BILLING_PUBLIC_ORIGIN }),
  };
  const emailTransport = loadSmtpEmailTransportFromEnv();
  if (emailTransport && process.env.SLY_FEEDBACK_TO) {
    serverOptions.feedbackEmail = {
      transport: emailTransport,
      to: process.env.SLY_FEEDBACK_TO,
      subjectPrefix: process.env.SLY_FEEDBACK_SUBJECT_PREFIX ?? "[SlyBrowser feedback]",
    };
  }
  if (postgresStore && process.env.SLY_EMAIL_WEBHOOK_TOKEN) {
    serverOptions.emailDeliveryStatus = {
      store: postgresStore,
      token: process.env.SLY_EMAIL_WEBHOOK_TOKEN,
    };
  }
  if (postgresStore) {
    serverOptions.customerPortal = {
      store: postgresStore,
    };
    serverOptions.customerSubscriptionCancellation = {
      store: postgresStore,
      client: checkoutClient,
    };
    const adminAuth = billingAdminAuthenticator();
    const legacyAdminToken = process.env.SLY_BILLING_ADMIN_TOKEN;
    if (adminAuth) {
      serverOptions.adminRefunds = {
        store: postgresStore,
        client: checkoutClient,
        adminAuth,
      };
      serverOptions.adminLicenseRotations = {
        store: postgresStore,
        adminAuth,
      };
    } else if (legacyAdminToken) {
      serverOptions.adminRefunds = {
        store: postgresStore,
        client: checkoutClient,
        token: legacyAdminToken,
      };
      serverOptions.adminLicenseRotations = {
        store: postgresStore,
        token: legacyAdminToken,
      };
    }
  }
  const server = createPayNowBillingHttpServer(receiver, serverOptions);
  const host = process.env.SLY_PAYNOW_HOST ?? "127.0.0.1";
  const port = Number(process.env.SLY_PAYNOW_PORT ?? 8787);
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, host, accept);
  });
  console.log(`SlyBrowser billing service listening on ${host}:${port}`);
  const stop = (): void => {
    clearInterval(pruneTimer);
    server.close(() => {
      void Promise.resolve(store.close()).finally(() => {
        process.exitCode = 0;
      });
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function billingSendLicenseEmails(arguments_: string[]): Promise<void> {
  const backend = selectBillingStoreBackend();
  if (backend !== "postgres") {
    throw new Error("License email outbox worker requires SLY_BILLING_STORE=postgres");
  }
  const transport = loadSmtpEmailTransportFromEnv();
  if (!transport) {
    throw new Error("SLY_EMAIL_SMTP_HOST and SLY_EMAIL_FROM are required to send license email");
  }
  const limit = boundedInteger(option(arguments_, "--limit"), Number(process.env.SLY_LICENSE_EMAIL_WORKER_LIMIT ?? 20), "--limit", 100);
  const maxAttempts = boundedInteger(option(arguments_, "--max-attempts"), Number(process.env.SLY_LICENSE_EMAIL_MAX_ATTEMPTS ?? 5), "--max-attempts", 20);
  const store = await PostgresPayNowWebhookStore.connect(billingDatabase(arguments_, backend), billingEmailKeys());
  try {
    const customerPortalUrl = process.env.SLY_BILLING_PUBLIC_ORIGIN === undefined
      ? undefined
      : new URL("/billing/order", process.env.SLY_BILLING_PUBLIC_ORIGIN).toString();
    const result = await sendQueuedLicenseEmails(store, transport, {
      limit,
      maxAttempts,
      supportEmail: process.env.SLY_SUPPORT_EMAIL ?? "support@slybrowser.com",
      ...(customerPortalUrl === undefined ? {} : { customerPortalUrl }),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await store.close();
  }
}

async function billingRetryPendingPayments(arguments_: string[]): Promise<void> {
  const backend = selectBillingStoreBackend();
  if (backend !== "postgres") {
    throw new Error("Pending PayNow payment retry worker requires SLY_BILLING_STORE=postgres");
  }
  const storeId = requiredEnvironment("SLY_PAYNOW_STORE_ID");
  const checkoutClient = payNowManagementClient(storeId);
  const limit = boundedInteger(option(arguments_, "--limit"), Number(process.env.SLY_PAYNOW_PENDING_WORKER_LIMIT ?? 20), "--limit", 100);
  const maxAttempts = boundedInteger(option(arguments_, "--max-attempts"), Number(process.env.SLY_PAYNOW_PENDING_MAX_ATTEMPTS ?? 5), "--max-attempts", 20);
  const store = await PostgresPayNowWebhookStore.connect(billingDatabase(arguments_, backend), await postgresBillingOptions());
  try {
    const result = await retryPendingFirstPayments(store, checkoutClient, {
      limit,
      maxAttempts,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await store.close();
  }
}

async function billingReconcilePayNow(arguments_: string[]): Promise<void> {
  const backend = selectBillingStoreBackend();
  if (backend !== "postgres") {
    throw new Error("PayNow reconciliation worker requires SLY_BILLING_STORE=postgres");
  }
  const storeId = requiredEnvironment("SLY_PAYNOW_STORE_ID");
  const checkoutClient = payNowManagementClient(storeId);
  const paymentLimit = boundedInteger(
    option(arguments_, "--payment-limit"),
    Number(process.env.SLY_PAYNOW_RECONCILE_PAYMENT_LIMIT ?? 100),
    "--payment-limit",
    250,
  );
  const subscriptionLimit = boundedInteger(
    option(arguments_, "--subscription-limit"),
    Number(process.env.SLY_PAYNOW_RECONCILE_SUBSCRIPTION_LIMIT ?? 100),
    "--subscription-limit",
    250,
  );
  const store = await PostgresPayNowWebhookStore.connect(billingDatabase(arguments_, backend), await postgresBillingOptions());
  try {
    const reconciliationOptions: Parameters<typeof reconcilePayNowBilling>[2] = {
      paymentLimit,
      subscriptionLimit,
    };
    const paymentAfter = option(arguments_, "--payment-after");
    const paymentBefore = option(arguments_, "--payment-before");
    const subscriptionAfter = option(arguments_, "--subscription-after");
    const subscriptionBefore = option(arguments_, "--subscription-before");
    if (paymentAfter !== undefined) reconciliationOptions.paymentAfter = paymentAfter;
    if (paymentBefore !== undefined) reconciliationOptions.paymentBefore = paymentBefore;
    if (subscriptionAfter !== undefined) reconciliationOptions.subscriptionAfter = subscriptionAfter;
    if (subscriptionBefore !== undefined) reconciliationOptions.subscriptionBefore = subscriptionBefore;
    const result = await reconcilePayNowBilling(store, checkoutClient, reconciliationOptions);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await store.close();
  }
}

async function billingLogs(arguments_: string[]): Promise<void> {
  const backend = selectBillingStoreBackend();
  const outcomeValue = option(arguments_, "--outcome");
  if (outcomeValue !== undefined && outcomeValue !== "success" && outcomeValue !== "failure") {
    throw new Error("--outcome must be success or failure");
  }
  const outcome = outcomeValue as PayNowPaymentLogOutcome | undefined;
  const limit = boundedInteger(option(arguments_, "--limit"), 100, "--limit", 1000);
  const sinceDays = boundedInteger(option(arguments_, "--since-days"), 30, "--since-days", 30);
  const store: PayNowBillingStore = backend === "postgres"
    ? await PostgresPayNowWebhookStore.connect(billingDatabase(arguments_, backend), billingEmailKeys())
    : new PayNowWebhookStore(billingDatabase(arguments_, backend), billingEmailKeys());
  try {
    await Promise.resolve(store.prunePaymentLogs());
    const logs = await Promise.resolve(store.paymentLogs({
      limit,
      since: Math.floor(Date.now() / 1000) - sinceDays * 24 * 60 * 60,
      ...(outcome === undefined ? {} : { outcome }),
    }));
    console.log(JSON.stringify(logs, null, 2));
  } finally {
    await Promise.resolve(store.close());
  }
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "issue") {
    await issue(arguments_);
    return;
  }
  if (command === "issue-test-v2") {
    await issueTestV2(arguments_);
    return;
  }
  if (command === "issue-portable-v2") {
    await issuePortableV2(arguments_);
    return;
  }
  if (command === "billing-serve") {
    await billingServe();
    return;
  }
  if (command === "billing-send-license-emails") {
    await billingSendLicenseEmails(arguments_);
    return;
  }
  if (command === "billing-retry-pending-payments") {
    await billingRetryPendingPayments(arguments_);
    return;
  }
  if (command === "billing-reconcile-paynow") {
    await billingReconcilePayNow(arguments_);
    return;
  }
  if (command === "billing-logs") {
    await billingLogs(arguments_);
    return;
  }
  throw new Error("Usage: sly-license-service serve | billing-serve | billing-send-license-emails [--limit 1-100] [--max-attempts 1-20] | billing-retry-pending-payments [--limit 1-100] [--max-attempts 1-20] | billing-reconcile-paynow [--payment-limit 1-250] [--subscription-limit 1-250] [--payment-after CURSOR] [--payment-before CURSOR] [--subscription-after CURSOR] [--subscription-before CURSOR] | billing-logs [--db FILE] [--outcome success|failure] [--since-days 1-30] [--limit 1-1000] | issue [--db FILE] --account ID --plan PLAN [--paid-through TIME] --service-url URL --output FILE | issue-test-v2 [--db FILE] --account ID --plan PLAN [--paid-through TIME] --service-url URL --output FILE --file-signing-key PEM [--file-signing-key-id ID] | issue-portable-v2 [--db FILE] --account ID --plan PLAN [--paid-through TIME] [--service-url URL] --output FILE [--file-signing-key PEM] [--file-signing-key-id ID]");
}

await main();
