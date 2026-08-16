#!/usr/bin/env node

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { installLatestAuthorizedBrowser } from "./licensed.js";
import { defaultDriverExecutable } from "./webdriver.js";

function parseTrustedKeys(value: string | undefined, name: string): Record<string, Buffer> {
  if (!value) throw new Error(`${name} is required`);
  const document = JSON.parse(value) as Record<string, unknown>;
  const result: Record<string, Buffer> = {};
  for (const [keyId, encoded] of Object.entries(document)) {
    if (typeof encoded !== "string") throw new Error(`${name}.${keyId} must be base64url`);
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error(`${name}.${keyId} must contain a raw 32-byte Ed25519 public key`);
    result[keyId] = key;
  }
  if (!Object.keys(result).length) throw new Error(`${name} must contain at least one key`);
  return result;
}

async function main(): Promise<number> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "--version" || command === "-V") {
    console.log("0.1.0");
    return 0;
  }
  if (command === "install") {
    const authorizationIndex = arguments_.indexOf("--authorization");
    const authorization = authorizationIndex >= 0 ? arguments_[authorizationIndex + 1] : undefined;
    if (!authorization) {
      console.error("Usage: slybrowser install --authorization FILE [--cache DIR] [--version VERSION] [--rollback]");
      return 2;
    }
    const cacheIndex = arguments_.indexOf("--cache");
    const cacheRoot = cacheIndex >= 0 ? arguments_[cacheIndex + 1] : undefined;
    const versionIndex = arguments_.indexOf("--version");
    const browserVersion = versionIndex >= 0 ? arguments_[versionIndex + 1] : undefined;
    const rollback = arguments_.includes("--rollback");
    if (rollback && !browserVersion) {
      console.error("--rollback requires --version VERSION");
      return 2;
    }
    const authorized = await installLatestAuthorizedBrowser(resolve(authorization), {
      trust: {
        licenseTrustedKeys: parseTrustedKeys(process.env.SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON, "SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON"),
        releaseTrustedKeys: parseTrustedKeys(process.env.SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON, "SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON"),
      },
      ...(cacheRoot === undefined ? {} : { install: { cacheRoot: resolve(cacheRoot) } }),
      ...(browserVersion === undefined ? {} : { browserVersion }),
      ...(browserVersion === undefined ? {} : { versionPolicy: rollback ? "at-or-before" : "exact" }),
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
        availableVersions: authorized.grant.availableBrowserVersions,
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
  if (command !== "doctor") {
    console.error("Usage: slybrowser doctor [--browser PATH] [--driver PATH] | install --authorization FILE [--cache DIR] [--version VERSION] [--rollback]");
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
    sdkVersion: "0.1.0",
    node: process.version,
    defaultBackend: "project-webdriver",
    browser: browserPath,
    browserExists,
    driver: driverPath,
    driverExists,
  }, null, 2));
  return !browser || browserExists && driverExists ? 0 : 2;
}

process.exitCode = await main();
