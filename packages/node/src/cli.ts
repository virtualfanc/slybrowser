#!/usr/bin/env node

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { LicenseServiceError } from "./errors.js";
import { installLatestAuthorizedBrowser } from "./licensed.js";
import {
  LicenseServiceClient,
  importLicenseFileToSealedAuthorization,
  readLicenseAuthorization,
  type BrowserVersionPolicy,
  type KernelMajor,
} from "./service.js";
import { defaultDriverExecutable } from "./webdriver.js";
import { LICENSE_FILE_KEYS, officialTrust } from "./official-trust.js";

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function optionValues(arguments_: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const value = arguments_[index + 1];
    if (arguments_[index] === name && value !== undefined) values.push(value);
  }
  return values;
}

export function parseKernelMajorArgument(value: string): KernelMajor;
export function parseKernelMajorArgument(value: undefined): undefined;
export function parseKernelMajorArgument(value: string | undefined): KernelMajor | undefined {
  if (value === undefined) return undefined;
  if (value === "latest") return "latest";
  if (/^[1-9][0-9]*$/.test(value)) return Number(value);
  throw new Error("--kernel-major must be a positive integer or latest");
}

export function parseInstallSelectionArguments(arguments_: readonly string[]): {
  browserVersion?: string;
  versionPolicy?: BrowserVersionPolicy;
  kernelMajor?: KernelMajor;
  updateKernel: boolean;
} {
  const browserVersion = optionValue(arguments_, "--version");
  const rollback = arguments_.includes("--rollback");
  if (rollback && !browserVersion) {
    throw new Error("--rollback requires --version VERSION");
  }
  const selection: {
    browserVersion?: string;
    versionPolicy?: BrowserVersionPolicy;
    kernelMajor?: KernelMajor;
    updateKernel: boolean;
  } = { updateKernel: arguments_.includes("--update-kernel") };
  if (browserVersion !== undefined) {
    selection.browserVersion = browserVersion;
    selection.versionPolicy = rollback ? "at-or-before" : "exact";
  }
  const kernelMajor = optionValue(arguments_, "--kernel-major");
  if (kernelMajor !== undefined) selection.kernelMajor = parseKernelMajorArgument(kernelMajor);
  return selection;
}

