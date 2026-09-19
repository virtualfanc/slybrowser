import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as playwright from "playwright-core";
import {
  launchAuthorizedPlaywright,
  launchAuthorizedPlaywrightPersistent,
} from "../../packages/node/dist/licensed.js";

const options = parseArgs(process.argv.slice(2));
for (const name of [
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
const commonOptions = {
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
};

const started = Date.now();
const probe = await listen();
try {
  const browser = await launchAuthorizedPlaywright(playwright, options.authorizationFile, commonOptions);
  let browserRuntime;
  try {
    const context = await browser.newContext();
    try {
      const matrix = await pageMatrix(context, probe.origin);
      browserRuntime = {
        browserVersion: browser.licenseRuntime?.browserVersion ?? null,
        versionAudit: browser.licenseRuntime?.versionAudit ?? null,
        matrix,
      };
    } finally {
      await context.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const userDataDir = await mkdtemp(join(tmpdir(), "sly-authorized-cdp-persistent-"));
  let persistentRuntime;
  try {
    const firstContext = await launchAuthorizedPlaywrightPersistent(
      playwright,
      userDataDir,
      options.authorizationFile,
      commonOptions,
    );
    try {
      const firstPage = firstContext.pages()[0] ?? await firstContext.newPage();
      await firstPage.goto(probe.origin);
      await firstPage.evaluate(() => localStorage.setItem("sly-cdp-persistent", "restored"));
      persistentRuntime = {
        browserVersion: firstContext.licenseRuntime?.browserVersion ?? null,
        versionAudit: firstContext.licenseRuntime?.versionAudit ?? null,
      };
    } finally {
      await firstContext.close().catch(() => undefined);
    }

    const secondContext = await launchAuthorizedPlaywrightPersistent(
      playwright,
      userDataDir,
      options.authorizationFile,
      commonOptions,
    );
    try {
      const page = secondContext.pages()[0] ?? await secondContext.newPage();
      await page.goto(probe.origin);
      const restored = await page.evaluate(() => localStorage.getItem("sly-cdp-persistent"));
      const probeResult = await realmProbe(page, "persistent");
      persistentRuntime = {
        ...persistentRuntime,
        restored,
        probe: probeResult,
      };
    } finally {
      await secondContext.close().catch(() => undefined);
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }

  const surfaces = [
    browserRuntime.matrix.main,
    browserRuntime.matrix.iframe,
    browserRuntime.matrix.popup,
    persistentRuntime.probe,
  ];
  const checks = {
    protocolRemainsFunctional: browserRuntime.matrix.protocolEvaluation === 4,
    noInspectorStackSideEffect: surfaces.every((surface) => surface.prepareStackTraceAccesses === 0)
      && browserRuntime.matrix.worker.prepareStackTraceAccesses === 0,
    webdriverHiddenAcrossContexts: surfaces.every((surface) => surface.webdriver === false),
    noAutomationGlobalsAcrossContexts: surfaces.every((surface) => surface.automationGlobals.length === 0),
    noHeadlessUserAgentAcrossContexts: surfaces.every((surface) => surface.headlessUserAgent === false),
    chromeObjectAcrossContexts: surfaces.every((surface) => surface.chromeObject === true),
    popupIframeWorkerAndServiceWorkerCovered: browserRuntime.matrix.popup.name === "popup"
      && browserRuntime.matrix.iframe.name === "iframe"
      && typeof browserRuntime.matrix.worker.prepareStackTraceAccesses === "number"
      && browserRuntime.matrix.serviceWorker.attached === true,
    persistentProfileRestored: persistentRuntime.restored === "restored",
  };
  const status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    language: "node",
    backend: "playwright",
    headed,
    browserVersion: browserRuntime.browserVersion,
    versionAudit: browserRuntime.versionAudit,
    persistentVersionAudit: persistentRuntime.versionAudit,
    checks,
    matrix: browserRuntime.matrix,
    persistent: {
      restored: persistentRuntime.restored,
      probe: persistentRuntime.probe,
    },
    durationMs: Date.now() - started,
  };
  await writeJson(options.output, report);
  console.log(JSON.stringify(report, null, 2));
  if (status !== "PASS") process.exitCode = 1;
} finally {
  await closeServer(probe.server);
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
    if (key.endsWith("KeyId") || key.endsWith("KeyHex") || key.endsWith("Base64url")) {
      result[key] = args[index];
    }
  }
  return result;
}

async function listen() {
  const server = createServer((request, response) => {
    if (request.url === "/frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>CDP Frame</title><main>frame</main>");
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>CDP Popup</title><main>popup</main>");
      return;
    }
    if (request.url === "/worker.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(`
        self.onmessage = () => {
          let accessed = 0;
          Error.prepareStackTrace = () => { accessed += 1; return 'worker-defined-stack'; };
          console.log(new Error('cdp-worker-probe'));
          setTimeout(() => self.postMessage({ prepareStackTraceAccesses: accessed }), 50);
        };
      `);
      return;
    }
    if (request.url === "/service-worker.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    response.end(`<!doctype html>
      <title>CDP Main</title>
      <a id="popup" href="/popup" target="_blank">popup</a>
      <iframe id="frame" src="http://localhost:${port}/frame"></iframe>`);
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CDP probe server did not allocate a port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  await new Promise((accept) => server.close(() => accept()));
}

async function realmProbe(realm, name) {
  return realm.evaluate(async (probeName) => {
    const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    let prepareStackTraceAccesses = 0;
    Error.prepareStackTrace = () => {
      prepareStackTraceAccesses += 1;
      return "page-defined-stack";
    };
    console.log(new Error(`cdp-${probeName}-probe`));
    await new Promise((accept) => setTimeout(accept, 50));
    const keys = Object.getOwnPropertyNames(globalThis).filter((key) =>
      /playwright|puppeteer|__pw|cdc_[A-Za-z0-9_]+/i.test(key));
    const result = {
      name: probeName,
      prepareStackTraceAccesses,
      webdriver: navigator.webdriver,
      chromeObject: typeof globalThis.chrome === "object",
      pluginCount: navigator.plugins.length,
      headlessUserAgent: /HeadlessChrome/i.test(navigator.userAgent),
      automationGlobals: keys,
    };
    if (original) Object.defineProperty(Error, "prepareStackTrace", original);
    else delete Error.prepareStackTrace;
    return result;
  }, name);
}

async function workerProbe(page, origin) {
  const workerPromise = page.waitForEvent("worker");
  const valuePromise = page.evaluate((workerUrl) => new Promise((accept, reject) => {
    const worker = new Worker(workerUrl);
    worker.onmessage = (event) => { accept(event.data); worker.terminate(); };
    worker.onerror = reject;
    worker.postMessage("probe");
  }), `${origin}/worker.js`);
  await workerPromise;
  return valuePromise;
}

async function pageMatrix(context, origin) {
  const page = await context.newPage();
  await page.goto(origin);
  const cdp = await context.newCDPSession(page);
  const consoleEvents = [];
  cdp.on("Runtime.consoleAPICalled", (event) => {
    consoleEvents.push({
      type: event.type,
      args: event.args.map((argument) => ({
        type: argument.type,
        subtype: argument.subtype,
        description: argument.description,
        hasPreview: Boolean(argument.preview),
      })),
    });
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Debugger.enable");
  const protocolEvaluation = await cdp.send("Runtime.evaluate", {
    expression: "2 + 2",
    returnByValue: true,
  });

  const main = await realmProbe(page, "main");
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (!frame) throw new Error("Cross-origin frame was not created");
  const iframe = await realmProbe(frame, "iframe");

  const popupPromise = page.waitForEvent("popup");
  await page.locator("#popup").click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const popupSession = await context.newCDPSession(popup);
  await popupSession.send("Runtime.enable");
  const popupResult = await realmProbe(popup, "popup");
  await popupSession.detach().catch(() => undefined);
  await popup.close();

  const worker = await workerProbe(page, origin);
  const serviceWorkerPromise = context.waitForEvent("serviceworker");
  await page.evaluate(() => navigator.serviceWorker.register("/service-worker.js"));
  const serviceWorker = await serviceWorkerPromise;
  const serviceWorkerUrl = serviceWorker.url();

  await cdp.detach();
  await page.close();
  return {
    protocolEvaluation: protocolEvaluation.result?.value,
    main,
    iframe,
    popup: popupResult,
    worker,
    serviceWorker: { attached: serviceWorkerUrl.endsWith("/service-worker.js") },
    consoleObserved: consoleEvents.length > 0,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
