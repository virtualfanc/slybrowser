import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  evaluateCoreSignals,
  extractTlsFingerprints,
  parseBrowserScan,
  parseConfiguredVerdict,
  parseDeviceInfo,
  parseDeviceInteractions,
  parseIncolumitas,
  parseRecaptcha,
} from "./webdriver-adapters.mjs";
import { summarizeResults } from "./score.mjs";
import { startNodeSdkDriver } from "./node-sdk-client.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const localPages = resolve(scriptDirectory, "pages");

function delay(milliseconds) {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseArguments(arguments_) {
  const options = {
    browser: null,
    driver: null,
    driverLicenseFile: null,
    browserArgs: [],
    excludeSwitches: [],
    browserId: "slybrowser-webdriver",
    browserName: "SlyBrowser (project WebDriver)",
    sites: resolve(scriptDirectory, "sites.json"),
    output: resolve(scriptDirectory, `../../artifacts/test-results/detection/webdriver-${timestamp()}`),
    only: null,
    headed: false,
    captureBrowserLogs: false,
    failOnDetection: false,
    navigationTimeout: 45_000,
    humanize: false,
    humanPreset: "default",
    humanSeed: 42424,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--browser") options.browser = resolve(arguments_[++index]);
    else if (argument === "--driver") options.driver = resolve(arguments_[++index]);
    else if (argument === "--driver-license-file") options.driverLicenseFile = resolve(arguments_[++index]);
    else if (argument === "--browser-arg") options.browserArgs.push(arguments_[++index]);
    else if (argument === "--exclude-switch") options.excludeSwitches.push(arguments_[++index]);
    else if (argument === "--browser-id") options.browserId = arguments_[++index];
    else if (argument === "--browser-name") options.browserName = arguments_[++index];
    else if (argument === "--sites") options.sites = resolve(arguments_[++index]);
    else if (argument === "--output") options.output = resolve(arguments_[++index]);
    else if (argument === "--only") options.only = new Set(arguments_[++index].split(",").filter(Boolean));
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--capture-browser-logs") options.captureBrowserLogs = true;
    else if (argument === "--fail-on-detection") options.failOnDetection = true;
    else if (argument === "--navigation-timeout") options.navigationTimeout = Number(arguments_[++index]);
    else if (argument === "--humanize") options.humanize = true;
    else if (argument === "--human-preset") options.humanPreset = arguments_[++index];
    else if (argument === "--human-seed") options.humanSeed = Number(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.browser) throw new Error("--browser is required");
  if (!options.driver) throw new Error("--driver is required");
  if (!/^[a-z0-9-]+$/.test(options.browserId)) throw new Error("--browser-id must use lowercase letters, numbers, and hyphens");
  if (!Number.isFinite(options.navigationTimeout) || options.navigationTimeout < 1_000) {
    throw new Error("--navigation-timeout must be at least 1000 milliseconds");
  }
  if (!["default", "careful"].includes(options.humanPreset)) throw new Error("--human-preset must be default or careful");
  if (!Number.isInteger(options.humanSeed) || options.humanSeed < 0) throw new Error("--human-seed must be a non-negative integer");
  return options;
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

export function redactLaunchArgument(argument) {
  return argument.replace(/^(--[^=]*(?:license|token|secret|password|proxy|config)[^=]*=).+$/i, "$1<redacted>");
}

function majorVersion(value) {
  const match = String(value ?? "").match(/^\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

export function validateDriverCompatibility(capabilities) {
  const browserVersion = capabilities.browserVersion ?? null;
  const driverVersion = capabilities.chrome?.chromedriverVersion?.split(/\s+/)[0] ?? null;
  const browserMajor = majorVersion(browserVersion);
  const driverMajor = majorVersion(driverVersion);
  if (browserMajor === null) throw new Error("WebDriver did not report a browser version");
  if (driverMajor === null) throw new Error("WebDriver did not report its ChromeDriver version");
  if (browserMajor !== driverMajor) {
    throw new Error(`Browser ${browserVersion} and ChromeDriver ${driverVersion} have different major versions`);
  }
  return { browserVersion, driverVersion, browserMajor };
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
    async close() {
      await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
    },
  };
}

function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("Detection URLs must not contain credentials");
  const sensitive = [...url.searchParams.keys()].filter((name) => /secret|token|password|authorization|api[-_]?key/i.test(name));
  if (sensitive.length) throw new Error(`Detection URL contains sensitive query parameters: ${sensitive.join(", ")}`);
  const local = new Set(["127.0.0.1", "localhost", "[::1]"]).has(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`Detection URL must use HTTPS or localhost HTTP: ${value}`);
  }
  return { url: url.href };
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

function validateSites(configuration) {
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

async function collectCommonSignals(client) {
  const result = await client.executeAsync(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const pluginNames = Array.from(navigator.plugins, plugin => plugin.name);
      const mimeTypeNames = Array.from(navigator.mimeTypes, mime => mime.type);
      const windowKeys = Object.keys(window);
      const cdpGlobals = windowKeys.filter(key =>
        key.startsWith('cdc_') || key.startsWith('__webdriver') || key.startsWith('__playwright') || key.startsWith('__pw_'));
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 80;
      const context = canvas.getContext('2d');
      context.textBaseline = 'top';
      context.font = '18px Arial';
      context.fillStyle = '#f05a47';
      context.fillRect(5, 5, 120, 50);
      context.fillStyle = '#5577ff';
      context.fillText('SlyBrowser test', 10, 20);
      const bytes = new TextEncoder().encode(canvas.toDataURL());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const canvasHash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
      const glCanvas = document.createElement('canvas');
      const gl = glCanvas.getContext('webgl');
      let webgl = null;
      if (gl) {
        const extension = gl.getExtension('WEBGL_debug_renderer_info');
        webgl = {
          vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          version: gl.getParameter(gl.VERSION),
        };
      }
      let highEntropyValues = null;
      try {
        highEntropyValues = await navigator.userAgentData?.getHighEntropyValues([
          'architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion', 'wow64',
        ]);
      } catch {}
      done({
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
        chromeKeys: typeof window.chrome === 'object' ? Object.keys(window.chrome) : [],
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
      });
    })().catch(error => done({ __harnessError: String(error && (error.stack || error.message) || error) }));
  `);
  if (result?.__harnessError) throw new Error(`Common-signal collection failed: ${result.__harnessError}`);
  return result;
}

async function evaluateContexts(client) {
  const result = await client.executeAsync(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const fields = ['userAgent', 'appVersion', 'platform', 'language', 'hardwareConcurrency', 'deviceMemory'];
      const select = source => Object.fromEntries(fields.map(field => [field, source[field] ?? null]));
      const main = select(navigator);
      const frame = document.createElement('iframe');
      frame.srcdoc = '<!doctype html><title>frame</title>';
      document.body.append(frame);
      await new Promise(accept => frame.addEventListener('load', accept, { once: true }));
      const iframe = select(frame.contentWindow.navigator);
      frame.remove();
      const worker = await new Promise((accept, reject) => {
        const source = 'onmessage=()=>postMessage({' + fields.map(field => JSON.stringify(field) + ':navigator[' + JSON.stringify(field) + ']??null').join(',') + '})';
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const instance = new Worker(url);
        const timer = setTimeout(() => reject(new Error('worker timeout')), 5000);
        instance.onmessage = event => {
          clearTimeout(timer); instance.terminate(); URL.revokeObjectURL(url); accept(event.data);
        };
        instance.onerror = event => {
          clearTimeout(timer); instance.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message));
        };
        instance.postMessage(null);
      });
      const comparisons = Object.fromEntries(fields.map(field => [field, {
        iframe: main[field] === iframe[field],
        worker: main[field] === worker[field],
      }]));
      done({ main, iframe, worker, comparisons });
    })().catch(error => done({ __harnessError: String(error && (error.stack || error.message) || error) }));
  `);
  if (result?.__harnessError) throw new Error(`Context collection failed: ${result.__harnessError}`);
  const primary = await client.currentWindowHandle();
  let secondary = null;
  try {
    await client.execute("window.open('about:blank', '_blank'); return true;");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const handles = await client.windowHandles();
      secondary = handles.find((handle) => handle !== primary) ?? null;
      if (secondary) break;
      await delay(50);
    }
    if (!secondary) throw new Error("new tab did not create a WebDriver window handle");
    await client.switchToWindow(secondary);
    result.newTab = await client.execute(`
      const fields = ['userAgent', 'appVersion', 'platform', 'language', 'hardwareConcurrency', 'deviceMemory'];
      return Object.fromEntries(fields.map(field => [field, navigator[field] ?? null]));
    `);
    for (const [field, comparison] of Object.entries(result.comparisons)) {
      comparison.newTab = result.main[field] === result.newTab[field];
    }
  } finally {
    if (secondary) await client.closeWindow().catch(() => undefined);
    await client.switchToWindow(primary).catch(() => undefined);
  }
  return result;
}

async function bodyText(client) {
  return String(await client.execute("return document.body ? document.body.innerText : ''")).slice(0, 500_000);
}

async function performDeviceInteractionTest(client) {
  const email = await client.findElement("css selector", 'input[type="email"]');
  if (client.humanizeEnabled) await client.humanType(email, "benchmark@example.test");
  else await client.sendKeys(email, "benchmark@example.test");
  await delay(450);
  const password = await client.findElement("css selector", 'input[type="password"]');
  if (client.humanizeEnabled) await client.humanType(password, "SlyBenchmark-2026!");
  else await client.sendKeys(password, "SlyBenchmark-2026!");
  await delay(650);
  if (client.humanizeEnabled) {
    const submit = await client.findVisibleElement("css selector", 'button, input[type="submit"]', "login");
    await client.humanClick(submit);
  } else {
    await client.pressKey("\uE007");
  }
}

async function evaluateAdapter(site, client, common, initialBodyText) {
  let text = initialBodyText;
  if (site.adapter === "core") return { verdict: evaluateCoreSignals(common), bodyText: text };
  if (site.adapter === "contexts") {
    const contexts = await evaluateContexts(client);
    const checks = Object.values(contexts.comparisons).flatMap((value) => Object.values(value));
    const score = checks.filter(Boolean).length / checks.length * 100;
    return { verdict: { status: score === 100 ? "PASS" : "FAIL", score, metrics: contexts }, bodyText: text };
  }
  if (site.adapter === "render-stability") {
    const hashes = [common.canvasHash];
    hashes.push((await collectCommonSignals(client)).canvasHash, (await collectCommonSignals(client)).canvasHash);
    const stable = new Set(hashes).size === 1;
    return {
      verdict: { status: stable ? "PASS" : "FAIL", score: stable ? 100 : 0, metrics: { canvasHashes: hashes, webgl: common.webgl } },
      bodyText: text,
    };
  }
  if (site.adapter === "sannysoft") {
    const rows = await client.execute(`
      return Array.from(document.querySelectorAll('table tr')).map(row => {
        const cells = row.querySelectorAll('td');
        return cells.length >= 2 ? { name: cells[0].textContent.trim(), className: cells[1].className } : null;
      }).filter(Boolean);
    `);
    const failed = rows.filter((row) => row.className.includes("failed")).map((row) => row.name);
    const score = rows.length ? (rows.length - failed.length) / rows.length * 100 : 0;
    return { verdict: { status: rows.length && !failed.length ? "PASS" : "FAIL", score, metrics: { total: rows.length, failed } }, bodyText: text };
  }
  if (site.adapter === "incolumitas") return { verdict: parseIncolumitas(text), bodyText: text };
  if (site.adapter === "browserscan") return { verdict: parseBrowserScan(text), bodyText: text };
  if (site.adapter === "device-info") return { verdict: parseDeviceInfo(text), bodyText: text };
  if (site.adapter === "device-interactions") return { verdict: parseDeviceInteractions(text), bodyText: text };
  if (site.adapter === "fingerprint-demo") {
    try {
      const element = await client.findElement("xpath", "//button[contains(normalize-space(.), 'Search')]");
      await client.click(element);
      await delay(4000);
      text = await bodyText(client);
    } catch { /* page content remains evidence */ }
    const blocked = /request was blocked|bot visit detected|access denied|you have been blocked|error loading flights/i.test(text);
    const content = /price per adult|flight results|\$\s*\d+/i.test(text);
    if (blocked) return { verdict: { status: "FAIL", score: 0, metrics: { blocked, content, conclusive: true } }, bodyText: text };
    if (content) return { verdict: { status: "PASS", score: 100, metrics: { blocked, content, conclusive: true } }, bodyText: text };
    return {
      verdict: { status: "EVIDENCE", score: null, metrics: { blocked, content, conclusive: false, reason: "No result or explicit block message rendered" } },
      bodyText: text,
    };
  }
  if (site.adapter === "recaptcha-v3") {
    const expectedAction = site.actionEnv ? process.env[site.actionEnv] ?? null : null;
    return { verdict: parseRecaptcha(text, site.threshold ?? 0.7, expectedAction), bodyText: text };
  }
  if (site.adapter === "configured-verdict") {
    return { verdict: parseConfiguredVerdict(text, site.passPatterns ?? [], site.failPatterns ?? []), bodyText: text };
  }
  if (site.adapter === "turnstile") {
    const metrics = await client.execute(`
      const token = document.querySelector('input[name="cf-turnstile-response"]')?.value || '';
      const output = document.querySelector('#result')?.textContent || null;
      return { functionalSuccess: Boolean(token) || Boolean(output && output.startsWith('passed:')), output, tokenPresent: Boolean(token) };
    `);
    return { verdict: { status: "EVIDENCE", score: null, metrics }, bodyText: await bodyText(client) };
  }
  if (site.adapter === "tls-json" || site.adapter === "json") {
    let document = null;
    try { document = JSON.parse(text); } catch { /* response remains evidence */ }
    if (site.adapter === "tls-json") {
      return {
        verdict: { status: "EVIDENCE", score: null, metrics: { fingerprints: extractTlsFingerprints(document), response: document } },
        bodyText: text,
      };
    }
    return { verdict: { status: "EVIDENCE", score: null, metrics: { response: document } }, bodyText: text };
  }
  return { verdict: { status: "EVIDENCE", score: null, metrics: { common } }, bodyText: text };
}

async function runSite(client, site, url, directory, captureBrowserLogs) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    await client.navigate(url);
    if (site.adapter === "device-interactions") await performDeviceInteractionTest(client);
    else await client.performBasicInteraction();
    await delay(site.waitMs ?? 3000);
    const common = await collectCommonSignals(client);
    const initialBodyText = await bodyText(client);
    const { verdict, bodyText: finalBodyText } = await evaluateAdapter(site, client, common, initialBodyText);
    const browserLogs = captureBrowserLogs ? await client.browserLogs().catch(() => []) : [];
    await mkdir(directory, { recursive: true });
    const screenshot = await client.screenshot().catch(() => null);
    await Promise.all([
      writeFile(join(directory, "body.txt"), finalBodyText, "utf8"),
      writeFile(join(directory, "common-signals.json"), JSON.stringify(common, null, 2), "utf8"),
      screenshot ? writeFile(join(directory, "screenshot.png"), Buffer.from(screenshot, "base64")) : Promise.resolve(),
    ]);
    return {
      siteId: site.id,
      name: site.name,
      category: site.category,
      url,
      status: verdict.status,
      score: verdict.score,
      metrics: verdict.metrics,
      httpStatus: null,
      finalUrl: await client.currentUrl().catch(() => null),
      startedAt,
      durationMs: Math.round(performance.now() - started),
      evidenceDirectory: directory,
      diagnostics: { transport: "W3C WebDriver via project-supplied ChromeDriver", browserLogs },
    };
  } catch (error) {
    await mkdir(directory, { recursive: true });
    const screenshot = await client.screenshot().catch(() => null);
    if (screenshot) await writeFile(join(directory, "error.png"), Buffer.from(screenshot, "base64"));
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
      diagnostics: {
        transport: "W3C WebDriver via project-supplied ChromeDriver",
        browserLogs: captureBrowserLogs ? await client.browserLogs().catch(() => []) : [],
      },
    };
  }
}

