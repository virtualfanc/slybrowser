import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import type { PlanId } from "./plans.js";
import { LicenseStore } from "./store.js";

export async function issueAuthorizationFile(input: {
  database: string;
  pepper: Uint8Array;
  accountId: string;
  plan: PlanId;
  paidThrough?: number;
  serviceUrl: string;
  output: string;
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
  let store: LicenseStore | undefined;
  try {
    store = new LicenseStore(resolve(input.database), input.pepper);
    const issued = store.issueEntitlement({
      accountId: input.accountId,
      plan: input.plan,
      ...(input.paidThrough === undefined ? {} : { paidThrough: input.paidThrough }),
      now: input.now ?? Math.floor(Date.now() / 1000),
    });
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
    store?.close();
    await handle.close();
    if (!completed) await unlink(authorizationFile).catch(() => undefined);
  }
}
