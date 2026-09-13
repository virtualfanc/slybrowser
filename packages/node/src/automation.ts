import { createRequire } from "node:module";

import { ConfigurationError } from "./errors.js";

export type AutomationBackend = "project-webdriver" | "playwright" | "puppeteer";
export type FrameworkBackend = Exclude<AutomationBackend, "project-webdriver">;

export interface AutomationCapability {
  backend: AutomationBackend;
  language: "node";
  frameworkVersion?: string;
  nativeHumanize: boolean;
  persistentContext: boolean;
}

const SUPPORTED_LINES: Readonly<Record<FrameworkBackend, readonly string[]>> = Object.freeze({
  playwright: Object.freeze(["1.62"]),
  puppeteer: Object.freeze(["25"]),
});

const PACKAGE_CANDIDATES: Readonly<Record<FrameworkBackend, readonly string[]>> = Object.freeze({
  playwright: Object.freeze(["playwright-core", "playwright"]),
  puppeteer: Object.freeze(["puppeteer-core", "puppeteer"]),
});

function versionLine(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) throw new ConfigurationError(`Invalid framework version: ${version}`, "framework_version_invalid");
  return match[1] === "1" ? `${match[1]}.${match[2]}` : match[1]!;
}

export function validateFrameworkVersion(backend: FrameworkBackend, version: string): string {
  const line = versionLine(version);
  if (!SUPPORTED_LINES[backend].includes(line)) {
    throw new ConfigurationError(
      `Unsupported ${backend} version ${version}; supported lines: ${SUPPORTED_LINES[backend].join(", ")}`,
      "framework_version_unsupported",
    );
  }
  return version;
}

export function installedFrameworkVersion(backend: FrameworkBackend): string {
  const require = createRequire(import.meta.url);
  for (const packageName of PACKAGE_CANDIDATES[backend]) {
    try {
      const metadata = require(`${packageName}/package.json`) as { version?: unknown };
      if (typeof metadata.version === "string") return validateFrameworkVersion(backend, metadata.version);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
  }
  throw new ConfigurationError(
    `Unable to determine the installed ${backend} package version; pass frameworkVersion explicitly`,
    "framework_version_missing",
  );
}

export function resolveFrameworkVersion(backend: FrameworkBackend, explicit?: string): string {
  return explicit === undefined
    ? installedFrameworkVersion(backend)
    : validateFrameworkVersion(backend, explicit);
}

export function automationCapability(
  backend: AutomationBackend = "project-webdriver",
  frameworkVersion?: string,
): AutomationCapability {
  if (backend === "project-webdriver") {
    if (frameworkVersion !== undefined) {
      throw new ConfigurationError("Project WebDriver does not accept frameworkVersion", "framework_version_forbidden");
    }
    return {
      backend,
      language: "node",
      nativeHumanize: true,
      persistentContext: true,
    };
  }
  return {
    backend,
    language: "node",
    frameworkVersion: resolveFrameworkVersion(backend, frameworkVersion),
    nativeHumanize: true,
    persistentContext: true,
  };
}

export function requireFrameworkHumanizeSupport(backend: FrameworkBackend, requested: boolean | undefined): void {
  void backend;
  void requested;
}
