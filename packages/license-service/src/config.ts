import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { ReleaseCatalog } from "./catalog.js";
import { LeaseSigner } from "./signer.js";
import { LicenseStore } from "./store.js";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function loadServiceComponents(environment: NodeJS.ProcessEnv = process.env): Promise<{
  store: LicenseStore;
  catalog: ReleaseCatalog;
  signer: LeaseSigner;
  artifactRoot: string;
  adminToken?: string;
}> {
  const manifestDirectory = resolve(required(environment, "SLY_RELEASE_MANIFEST_DIR"));
  const manifestFiles = (await readdir(manifestDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const manifests = await Promise.all(manifestFiles.map(async (name) =>
    JSON.parse(await readFile(resolve(manifestDirectory, name), "utf8")) as unknown,
  ));
  const privateKey = await readFile(resolve(required(environment, "SLY_LICENSE_SIGNING_KEY_FILE")));
  const pepper = Buffer.from(required(environment, "SLY_LICENSE_KEY_PEPPER"), "base64url");
  return {
    store: new LicenseStore(resolve(required(environment, "SLY_LICENSE_DB")), pepper),
    catalog: new ReleaseCatalog(manifests),
    signer: new LeaseSigner(required(environment, "SLY_LICENSE_KEY_ID"), privateKey),
    artifactRoot: resolve(required(environment, "SLY_RELEASE_ARTIFACT_ROOT")),
    ...(environment.SLY_LICENSE_ADMIN_TOKEN === undefined ? {} : { adminToken: environment.SLY_LICENSE_ADMIN_TOKEN }),
  };
}
