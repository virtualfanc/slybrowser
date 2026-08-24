import {
  findCurrentBrowserInstallation,
  acquireBrowserInstallationReference,
  installGrantedBrowser,
  type BrowserInstallation,
  type BrowserInstallationReference,
  type InstallOptions,
} from "./installer.js";
import {
  launchPlaywright,
  launchPlaywrightPersistent,
  launchPuppeteer,
  launchPuppeteerPersistent,
  type FrameworkLaunchSettings,
  type PlaywrightLike,
  type PuppeteerLike,
} from "./browser.js";
import type { AutomationBackend } from "./automation.js";
import {
  LicenseServiceClient,
  type BrowserVersionPolicy,
  type KernelMajor,
  type LicenseServiceClientOptions,
  type RuntimeSessionGrant,
  readLicenseAuthorization,
} from "./service.js";
import { launch as launchWebDriver, type SlyWebDriverSession, type WebDriverLaunchSettings } from "./webdriver.js";
import { ArtifactError, ConfigurationError, LicenseServiceError } from "./errors.js";

export interface LicensedLaunchOptions extends Omit<WebDriverLaunchSettings, "driverExecutable"> {
  trust: LicenseServiceClientOptions;
  install?: InstallOptions;
  platform?: "windows" | "linux" | "macos";
  arch?: "x64" | "arm64";
  deviceHash?: string;
  kernelMajor?: KernelMajor;
  updateKernel?: boolean;
  browserVersion?: string;
  versionPolicy?: BrowserVersionPolicy;
  automationBackend?: AutomationBackend;
}

export interface BrowserVersionAudit {
  requested: string | null;
  selected: string;
  downloaded: string;
  launched: string;
  policy: BrowserVersionPolicy;
  selectionReason: "latest" | "exact" | "rollback";
}

export interface LicensedFrameworkLaunchOptions extends FrameworkLaunchSettings {
  trust: LicenseServiceClientOptions;
  install?: InstallOptions;
  platform?: "windows" | "linux" | "macos";
  arch?: "x64" | "arm64";
  deviceHash?: string;
  kernelMajor?: KernelMajor;
  updateKernel?: boolean;
  browserVersion?: string;
  versionPolicy?: BrowserVersionPolicy;
}

export interface LicensedRuntimeMetadata {
  sessionId: string;
  plan: string;
  concurrencyLimit: number;
  browserVersion: string;
  versionPolicy?: BrowserVersionPolicy;
  selectionReason?: "latest" | "exact" | "rollback";
  versionAudit?: BrowserVersionAudit;
}

export type LicensedFrameworkRuntime<T> = T & { licenseRuntime?: LicensedRuntimeMetadata };

interface ClosableRuntime {
  close(...args: unknown[]): unknown;
  licenseRuntime?: LicensedRuntimeMetadata;
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

export function heartbeatDelayMilliseconds(
  heartbeatAfterSeconds: number,
  random: () => number = Math.random,
): number {
  const baseSeconds = Math.max(1, heartbeatAfterSeconds);
  const jitterWindowSeconds = Math.min(15, Math.max(0, baseSeconds - 1));
  const sample = Math.max(0, Math.min(1, random()));
  return Math.round((baseSeconds - jitterWindowSeconds * sample) * 1000);
}

class BootstrapHeartbeatController {
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #expiresAt: number;

  constructor(
    readonly client: LicenseServiceClient,
    readonly grant: RuntimeSessionGrant,
  ) {
    this.#expiresAt = grant.expiresAt;
  }

  start(): void {
    this.#schedule(heartbeatDelayMilliseconds(this.grant.heartbeatAfterSeconds));
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#heartbeat(), delay);
    this.#timer.unref();
  }

