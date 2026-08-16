import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

import { ConfigurationError, SlyBrowserError } from "./errors.js";
import { type HumanConfig, type HumanPreset } from "./humanize.js";
import { prepareLaunch } from "./launcher.js";

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const DEFAULT_EXCLUDED_SWITCHES = ["enable-automation", "enable-unsafe-swiftshader"] as const;

type JsonObject = Record<string, unknown>;

export interface MobilePersona {
  userAgent: string;
  deviceMetrics: {
    width: number;
    height: number;
    pixelRatio: number;
    mobile: true;
    touch: true;
  };
  clientHints: JsonObject & { platform: string; mobile: true };
}

export interface WebDriverLaunchSettings {
  driverExecutable?: string;
  profile?: Record<string, unknown>;
  profileDir?: string;
  profileMode?: "ephemeral" | "persistent";
  args?: readonly string[];
  headless?: boolean;
  viewport?: { width: number; height: number };
  excludeSwitches?: readonly string[];
  humanize?: boolean;
  humanPreset?: HumanPreset;
  humanConfig?: Partial<HumanConfig>;
  humanSeed?: number;
  tempRoot?: string;
  driverStartTimeout?: number;
  commandTimeout?: number;
  mobilePersona?: MobilePersona;
}

export interface WebDriverVersions {
  browserVersion: string;
  driverVersion: string;
  browserMajor: number;
}

export class WebDriverError extends SlyBrowserError {
  readonly command?: string;
  readonly status?: number;
  readonly payload?: unknown;

