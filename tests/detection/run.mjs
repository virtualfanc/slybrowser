import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

import { compareRuns, renderMarkdown } from "./compare.mjs";
import { summarizeResults } from "./score.mjs";
import { parseDeviceInfo, parseDeviceInteractions } from "./webdriver-adapters.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localPages = resolve(scriptDirectory, "pages");

function parseArguments(arguments_) {
  const options = {
    browsers: resolve(scriptDirectory, "browsers.local.json"),
    sites: resolve(scriptDirectory, "sites.json"),
    output: resolve(scriptDirectory, "../../artifacts/test-results/detection"),
    only: null,
    headed: false,
    failOnDetection: false,
    navigationTimeout: 45_000,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--browsers") options.browsers = resolve(arguments_[++index]);
    else if (argument === "--sites") options.sites = resolve(arguments_[++index]);
    else if (argument === "--output") options.output = resolve(arguments_[++index]);
    else if (argument === "--only") options.only = new Set(arguments_[++index].split(",").filter(Boolean));
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--fail-on-detection") options.failOnDetection = true;
    else if (argument === "--navigation-timeout") options.navigationTimeout = Number(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(options.navigationTimeout) || options.navigationTimeout < 1_000) {
    throw new Error("--navigation-timeout must be at least 1000 milliseconds");
  }
  return options;
}

function expandEnvironment(value, missing) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name) => {
      const replacement = process.env[name];
      if (!replacement) missing.add(name);
      return replacement ?? "";
    });
  }
  if (Array.isArray(value)) return value.map((item) => expandEnvironment(item, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvironment(item, missing)]));
  }
  return value;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((accept, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", accept);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function startLocalServer() {
  const routes = new Map([
    ["/probe", "probe.html"],
    ["/turnstile-visible", "turnstile-visible.html"],
    ["/turnstile-invisible", "turnstile-invisible.html"],
  ]);
  const server = createServer(async (request, response) => {
    const file = routes.get(new URL(request.url, "http://127.0.0.1").pathname);
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    try {
      const content = await readFile(join(localPages, file));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(content);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(String(error));
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() { await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())); },
  };
}

function resolveSiteUrl(site, localOrigin) {
  if (site.urlEnv) {
    const value = process.env[site.urlEnv];
    if (!value) return { skip: `Environment variable ${site.urlEnv} is not configured` };
    return validateUrl(value);
  }
  if (site.url.startsWith("local:")) return { url: `${localOrigin}/${site.url.slice("local:".length)}` };
  return validateUrl(site.url);
}

function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Detection URLs must not contain credentials");
  const local = new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`Detection URL must use HTTPS or localhost HTTP: ${value}`);
  }
  return { url: url.href };
}

function validateDefinitions(configuration) {
  if (configuration.schemaVersion !== 1 || !Array.isArray(configuration.sites) || configuration.sites.length < 30) {
    throw new Error("Detection site configuration must contain schemaVersion 1 and at least 30 sites");
  }
  const ids = configuration.sites.map((site) => site.id);
  if (new Set(ids).size !== ids.length) throw new Error("Detection site IDs must be unique");
  for (const site of configuration.sites) {
    if (!/^[a-z0-9-]+$/.test(site.id) || !site.name || !site.category || !site.adapter) {
      throw new Error(`Invalid detection site definition: ${site.id ?? "unknown"}`);
    }
    if (site.grading && (!Number.isFinite(site.weight) || site.weight <= 0)) {
      throw new Error(`Graded site requires a positive weight: ${site.id}`);
    }
  }
}

