import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { createPortableLicenseFile, createTestLicenseFile } from "./license-file.js";
import type { PlanId } from "./plans.js";
import { PostgresLicenseStore } from "./postgres-store.js";
import { LicenseStore, type EntitlementStore } from "./store.js";

export type AuthorizationStoreBackend = "sqlite" | "postgres";

async function openEntitlementStore(input: {
  backend?: AuthorizationStoreBackend;
  database: string;
  pepper: Uint8Array;
}): Promise<EntitlementStore> {
  return input.backend === "postgres"
    ? PostgresLicenseStore.connect(input.database, input.pepper)
    : new LicenseStore(resolve(input.database), input.pepper);
}

export async function issueAuthorizationFile(input: {
  database: string;
  pepper: Uint8Array;
  accountId: string;
  plan: PlanId;
  paidThrough?: number;
  serviceUrl: string;
  output: string;
  backend?: AuthorizationStoreBackend;
  now?: number;
}): Promise<{
  licenseId: string;
  accountId: string;
  plan: PlanId;
  paidThrough: number | null;
  authorizationFile: string;
}> {
  const serviceUrl = new URL(input.serviceUrl);
  if (serviceUrl.protocol !== "https:") throw new Error("Service URL must use HTTPS");
  const authorizationFile = resolve(input.output);
  const handle = await open(authorizationFile, "wx", 0o600);
  let completed = false;
  let store: EntitlementStore | undefined;
  try {
    store = await openEntitlementStore(input);
    const issued = await Promise.resolve(store.issueEntitlement({
      accountId: input.accountId,
      plan: input.plan,
      ...(input.paidThrough === undefined ? {} : { paidThrough: input.paidThrough }),
      now: input.now ?? Math.floor(Date.now() / 1000),
    }));
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      serviceUrl: serviceUrl.toString().replace(/\/$/, ""),
      licenseKey: issued.licenseKey,
      channel: "stable",
    }, null, 2)}\n`, "utf8");
    await handle.sync();
    completed = true;
    return {
      licenseId: issued.licenseId,
      accountId: issued.accountId,
      plan: issued.plan,
      paidThrough: issued.paidThrough,
      authorizationFile,
    };
  } finally {
    await Promise.resolve(store?.close());
    await handle.close();
    if (!completed) await unlink(authorizationFile).catch(() => undefined);
  }
}

export async function issueTestLicenseFile(input: {
  database: string;
  pepper: Uint8Array;
  accountId: string;
  plan: PlanId;
  paidThrough?: number;
  serviceUrl: string;
  output: string;
  passphrase: string;
  signingKeyId: string;
  signingPrivateKey: string | Buffer;
  backend?: AuthorizationStoreBackend;
  now?: number;
}): Promise<{
  schemaVersion: 2;
  scope: "test-private-preview";
  licenseId: string;
  accountId: string;
  plan: PlanId;
  paidThrough: number | null;
  licenseFile: string;
  fileId: string;
}> {
  const licenseFile = resolve(input.output);
  const handle = await open(licenseFile, "wx", 0o600);
  let completed = false;
  let store: EntitlementStore | undefined;
  try {
    store = await openEntitlementStore(input);
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const issued = await Promise.resolve(store.issueEntitlement({
      accountId: input.accountId,
      plan: input.plan,
      ...(input.paidThrough === undefined ? {} : { paidThrough: input.paidThrough }),
      now,
    }));
    const document = createTestLicenseFile({
      licenseId: issued.licenseId,
      licenseKey: issued.licenseKey,
      serviceUrl: input.serviceUrl,
      issuedAt: new Date(now * 1000),
      passphrase: input.passphrase,
      signingKeyId: input.signingKeyId,
      signingPrivateKey: input.signingPrivateKey,
    });
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    completed = true;
    return {
      schemaVersion: 2,
      scope: "test-private-preview",
      licenseId: issued.licenseId,
      accountId: issued.accountId,
      plan: issued.plan,
      paidThrough: issued.paidThrough,
      licenseFile,
      fileId: document.fileId,
    };
  } finally {
    await Promise.resolve(store?.close());
    await handle.close();
    if (!completed) await unlink(licenseFile).catch(() => undefined);
  }
}

export async function issuePortableLicenseFile(input: {
  database: string;
  pepper: Uint8Array;
  accountId: string;
  plan: PlanId;
  paidThrough?: number;
  serviceUrl: string;
  output: string;
  passphrase: string;
  signingKeyId: string;
  signingPrivateKey: string | Buffer;
  backend?: AuthorizationStoreBackend;
  now?: number;
  expiresAt?: Date | string;
}): Promise<{
  schemaVersion: 2;
  scope: "portable-passphrase";
  licenseId: string;
  accountId: string;
  plan: PlanId;
  paidThrough: number | null;
  licenseFile: string;
  fileId: string;
}> {
  const licenseFile = resolve(input.output);
  const handle = await open(licenseFile, "wx", 0o600);
  let completed = false;
  let store: EntitlementStore | undefined;
  try {
    store = await openEntitlementStore(input);
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const issued = await Promise.resolve(store.issueEntitlement({
      accountId: input.accountId,
      plan: input.plan,
      ...(input.paidThrough === undefined ? {} : { paidThrough: input.paidThrough }),
      now,
    }));
    const document = createPortableLicenseFile({
      licenseId: issued.licenseId,
      licenseKey: issued.licenseKey,
      serviceUrl: input.serviceUrl,
      issuedAt: new Date(now * 1000),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      passphrase: input.passphrase,
      signingKeyId: input.signingKeyId,
      signingPrivateKey: input.signingPrivateKey,
    });
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    completed = true;
    return {
      schemaVersion: 2,
      scope: "portable-passphrase",
      licenseId: issued.licenseId,
      accountId: issued.accountId,
      plan: issued.plan,
      paidThrough: issued.paidThrough,
      licenseFile,
      fileId: document.fileId,
    };
  } finally {
    await Promise.resolve(store?.close());
    await handle.close();
    if (!completed) await unlink(licenseFile).catch(() => undefined);
  }
}
