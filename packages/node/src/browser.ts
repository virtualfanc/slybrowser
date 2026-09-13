import { dirname, resolve } from "node:path";

import {
  requireFrameworkHumanizeSupport,
  resolveFrameworkVersion,
  type FrameworkBackend,
} from "./automation.js";
import { ConfigurationError } from "./errors.js";
import { prepareLaunch } from "./launcher.js";
import { resolveHumanConfig, type HumanConfig, type HumanPreset } from "./humanize.js";

export interface ChromiumLauncherLike<TBrowser = unknown, TContext = unknown> {
  launch(options: Record<string, unknown>): Promise<TBrowser>;
  launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<TContext>;
}

export interface PlaywrightLike<TBrowser = unknown, TContext = unknown> {
  chromium: ChromiumLauncherLike<TBrowser, TContext>;
}

export interface PuppeteerLike<TBrowser = unknown> {
  launch(options: Record<string, unknown>): Promise<TBrowser>;
}

export interface FrameworkLaunchSettings {
  profile?: Record<string, unknown>;
  launchOptions?: Record<string, unknown>;
  tempRoot?: string;
  nativeReady?: boolean;
  nativeReadyTimeout?: number;
  humanize?: boolean;
  humanPreset?: HumanPreset;
  humanConfig?: Partial<HumanConfig>;
  humanSeed?: number;
  frameworkVersion?: string;
  runtimeHandoff?: Record<string, unknown>;
  allowRuntimeActivationTicket?: boolean;
  releaseRoot?: string;
}

type JsonObject = Record<string, unknown>;

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function parseSignedLeaseClaims(lease: string | Buffer | Record<string, unknown>): JsonObject | undefined {
  try {
    const envelope = typeof lease === "string"
      ? JSON.parse(lease) as unknown
      : Buffer.isBuffer(lease)
        ? JSON.parse(lease.toString("utf8")) as unknown
        : lease;
    const payload = jsonObject(envelope)?.payload;
    if (typeof payload !== "string" || payload.length === 0) return undefined;
    return jsonObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
  } catch (error) {
    return undefined;
  }
}

function deriveReleaseRoot(browserExecutable: string, artifactBrowserExecutable: unknown): string | undefined {
  if (typeof artifactBrowserExecutable !== "string" || !artifactBrowserExecutable.trim()) return undefined;
  const expectedParts = artifactBrowserExecutable.replaceAll("\\", "/").split("/").filter(Boolean);
  if (expectedParts.length === 0) return undefined;
  const actualPath = resolve(browserExecutable);
  const actualParts = actualPath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (actualParts.length < expectedParts.length) return undefined;
  const actualSuffix = actualParts.slice(-expectedParts.length);
  const matches = expectedParts.every((part, index) => {
    const actualPart = actualSuffix[index];
    return typeof actualPart === "string" && part.toLowerCase() === actualPart.toLowerCase();
  });
  if (!matches) return undefined;
  let releaseRoot = actualPath;
  for (let index = 0; index < expectedParts.length; ++index) {
    releaseRoot = dirname(releaseRoot);
  }
  return releaseRoot;
}

function releaseRootFromLease(
  browserExecutable: string,
  lease: string | Buffer | Record<string, unknown>,
): string | undefined {
  const claims = parseSignedLeaseClaims(lease);
  const artifact = jsonObject(claims?.artifact);
  return deriveReleaseRoot(browserExecutable, artifact?.browserExecutable);
}

function validateFrameworkSettings(backend: FrameworkBackend, settings: FrameworkLaunchSettings): void {
  resolveFrameworkVersion(backend, settings.frameworkVersion);
  requireFrameworkHumanizeSupport(backend, settings.humanize);
  if (settings.nativeReady === true &&
      settings.nativeReadyTimeout !== undefined &&
      (!Number.isFinite(settings.nativeReadyTimeout) || settings.nativeReadyTimeout < 1)) {
    throw new ConfigurationError("nativeReadyTimeout must be a positive number of milliseconds", "config_invalid");
  }
}

function nativeHumanizeControl(
  backend: FrameworkBackend,
  settings: FrameworkLaunchSettings,
): Record<string, unknown> | undefined {
  if (settings.humanize !== true) return undefined;
  if (settings.humanSeed !== undefined &&
      (!Number.isInteger(settings.humanSeed) || settings.humanSeed < 0)) {
    throw new ConfigurationError("Native Humanize seed must be a non-negative integer", "humanize_seed_invalid");
  }
  const preset = settings.humanPreset ?? "default";
  return {
    schemaVersion: 1,
    kind: "slybrowser.native-humanize-control",
    backend,
    humanize: {
      enabled: true,
      version: 1,
      preset,
      config: resolveHumanConfig({
        preset,
        ...(settings.humanConfig === undefined ? {} : { config: settings.humanConfig }),
      }),
      ...(settings.humanSeed === undefined ? {} : { seed: settings.humanSeed }),
    },
  };
}

function mergeLaunchOptions(
  launchOptions: Record<string, unknown> | undefined,
  executable: string,
  handoffArguments: readonly string[],
): Record<string, unknown> {
  const result = { ...(launchOptions ?? {}) };
  if ("executablePath" in result || "executable_path" in result) {
    throw new ConfigurationError(
      "The browser executable must be passed to the SlyBrowser adapter",
      "executable_option_conflict",
    );
  }
  const existingArguments = result.args ?? [];
  if (!Array.isArray(existingArguments) || existingArguments.some((argument) => typeof argument !== "string")) {
    throw new ConfigurationError("Framework args must be a string array", "config_invalid");
  }
  return {
    ...result,
    executablePath: executable,
    args: [...handoffArguments, ...existingArguments],
  };
}

