import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import * as playwright from "playwright-core";
import puppeteer from "puppeteer-core";
import {
  launchAuthorizedPlaywright,
  launchAuthorizedPuppeteer,
} from "../../packages/node/dist/index.js";

const options = parseArgs(process.argv.slice(2));
for (const name of [
  "backend",
  "authorizationFile",
  "cacheRoot",
  "licenseKeyId",
  "licensePublicKeyHex",
  "releaseKeyId",
  "releasePublicKeyBase64url",
  "output",
]) {
  if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
}
if (!["playwright", "puppeteer"].includes(options.backend)) {
  throw new Error("--backend must be playwright or puppeteer");
}

const headed = options.headed === true;
const trust = {
  trustedServiceUrls: ["https://api.slybrowser.com"],
  licenseTrustedKeys: {
    [options.licenseKeyId]: Buffer.from(options.licensePublicKeyHex, "hex"),
  },
  releaseTrustedKeys: {
    [options.releaseKeyId]: Buffer.from(options.releasePublicKeyBase64url, "base64url"),
  },
};
const launchOptions = {
  headless: !headed,
  args: ["--window-size=900,700", "--force-device-scale-factor=1.5"],
};
const started = Date.now();

let runtime;
try {
  if (options.backend === "playwright") {
    runtime = await launchAuthorizedPlaywright(playwright, options.authorizationFile, {
      trust,
      install: { cacheRoot: options.cacheRoot },
      platform: "windows",
      arch: "x64",
      launchOptions,
      humanize: true,
      humanPreset: "careful",
      humanSeed: 52525,
      nativeReady: true,
      nativeReadyTimeout: 30_000,
    });
  } else {
    runtime = await launchAuthorizedPuppeteer(puppeteer, options.authorizationFile, {
      trust,
      install: { cacheRoot: options.cacheRoot },
      platform: "windows",
      arch: "x64",
      launchOptions,
      humanize: true,
      humanPreset: "careful",
      humanSeed: 52525,
      nativeReady: true,
      nativeReadyTimeout: 30_000,
    });
  }
  const page = await runtime.newPage();
  await page.goto(dataUrl(`<title>sly-node-${options.backend}-ok</title><button id="target">Target</button>`));
  const title = await page.title();
  const signals = await page.evaluate(() => ({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    chromeType: typeof window.chrome,
    dpr: devicePixelRatio,
  }));
  if (title !== `sly-node-${options.backend}-ok`) throw new Error(`unexpected title ${title}`);
  if (signals.webdriver === true) throw new Error("navigator.webdriver is true");
  if (signals.chromeType !== "object") throw new Error(`window.chrome type is ${signals.chromeType}`);
  await writeJson(options.output, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "PASS",
    language: "node",
    backend: options.backend,
    headed,
    browserVersion: runtime.licenseRuntime?.browserVersion ?? null,
    versionAudit: runtime.licenseRuntime?.versionAudit ?? null,
    signals,
    durationMs: Date.now() - started,
  });
} finally {
  if (runtime) await runtime.close().catch(() => undefined);
}

function parseArgs(args) {
  const result = { headed: false };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--headed") {
      result.headed = true;
      continue;
    }
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = resolve(args[++index]);
    if (key.endsWith("KeyId") || key.endsWith("KeyHex") || key.endsWith("Base64url") || key === "backend") {
      result[key] = args[index];
    }
  }
  return result;
}

function dataUrl(markup) {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(markup, "utf8").toString("base64")}`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
