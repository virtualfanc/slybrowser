#!/usr/bin/env node

import { resolve } from "node:path";

import { issueAuthorizationFile } from "./authorization.js";
import { loadServiceComponents } from "./config.js";
import { isPlanId } from "./plans.js";
import { PayNowWebhookReceiver, PayNowWebhookStore } from "./paynow.js";
import { createPayNowBillingHttpServer } from "./paynow-server.js";
import { createLicenseHttpServer } from "./server.js";
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
  const service = new EntitlementService(components.store, components.catalog, components.signer, {
    sessionTtlSeconds: Number(process.env.SLY_LICENSE_SESSION_TTL_SECONDS ?? 600),
    heartbeatAfterSeconds: Number(process.env.SLY_LICENSE_HEARTBEAT_SECONDS ?? 60),
  });
  const server = createLicenseHttpServer({
    service,
    catalog: components.catalog,
    artifactRoot: components.artifactRoot,
    ...(components.adminToken === undefined ? {} : { adminToken: components.adminToken }),
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
      components.store.close();
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function issue(arguments_: string[]): Promise<void> {
  const plan = requiredOption(arguments_, "--plan");
  if (!isPlanId(plan)) throw new Error("--plan must be free, launch, studio, fleet, or grid");
  const pepper = Buffer.from(process.env.SLY_LICENSE_KEY_PEPPER ?? "", "base64url");
  const paidThrough = parsePaidThrough(option(arguments_, "--paid-through"));
  const issued = await issueAuthorizationFile({
    database: requiredOption(arguments_, "--db"),
    pepper,
    accountId: requiredOption(arguments_, "--account"),
    plan,
    ...(paidThrough === undefined ? {} : { paidThrough }),
    serviceUrl: requiredOption(arguments_, "--service-url"),
    output: requiredOption(arguments_, "--output"),
  });
  console.log(JSON.stringify(issued, null, 2));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function billingServe(): Promise<void> {
  const store = new PayNowWebhookStore(resolve(requiredEnvironment("SLY_PAYNOW_DB")));
  const receiver = new PayNowWebhookReceiver(store, {
    signingSecrets: requiredEnvironment("SLY_PAYNOW_WEBHOOK_SECRETS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    storeId: requiredEnvironment("SLY_PAYNOW_STORE_ID"),
  });
  const server = createPayNowBillingHttpServer(receiver);
  const host = process.env.SLY_PAYNOW_HOST ?? "127.0.0.1";
  const port = Number(process.env.SLY_PAYNOW_PORT ?? 8787);
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(port, host, accept);
  });
  console.log(`SlyBrowser billing service listening on ${host}:${port}`);
  const stop = (): void => {
    server.close(() => {
      store.close();
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
  if (command === "billing-serve") {
    await billingServe();
    return;
  }
  throw new Error("Usage: sly-license-service serve | billing-serve | issue --db FILE --account ID --plan PLAN [--paid-through TIME] --service-url URL --output FILE");
}

await main();