  async #heartbeat(): Promise<void> {
    if (this.#stopped) return;
    try {
      const renewal = await this.client.bootstrapHeartbeat(this.grant);
      this.#expiresAt = renewal.expiresAt;
      this.grant.expiresAt = renewal.expiresAt;
      this.grant.lease = renewal.lease;
      this.grant.claims = renewal.claims;
      this.#schedule(heartbeatDelayMilliseconds(this.grant.heartbeatAfterSeconds));
    } catch {
      const remaining = this.#expiresAt * 1000 - Date.now();
      if (remaining <= 30_000) {
        this.stop();
        return;
      }
      this.#schedule(Math.min(15_000, Math.max(1000, remaining - 30_000)));
    }
  }
}

function runtimeBootstrapHandoff(
  client: LicenseServiceClient,
  grant: RuntimeSessionGrant,
  existing: Record<string, unknown> | undefined,
  activationTicket = grant.activationTicket,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    schemaVersion: 2,
    serviceUrl: client.authorization.serviceUrl,
    state: grant.state,
    startupId: grant.startupId,
    sessionId: grant.sessionId,
    bootstrapToken: grant.bootstrapToken,
    activationTicket,
    heartbeatAfterSeconds: grant.heartbeatAfterSeconds,
    expiresAt: grant.expiresAt,
    plan: grant.plan,
    features: [...grant.features],
    concurrencyLimit: grant.concurrencyLimit,
    activeSessions: grant.activeSessions,
    browserVersion: grant.browserVersion,
    ...(grant.automationBackend === undefined ? {} : { automationBackend: grant.automationBackend }),
  };
}

function driverRuntimeBootstrapHandoff(
  client: LicenseServiceClient,
  grant: RuntimeSessionGrant,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!grant.driverActivationTicket) {
    throw new ConfigurationError(
      "Project WebDriver runtime session is missing a driver activation ticket",
      "license_service_invalid_response",
    );
  }
  return runtimeBootstrapHandoff(client, grant, existing, grant.driverActivationTicket);
}

function splitFrameworkLaunchOptions(options: LicensedFrameworkLaunchOptions): {
  authorizedOptions: Parameters<typeof installLatestAuthorizedBrowser>[1];
  frameworkOptions: FrameworkLaunchSettings;
} {
  const {
    trust,
    install,
    platform,
    arch,
    deviceHash,
    kernelMajor,
    updateKernel,
    browserVersion,
    versionPolicy,
    ...frameworkOptions
  } = options;
  const authorizedOptions = {
    trust,
    ...(install === undefined ? {} : { install }),
    ...(platform === undefined ? {} : { platform }),
    ...(arch === undefined ? {} : { arch }),
    ...(deviceHash === undefined ? {} : { deviceHash }),
    ...(kernelMajor === undefined ? {} : { kernelMajor }),
    ...(updateKernel === undefined ? {} : { updateKernel }),
    ...(browserVersion === undefined ? {} : { browserVersion }),
    ...(versionPolicy === undefined ? {} : { versionPolicy }),
  };
  return {
    authorizedOptions,
    frameworkOptions,
  };
}

function normalizeFrameworkBrowserVersion(value: unknown): string {
  if (typeof value !== "string") {
    throw new ArtifactError("Framework browser did not report a version", "browser_version_missing");
  }
  const match = value.match(/(\d+\.\d+\.\d+\.\d+)/);
  if (!match) {
    throw new ArtifactError(`Framework browser returned an unsupported version string: ${value}`, "browser_version_invalid");
  }
  return match[1]!;
}

async function frameworkRuntimeVersion(runtime: unknown): Promise<string> {
  const candidate = runtime as {
    version?: () => string | Promise<string>;
    browser?: () => { version?: () => string | Promise<string> } | null;
  };
  if (typeof candidate.version === "function") {
    return normalizeFrameworkBrowserVersion(await candidate.version.call(runtime));
  }
  if (typeof candidate.browser === "function") {
    const browser = candidate.browser.call(runtime);
    if (browser && typeof browser.version === "function") {
      return normalizeFrameworkBrowserVersion(await browser.version.call(browser));
    }
  }
  throw new ArtifactError("Framework browser did not expose a version method", "browser_version_missing");
}

function attachLicensedRuntime<T>(
  runtime: T,
  authorized: Awaited<ReturnType<typeof installLatestAuthorizedBrowser>>,
  versionAudit: BrowserVersionAudit,
  reference: BrowserInstallationReference,
): LicensedFrameworkRuntime<T> {
  const closable = runtime as T & ClosableRuntime;
  if (typeof closable.close !== "function") {
    throw new ArtifactError("Framework runtime does not expose a close method for license release", "framework_runtime_close_missing");
  }
  const originalClose = closable.close;
  let released = false;
  async function stopAndRelease(): Promise<void> {
    if (released) return;
    released = true;
    await Promise.allSettled([
      authorized.release(),
      reference.release(),
    ]);
  }
  closable.licenseRuntime = {
    sessionId: authorized.grant.sessionId,
    plan: authorized.grant.plan,
    concurrencyLimit: authorized.grant.concurrencyLimit,
    browserVersion: authorized.grant.browserVersion,
    versionPolicy: authorized.grant.versionPolicy,
    selectionReason: authorized.grant.selectionReason,
    versionAudit,
  };
  closable.close = async function closeWithLicenseRelease(...args: unknown[]): Promise<unknown> {
    try {
      return await originalClose.apply(this, args);
    } finally {
      await stopAndRelease();
    }
  };
  return closable;
}

