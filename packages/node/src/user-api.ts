import type { PlaywrightLike, PuppeteerLike } from "./browser.js";
import type { HumanConfig, HumanPreset } from "./humanize.js";
import {
  launchLatest as launchInternal,
  launchLatestPlaywright as launchPlaywrightInternal,
  launchLatestPlaywrightPersistent as launchPlaywrightPersistentInternal,
  launchLatestPuppeteer as launchPuppeteerInternal,
  launchLatestPuppeteerPersistent as launchPuppeteerPersistentInternal,
  type LicensedFrameworkRuntime,
} from "./licensed.js";
import { officialTrust } from "./official-trust.js";
import { ConfigurationError } from "./errors.js";
import type { SlyWebDriverSession } from "./webdriver.js";

export interface NoiseProfile { r: number; g: number; b: number; a: number }
export interface ClientHint { brand: string; version: string }

export interface SlyBrowserProfile {
  fingerprintMode?: "explicit" | "seeded";
  fingerprintSeed?: string;
  fingerprintSchemaVersion?: 1;
  userAgent?: string;
  userAgentFullVersion?: string;
  clientHints?: readonly ClientHint[];
  osVersion?: string;
  locale?: string;
  languages?: readonly string[];
  timezone?: string | { zone: string; utc?: string; locale?: string };
  screen?: { width: number; height: number };
  webrtc?: "default";
  disabledFonts?: readonly string[];
  canvasNoise?: NoiseProfile;
  webglImageNoise?: NoiseProfile;
  webgl?: { vendor: string; renderer: string };
  webgpu?: { vendor: string; architecture: string };
  audioContext?: { channel: number; analyzer: number };
  disabledCipherSuites?: readonly string[];
  disabledMediaDevices?: readonly string[];
  clientRects?: { width: number; height: number };
  speechVoices?: readonly {
    default: boolean;
    lang: string;
    localService: boolean;
    name: string;
    voiceURI: string;
  }[];
  cookies?: readonly {
    name: string;
    value: string;
    domain: string;
    path: string;
    session: boolean;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "None" | "Lax" | "Strict" | "Unspecified";
  }[];
  hardwareConcurrency?: number;
  deviceMemory?: number;
  deviceName?: string;
  macAddress?: string;
  doNotTrack?: boolean;
  allowedPorts?: readonly number[];
  gpuEnabled?: boolean;
  homepages?: readonly string[];
}

export interface SlyBrowserLaunchOptions {
  headless?: boolean;
  profileMode?: "ephemeral" | "persistent";
  profileDirectory?: string;
  updateKernel?: boolean;
}

export interface SlyBrowserHumanizeOptions {
  enabled?: boolean;
  preset?: HumanPreset;
  seed?: number;
  config?: Partial<HumanConfig>;
}

export interface SlyBrowserOptions {
  profile?: SlyBrowserProfile;
  launch?: SlyBrowserLaunchOptions;
  humanize?: SlyBrowserHumanizeOptions;
}