  constructor(
    message: string,
    code = "webdriver_error",
    details: { command?: string; status?: number; payload?: unknown } = {},
  ) {
    super(message, code);
    if (details.command !== undefined) this.command = details.command;
    if (details.status !== undefined) this.status = details.status;
    if (details.payload !== undefined) this.payload = details.payload;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new WebDriverError("Unable to allocate a WebDriver port", "webdriver_port_failed");
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

export function defaultDriverExecutable(browserExecutable: string, explicit?: string): string {
  const configured = explicit ?? process.env.SLYBROWSER_WEBDRIVER_PATH;
  if (configured) return resolve(configured);
  return join(dirname(resolve(browserExecutable)), process.platform === "win32" ? "chromedriver.exe" : "chromedriver");
}

export function buildWebDriverSessionPayload(
  browserExecutable: string,
  settings: Pick<WebDriverLaunchSettings, "args" | "headless" | "viewport" | "excludeSwitches" | "profileDir" | "profileMode" | "humanize" | "humanPreset" | "humanConfig" | "humanSeed" | "mobilePersona"> = {},
  handoffArguments: readonly string[] = [],
): JsonObject {
  const args = ["--no-first-run", "--no-default-browser-check", ...handoffArguments, ...(settings.args ?? [])];
  if ((settings.headless ?? true) && !args.some((argument) => argument.startsWith("--headless"))) args.push("--headless=new");
  const mobilePersona = settings.mobilePersona === undefined ? undefined : validateMobilePersona(settings.mobilePersona);
  const viewport = settings.viewport ?? mobilePersona?.deviceMetrics ?? { width: 1920, height: 947 };
  if (!args.some((argument) => argument.startsWith("--window-size"))) args.push(`--window-size=${viewport.width},${viewport.height}`);
  const profileMode = settings.profileMode ?? (settings.profileDir ? "persistent" : "ephemeral");
  if (profileMode === "persistent" && !settings.profileDir) {
    throw new ConfigurationError("Persistent profile mode requires profileDir", "persistent_profile_dir_required");
  }
  if (settings.profileMode === "ephemeral" && settings.profileDir) {
    throw new ConfigurationError("Ephemeral profile mode cannot use profileDir", "ephemeral_profile_dir_forbidden");
  }
  if (settings.profileDir && !args.some((argument) => argument.startsWith("--user-data-dir"))) {
    args.push(`--user-data-dir=${resolve(settings.profileDir)}`);
  }
  return {
    capabilities: {
      alwaysMatch: {
        browserName: "chrome",
        acceptInsecureCerts: false,
        "sly:options": {
          humanize: {
            enabled: settings.humanize === true,
            preset: settings.humanPreset ?? "default",
            ...(settings.humanConfig === undefined ? {} : { config: settings.humanConfig }),
            ...(settings.humanSeed === undefined ? {} : { seed: settings.humanSeed }),
          },
        },
        "goog:chromeOptions": {
          binary: resolve(browserExecutable),
          args,
          excludeSwitches: [...(settings.excludeSwitches ?? DEFAULT_EXCLUDED_SWITCHES)],
          ...(mobilePersona === undefined ? {} : { mobileEmulation: mobilePersona }),
        },
      },
    },
  };
}

function validateMobilePersona(value: MobilePersona): MobilePersona {
  const metrics = value?.deviceMetrics;
  const hints = value?.clientHints;
  if (!value || typeof value.userAgent !== "string" || !value.userAgent ||
      !metrics || !Number.isInteger(metrics.width) || metrics.width < 320 || metrics.width > 4096 ||
      !Number.isInteger(metrics.height) || metrics.height < 240 || metrics.height > 4096 ||
      !Number.isFinite(metrics.pixelRatio) || metrics.pixelRatio < 0.5 || metrics.pixelRatio > 8 ||
      metrics.mobile !== true || metrics.touch !== true || !hints || typeof hints.platform !== "string" ||
      !hints.platform || hints.mobile !== true) {
    throw new ConfigurationError("Mobile persona must provide one coherent UA, metrics, touch and client-hint set", "mobile_persona_invalid");
  }
  return value;
}

function nativeProfileForSettings(settings: WebDriverLaunchSettings): Record<string, unknown> {
  const profile = { ...(settings.profile ?? {}) };
  if (settings.mobilePersona === undefined) return profile;
  const persona = validateMobilePersona(settings.mobilePersona);
  const expectedScreen = { width: persona.deviceMetrics.width, height: persona.deviceMetrics.height };
  if (profile.userAgent !== undefined && profile.userAgent !== persona.userAgent) {
    throw new ConfigurationError("Mobile persona conflicts with profile.userAgent", "mobile_persona_conflict");
  }
  if (profile.screen !== undefined && JSON.stringify(profile.screen) !== JSON.stringify(expectedScreen)) {
    throw new ConfigurationError("Mobile persona conflicts with profile.screen", "mobile_persona_conflict");
  }
  profile.userAgent = persona.userAgent;
  profile.screen = expectedScreen;
  const brands = persona.clientHints.brands;
  if (profile.clientHints === undefined && Array.isArray(brands)) profile.clientHints = brands;
  const platformVersion = persona.clientHints.platformVersion;
  if (profile.osVersion === undefined && typeof platformVersion === "string" && platformVersion) {
    profile.osVersion = platformVersion;
  }
  return profile;
}

function majorVersion(value: unknown): number | null {
  const match = String(value ?? "").match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

export function validateWebDriverCapabilities(capabilities: JsonObject): WebDriverVersions {
  const browserVersion = typeof capabilities.browserVersion === "string" ? capabilities.browserVersion : "";
  const chrome = capabilities.chrome as JsonObject | undefined;
  const fullDriverVersion = typeof chrome?.chromedriverVersion === "string" ? chrome.chromedriverVersion : "";
  const driverVersion = fullDriverVersion.split(/\s+/)[0] ?? "";
  const browserMajor = majorVersion(browserVersion);
  const driverMajor = majorVersion(driverVersion);
  if (browserMajor === null || driverMajor === null) {
    throw new WebDriverError("The project WebDriver did not report browser and driver versions", "webdriver_version_missing");
  }
  if (browserMajor !== driverMajor) {
    throw new WebDriverError(
      `SlyBrowser ${browserVersion} and project WebDriver ${driverVersion} have different major versions`,
      "webdriver_version_mismatch",
    );
  }
  return { browserVersion, driverVersion, browserMajor };
}

async function requestJson(
  origin: string,
  method: string,
  path: string,
  body: unknown,
  timeout: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      signal: AbortSignal.timeout(timeout),
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WebDriverError(`${method} ${path} exceeded ${timeout} ms`, "webdriver_command_timeout", { command: `${method} ${path}` });
    }
    throw error;
  }
  const payload = await response.json().catch(() => null) as JsonObject | null;
  const value = payload?.value as JsonObject | undefined;
  if (!response.ok || value?.error) {
    const remoteMessage = typeof value?.message === "string" ? value.message : JSON.stringify(payload);
    throw new WebDriverError(
      `${method} ${path} failed: ${String(value?.error ?? response.status)}: ${remoteMessage}`,
      "webdriver_protocol_error",
      { command: `${method} ${path}`, status: response.status, payload },
    );
  }
  return payload?.value;
}

export class SlyWebDriverElement {
  constructor(readonly session: SlyWebDriverSession, readonly id: string) {}