async function finalizeFrameworkRuntime<T>(
  runtime: T,
  authorized: Awaited<ReturnType<typeof installLatestAuthorizedBrowser>>,
): Promise<LicensedFrameworkRuntime<T>> {
  try {
    const closable = runtime as Partial<ClosableRuntime>;
    if (typeof closable.close !== "function") {
      throw new ArtifactError("Framework runtime does not expose a close method for license release", "framework_runtime_close_missing");
    }
    const launched = await frameworkRuntimeVersion(runtime);
    const versionAudit = verifyBrowserVersionAudit({
      requested: authorized.grant.requestedBrowserVersion ?? null,
      selected: authorized.grant.browserVersion,
      downloaded: authorized.installation.version,
      launched,
      policy: authorized.grant.versionPolicy,
      selectionReason: authorized.grant.selectionReason,
    });
    const reference = await acquireBrowserInstallationReference(authorized.installation);
    return attachLicensedRuntime(runtime, authorized, versionAudit, reference);
  } catch (error) {
    const closable = runtime as Partial<ClosableRuntime>;
    if (typeof closable.close === "function") await Promise.resolve(closable.close()).catch(() => undefined);
    await authorized.release().catch(() => undefined);
    throw error;
  }
}

async function installWithHeartbeat(
  client: LicenseServiceClient,
  grant: RuntimeSessionGrant,
  install: () => Promise<BrowserInstallation>,
): Promise<BrowserInstallation> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let renewalFailure: unknown;
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void renew(), heartbeatDelayMilliseconds(grant.heartbeatAfterSeconds));
    timer.unref();
  };
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const heartbeat = await client.bootstrapHeartbeat(grant);
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
    kernelMajor?: KernelMajor;
    updateKernel?: boolean;
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
    automationBackend?: AutomationBackend;
  },
): Promise<{
  client: LicenseServiceClient;
  grant: RuntimeSessionGrant;
  installation: BrowserInstallation;
  release(): Promise<void>;
}> {
  const authorization = await readLicenseAuthorization(authorizationFile, {
    ...(options.trust.allowInsecureLocalhost === undefined
      ? {}
      : { allowInsecureLocalhost: options.trust.allowInsecureLocalhost }),
    ...(options.trust.licenseFilePassphrase === undefined
      ? {}
      : { licenseFilePassphrase: options.trust.licenseFilePassphrase }),
    ...(options.trust.licenseFileTrustedKeys === undefined
      ? {}
      : { licenseFileTrustedKeys: options.trust.licenseFileTrustedKeys }),
    ...(options.trust.trustedServiceUrls === undefined
      ? {}
      : { trustedServiceUrls: options.trust.trustedServiceUrls }),
  });
  const client = new LicenseServiceClient(authorization, options.trust);
  const updateKernel = options.updateKernel ?? true;
  const localCandidate = !updateKernel && options.browserVersion === undefined && options.versionPolicy === undefined
    ? await findCurrentBrowserInstallation({
      ...(options.install?.cacheRoot === undefined ? {} : { cacheRoot: options.install.cacheRoot }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.arch === undefined ? {} : { arch: options.arch }),
      ...(options.kernelMajor === undefined ? {} : { kernelMajor: options.kernelMajor }),
    })
    : null;
  let grant: RuntimeSessionGrant;
  try {
    grant = await client.createRuntimeSession({
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.arch === undefined ? {} : { arch: options.arch }),
      ...(options.deviceHash === undefined ? {} : { deviceHash: options.deviceHash }),
      ...(options.kernelMajor === undefined ? {} : { kernelMajor: options.kernelMajor }),
      automationBackend: options.automationBackend ?? "project-webdriver",
      updateKernel,
      ...(localCandidate ? { browserVersion: localCandidate.version } :
        options.browserVersion === undefined ? {} : { browserVersion: options.browserVersion }),
      ...(localCandidate ? { versionPolicy: "exact" as const } :
        options.versionPolicy === undefined ? {} : { versionPolicy: options.versionPolicy }),
    });
  } catch (error) {
    if (localCandidate && error instanceof LicenseServiceError && error.code === "release_version_unavailable") {
      throw new LicenseServiceError(
        "The current local browser release was withdrawn; update is required before continuing",
        "kernel_update_required",
        409,
      );
    }
    throw error;
  }
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
        await client.releaseRuntimeSession(grant);
      },
    };
  } catch (error) {
    await client.releaseRuntimeSession(grant).catch(() => undefined);
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

export async function prepareAuthorizedBrowser(
  authorizationFile: string,
  options: Parameters<typeof installLatestAuthorizedBrowser>[1],
): Promise<Awaited<ReturnType<typeof installLatestAuthorizedBrowser>>> {
  return installLatestAuthorizedBrowser(authorizationFile, {
    ...options,
    updateKernel: options.updateKernel ?? false,
  });
}

// The general authorized entry point supports latest, major-scoped selection, exact pinning,
// and explicit at-or-before rollback without opting into updates by default.
export const installAuthorizedBrowser = prepareAuthorizedBrowser;

export async function installAuthorized(
  authorizationFile: string,
  options: Parameters<typeof installLatestAuthorizedBrowser>[1],
): Promise<BrowserInstallation> {
  const authorized = await prepareAuthorizedBrowser(authorizationFile, options);
  try {
    return authorized.installation;
  } finally {
    await authorized.release().catch(() => undefined);
  }
}

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
    kernelMajor: _kernelMajor,
    updateKernel: _updateKernel,
    browserVersion: _browserVersion,
    versionPolicy: _versionPolicy,
    automationBackend: _automationBackend,
    ...launchOptions
  } = options;
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, {
    ...options,
    automationBackend: options.automationBackend ?? "project-webdriver",
  });
  let reference: BrowserInstallationReference | undefined;
  const bootstrap = new BootstrapHeartbeatController(authorized.client, authorized.grant);
  try {
    bootstrap.start();
    reference = await acquireBrowserInstallationReference(authorized.installation);
    const browser = await launchWebDriver(
      authorized.installation.browserExecutable,
      authorized.grant.lease as unknown as Record<string, unknown>,
      {
        ...launchOptions,
        driverExecutable: authorized.installation.driverExecutable,
        runtimeHandoff: runtimeBootstrapHandoff(authorized.client, authorized.grant, launchOptions.runtimeHandoff),
        driverRuntimeHandoff: driverRuntimeBootstrapHandoff(authorized.client, authorized.grant, launchOptions.driverRuntimeHandoff),
        allowRuntimeActivationTicket: true,
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
    bootstrap.stop();
    browser.licenseRuntime = {
      sessionId: authorized.grant.sessionId,
      plan: authorized.grant.plan,
      concurrencyLimit: authorized.grant.concurrencyLimit,
      browserVersion: authorized.grant.browserVersion,
      versionPolicy: authorized.grant.versionPolicy,
      selectionReason: authorized.grant.selectionReason,
      versionAudit,
    };
    browser.addCloseCallback(async () => {
      await Promise.allSettled([
        authorized.release(),
        reference?.release() ?? Promise.resolve(),
      ]);
    });
    return browser;
  } catch (error) {
    bootstrap.stop();
    await reference?.release().catch(() => undefined);
    await authorized.release().catch(() => undefined);
    throw error;
  }
}

export async function launchLatestPlaywright<TBrowser>(
  playwright: PlaywrightLike<TBrowser>,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  const { authorizedOptions, frameworkOptions } = splitFrameworkLaunchOptions(options);
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, { ...authorizedOptions, automationBackend: "playwright" });
  const bootstrap = new BootstrapHeartbeatController(authorized.client, authorized.grant);
  try {
    bootstrap.start();
    const browser = await launchPlaywright(
      playwright,
      authorized.installation.browserExecutable,
      authorized.grant.lease as unknown as Record<string, unknown>,
      {
        ...frameworkOptions,
        runtimeHandoff: runtimeBootstrapHandoff(authorized.client, authorized.grant, frameworkOptions.runtimeHandoff),
        allowRuntimeActivationTicket: true,
      },
    );
    bootstrap.stop();
    return await finalizeFrameworkRuntime(browser, authorized);
  } catch (error) {
    bootstrap.stop();
    await authorized.release().catch(() => undefined);
    throw error;
  }
}

