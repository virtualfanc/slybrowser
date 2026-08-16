import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { LicenseServiceError } from "./errors.js";
import { type LicenseEnvelope, type LicenseClaims, LicenseVerifier } from "./license.js";
import {
  type ReleaseArtifact,
  type ReleaseManifest,
  isSdkCompatible,
  selectArtifact,
  verifyReleaseManifest,
} from "./manifest.js";

export interface LicenseAuthorization {
  schemaVersion: 1;
  serviceUrl: string;
  licenseKey: string;
  channel: "stable";
}

export interface LicensedSessionGrant {
  sessionId: string;
  sessionToken: string;
  heartbeatAfterSeconds: number;
  expiresAt: number;
  plan: "free" | "launch" | "studio" | "fleet" | "grid";
  concurrencyLimit: number;
  activeSessions: number;
  browserVersion: string;
  requestedBrowserVersion?: string;
  versionPolicy: BrowserVersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
  availableBrowserVersions: string[];
  updateRights: {
    status: "active";
    channel: "stable";
    updatesThrough: number | null;
    exactVersion: true;
    rollback: true;
  };
  lease: LicenseEnvelope;
  claims: LicenseClaims;
  manifest: ReleaseManifest;
  artifact: ReleaseArtifact;
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
}

export type BrowserVersionPolicy = "latest" | "exact" | "at-or-before";

export interface LicenseServiceClientOptions {
  licenseTrustedKeys: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  releaseTrustedKeys: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>;
  fetch?: typeof fetch;
  allowInsecureLocalhost?: boolean;
}

function fail(code: string, message: string, status = 0): never {
  throw new LicenseServiceError(message, code, status);
}

function parseAuthorization(value: unknown, allowInsecureLocalhost = false): LicenseAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("authorization_invalid", "Authorization file must be an object");
  const document = value as Record<string, unknown>;
  if (Object.keys(document).sort().join(",") !== "channel,licenseKey,schemaVersion,serviceUrl" ||
      document.schemaVersion !== 1 || document.channel !== "stable" ||
      typeof document.licenseKey !== "string" ||
      !/^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/.test(document.licenseKey) ||
      typeof document.serviceUrl !== "string") {
    fail("authorization_invalid", "Authorization file fields are invalid");
  }
  let url: URL;
  try {
    url = new URL(document.serviceUrl);
  } catch {
    fail("authorization_invalid", "Authorization service URL is invalid");
  }
  const local = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLocalhost && local && url.protocol === "http:")) {
    fail("authorization_invalid", "Authorization service URL must use HTTPS");
  }
  return {
    schemaVersion: 1,
    serviceUrl: url.toString().replace(/\/$/, ""),
    licenseKey: document.licenseKey,
    channel: "stable",
  };
}

export async function readLicenseAuthorization(
  path: string,
  options: { allowInsecureLocalhost?: boolean } = {},
): Promise<LicenseAuthorization> {
  const raw = await readFile(resolve(path));
  if (raw.length > 64 * 1024) fail("authorization_invalid", "Authorization file is too large");
  try {
    return parseAuthorization(JSON.parse(raw.toString("utf8")), options.allowInsecureLocalhost ?? false);
  } catch (error) {
    if (error instanceof LicenseServiceError) throw error;
    fail("authorization_invalid", "Authorization file is not valid JSON");
  }
}

function currentPlatform(): "windows" | "linux" | "macos" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  fail("platform_unsupported", `Unsupported platform: ${process.platform}`);
}

function currentArch(): "x64" | "arm64" {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  fail("platform_unsupported", `Unsupported architecture: ${process.arch}`);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "License service returned an invalid response");
  return value as Record<string, unknown>;
}

function versionParts(value: string): number[] {
  if (!/^\d+(\.\d+){0,7}$/.test(value)) fail("browser_version_invalid", `Browser version is invalid: ${value}`);
  return value.split(".").map(Number);
}

function compareVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export class LicenseServiceClient {
  readonly authorization: LicenseAuthorization;
  readonly #fetch: typeof fetch;
  readonly #licenseVerifier: LicenseVerifier;
  readonly #releaseTrustedKeys: LicenseServiceClientOptions["releaseTrustedKeys"];

  constructor(authorization: LicenseAuthorization, options: LicenseServiceClientOptions) {
    this.authorization = parseAuthorization(authorization, options.allowInsecureLocalhost ?? false);
    this.#fetch = options.fetch ?? fetch;
    this.#licenseVerifier = new LicenseVerifier(options.licenseTrustedKeys);
    this.#releaseTrustedKeys = options.releaseTrustedKeys;
  }

  async createSession(options: {
    platform?: "windows" | "linux" | "macos";
    arch?: "x64" | "arm64";
    sdkVersion?: string;
    deviceHash?: string;
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
  } = {}): Promise<LicensedSessionGrant> {
    const platform = options.platform ?? currentPlatform();
    const arch = options.arch ?? currentArch();
    const sdkVersion = options.sdkVersion ?? "0.1.0";
    const versionPolicy = options.versionPolicy ?? (options.browserVersion === undefined ? "latest" : "exact");
    if (versionPolicy === "latest" && options.browserVersion !== undefined) {
      fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (versionPolicy !== "latest" && options.browserVersion === undefined) {
      fail("version_policy_invalid", `${versionPolicy} selection requires a browser version`);
    }
    if (options.browserVersion !== undefined) versionParts(options.browserVersion);
    const value = object(await this.#request("POST", "/v1/licenses/sessions", {
      authorization: `License ${this.authorization.licenseKey}`,
      body: {
        platform,
        arch,
        channel: this.authorization.channel,
        sdkVersion,
        ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
        versionPolicy,
        ...(options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
      },
    }), "license_service_invalid_response");
    const sessionId = String(value.sessionId ?? "");
    const sessionToken = String(value.sessionToken ?? "");
    const browserVersion = String(value.browserVersion ?? "");
    if (!sessionId || !sessionToken || !browserVersion || !Number.isSafeInteger(value.expiresAt) ||
        !Number.isSafeInteger(value.heartbeatAfterSeconds)) {
      fail("license_service_invalid_response", "License service session response is invalid");
    }
    const returnedPolicy = String(value.versionPolicy ?? "");
    const selectionReason = String(value.selectionReason ?? "");
    const requestedBrowserVersion = value.requestedBrowserVersion;
    const availableBrowserVersions = value.availableBrowserVersions;
    const updateRights = value.updateRights as Record<string, unknown> | undefined;
    if (returnedPolicy !== versionPolicy ||
        !new Set(["latest", "exact", "rollback"]).has(selectionReason) ||
        (options.browserVersion === undefined
          ? requestedBrowserVersion !== undefined
          : requestedBrowserVersion !== options.browserVersion) ||
        !Array.isArray(availableBrowserVersions) ||
        !availableBrowserVersions.every((item) => typeof item === "string" && /^\d+(\.\d+){0,7}$/.test(item)) ||
        !updateRights || updateRights.status !== "active" || updateRights.channel !== "stable" ||
        (updateRights.updatesThrough !== null && !Number.isSafeInteger(updateRights.updatesThrough)) ||
        updateRights.exactVersion !== true || updateRights.rollback !== true) {
      fail("license_service_invalid_response", "License service version-selection response is invalid");
    }
    if (versionPolicy === "exact" && browserVersion !== options.browserVersion) {
      fail("release_version_mismatch", `Requested browser ${options.browserVersion} but service selected ${browserVersion}`);
    }
    if (versionPolicy === "at-or-before" && compareVersion(browserVersion, options.browserVersion!) > 0) {
      fail("release_version_mismatch", `Rollback selection ${browserVersion} is newer than requested ${options.browserVersion}`);
    }
    const lease = value.lease as LicenseEnvelope;
    const claims = this.#licenseVerifier.verify(lease, {
      browserVersion,
      requiredFeatures: ["browser", "webdriver"],
      ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
    });
    if (claims.sessionId !== sessionId || claims.expiresAt !== value.expiresAt) {
      fail("license_service_invalid_response", "Signed lease does not match the allocated session");
    }
    const manifest = verifyReleaseManifest(value.manifest as Record<string, unknown>, this.#releaseTrustedKeys);
    if (manifest.browserVersion !== browserVersion) {
      fail("license_service_invalid_response", "Release manifest does not match the signed lease");
    }
    if (!isSdkCompatible(manifest.sdkCompatibility, sdkVersion)) {
      fail("sdk_version_unsupported", `Browser ${browserVersion} does not support SDK ${sdkVersion}`);
    }
    const artifact = selectArtifact(manifest, platform, arch);
    const serviceOrigin = new URL(this.authorization.serviceUrl).origin;
    if (new URL(artifact.url).origin !== serviceOrigin) {
      fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
    }
    const plan = value.plan;
    if (!new Set(["free", "launch", "studio", "fleet", "grid"]).has(String(plan)) ||
        !Number.isSafeInteger(value.concurrencyLimit) || !Number.isSafeInteger(value.activeSessions)) {
      fail("license_service_invalid_response", "License service plan response is invalid");
    }
    return {
      sessionId,
      sessionToken,
      heartbeatAfterSeconds: Number(value.heartbeatAfterSeconds),
      expiresAt: Number(value.expiresAt),
      plan: plan as LicensedSessionGrant["plan"],
      concurrencyLimit: Number(value.concurrencyLimit),
      activeSessions: Number(value.activeSessions),
      browserVersion,
      ...(requestedBrowserVersion === undefined ? {} : { requestedBrowserVersion: String(requestedBrowserVersion) }),
      versionPolicy,
      selectionReason: selectionReason as LicensedSessionGrant["selectionReason"],
      availableBrowserVersions: availableBrowserVersions as string[],
      updateRights: updateRights as LicensedSessionGrant["updateRights"],
      lease,
      claims,
      manifest,
      artifact,
      platform,
      arch,
    };
  }

  async heartbeat(grant: LicensedSessionGrant): Promise<{ expiresAt: number; lease: LicenseEnvelope; claims: LicenseClaims }> {
    const value = object(await this.#request("POST", `/v1/licenses/sessions/${encodeURIComponent(grant.sessionId)}/heartbeat`, {
      authorization: `Session ${grant.sessionToken}`,
      body: {},
    }), "license_service_invalid_response");
    const lease = value.lease as LicenseEnvelope;
    const claims = this.#licenseVerifier.verify(lease, {
      browserVersion: grant.browserVersion,
      requiredFeatures: ["browser", "webdriver"],
      ...(grant.claims.deviceHash === undefined ? {} : { deviceHash: grant.claims.deviceHash }),
    });
    if (claims.sessionId !== grant.sessionId || claims.expiresAt !== value.expiresAt) {
      fail("license_service_invalid_response", "Heartbeat lease does not match the active session");
    }
    return { expiresAt: Number(value.expiresAt), lease, claims };
  }

  async release(grant: Pick<LicensedSessionGrant, "sessionId" | "sessionToken">): Promise<void> {
    await this.#request("DELETE", `/v1/licenses/sessions/${encodeURIComponent(grant.sessionId)}`, {
      authorization: `Session ${grant.sessionToken}`,
    });
  }

  async downloadArtifact(grant: LicensedSessionGrant): Promise<Response> {
    const response = await this.#fetch(grant.artifact.url, {
      method: "GET",
      headers: { authorization: `Session ${grant.sessionToken}` },
      redirect: "error",
    });
    if (!response.ok || !response.body) await this.#throwResponse(response);
    return response;
  }

  async #request(method: string, path: string, options: {
    authorization: string;
    body?: unknown;
  }): Promise<unknown> {
    const response = await this.#fetch(`${this.authorization.serviceUrl}${path}`, {
      method,
      headers: {
        authorization: options.authorization,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
    });
    if (!response.ok) await this.#throwResponse(response);
    if (response.status === 204) return {};
    try {
      return await response.json();
    } catch {
      fail("license_service_invalid_response", "License service returned invalid JSON", response.status);
    }
  }

  async #throwResponse(response: Response): Promise<never> {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    fail(
      payload?.error?.code ?? "license_service_error",
      payload?.error?.message ?? `License service request failed with HTTP ${response.status}`,
      response.status,
    );
  }
}