export function licenseServiceErrorOutput(error: LicenseServiceError): {
  schemaVersion: 1;
  status: "error";
  stableErrorCode: string;
  httpStatus: number | null;
} {
  return {
    schemaVersion: 1,
    status: "error",
    stableErrorCode: error.code,
    httpStatus: error.status || null,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...arguments_] = argv;
  if (command === "--version" || command === "-V") {
    console.log("0.2.0");
    return 0;
  }
  if (command === "install") {
    const authorization = optionValue(arguments_, "--authorization");
    if (!authorization) {
      console.error("Usage: slybrowser install --authorization FILE [--cache DIR] [--kernel-major MAJOR|latest] [--update-kernel] [--version VERSION] [--rollback]");
      return 2;
    }
    const cacheRoot = optionValue(arguments_, "--cache");
    let selection: ReturnType<typeof parseInstallSelectionArguments>;
    try {
      selection = parseInstallSelectionArguments(arguments_);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
    const authorized = await installLatestAuthorizedBrowser(resolve(authorization), {
      trust: {
        ...officialTrust(),
      },
      ...(cacheRoot === undefined ? {} : { install: { cacheRoot: resolve(cacheRoot) } }),
      ...selection,
    });
    try {
      console.log(JSON.stringify({
        plan: authorized.grant.plan,
        concurrencyLimit: authorized.grant.concurrencyLimit,
        activeSessions: authorized.grant.activeSessions,
        requestedVersion: authorized.grant.requestedBrowserVersion ?? null,
        selectedVersion: authorized.grant.browserVersion,
        downloadedVersion: authorized.installation.version,
        launchedVersion: null,
        versionPolicy: authorized.grant.versionPolicy,
        selectionReason: authorized.grant.selectionReason,
        requestedKernelMajor: authorized.grant.requestedKernelMajor ?? null,
        selectionMode: authorized.grant.selectionMode ?? null,
        availableVersions: authorized.grant.availableBrowserVersions,
        latestAvailableVersion: authorized.grant.latestAvailableVersion ?? null,
        updateAvailable: authorized.grant.updateAvailable ?? null,
        updateRequired: authorized.grant.updateRequired ?? null,
        updateRights: authorized.grant.updateRights,
        platform: authorized.installation.platform,
        arch: authorized.installation.arch,
        browser: authorized.installation.browserExecutable,
        driver: authorized.installation.driverExecutable,
        artifactSha256: authorized.installation.artifactSha256,
      }, null, 2));
    } finally {
      await authorized.release().catch(() => undefined);
    }
    return 0;
  }
  if (command === "license") {
    const [licenseCommand, ...licenseArguments] = arguments_;
    if (licenseCommand === "info") {
      const authorization = optionValue(licenseArguments, "--authorization");
      if (!authorization) {
        console.error("Usage: slybrowser license info --authorization FILE [--passphrase VALUE] [--trusted-service-url URL] [--kernel-major MAJOR|latest] [--update-kernel] [--version VERSION] [--rollback]");
        return 2;
      }
      let selection: ReturnType<typeof parseInstallSelectionArguments>;
      try {
        selection = parseInstallSelectionArguments(licenseArguments);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 2;
      }
      const trustedServiceUrls = optionValues(licenseArguments, "--trusted-service-url");
      const licenseFilePassphrase = optionValue(licenseArguments, "--passphrase");
      const licenseFileTrustedKeys = LICENSE_FILE_KEYS;
      try {
        const document = await readLicenseAuthorization(resolve(authorization), {
          ...(licenseFilePassphrase === undefined ? {} : { licenseFilePassphrase }),
          ...(licenseFileTrustedKeys === undefined ? {} : { licenseFileTrustedKeys }),
          ...(trustedServiceUrls.length ? { trustedServiceUrls } : {}),
        });
        const client = new LicenseServiceClient(document, {
          ...officialTrust(),
        });
        const info = await client.licenseInfo(selection);
        console.log(JSON.stringify(info, null, 2));
        return 0;
      } catch (error) {
        if (error instanceof LicenseServiceError) {
          console.log(JSON.stringify(licenseServiceErrorOutput(error), null, 2));
          return 1;
        }
        throw error;
      }
    }
    if (licenseCommand !== "import") {
      console.error("Usage: slybrowser license info --authorization FILE [--passphrase VALUE] [--trusted-service-url URL] [--kernel-major MAJOR|latest] [--update-kernel] [--version VERSION] [--rollback] | license import --input FILE --output FILE --passphrase VALUE [--trusted-service-url URL]");
      return 2;
    }
    const input = optionValue(licenseArguments, "--input");
    const output = optionValue(licenseArguments, "--output");
    const passphrase = optionValue(licenseArguments, "--passphrase");
    if (!input || !output || !passphrase) {
      console.error("Usage: slybrowser license import --input FILE --output FILE --passphrase VALUE [--trusted-service-url URL]");
      return 2;
    }
    const trustedServiceUrls = optionValues(licenseArguments, "--trusted-service-url");
    const result = await importLicenseFileToSealedAuthorization(resolve(input), resolve(output), {
      licenseFilePassphrase: passphrase,
      licenseFileTrustedKeys: LICENSE_FILE_KEYS,
      ...(trustedServiceUrls.length ? { trustedServiceUrls } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command !== "doctor") {
    console.error("Usage: slybrowser doctor [--browser PATH] [--driver PATH] | install --authorization FILE [--cache DIR] [--kernel-major MAJOR|latest] [--update-kernel] [--version VERSION] [--rollback] | license info --authorization FILE [--passphrase VALUE] [--trusted-service-url URL] [--kernel-major MAJOR|latest] [--update-kernel] [--version VERSION] [--rollback] | license import --input FILE --output FILE --passphrase VALUE [--trusted-service-url URL]");
    return 2;
  }
  const browserIndex = arguments_.indexOf("--browser");
  const browser = browserIndex >= 0 ? arguments_[browserIndex + 1] : undefined;
  const driverIndex = arguments_.indexOf("--driver");
  const driver = driverIndex >= 0 ? arguments_[driverIndex + 1] : undefined;
  let browserExists = false;
  let browserPath: string | undefined;
  if (browser) {
    browserPath = resolve(browser);
    try {
      await access(browserPath);
      browserExists = true;
    } catch {
      browserExists = false;
    }
  }
  let driverExists = false;
  let driverPath: string | undefined;
  if (browserPath) {
    driverPath = defaultDriverExecutable(browserPath, driver);
    try {
      await access(driverPath);
      driverExists = true;
    } catch {
      driverExists = false;
    }
  }
  console.log(JSON.stringify({
    sdkVersion: "0.2.0",
    node: process.version,
    defaultBackend: "project-webdriver",
    browser: browserPath,
    browserExists,
    driver: driverPath,
    driverExists,
  }, null, 2));
  return !browser || browserExists && driverExists ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