async function collectCommonSignals(page) {
  return page.evaluate(async () => {
    const pluginNames = Array.from(navigator.plugins, (plugin) => plugin.name);
    const mimeTypeNames = Array.from(navigator.mimeTypes, (mime) => mime.type);
    const windowKeys = Object.keys(window);
    const cdpGlobals = windowKeys.filter((key) =>
      key.startsWith("cdc_") || key.startsWith("__webdriver") || key.startsWith("__playwright") || key.startsWith("__pw_"));
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 80;
    const context = canvas.getContext("2d");
    context.textBaseline = "top";
    context.font = "18px Arial";
    context.fillStyle = "#f05a47";
    context.fillRect(5, 5, 120, 50);
    context.fillStyle = "#5577ff";
    context.fillText("SlyBrowser Ω😀", 10, 20);
    const canvasBytes = new TextEncoder().encode(canvas.toDataURL());
    const canvasHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", canvasBytes)))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const glCanvas = document.createElement("canvas");
    const gl = glCanvas.getContext("webgl");
    let webgl = null;
    if (gl) {
      const extension = gl.getExtension("WEBGL_debug_renderer_info");
      webgl = {
        vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
      };
    }
    let highEntropyValues = null;
    try {
      highEntropyValues = await navigator.userAgentData?.getHighEntropyValues([
        "architecture", "bitness", "fullVersionList", "model", "platformVersion", "wow64",
      ]);
    } catch { /* evidence remains null */ }
    return {
      webdriver: navigator.webdriver ?? null,
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      platform: navigator.platform,
      vendor: navigator.vendor,
      languages: Array.from(navigator.languages),
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory ?? null,
      pluginsLength: navigator.plugins.length,
      pluginNames,
      mimeTypesLength: navigator.mimeTypes.length,
      mimeTypeNames,
      windowChromeType: typeof window.chrome,
      chromeKeys: typeof window.chrome === "object" ? Object.keys(window.chrome) : [],
      cdpGlobals,
      outerSize: { width: outerWidth, height: outerHeight },
      innerSize: { width: innerWidth, height: innerHeight },
      screen: {
        width: screen.width, height: screen.height, availWidth: screen.availWidth,
        availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      userAgentData: navigator.userAgentData ? {
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform,
        highEntropyValues,
      } : null,
      canvasHash,
      webgl,
    };
  });
}

async function evaluateContexts(page) {
  return page.evaluate(async () => {
    const fields = ["userAgent", "appVersion", "platform", "language", "hardwareConcurrency", "deviceMemory"];
    const select = (source) => Object.fromEntries(fields.map((field) => [field, source[field] ?? null]));
    const main = select(navigator);
    const frame = document.createElement("iframe");
    frame.srcdoc = "<!doctype html><title>frame</title>";
    document.body.append(frame);
    await new Promise((accept) => frame.addEventListener("load", accept, { once: true }));
    const iframe = select(frame.contentWindow.navigator);
    frame.remove();
    const worker = await new Promise((accept, reject) => {
      const source = `onmessage=()=>postMessage({${fields.map((field) => `${JSON.stringify(field)}:navigator[${JSON.stringify(field)}]??null`).join(",")}})`;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const instance = new Worker(url);
      const timer = setTimeout(() => reject(new Error("worker timeout")), 5000);
      instance.onmessage = (event) => { clearTimeout(timer); instance.terminate(); URL.revokeObjectURL(url); accept(event.data); };
      instance.onerror = (event) => { clearTimeout(timer); instance.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message)); };
      instance.postMessage(null);
    });
    const comparisons = Object.fromEntries(fields.map((field) => [field, {
      iframe: main[field] === iframe[field],
      worker: main[field] === worker[field],
    }]));
    return { main, iframe, worker, comparisons };
  });
}