  async click(): Promise<void> { await this.session.clickElement(this.id); }
  async clear(): Promise<void> { await this.session.clearElement(this.id); }
  async sendKeys(value: string): Promise<void> { await this.session.sendKeysToElement(this.id, value); }
  async type(value: string, options: { clear?: boolean } = {}): Promise<void> {
    await this.session.typeIntoElement(this.id, value, options.clear ?? true);
  }
  async rect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.session.elementRect(this.id);
  }
}

export class SlyWebDriverSession {
  readonly versions: WebDriverVersions;
  readonly capabilities: JsonObject;
  readonly driverExecutable: string;
  readonly browserExecutable: string;
  private closed = false;
  private readonly humanizeEnabled: boolean;
  private readonly closeCallbacks: Array<() => Promise<void>> = [];
  licenseRuntime?: {
    sessionId: string;
    plan: string;
    concurrencyLimit: number;
    browserVersion: string;
    versionPolicy?: "latest" | "exact" | "at-or-before";
    selectionReason?: "latest" | "exact" | "rollback";
    versionAudit?: {
      requested: string | null;
      selected: string;
      downloaded: string;
      launched: string;
      policy: "latest" | "exact" | "at-or-before";
      selectionReason: "latest" | "exact" | "rollback";
    };
  };

  constructor(
    private readonly service: SlyWebDriverService,
    readonly sessionId: string,
    capabilities: JsonObject,
    browserExecutable: string,
    humanize: { enabled?: boolean; preset?: HumanPreset; config?: Partial<HumanConfig>; seed?: number } = {},
  ) {
    this.capabilities = capabilities;
    this.versions = validateWebDriverCapabilities(capabilities);
    this.driverExecutable = service.executable;
    this.browserExecutable = resolve(browserExecutable);
    this.humanizeEnabled = humanize.enabled === true;
    if (this.humanizeEnabled) {
      const features = capabilities["sly:features"] as JsonObject | undefined;
      const advertised = features?.humanize as JsonObject | undefined;
      if (advertised?.enabled !== true || advertised.version !== 1) {
        throw new WebDriverError(
          "Project WebDriver did not enable the requested Humanize capability",
          "humanize_not_supported",
        );
      }
    }
  }

  private path(suffix = ""): string { return `/session/${encodeURIComponent(this.sessionId)}${suffix}`; }
  private async request(method: string, suffix: string, body?: unknown): Promise<unknown> {
    if (this.closed) throw new WebDriverError("The WebDriver session is closed", "webdriver_session_closed");
    return requestJson(this.service.origin, method, this.path(suffix), body, this.service.commandTimeout);
  }
  private reference(id: string): JsonObject { return { [ELEMENT_KEY]: id }; }