export async function launchLatestPlaywrightPersistent<TContext>(
  playwright: PlaywrightLike<unknown, TContext>,
  userDataDir: string,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TContext>> {
  const { authorizedOptions, frameworkOptions } = splitFrameworkLaunchOptions(options);
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, { ...authorizedOptions, automationBackend: "playwright" });
  const bootstrap = new BootstrapHeartbeatController(authorized.client, authorized.grant);
  try {
    bootstrap.start();
    const context = await launchPlaywrightPersistent(
      playwright,
      userDataDir,
      authorized.installation.browserExecutable,
      authorized.grant.lease as unknown as Record<string, unknown>,
      {
        ...frameworkOptions,
        runtimeHandoff: runtimeBootstrapHandoff(authorized.client, authorized.grant, frameworkOptions.runtimeHandoff),
        allowRuntimeActivationTicket: true,
      },
    );
    bootstrap.stop();
    return await finalizeFrameworkRuntime(context, authorized);
  } catch (error) {
    bootstrap.stop();
    await authorized.release().catch(() => undefined);
    throw error;
  }
}

export async function launchLatestPuppeteer<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  const { authorizedOptions, frameworkOptions } = splitFrameworkLaunchOptions(options);
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, { ...authorizedOptions, automationBackend: "puppeteer" });
  const bootstrap = new BootstrapHeartbeatController(authorized.client, authorized.grant);
  try {
    bootstrap.start();
    const browser = await launchPuppeteer(
      puppeteer,
      authorized.installation.browserExecutable,
      authorized.grant.lease as unknown as Record<string, unknown>,
      {
        ...frameworkOptions,
        runtimeHandoff: runtimeBootstrapHandoff(authorized.client, authorized.grant, frameworkOptions.runtimeHandoff),
        allowRuntimeActivationTicket: true,
      },
    );
    bootstrap.stop();
    return await finalizeFrameworkRuntime(browser, authorized);
  } catch (error) {
    bootstrap.stop();
    await authorized.release().catch(() => undefined);
    throw error;
  }
}