function nativeReadyTimeout(settings: FrameworkLaunchSettings): number | undefined {
  return settings.nativeReady === true ? settings.nativeReadyTimeout ?? 15_000 : undefined;
}

async function closeFrameworkRuntime(runtime: unknown): Promise<void> {
  const candidate = runtime as { close?: (...args: unknown[]) => unknown } | undefined;
  if (typeof candidate?.close !== "function") return;
  await Promise.resolve(candidate.close.call(runtime)).catch(() => undefined);
}

export async function launchPlaywright<TBrowser>(
  playwright: PlaywrightLike<TBrowser>,
  executable: string,
  lease: string | Buffer | Record<string, unknown>,
  settings: FrameworkLaunchSettings = {},
): Promise<TBrowser> {
  validateFrameworkSettings("playwright", settings);
  const readyTimeout = nativeReadyTimeout(settings);
  const plan = await prepareLaunch(executable, settings.profile ?? {}, lease, {
    tempRoot: settings.tempRoot,
    runtimeHandoff: settings.runtimeHandoff,
    allowRuntimeActivationTicket: settings.allowRuntimeActivationTicket === true,
    humanizeControl: nativeHumanizeControl("playwright", settings),
    nativeReady: readyTimeout !== undefined,
    releaseRoot: settings.releaseRoot === undefined ? releaseRootFromLease(executable, lease) : settings.releaseRoot,
  });
  try {
    const browser = await playwright.chromium.launch(
      mergeLaunchOptions(settings.launchOptions, plan.executable, plan.arguments),
    );
    try {
      if (readyTimeout !== undefined) await plan.waitForNativeReady(readyTimeout);
      return browser;
    } catch (error) {
      await closeFrameworkRuntime(browser);
      throw error;
    }
  } finally {
    await plan.cleanup();
  }
}

export async function launchPlaywrightPersistent<TContext>(
  playwright: PlaywrightLike<unknown, TContext>,
  userDataDir: string,
  executable: string,
  lease: string | Buffer | Record<string, unknown>,
  settings: FrameworkLaunchSettings = {},
): Promise<TContext> {
  validateFrameworkSettings("playwright", settings);
  const readyTimeout = nativeReadyTimeout(settings);
  const plan = await prepareLaunch(executable, settings.profile ?? {}, lease, {
    tempRoot: settings.tempRoot,
    runtimeHandoff: settings.runtimeHandoff,
    allowRuntimeActivationTicket: settings.allowRuntimeActivationTicket === true,
    humanizeControl: nativeHumanizeControl("playwright", settings),
    nativeReady: readyTimeout !== undefined,
    releaseRoot: settings.releaseRoot === undefined ? releaseRootFromLease(executable, lease) : settings.releaseRoot,
  });
  try {
    const context = await playwright.chromium.launchPersistentContext(
      resolve(userDataDir),
      mergeLaunchOptions(settings.launchOptions, plan.executable, plan.arguments),
    );
    try {
      if (readyTimeout !== undefined) await plan.waitForNativeReady(readyTimeout);
      return context;
    } catch (error) {
      await closeFrameworkRuntime(context);
      throw error;
    }
  } finally {
    await plan.cleanup();
  }
}

export async function launchPuppeteer<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  executable: string,
  lease: string | Buffer | Record<string, unknown>,
  settings: FrameworkLaunchSettings = {},
): Promise<TBrowser> {
  validateFrameworkSettings("puppeteer", settings);
  const readyTimeout = nativeReadyTimeout(settings);
  const plan = await prepareLaunch(executable, settings.profile ?? {}, lease, {
    tempRoot: settings.tempRoot,
    runtimeHandoff: settings.runtimeHandoff,
    allowRuntimeActivationTicket: settings.allowRuntimeActivationTicket === true,
    humanizeControl: nativeHumanizeControl("puppeteer", settings),
    nativeReady: readyTimeout !== undefined,
    releaseRoot: settings.releaseRoot === undefined ? releaseRootFromLease(executable, lease) : settings.releaseRoot,
  });
  try {
    const browser = await puppeteer.launch(
      mergeLaunchOptions(settings.launchOptions, plan.executable, plan.arguments),
    );
    try {
      if (readyTimeout !== undefined) await plan.waitForNativeReady(readyTimeout);
      return browser;
    } catch (error) {
      await closeFrameworkRuntime(browser);
      throw error;
    }
  } finally {
    await plan.cleanup();
  }
}

export async function launchPuppeteerPersistent<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  userDataDir: string,
  executable: string,
  lease: string | Buffer | Record<string, unknown>,
  settings: FrameworkLaunchSettings = {},
): Promise<TBrowser> {
  if (settings.launchOptions && "userDataDir" in settings.launchOptions) {
    throw new ConfigurationError(
      "The persistent profile directory must be passed to the SlyBrowser adapter",
      "profile_option_conflict",
    );
  }
  return launchPuppeteer(puppeteer, executable, lease, {
    ...settings,
    launchOptions: {
      ...(settings.launchOptions ?? {}),
      userDataDir: resolve(userDataDir),
    },
  });
}