function displayResult(result) {
  if ((result.status === "PASS" || result.status === "FAIL") && Number.isFinite(result.score)) {
    return `${result.status} ${result.score.toFixed(1)}`;
  }
  return result.status;
}

function renderRunMarkdown(run) {
  const lines = [
    `# ${run.browser.name} detection benchmark`,
    "",
    `- Adjusted score: **${run.summary.score.toFixed(2)} / 100**`,
    `- Raw measured score: **${run.summary.rawScore.toFixed(2)} / 100**`,
    `- Required coverage: **${run.summary.coverage.toFixed(2)}%** (${run.summary.qualification})`,
    `- Browser: ${run.browser.browserVersion}`,
    `- WebDriver: ${run.browser.driverVersion}`,
    `- Started: ${run.startedAt}`,
    "",
    "| Test | Result | Notes |",
    "| --- | ---: | --- |",
  ];
  for (const result of run.results) {
    let notes = result.reason ?? result.error?.message ?? "";
    if (result.siteId === "local-core-signals" && result.metrics?.checks) {
      const passed = Object.values(result.metrics.checks).filter(Boolean).length;
      notes = `${passed}/${Object.keys(result.metrics.checks).length} core checks`;
    } else if (result.siteId === "incolumitas" && result.metrics) {
      notes = `${result.metrics.failed?.length ?? 0} failed checks`;
    } else if (result.siteId === "browserscan" && result.metrics) {
      notes = `${result.metrics.normal ?? 0}/${result.metrics.expected ?? 4} normal`;
    } else if (result.siteId === "device-browser-info" && result.metrics) {
      notes = `${result.metrics.trueCount ?? 0} true bot flags`;
    } else if (result.siteId === "fingerprint-web-scraping" && result.metrics?.conclusive === false) {
      notes = result.metrics.reason;
    } else if (result.siteId.startsWith("turnstile-") && result.metrics?.functionalSuccess !== undefined) {
      notes = result.metrics.functionalSuccess ? "Official test token generated" : "No test token generated";
    } else if (result.siteId === "tls-peet") {
      notes = "Evidence only; compare with same-major stock Chrome before claiming parity";
    }
    lines.push(`| ${result.name} | ${displayResult(result)} | ${String(notes).replace(/\|/g, "\\|")} |`);
  }
  lines.push(
    "",
    "> Live services can change. ERROR and EVIDENCE do not receive invented zeroes; protected-service tests run only against explicitly configured authorized endpoints.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [browserInfo, driverInfo, siteConfiguration] = await Promise.all([
    stat(options.browser),
    stat(options.driver),
    readFile(options.sites, "utf8").then(JSON.parse),
  ]);
  if (!browserInfo.isFile()) throw new Error(`Browser executable is missing: ${options.browser}`);
  if (!driverInfo.isFile()) throw new Error(`WebDriver executable is missing: ${options.driver}`);
  validateSites(siteConfiguration);
  const sites = options.only ? siteConfiguration.sites.filter((site) => options.only.has(site.id)) : siteConfiguration.sites;
  if (!sites.length) throw new Error("No detection sites were selected");
  await mkdir(options.output, { recursive: true });
  const localServer = await startLocalServer();
  const driverServer = await startNodeSdkDriver(options.driver, {
    licenseFile: options.driverLicenseFile,
    commandTimeout: options.navigationTimeout + 15_000,
  });
  let client;
  const startedAt = new Date().toISOString();
  try {
    const launchArgs = ["--no-first-run", "--no-default-browser-check", ...options.browserArgs];
    client = await driverServer.createSession(options.browser, {
      headless: !options.headed,
      viewport: { width: 1920, height: 947 },
      args: launchArgs,
      excludeSwitches: options.excludeSwitches,
      captureBrowserLogs: options.captureBrowserLogs,
      humanize: {
        enabled: options.humanize,
        preset: options.humanPreset,
        seed: options.humanSeed,
        commandTimeout: options.navigationTimeout + 15_000,
      },
    });
    const versions = validateDriverCompatibility(client.capabilities);
    await client.setTimeouts({ pageLoad: options.navigationTimeout, script: options.navigationTimeout, implicit: 0 });
    await client.setWindowRect(1920, 1080).catch(() => undefined);
    const results = [];
    const evidenceRoot = join(options.output, options.browserId);
    for (const site of sites) {
      const resolution = resolveSiteUrl(site, localServer.origin);
      if (resolution.skip) {
        results.push({ siteId: site.id, name: site.name, category: site.category, status: "SKIP", score: null, reason: resolution.skip });
        console.log(`[SKIP] ${site.id}: ${resolution.skip}`);
        continue;
      }
      console.log(`[SITE] ${site.id}`);
      const result = await runSite(client, site, resolution.url, join(evidenceRoot, site.id), options.captureBrowserLogs);
      results.push(result);
      await writeFile(join(evidenceRoot, site.id, "result.json"), JSON.stringify(result, null, 2), "utf8");
      console.log(`  ${result.status}${Number.isFinite(result.score) ? ` ${result.score.toFixed(1)}` : ""}`);
    }
    const run = {
      schemaVersion: 1,
      runnerVersion: "1.1.0-webdriver",
      startedAt,
      completedAt: new Date().toISOString(),
      browser: {
        id: options.browserId,
        name: options.browserName,
        browserVersion: versions.browserVersion,
        executable: options.browser,
        executableSize: browserInfo.size,
        executableSha256: await sha256File(options.browser),
        headless: !options.headed,
        launchArgs: launchArgs.map(redactLaunchArgument),
        excludedSwitches: options.excludeSwitches,
        driverExecutable: options.driver,
        driverSize: driverInfo.size,
        driverSha256: await sha256File(options.driver),
        driverVersion: versions.driverVersion,
        driverBrowserMajorMatch: true,
      },
      environment: { platform: platform(), arch: arch(), node: process.version },
      methodology: {
        automationProtocol: "W3C WebDriver",
        driver: "public Node SDK with explicit project-supplied ChromeDriver path; no driver manager or download",
        siteDefinitionSha256: sha256Json(siteConfiguration),
        selectedSites: sites.map((site) => site.id),
        contextReuse: "one WebDriver session; sequential navigation per site",
        interactionScript: options.humanize ? `sly-webdriver-native-humanize-${options.humanPreset}-v1` : "webdriver-deterministic-v1",
        humanize: {
          enabled: options.humanize,
          preset: options.humanize ? options.humanPreset : null,
          seed: options.humanize ? options.humanSeed : null,
          input: options.humanize ? "native Sly WebDriver trusted element click and per-character key input; explicit Actions remain caller-controlled" : "deterministic baseline",
        },
        browserLogs: options.captureBrowserLogs ? "enabled by request" : "disabled to avoid changing DevTools command traffic",
      },
      results,
      summary: summarizeResults(results, sites),
    };
    await Promise.all([
      writeFile(join(options.output, `${options.browserId}.json`), JSON.stringify(run, null, 2), "utf8"),
      writeFile(join(options.output, `${options.browserId}.md`), renderRunMarkdown(run), "utf8"),
    ]);
    console.log(`Results: ${options.output}`);
    if (options.failOnDetection && results.some((result) => result.status === "FAIL" || result.status === "ERROR")) {
      process.exitCode = 1;
    }
  } finally {
    await client?.quit().catch(() => undefined);
    await driverServer.close();
    await localServer.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
