import { resolve } from "node:path";

import { ConfigurationError } from "./errors.js";
import { prepareLaunch } from "./launcher.js";
import { humanizeBrowser, humanizeContext, type HumanConfig, type HumanPreset } from "./humanize.js";

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
  humanize?: boolean;
  humanPreset?: HumanPreset;
  humanConfig?: Partial<HumanConfig>;
  humanSeed?: number;
}

function humanizeSettings(settings: FrameworkLaunchSettings) {
  return {
    ...(settings.humanPreset === undefined ? {} : { preset: settings.humanPreset }),
    ...(settings.humanConfig === undefined ? {} : { config: settings.humanConfig }),
    ...(settings.humanSeed === undefined ? {} : { seed: settings.humanSeed }),
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

export async function launchPlaywright<TBrowser>(
  playwright: PlaywrightLike<TBrowser>,
  executable: string,
  lease: string | Buffer | Record<string, unknown>,
  settings: FrameworkLaunchSettings = {},
): Promise<TBrowser> {
  const plan = await prepareLaunch(executable, settings.profile ?? {}, lease, { tempRoot: settings.tempRoot });
  try {
    const browser = await playwright.chromium.launch(
      mergeLaunchOptions(settings.launchOptions, plan.executable, plan.arguments),
    );
    return settings.humanize ? await humanizeBrowser(browser, humanizeSettings(settings)) : browser;
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
  const plan = await prepareLaunch(executable, settings.profile ?? {}, lease, { tempRoot: settings.tempRoot });
  try {
    const context = await playwright.chromium.launchPersistentContext(
      resolve(userDataDir),
      mergeLaunchOptions(settings.launchOptions, plan.executable, plan.arguments),
    );
    return settings.humanize ? humanizeContext(context, humanizeSettings(settings)) : context;
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
  const plan = await prepareLaunch(executable, settings.profile ?? {}, lease, { tempRoot: settings.tempRoot });
  try {
    const browser = await puppeteer.launch(
      mergeLaunchOptions(settings.launchOptions, plan.executable, plan.arguments),
    );
    return settings.humanize ? await humanizeBrowser(browser, humanizeSettings(settings)) : browser;
  } finally {
    await plan.cleanup();
  }
}
