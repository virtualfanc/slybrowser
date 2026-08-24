import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chromium } from "playwright-core";

function parseArguments(values) {
  const options = { headed: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--sly-browser") options.slyBrowser = resolve(values[++index]);
    else if (value === "--stock-browser") options.stockBrowser = resolve(values[++index]);
    else if (value === "--license-file") options.licenseFile = resolve(values[++index]);
    else if (value === "--profile-file") options.profileFile = resolve(values[++index]);
    else if (value === "--output") options.output = resolve(values[++index]);
    else if (value === "--headed") options.headed = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.slyBrowser || !options.stockBrowser || !options.output) {
    throw new Error("--sly-browser, --stock-browser and --output are required");
  }
  return options;
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
    // Stay on the raw protocol event. Calling Playwright's
    // ConsoleMessage.args().jsonValue() explicitly serializes the Error object
    // in page JavaScript and can invoke user-defined Error.prepareStackTrace;
    // that is a client-requested read, not a CDP preview side effect.
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

async function persistentProbe(executablePath, launchOptions, origin) {
  const userDataDir = await mkdtemp(join(tmpdir(), "sly-playwright-persistent-"));
  try {
    let context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      ...launchOptions,
    });
    let page = context.pages()[0] ?? await context.newPage();
    await page.goto(origin);
    await page.evaluate(() => localStorage.setItem("sly-cdp-persistent", "restored"));
    await context.close();

    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      ...launchOptions,
    });
    page = context.pages()[0] ?? await context.newPage();
    await page.goto(origin);
    const restored = await page.evaluate(() => localStorage.getItem("sly-cdp-persistent"));
    const probe = await realmProbe(page, "persistent");
    await context.close();
    return { restored, probe };
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function runTarget(executablePath, args, headed, origin) {
  const launchOptions = { headless: !headed, args };
  const browser = await chromium.launch({ executablePath, ...launchOptions });
  try {
    const context = await browser.newContext();
    const matrix = await pageMatrix(context, origin);
    await context.close();
    const persistent = await persistentProbe(executablePath, launchOptions, origin);
    return { matrix, persistent };
  } finally {
    await browser.close();
  }
}

function surfaces(result) {
  return [
    result.matrix.main,
    result.matrix.iframe,
    result.matrix.popup,
    result.persistent.probe,
  ];
}

const options = parseArguments(process.argv.slice(2));
const handoffRoot = await mkdtemp(join(tmpdir(), "sly-playwright-handoff-"));
const slyArguments = [];
if (options.licenseFile) {
  const licenseHandoff = join(handoffRoot, "license.json");
  await copyFile(options.licenseFile, licenseHandoff);
  slyArguments.push(`--sly-license-file=${licenseHandoff}`);
}
if (options.profileFile) {
  const profileHandoff = join(handoffRoot, "profile.json");
  await copyFile(options.profileFile, profileHandoff);
  slyArguments.push(`--sly-config-file=${profileHandoff}`);
}
const probe = await listen();
try {
  const [sly, stock] = await Promise.all([
    runTarget(options.slyBrowser, slyArguments, options.headed, probe.origin),
    runTarget(options.stockBrowser, [], options.headed, probe.origin),
  ]);
  const slySurfaces = surfaces(sly);
  const checks = {
    protocolRemainsFunctional: sly.matrix.protocolEvaluation === 4,
    noInspectorStackSideEffect: slySurfaces.every((surface) => surface.prepareStackTraceAccesses === 0)
      && sly.matrix.worker.prepareStackTraceAccesses === 0,
    webdriverHiddenAcrossContexts: slySurfaces.every((surface) => surface.webdriver === false),
    noAutomationGlobalsAcrossContexts: slySurfaces.every((surface) => surface.automationGlobals.length === 0),
    noHeadlessUserAgentAcrossContexts: slySurfaces.every((surface) => surface.headlessUserAgent === false),
    chromeObjectAcrossContexts: slySurfaces.every((surface) => surface.chromeObject === true),
    popupIframeWorkerAndServiceWorkerCovered: sly.matrix.popup.name === "popup"
      && sly.matrix.iframe.name === "iframe"
      && typeof sly.matrix.worker.prepareStackTraceAccesses === "number"
      && sly.matrix.serviceWorker.attached === true,
    persistentProfileRestored: sly.persistent.restored === "restored",
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    framework: { name: "playwright-core", version: "1.62.x" },
    status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    checks,
    sly,
    stock,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
} finally {
  await closeServer(probe.server);
  await rm(handoffRoot, { recursive: true, force: true });
}
