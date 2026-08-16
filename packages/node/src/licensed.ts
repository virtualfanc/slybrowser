import { installGrantedBrowser, type BrowserInstallation, type InstallOptions } from "./installer.js";
import {
  LicenseServiceClient,
  type BrowserVersionPolicy,
  type LicenseServiceClientOptions,
  type LicensedSessionGrant,
  readLicenseAuthorization,
} from "./service.js";
import { launch, type SlyWebDriverSession, type WebDriverLaunchSettings } from "./webdriver.js";
import { ArtifactError } from "./errors.js";

export interface LicensedLaunchOptions extends Omit<WebDriverLaunchSettings, "driverExecutable"> {
  trust: LicenseServiceClientOptions;
  install?: InstallOptions;
  platform?: "windows" | "linux" | "macos";
  arch?: "x64" | "arm64";
  deviceHash?: string;
  browserVersion?: string;
  versionPolicy?: BrowserVersionPolicy;
}

export interface BrowserVersionAudit {
  requested: string | null;
  selected: string;
  downloaded: string;
  launched: string;
  policy: BrowserVersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function verifyBrowserVersionAudit(audit: BrowserVersionAudit): BrowserVersionAudit {
  if (audit.downloaded !== audit.selected || audit.launched !== audit.selected) {
    throw new ArtifactError(
      `Browser version chain mismatch: selected=${audit.selected}, downloaded=${audit.downloaded}, launched=${audit.launched}`,
      "browser_version_chain_mismatch",
    );
  }
  if (audit.policy === "latest" && audit.requested !== null ||
      audit.policy === "exact" && audit.requested !== audit.selected ||
      audit.policy === "at-or-before" && (audit.requested === null || compareVersion(audit.selected, audit.requested) > 0)) {
    throw new ArtifactError("Requested and selected browser versions violate the declared policy", "browser_version_policy_mismatch");
  }
  return Object.freeze({ ...audit });
}

class HeartbeatController {
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #expiresAt: number;

  constructor(
    readonly client: LicenseServiceClient,
    readonly grant: LicensedSessionGrant,
    readonly browser: SlyWebDriverSession,
  ) {
    this.#expiresAt = grant.expiresAt;
  }

  start(): void {
    this.#schedule(this.grant.heartbeatAfterSeconds * 1000);
  }

  async stopAndRelease(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    await this.client.release(this.grant).catch(() => undefined);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#heartbeat(), delay);
    this.#timer.unref();
  }

  async #heartbeat(): Promise<void> {
    if (this.#stopped) return;
    try {
      const renewal = await this.client.heartbeat(this.grant);
      this.#expiresAt = renewal.expiresAt;
      this.grant.expiresAt = renewal.expiresAt;
      this.grant.lease = renewal.lease;
      this.grant.claims = renewal.claims;
      this.#schedule(this.grant.heartbeatAfterSeconds * 1000);
    } catch {
      const remaining = this.#expiresAt * 1000 - Date.now();
      if (remaining <= 30_000) {
        await this.browser.close();
        return;
      }
      this.#schedule(Math.min(15_000, Math.max(1000, remaining - 30_000)));
    }
  }
}

async function installWithHeartbeat(
  client: LicenseServiceClient,
  grant: LicensedSessionGrant,
  install: () => Promise<BrowserInstallation>,
): Promise<BrowserInstallation> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let renewalFailure: unknown;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void renew(), grant.heartbeatAfterSeconds * 1000);
    timer.unref();
  };
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const heartbeat = await client.heartbeat(grant);
      grant.expiresAt = heartbeat.expiresAt;
      grant.lease = heartbeat.lease;
      grant.claims = heartbeat.claims;
      renewalFailure = undefined;
    } catch (error) {
      renewalFailure = error;
    }
    schedule();
  };
  schedule();
  try {
    const installation = await install();
    if (renewalFailure && grant.expiresAt * 1000 <= Date.now() + 30_000) throw renewalFailure;
    return installation;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
  }
}

export async function installLatestAuthorizedBrowser(
  authorizationFile: string,
  options: {
    trust: LicenseServiceClientOptions;
    install?: InstallOptions;
    platform?: "windows" | "linux" | "macos";
    arch?: "x64" | "arm64";
    deviceHash?: string;
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
  },
): Promise<{
  client: LicenseServiceClient;
  grant: LicensedSessionGrant;
  installation: BrowserInstallation;
  release(): Promise<void>;
}> {
  const authorization = await readLicenseAuthorization(authorizationFile, {
    ...(options.trust.allowInsecureLocalhost === undefined
      ? {}
      : { allowInsecureLocalhost: options.trust.allowInsecureLocalhost }),
  });
  const client = new LicenseServiceClient(authorization, options.trust);
  const grant = await client.createSession({
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
    ...(options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
    ...(options.versionPolicy === undefined ? {} : { versionPolicy: options.versionPolicy }),
  });
  try {
    const installation = await installWithHeartbeat(
      client,
      grant,
      () => installGrantedBrowser(client, grant, options.install),
    );
    let released = false;
    return {
      client,
      grant,
      installation,
      async release() {
        if (released) return;
        released = true;
        await client.release(grant);
      },
    };
  } catch (error) {
    await client.release(grant).catch(() => undefined);
    throw error;
  }
}

export async function installLatest(
  authorizationFile: string,
  options: Parameters<typeof installLatestAuthorizedBrowser>[1],
): Promise<BrowserInstallation> {
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, options);
  try {
    return authorized.installation;
  } finally {
    await authorized.release().catch(() => undefined);
  }
}

// The general entry point supports latest, exact pinning, and explicit at-or-before rollback.
export const installAuthorizedBrowser = installLatestAuthorizedBrowser;

export async function launchLatest(
  authorizationFile: string,
  options: LicensedLaunchOptions,
): Promise<SlyWebDriverSession> {
  const {
    trust: _trust,
    install: _install,
    platform: _platform,
    arch: _arch,
    deviceHash: _deviceHash,
    browserVersion: _browserVersion,
    versionPolicy: _versionPolicy,
    ...launchOptions
  } = options;
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, options);
  try {
    const browser = await launch(
      authorized.installation.browserExecutable,
      authorized.grant.lease as unknown as Record<string, unknown>,
      {
        ...launchOptions,
        driverExecutable: authorized.installation.driverExecutable,
      },
    );
    let versionAudit: BrowserVersionAudit;
    try {
      versionAudit = verifyBrowserVersionAudit({
        requested: authorized.grant.requestedBrowserVersion ?? null,
        selected: authorized.grant.browserVersion,
        downloaded: authorized.installation.version,
        launched: browser.versions.browserVersion,
        policy: authorized.grant.versionPolicy,
        selectionReason: authorized.grant.selectionReason,
      });
    } catch (error) {
      await browser.close();
      throw error;
    }
    browser.licenseRuntime = {
      sessionId: authorized.grant.sessionId,
      plan: authorized.grant.plan,
      concurrencyLimit: authorized.grant.concurrencyLimit,
      browserVersion: authorized.grant.browserVersion,
      versionPolicy: authorized.grant.versionPolicy,
      selectionReason: authorized.grant.selectionReason,
      versionAudit,
    };
    const controller = new HeartbeatController(authorized.client, authorized.grant, browser);
    browser.addCloseCallback(() => controller.stopAndRelease());
    controller.start();
    return browser;
  } catch (error) {
    await authorized.release().catch(() => undefined);
    throw error;
  }
}