export async function launchLatestPuppeteerPersistent<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  userDataDir: string,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  const { authorizedOptions, frameworkOptions } = splitFrameworkLaunchOptions(options);
  const authorized = await installLatestAuthorizedBrowser(authorizationFile, { ...authorizedOptions, automationBackend: "puppeteer" });
  const bootstrap = new BootstrapHeartbeatController(authorized.client, authorized.grant);
  try {
    bootstrap.start();
    const browser = await launchPuppeteerPersistent(
      puppeteer,
      userDataDir,
      authorized.installation.browserExecutable,
      authorized.grant.lease as unknown as Record<string, unknown>,
      {
        ...frameworkOptions,
        runtimeHandoff: runtimeBootstrapHandoff(authorized.client, authorized.grant, frameworkOptions.runtimeHandoff),
        allowRuntimeActivationTicket: true,
      },
    );
    bootstrap.stop();
    return await finalizeFrameworkRuntime(browser, authorized);
  } catch (error) {
    bootstrap.stop();
    await authorized.release().catch(() => undefined);
    throw error;
  }
}

export async function launchAuthorized(
  authorizationFile: string,
  options: LicensedLaunchOptions,
): Promise<SlyWebDriverSession> {
  return launchLatest(authorizationFile, {
    ...options,
    updateKernel: options.updateKernel ?? false,
  });
}

export async function launchAuthorizedPlaywright<TBrowser>(
  playwright: PlaywrightLike<TBrowser>,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  return launchLatestPlaywright(playwright, authorizationFile, {
    ...options,
    updateKernel: options.updateKernel ?? false,
  });
}

export async function launchAuthorizedPlaywrightPersistent<TContext>(
  playwright: PlaywrightLike<unknown, TContext>,
  userDataDir: string,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TContext>> {
  return launchLatestPlaywrightPersistent(playwright, userDataDir, authorizationFile, {
    ...options,
    updateKernel: options.updateKernel ?? false,
  });
}

export async function launchAuthorizedPuppeteer<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  return launchLatestPuppeteer(puppeteer, authorizationFile, {
    ...options,
    updateKernel: options.updateKernel ?? false,
  });
}

export async function launchAuthorizedPuppeteerPersistent<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  userDataDir: string,
  authorizationFile: string,
  options: LicensedFrameworkLaunchOptions,
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  return launchLatestPuppeteerPersistent(puppeteer, userDataDir, authorizationFile, {
    ...options,
    updateKernel: options.updateKernel ?? false,
  });
}