  async get(url: string): Promise<void> { await this.request("POST", "/url", { url }); }
  async currentUrl(): Promise<string> { return String(await this.request("GET", "/url")); }
  async title(): Promise<string> { return String(await this.request("GET", "/title")); }
  async executeScript(script: string, args: readonly unknown[] = []): Promise<unknown> {
    const encoded = args.map((value) => value instanceof SlyWebDriverElement ? this.reference(value.id) : value);
    return this.request("POST", "/execute/sync", { script, args: encoded });
  }
  async executeAsyncScript(script: string, args: readonly unknown[] = []): Promise<unknown> {
    const encoded = args.map((value) => value instanceof SlyWebDriverElement ? this.reference(value.id) : value);
    return this.request("POST", "/execute/async", { script, args: encoded });
  }
  async findElement(selector: string, using = "css selector"): Promise<SlyWebDriverElement> {
    const result = await this.request("POST", "/element", { using, value: selector }) as JsonObject;
    return new SlyWebDriverElement(this, String(result[ELEMENT_KEY]));
  }
  async findElements(selector: string, using = "css selector"): Promise<SlyWebDriverElement[]> {
    const results = await this.request("POST", "/elements", { using, value: selector }) as JsonObject[];
    return results.map((result) => new SlyWebDriverElement(this, String(result[ELEMENT_KEY])));
  }
  async clearElement(id: string): Promise<void> { await this.request("POST", `/element/${encodeURIComponent(id)}/clear`, {}); }

  async sendKeysToElement(id: string, value: string): Promise<void> {
    const text = String(value);
    await this.request("POST", `/element/${encodeURIComponent(id)}/value`, { text, value: [...text] });
  }

  async elementRect(id: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const result = await this.executeScript(`
      const element = arguments[0];
      element.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Element has an empty rectangle');
      return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    `, [new SlyWebDriverElement(this, id)]);
    return result as { x: number; y: number; width: number; height: number };
  }

  async clickElement(id: string): Promise<void> {
    await this.request("POST", `/element/${encodeURIComponent(id)}/click`, {});
  }

  async typeIntoElement(id: string, value: string, clear = true): Promise<void> {
    if (clear) await this.clearElement(id).catch(() => undefined);
    // The W3C element-value command focuses and scrolls the target before the
    // native driver emits Humanize key events. An extra click is both
    // redundant and more likely to be intercepted by sticky page chrome.
    await this.sendKeysToElement(id, value);
  }

  async addVirtualAuthenticator(options: JsonObject = {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserConsenting: true,
    isUserVerified: true,
  }): Promise<string> {
    const result = await this.request("POST", "/webauthn/authenticator", options);
    if (typeof result !== "string" || !result) {
      throw new WebDriverError("WebDriver returned an invalid virtual authenticator ID", "webauthn_response_invalid");
    }
    return result;
  }

  async removeVirtualAuthenticator(authenticatorId: string): Promise<void> {
    await this.request("DELETE", `/webauthn/authenticator/${encodeURIComponent(authenticatorId)}`);
  }

  async addVirtualCredential(authenticatorId: string, credential: JsonObject): Promise<void> {
    await this.request("POST", `/webauthn/authenticator/${encodeURIComponent(authenticatorId)}/credential`, credential);
  }

  async virtualCredentials(authenticatorId: string): Promise<JsonObject[]> {
    const result = await this.request("GET", `/webauthn/authenticator/${encodeURIComponent(authenticatorId)}/credentials`);
    if (!Array.isArray(result)) throw new WebDriverError("WebDriver returned an invalid credential list", "webauthn_response_invalid");
    return result as JsonObject[];
  }

