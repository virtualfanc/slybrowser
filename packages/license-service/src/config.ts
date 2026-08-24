import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { ReleaseCatalog } from "./catalog.js";
import { LeaseSigner } from "./signer.js";
import { PostgresLicenseStore } from "./postgres-store.js";
import { LicenseStore, type EntitlementStore } from "./store.js";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export type LicenseStoreBackend = "sqlite" | "postgres";

export interface SigningKeySeparationOptions {
  onlineSigningKeyFile?: string | undefined;
  onlineKeyId?: string | undefined;
  licenseFileSigningKeyFile?: string | undefined;
  licenseFileKeyId?: string | undefined;
}

export function assertSeparatedSigningKeys(options: SigningKeySeparationOptions): void {
  const onlineSigningKeyFile = options.onlineSigningKeyFile
    ? resolve(options.onlineSigningKeyFile)
    : undefined;
  const licenseFileSigningKeyFile = options.licenseFileSigningKeyFile
    ? resolve(options.licenseFileSigningKeyFile)
    : undefined;
  if (
    onlineSigningKeyFile &&
    licenseFileSigningKeyFile &&
    onlineSigningKeyFile.toLowerCase() === licenseFileSigningKeyFile.toLowerCase()
  ) {
    throw new Error("Online lease signing key and license-file signing key must use separate files");
  }
  if (options.onlineKeyId && options.licenseFileKeyId && options.onlineKeyId === options.licenseFileKeyId) {
    throw new Error("Online lease signing key ID and license-file signing key ID must be different");
  }
}

export function selectLicenseStoreBackend(environment: NodeJS.ProcessEnv = process.env): LicenseStoreBackend {
  const backend = environment.SLY_LICENSE_STORE ?? "sqlite";
  if (backend !== "sqlite" && backend !== "postgres") {
    throw new Error("SLY_LICENSE_STORE must be sqlite or postgres");
  }
  const deploymentMode = environment.SLY_LICENSE_DEPLOYMENT_MODE ?? environment.NODE_ENV;
  if (deploymentMode === "production" && backend === "sqlite") {
    throw new Error("Production license service requires SLY_LICENSE_STORE=postgres; SQLite is local/private-preview only");
  }
  return backend;
}

export async function loadServiceComponents(environment: NodeJS.ProcessEnv = process.env): Promise<{
  store: EntitlementStore;
  catalog: ReleaseCatalog;
  signer: LeaseSigner;
  artifactRoot: string;
  adminToken?: string;
}> {
  assertSeparatedSigningKeys({
    onlineSigningKeyFile: environment.SLY_LICENSE_SIGNING_KEY_FILE,
    onlineKeyId: environment.SLY_LICENSE_KEY_ID,
    licenseFileSigningKeyFile: environment.SLY_LICENSE_FILE_SIGNING_KEY_FILE,
    licenseFileKeyId: environment.SLY_LICENSE_FILE_SIGNING_KEY_ID,
  });
  const backend = selectLicenseStoreBackend(environment);
  const manifestDirectory = resolve(required(environment, "SLY_RELEASE_MANIFEST_DIR"));
  const manifestFiles = (await readdir(manifestDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const manifests = await Promise.all(manifestFiles.map(async (name) =>
    JSON.parse(await readFile(resolve(manifestDirectory, name), "utf8")) as unknown,
  ));
  const privateKey = await readFile(resolve(required(environment, "SLY_LICENSE_SIGNING_KEY_FILE")));
  const pepper = Buffer.from(required(environment, "SLY_LICENSE_KEY_PEPPER"), "base64url");
  const store = backend === "postgres"
    ? await PostgresLicenseStore.connect(required(environment, "SLY_LICENSE_POSTGRES_URL"), pepper)
    : new LicenseStore(resolve(required(environment, "SLY_LICENSE_DB")), pepper);
  return {
    store,
    catalog: new ReleaseCatalog(manifests),
    signer: new LeaseSigner(required(environment, "SLY_LICENSE_KEY_ID"), privateKey),
    artifactRoot: resolve(required(environment, "SLY_RELEASE_ARTIFACT_ROOT")),
    ...(environment.SLY_LICENSE_ADMIN_TOKEN === undefined ? {} : { adminToken: environment.SLY_LICENSE_ADMIN_TOKEN }),
  };
}