async function evaluateAdapter(site, page, common, bodyText) {
  if (site.adapter === "core") {
    const checks = {
      navigatorWebdriver: common.webdriver === false,
      plugins: common.pluginsLength >= 5,
      windowChrome: common.windowChromeType === "object",
      userAgent: common.userAgent.includes("Chrome/") && !common.userAgent.includes("HeadlessChrome"),
      cdpGlobals: common.cdpGlobals.length === 0,
    };
    const passed = Object.values(checks).filter(Boolean).length;
    const score = passed / Object.keys(checks).length * 100;
    return { status: score === 100 ? "PASS" : "FAIL", score, metrics: { checks, common } };
  }
  if (site.adapter === "contexts") {
    const contexts = await evaluateContexts(page);
    const checks = Object.values(contexts.comparisons).flatMap((value) => [value.iframe, value.worker]);
    const score = checks.filter(Boolean).length / checks.length * 100;
    return { status: score === 100 ? "PASS" : "FAIL", score, metrics: contexts };
  }
  if (site.adapter === "render-stability") {
    const hashes = [common.canvasHash, ...(await Promise.all([collectCommonSignals(page), collectCommonSignals(page)])).map((item) => item.canvasHash)];
    const stable = new Set(hashes).size === 1;
    return { status: stable ? "PASS" : "FAIL", score: stable ? 100 : 0, metrics: { canvasHashes: hashes, webgl: common.webgl } };
  }
  if (site.adapter === "sannysoft") {
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll("table tr")).map((row) => {
      const cells = row.querySelectorAll("td");
      return cells.length >= 2 ? { name: cells[0].textContent.trim(), className: cells[1].className } : null;
    }).filter(Boolean));
    const failed = rows.filter((row) => row.className.includes("failed")).map((row) => row.name);
    const score = rows.length ? (rows.length - failed.length) / rows.length * 100 : 0;
    return { status: rows.length && !failed.length ? "PASS" : "FAIL", score, metrics: { total: rows.length, failed } };
  }
  if (site.adapter === "incolumitas") {
    const passed = [...bodyText.matchAll(/"([^"\r\n]+)"\s*:\s*"OK"/g)].map((match) => match[1]);
    const failed = [...bodyText.matchAll(/"([^"\r\n]+)"\s*:\s*"FAIL"/g)].map((match) => match[1]);
    const behavioral = Number(bodyText.match(/behavioralClassificationScore[^0-9]+([01](?:\.\d+)?)/i)?.[1] ?? NaN);
    const total = passed.length + failed.length;
    const score = total ? passed.length / total * 100 : 0;
    return { status: total && !failed.length ? "PASS" : "FAIL", score, metrics: { passed, failed, behavioralScore: Number.isFinite(behavioral) ? behavioral : null } };
  }
  if (site.adapter === "browserscan") {
    const normal = (bodyText.match(/\bNormal\b/gi) ?? []).length;
    const abnormal = (bodyText.match(/\bAbnormal\b/gi) ?? []).length;
    const total = normal + abnormal;
    const score = total ? normal / total * 100 : 0;
    return { status: total && !abnormal ? "PASS" : "FAIL", score, metrics: { normal, abnormal } };
  }
  if (site.adapter === "device-info") {
    return parseDeviceInfo(bodyText);
  }
  if (site.adapter === "device-interactions") {
    return parseDeviceInteractions(bodyText);
  }
  if (site.adapter === "fingerprint-demo") {
    try {
      const search = page.getByRole("button", { name: /search/i }).first();
      if (await search.isVisible({ timeout: 1000 })) await search.click({ timeout: 3000 });
      await page.waitForTimeout(4000);
      bodyText = await page.locator("body").innerText();
    } catch { /* evidence below is still useful */ }
    const blocked = /request was blocked|bot visit detected|access denied/i.test(bodyText);
    const content = /price per adult|\$\s*\d+/i.test(bodyText);
    return { status: !blocked && content ? "PASS" : "FAIL", score: !blocked && content ? 100 : 0, metrics: { blocked, content } };
  }
  if (site.adapter === "recaptcha-v3") {
    const score = Number(bodyText.match(/"score"\s*:\s*([01](?:\.\d+)?)/i)?.[1] ?? NaN);
    const threshold = site.threshold ?? 0.7;
    return {
      status: Number.isFinite(score) ? (score >= threshold ? "PASS" : "FAIL") : "EVIDENCE",
      score: Number.isFinite(score) ? score * 100 : null,
      metrics: { recaptchaScore: Number.isFinite(score) ? score : null, threshold },
    };
  }
  if (site.adapter === "turnstile") {
    const output = await page.locator("#result").textContent().catch(() => null);
    const token = await page.locator('input[name="cf-turnstile-response"]').inputValue().catch(() => null);
    return { status: "EVIDENCE", score: null, metrics: { functionalSuccess: Boolean(token) || output?.startsWith("passed:"), output, tokenPresent: Boolean(token) } };
  }
  if (site.adapter === "configured-verdict") {
    const passed = (site.passPatterns ?? []).some((pattern) => new RegExp(pattern, "i").test(bodyText));
    const failed = (site.failPatterns ?? []).some((pattern) => new RegExp(pattern, "i").test(bodyText));
    return { status: passed && !failed ? "PASS" : "FAIL", score: passed && !failed ? 100 : 0, metrics: { passedPattern: passed, failedPattern: failed } };
  }
  if (site.adapter === "tls-json" || site.adapter === "json") {
    let document = null;
    try { document = JSON.parse(bodyText); } catch { /* captured as evidence */ }
    if (site.adapter === "tls-json") {
      const fingerprints = document ? {
        ja3: document.tls?.ja3_hash ?? document.tls?.ja3 ?? null,
        ja4: document.tls?.ja4 ?? null,
        peetprint: document.tls?.peetprint_hash ?? document.tls?.peetprint ?? null,
        akamai: document.http2?.akamai_fingerprint_hash ?? document.http2?.akamai_fingerprint ?? null,
      } : null;
      return { status: "EVIDENCE", score: null, metrics: { fingerprints, response: document } };
    }
    return { status: "EVIDENCE", score: null, metrics: { response: document } };
  }
  return { status: "EVIDENCE", score: null, metrics: { common } };
}