  async windowHandles(): Promise<string[]> {
    const result = await this.request("GET", "/window/handles");
    if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
      throw new WebDriverError("WebDriver returned invalid window handles", "webdriver_response_invalid");
    }
    return result as string[];
  }

  async currentWindowHandle(): Promise<string> {
    const result = await this.request("GET", "/window");
    if (typeof result !== "string" || !result) throw new WebDriverError("WebDriver returned an invalid window handle", "webdriver_response_invalid");
    return result;
  }

  async newWindow(type: "tab" | "window" = "tab"): Promise<{ handle: string; type: string }> {
    const result = await this.request("POST", "/window/new", { type }) as JsonObject;
    if (typeof result?.handle !== "string" || !result.handle || typeof result.type !== "string") {
      throw new WebDriverError("WebDriver returned an invalid new-window result", "webdriver_response_invalid");
    }
    return { handle: result.handle, type: result.type } as { handle: string; type: string };
  }

  async switchToWindow(handle: string): Promise<void> { await this.request("POST", "/window", { handle }); }
  async windowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
    return await this.request("GET", "/window/rect") as { x: number; y: number; width: number; height: number };
  }
  async setWindowRect(rect: { x?: number; y?: number; width?: number; height?: number }): Promise<{ x: number; y: number; width: number; height: number }> {
    return await this.request("POST", "/window/rect", rect) as { x: number; y: number; width: number; height: number };
  }
  async closeWindow(): Promise<string[]> {
    const result = await this.request("DELETE", "/window");
    if (!Array.isArray(result) || result.some((item) => typeof item !== "string")) {
      throw new WebDriverError("WebDriver returned invalid remaining window handles", "webdriver_response_invalid");
    }
    return result as string[];
  }
  async switchToFrame(frame: number | SlyWebDriverElement | null): Promise<void> {
    await this.request("POST", "/frame", { id: frame instanceof SlyWebDriverElement ? this.reference(frame.id) : frame });
  }
  async switchToParentFrame(): Promise<void> { await this.request("POST", "/frame/parent", {}); }
  async alertText(): Promise<string> { return String(await this.request("GET", "/alert/text")); }
  async acceptAlert(): Promise<void> { await this.request("POST", "/alert/accept", {}); }
  async dismissAlert(): Promise<void> { await this.request("POST", "/alert/dismiss", {}); }
  async sendAlertText(text: string): Promise<void> {
    const value = String(text);
    await this.request("POST", "/alert/text", { text: value, value: [...value] });
  }

  async performActions(actions: readonly JsonObject[]): Promise<void> { await this.request("POST", "/actions", { actions }); }
  async screenshot(path?: string): Promise<Buffer> {
    const bytes = Buffer.from(String(await this.request("GET", "/screenshot")), "base64");
    if (path) await writeFile(resolve(path), bytes);
    return bytes;
  }
  async browserLogs(): Promise<unknown[]> {
    const result = await this.request("POST", "/log", { type: "browser" });
    if (!Array.isArray(result)) throw new WebDriverError("WebDriver returned invalid browser logs", "webdriver_response_invalid");
    return result;
  }
  async setTimeouts(timeouts: { script?: number; pageLoad?: number; implicit?: number }): Promise<void> {
    await this.request("POST", "/timeouts", timeouts);
  }

  addCloseCallback(callback: () => Promise<void>): void {
    if (this.closed) throw new WebDriverError("The WebDriver session is closed", "webdriver_session_closed");
    this.closeCallbacks.push(callback);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await requestJson(this.service.origin, "DELETE", this.path(), undefined, this.service.commandTimeout); }
    catch { /* closing the owned service below is authoritative */ }
    try {
      await this.service.close();
    } finally {
      await Promise.allSettled(this.closeCallbacks.map((callback) => callback()));
    }
  }
  async quit(): Promise<void> { await this.close(); }
  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export class SlyWebDriverService {
  private constructor(
    readonly executable: string,
    readonly origin: string,
    readonly commandTimeout: number,
    private readonly process: ChildProcess,
    private readonly stdout: string[],
    private readonly stderr: string[],
  ) {}

  static async start(executable: string, options: { startTimeout?: number; commandTimeout?: number; licenseFile?: string } = {}): Promise<SlyWebDriverService> {
    const path = resolve(executable);
    if (!await fileExists(path)) throw new ConfigurationError("Project WebDriver executable does not exist", "webdriver_missing");
    const port = await freePort();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const process = spawn(path, [
      `--port=${port}`,
      "--log-level=WARNING",
      ...(options.licenseFile === undefined ? [] : [`--sly-license-file=${resolve(options.licenseFile)}`]),
    ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    process.stdout?.on("data", (chunk) => { if (stdout.length < 200) stdout.push(String(chunk).slice(0, 4000)); });
    process.stderr?.on("data", (chunk) => { if (stderr.length < 200) stderr.push(String(chunk).slice(0, 4000)); });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (options.startTimeout ?? 15_000);
    while (Date.now() < deadline) {
      if (process.exitCode !== null) {
        throw new WebDriverError(`Project WebDriver exited with ${process.exitCode}: ${stderr.join("") || stdout.join("")}`, "webdriver_start_failed");
      }
      try {
        const status = await requestJson(origin, "GET", "/status", undefined, 1000) as JsonObject;
        if (status.ready === true) return new SlyWebDriverService(path, origin, options.commandTimeout ?? 60_000, process, stdout, stderr);
      } catch { /* startup polling */ }
      await delay(100);
    }
    if (process.exitCode === null) process.kill();
    throw new WebDriverError(`Project WebDriver did not become ready: ${stderr.join("") || stdout.join("")}`, "webdriver_start_timeout");
  }

  async createSession(
    browserExecutable: string,
    settings: WebDriverLaunchSettings,
    handoffArguments: readonly string[] = [],
  ): Promise<SlyWebDriverSession> {
    const payload = buildWebDriverSessionPayload(browserExecutable, settings, handoffArguments);
    const value = await requestJson(this.origin, "POST", "/session", payload, this.commandTimeout) as JsonObject;
    const sessionId = String(value.sessionId ?? "");
    const capabilities = (value.capabilities ?? value) as JsonObject;
    if (!sessionId) throw new WebDriverError("Project WebDriver did not return a session ID", "webdriver_session_invalid");
    try {
      return new SlyWebDriverSession(this, sessionId, capabilities, browserExecutable, {
        ...(settings.humanize === undefined ? {} : { enabled: settings.humanize }),
        ...(settings.humanPreset === undefined ? {} : { preset: settings.humanPreset }),
        ...(settings.humanConfig === undefined ? {} : { config: settings.humanConfig }),
        ...(settings.humanSeed === undefined ? {} : { seed: settings.humanSeed }),
      });
    } catch (error) {
      await requestJson(this.origin, "DELETE", `/session/${encodeURIComponent(sessionId)}`, undefined, this.commandTimeout).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill();
    await new Promise<void>((accept) => {
      if (this.process.exitCode !== null) accept();
      else {
        const timer = setTimeout(accept, 3000);
        this.process.once("exit", () => { clearTimeout(timer); accept(); });
      }
    });
  }
}

/** Launch SlyBrowser through its project-built WebDriver. This is the default SDK backend. */
export async function launch(
  executable: string,
  lease: string | Buffer | Record<string, unknown>,
  settings: WebDriverLaunchSettings = {},
): Promise<SlyWebDriverSession> {
  if (settings.driverStartTimeout !== undefined && settings.driverStartTimeout < 1000) {
    throw new ConfigurationError("driverStartTimeout must be at least 1000 milliseconds", "config_invalid");
  }
  if (settings.commandTimeout !== undefined && settings.commandTimeout < 1000) {
    throw new ConfigurationError("commandTimeout must be at least 1000 milliseconds", "config_invalid");
  }
  const browserExecutable = resolve(executable);
  const driverExecutable = defaultDriverExecutable(browserExecutable, settings.driverExecutable);
  const plan = await prepareLaunch(browserExecutable, nativeProfileForSettings(settings), lease, {
    tempRoot: settings.tempRoot,
    includeDriverLease: true,
  });
  let service: SlyWebDriverService | undefined;
  try {
    service = await SlyWebDriverService.start(driverExecutable, {
      ...(settings.driverStartTimeout === undefined ? {} : { startTimeout: settings.driverStartTimeout }),
      ...(settings.commandTimeout === undefined ? {} : { commandTimeout: settings.commandTimeout }),
      ...(plan.driverLicenseFile === undefined ? {} : { licenseFile: plan.driverLicenseFile }),
    });
    const session = await service.createSession(browserExecutable, settings, plan.arguments);
    await session.setTimeouts({ pageLoad: settings.commandTimeout ?? 60_000, script: settings.commandTimeout ?? 60_000, implicit: 0 });
    return session;
  } catch (error) {
    await service?.close();
    throw error;
  } finally {
    await plan.cleanup();
  }
}

export const launchWebDriver = launch;

export function describeDefaultDriver(browserExecutable: string, explicit?: string): { backend: "project-webdriver"; executable: string; source: string } {
  const executable = defaultDriverExecutable(browserExecutable, explicit);
  const source = explicit ? "explicit" : process.env.SLYBROWSER_WEBDRIVER_PATH ? "environment" : `sibling-of-${basename(browserExecutable)}`;
  return { backend: "project-webdriver", executable, source };
}