const allowedOptionFields = new Set(["profile", "launch", "humanize"]);
const allowedLaunchFields = new Set(["headless", "profileMode", "profileDirectory", "updateKernel"]);
const allowedHumanizeFields = new Set(["enabled", "preset", "seed", "config"]);

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${label} must be an object`, "launch_options_invalid");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw new ConfigurationError(`Unknown ${label} field: ${unknown}`, "launch_options_invalid");
}

function validateOptions(options: SlyBrowserOptions): void {
  const root = objectValue(options, "options");
  rejectUnknownFields(root, allowedOptionFields, "options");
  if (root.profile !== undefined) objectValue(root.profile, "profile");
  if (root.launch !== undefined) {
    const launch = objectValue(root.launch, "launch");
    rejectUnknownFields(launch, allowedLaunchFields, "launch");
    if (launch.profileMode !== undefined && launch.profileMode !== "ephemeral" && launch.profileMode !== "persistent") {
      throw new ConfigurationError("launch.profileMode must be ephemeral or persistent", "launch_options_invalid");
    }
  }
  if (root.humanize !== undefined) {
    const humanize = objectValue(root.humanize, "humanize");
    rejectUnknownFields(humanize, allowedHumanizeFields, "humanize");
    if (humanize.preset !== undefined && humanize.preset !== "default" && humanize.preset !== "careful") {
      throw new ConfigurationError("humanize.preset must be default or careful", "humanize_preset_invalid");
    }
    if (humanize.config !== undefined) objectValue(humanize.config, "humanize.config");
  }
}

function common(options: SlyBrowserOptions) {
  validateOptions(options);
  const launch = options.launch ?? {};
  const humanize = options.humanize ?? {};
  return {
    trust: officialTrust(),
    ...(options.profile === undefined ? {} : { profile: options.profile as Record<string, unknown> }),
    ...(launch.headless === undefined ? {} : { headless: launch.headless }),
    ...(launch.profileMode === undefined ? {} : { profileMode: launch.profileMode }),
    ...(launch.profileDirectory === undefined ? {} : { profileDir: launch.profileDirectory }),
    ...(launch.updateKernel === undefined ? {} : { updateKernel: launch.updateKernel }),
    ...(humanize.enabled === undefined ? {} : { humanize: humanize.enabled }),
    ...(humanize.preset === undefined ? {} : { humanPreset: humanize.preset }),
    ...(humanize.seed === undefined ? {} : { humanSeed: humanize.seed }),
    ...(humanize.config === undefined ? {} : { humanConfig: humanize.config }),
  };
}

/** Launch the project WebDriver using only the customer authorization file and user options. */
export async function launch(
  authorizationFile: string,
  options: SlyBrowserOptions = {},
): Promise<SlyWebDriverSession> {
  return launchInternal(authorizationFile, common(options));
}

/** Launch through the installed Playwright binding; its version is detected automatically. */
export async function launchPlaywright<TBrowser>(
  playwright: PlaywrightLike<TBrowser>,
  authorizationFile: string,
  options: SlyBrowserOptions = {},
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  const normalized = common(options);
  return launchPlaywrightInternal(playwright, authorizationFile, {
    ...normalized,
    ...(normalized.headless === undefined ? {} : { launchOptions: { headless: normalized.headless } }),
  });
}

export async function launchPlaywrightPersistent<TContext>(
  playwright: PlaywrightLike<unknown, TContext>,
  userDataDirectory: string,
  authorizationFile: string,
  options: SlyBrowserOptions = {},
): Promise<LicensedFrameworkRuntime<TContext>> {
  const normalized = common(options);
  return launchPlaywrightPersistentInternal(playwright, userDataDirectory, authorizationFile, {
    ...normalized,
    ...(normalized.headless === undefined ? {} : { launchOptions: { headless: normalized.headless } }),
  });
}

/** Launch through the installed Puppeteer binding; its version is detected automatically. */
export async function launchPuppeteer<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  authorizationFile: string,
  options: SlyBrowserOptions = {},
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  const normalized = common(options);
  return launchPuppeteerInternal(puppeteer, authorizationFile, {
    ...normalized,
    ...(normalized.headless === undefined ? {} : { launchOptions: { headless: normalized.headless } }),
  });
}

export async function launchPuppeteerPersistent<TBrowser>(
  puppeteer: PuppeteerLike<TBrowser>,
  userDataDirectory: string,
  authorizationFile: string,
  options: SlyBrowserOptions = {},
): Promise<LicensedFrameworkRuntime<TBrowser>> {
  const normalized = common(options);
  return launchPuppeteerPersistentInternal(puppeteer, userDataDirectory, authorizationFile, {
    ...normalized,
    ...(normalized.headless === undefined ? {} : { launchOptions: { headless: normalized.headless } }),
  });
}

export type { HumanConfig, HumanPreset, SlyWebDriverSession };