async function exercisePage(page) {
  try {
    await page.mouse.move(120, 120, { steps: 8 });
    await page.mouse.move(420, 260, { steps: 12 });
    await page.mouse.wheel(0, 240);
  } catch { /* not all response types accept interaction */ }
}

async function performDeviceInteractionTest(page) {
  await page.locator('input[type="email"]').fill("benchmark@example.test", { timeout: 10_000 });
  await page.waitForTimeout(450);
  await page.locator('input[type="password"]').fill("SlyBenchmark-2026!", { timeout: 10_000 });
  await page.waitForTimeout(650);
  await page.getByRole("button", { name: /^login$/i }).click({ timeout: 10_000 });
}

async function runSite(context, site, url, directory, navigationTimeout) {
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => {
    if (consoleMessages.length < 100) consoleMessages.push({ type: message.type(), text: message.text().slice(0, 1000) });
  });
  page.on("pageerror", (error) => { if (pageErrors.length < 100) pageErrors.push(String(error).slice(0, 2000)); });
  page.on("requestfailed", (request) => {
    if (requestFailures.length < 100) requestFailures.push({ url: request.url().slice(0, 2000), error: request.failure()?.errorText ?? null });
  });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeout });
    if (site.adapter === "device-interactions") await performDeviceInteractionTest(page);
    else await exercisePage(page);
    await page.waitForTimeout(site.waitMs ?? 3000);
    const common = await collectCommonSignals(page);
    const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 500_000);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      writeFile(join(directory, "body.txt"), bodyText, "utf8"),
      writeFile(join(directory, "common-signals.json"), JSON.stringify(common, null, 2), "utf8"),
      page.screenshot({ path: join(directory, "screenshot.png"), fullPage: true }).catch(() => undefined),
    ]);
    const verdict = await evaluateAdapter(site, page, common, bodyText);
    return {
      siteId: site.id,
      name: site.name,
      category: site.category,
      url,
      status: verdict.status,
      score: verdict.score,
      metrics: verdict.metrics,
      httpStatus: response?.status() ?? null,
      finalUrl: page.url(),
      startedAt,
      durationMs: Math.round(performance.now() - started),
      evidenceDirectory: directory,
      diagnostics: { consoleMessages, pageErrors, requestFailures },
    };
  } catch (error) {
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, "error.png"), fullPage: true }).catch(() => undefined);
    return {
      siteId: site.id,
      name: site.name,
      category: site.category,
      url,
      status: "ERROR",
      score: null,
      error: { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 4000) },
      startedAt,
      durationMs: Math.round(performance.now() - started),
      evidenceDirectory: directory,
      diagnostics: { consoleMessages, pageErrors, requestFailures },
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function runBrowser(target, sites, options, localOrigin, siteDefinitionHash) {
  const missing = new Set();
  const browserTarget = expandEnvironment(target, missing);
  if (missing.size) {
    console.warn(`[SKIP] ${target.name}: missing ${[...missing].join(", ")}`);
    return null;
  }
  const executable = resolve(browserTarget.executable);
  const executableInfo = await stat(executable);
  if (!executableInfo.isFile()) throw new Error(`Browser executable is missing: ${executable}`);
  const runDirectory = join(options.output, browserTarget.id);
  await mkdir(runDirectory, { recursive: true });
  console.log(`[BROWSER] ${browserTarget.name}: ${executable}`);
  const headless = options.headed ? false : browserTarget.headless !== false;
  const targetArgs = (browserTarget.args ?? []).filter(
    (argument) => typeof argument === "string" && argument.length > 0,
  );
  let browser;
  let effectiveLaunchArgs = targetArgs;
  let contextOptions = {
    locale: browserTarget.locale ?? "en-US",
    timezoneId: browserTarget.timezone ?? "UTC",
    viewport: browserTarget.viewport ?? { width: 1365, height: 768 },
    ignoreHTTPSErrors: false,
  };
  let automationProvider = "playwright-core";
  let humanize = null;
  let productFeatures = null;
  if (browserTarget.provider === "cloakbrowser-wrapper") {
    if (!browserTarget.wrapperModule) {
      throw new Error(`${browserTarget.name} requires wrapperModule for provider cloakbrowser-wrapper`);
    }
    const wrapperPath = resolve(browserTarget.wrapperModule);
    if (!(await stat(wrapperPath)).isFile()) {
      throw new Error(`CloakBrowser wrapper module is missing: ${wrapperPath}`);
    }
    const cloak = await import(pathToFileURL(wrapperPath).href);
    const cloakOptions = {
      headless,
      stealthArgs: browserTarget.stealthArgs !== false,
      geoip: browserTarget.geoip === true,
      humanize: browserTarget.humanize === true,
      humanPreset: browserTarget.humanPreset ?? "default",
      humanConfig: browserTarget.humanConfig,
      timezone: browserTarget.timezone,
      locale: browserTarget.locale,
      proxy: browserTarget.proxy,
      args: targetArgs,
      browserVersion: browserTarget.browserVersion,
      releaseChannel: browserTarget.releaseChannel,
      launchOptions: { executablePath: executable },
    };
    const launchOptions = await cloak.buildLaunchOptions(cloakOptions);
    effectiveLaunchArgs = launchOptions.args ?? [];
    browser = await chromium.launch(launchOptions);
    await cloak.humanizeBrowser(browser, cloakOptions);
    contextOptions = {
      viewport: browserTarget.viewport ?? (headless ? { width: 1920, height: 947 } : null),
      ignoreHTTPSErrors: false,
    };
    automationProvider = "cloakbrowser-wrapper/playwright-core";
    humanize = cloakOptions.humanize ? {
      enabled: true,
      preset: cloakOptions.humanPreset,
      config: cloakOptions.humanConfig ?? null,
    } : { enabled: false };
    productFeatures = {
      stealthArgs: cloakOptions.stealthArgs,
      geoip: cloakOptions.geoip,
      locale: cloakOptions.locale ?? null,
      timezone: cloakOptions.timezone ?? null,
      proxyConfigured: Boolean(cloakOptions.proxy),
    };
  } else {
    browser = await chromium.launch({
      executablePath: executable,
      headless,
      args: effectiveLaunchArgs,
      proxy: browserTarget.proxy,
    });
  }
  const startedAt = new Date().toISOString();
  try {
    const context = await browser.newContext(contextOptions);
    const results = [];
    for (const site of sites) {
      const resolution = resolveSiteUrl(site, localOrigin);
      if (resolution.skip) {
        results.push({
          siteId: site.id, name: site.name, category: site.category,
          status: "SKIP", score: null, reason: resolution.skip,
        });
        continue;
      }
      console.log(`  [SITE] ${site.id}`);
      const result = await runSite(
        context,
        site,
        resolution.url,
        join(runDirectory, site.id),
        options.navigationTimeout,
      );
      results.push(result);
      await writeFile(join(runDirectory, site.id, "result.json"), JSON.stringify(result, null, 2), "utf8");
      console.log(`    ${result.status}${typeof result.score === "number" ? ` ${result.score.toFixed(1)}` : ""}`);
    }
    await context.close();
    const metadata = {
      id: browserTarget.id,
      name: browserTarget.name,
      browserVersion: browser.version(),
      executable,
      executableSize: executableInfo.size,
      executableSha256: await sha256File(executable),
      headless,
      launchArgs: effectiveLaunchArgs.map((argument) => argument.replace(/(--sly-license-file=).+/, "$1<redacted>")),
      automationProvider,
      humanize,
      productFeatures,
    };
    const run = {
      schemaVersion: 1,
      runnerVersion: "1.0.0",
      startedAt,
      completedAt: new Date().toISOString(),
      browser: metadata,
      environment: { platform: platform(), arch: arch(), node: process.version },
      methodology: {
        playwrightCore: "1.62.1",
        automationProvider,
        humanize,
        productFeatures,
        siteDefinitionSha256: siteDefinitionHash,
        contextReuse: "one isolated context per browser; one fresh page per site",
        interactionScript: "deterministic-v1",
      },
      results,
      summary: summarizeResults(results, sites),
    };
    await writeFile(join(options.output, `${browserTarget.id}.json`), JSON.stringify(run, null, 2), "utf8");
    return run;
  } finally {
    await browser.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [browserConfiguration, siteConfiguration] = await Promise.all([
    readFile(options.browsers, "utf8").then(JSON.parse),
    readFile(options.sites, "utf8").then(JSON.parse),
  ]);
  validateDefinitions(siteConfiguration);
  if (browserConfiguration.schemaVersion !== 1 || !Array.isArray(browserConfiguration.browsers)) {
    throw new Error("Browser configuration is invalid");
  }
  const sites = options.only
    ? siteConfiguration.sites.filter((site) => options.only.has(site.id))
    : siteConfiguration.sites;
  if (!sites.length) throw new Error("No detection sites were selected");
  await mkdir(options.output, { recursive: true });
  const server = await startLocalServer();
  const runs = [];
  try {
    for (const target of browserConfiguration.browsers) {
      const run = await runBrowser(target, sites, options, server.origin, sha256Json(siteConfiguration));
      if (run) runs.push(run);
    }
  } finally {
    await server.close();
  }
  if (!runs.length) throw new Error("No configured browser target could be run");
  if (runs.length >= 2) {
    const comparison = compareRuns(runs);
    await Promise.all([
      writeFile(join(options.output, "comparison.md"), renderMarkdown(comparison), "utf8"),
      writeFile(join(options.output, "comparison.json"), JSON.stringify(comparison, null, 2), "utf8"),
    ]);
  }
  console.log(`Results: ${options.output}`);
  if (options.failOnDetection && runs.some((run) => run.results.some((result) => result.status === "FAIL" || result.status === "ERROR"))) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
