import { constants } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--browser") options.browser = resolve(values[++index]);
    else if (values[index] === "--output") options.output = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  if (!options.browser) throw new Error("--browser is required");
  return options;
}

async function privateConfig(configuration) {
  const path = resolve(tmpdir(), `sly-context-${randomUUID()}.json`);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(JSON.stringify(configuration)); await handle.sync(); }
  finally { await handle.close(); }
  return path;
}

async function probe(page) {
  return page.evaluate(async () => {
    const select = (source) => ({
      userAgent: source.userAgent,
      language: source.language,
      languages: Array.from(source.languages),
      hardwareConcurrency: source.hardwareConcurrency,
      deviceMemory: source.deviceMemory ?? null,
      webdriver: source.webdriver ?? null,
    });
    const top = {
      ...select(navigator),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: { width: screen.width, height: screen.height },
      fontArialDisabled: !document.fonts.check("16px Arial"),
    };
    const iframe = document.createElement("iframe");
    iframe.srcdoc = "<!doctype html><title>frame</title>";
    document.body.append(iframe);
    await new Promise((accept) => iframe.addEventListener("load", accept, { once: true }));
    const frame = {
      ...select(iframe.contentWindow.navigator),
      fontArialDisabled: !iframe.contentDocument.fonts.check("16px Arial"),
    };
    iframe.remove();
    const worker = await new Promise((accept, reject) => {
      const source = `postMessage({
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: Array.from(navigator.languages),
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        webdriver: navigator.webdriver ?? null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        fontArialDisabled: !self.fonts.check("16px Arial")
      })`;
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const instance = new Worker(url);
      const timer = setTimeout(() => reject(new Error("worker timeout")), 5000);
      instance.onmessage = ({ data }) => {
        clearTimeout(timer); instance.terminate(); URL.revokeObjectURL(url); accept(data);
      };
      instance.onerror = (event) => {
        clearTimeout(timer); instance.terminate(); URL.revokeObjectURL(url); reject(new Error(event.message));
      };
    });
    return { top, frame, worker };
  });
}

function coherent(surface) {
  const fields = ["userAgent", "language", "languages", "hardwareConcurrency", "deviceMemory"];
  return fields.every((name) => JSON.stringify(surface.top[name]) === JSON.stringify(surface.frame[name]) &&
    JSON.stringify(surface.top[name]) === JSON.stringify(surface.worker[name])) &&
    surface.top.timezone === surface.worker.timezone &&
    surface.top.webdriver === false && surface.frame.webdriver === false && surface.worker.webdriver === null;
}

async function server() {
  const instance = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>context probe</title><body>probe</body>");
  });
  await new Promise((accept, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", accept);
  });
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Probe server did not bind");
  return { instance, url: `http://127.0.0.1:${address.port}/` };
}

const options = parseArguments(process.argv.slice(2));
if (!(await stat(options.browser)).isFile()) throw new Error(`Browser is missing: ${options.browser}`);
const root = resolve(tmpdir(), `sly-profile-matrix-${randomUUID()}`);
const profileA = join(root, "profile-a");
const profileB = join(root, "profile-b");
await mkdir(root, { recursive: true });
const expected = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  locale: "fr-FR",
  languages: ["fr-FR", "fr"],
  timezone: "Europe/Paris",
  screen: { width: 1600, height: 900 },
  hardwareConcurrency: 12,
  deviceMemory: 8,
};
const configuration = () => ({ profile: {
  userAgent: expected.userAgent,
  locale: expected.locale,
  languages: expected.languages,
  timezone: expected.timezone,
  screen: expected.screen,
  hardwareConcurrency: expected.hardwareConcurrency,
  deviceMemory: expected.deviceMemory,
  disabledFonts: ["Arial"],
  webgl: { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA GeForce RTX 3060 Direct3D11)" },
} });
const probeServer = await server();
const configFiles = [];
async function persistentLaunch(directory) {
  const config = await privateConfig(configuration());
  configFiles.push(config);
  return chromium.launchPersistentContext(directory, {
    executablePath: options.browser,
    headless: true,
    args: [`--sly-config-file=${config}`],
  });
}
let surfaceA;
let surfaceB;
let persistentRestored = false;
let separateProfileIsolated = false;
let ephemeralIsolated = false;
try {
  let context = await persistentLaunch(profileA);
  let page = context.pages()[0] ?? await context.newPage();
  await page.goto(probeServer.url);
  surfaceA = await probe(page);
  await page.evaluate(() => localStorage.setItem("sly-profile-marker", "profile-a"));
  await context.close();

  context = await persistentLaunch(profileA);
  page = context.pages()[0] ?? await context.newPage();
  await page.goto(probeServer.url);
  persistentRestored = await page.evaluate(() => localStorage.getItem("sly-profile-marker")) === "profile-a";
  await context.close();

  context = await persistentLaunch(profileB);
  page = context.pages()[0] ?? await context.newPage();
  await page.goto(probeServer.url);
  separateProfileIsolated = await page.evaluate(() => localStorage.getItem("sly-profile-marker")) === null;
  surfaceB = await probe(page);
  await context.close();

  const ephemeralConfig = await privateConfig(configuration());
  configFiles.push(ephemeralConfig);
  const browser = await chromium.launch({ executablePath: options.browser, headless: true, args: [`--sly-config-file=${ephemeralConfig}`] });
  const first = await browser.newContext();
  page = await first.newPage();
  await page.goto(probeServer.url);
  await page.evaluate(() => localStorage.setItem("sly-ephemeral-marker", "first-context"));
  await first.close();
  const second = await browser.newContext();
  page = await second.newPage();
  await page.goto(probeServer.url);
  ephemeralIsolated = await page.evaluate(() => localStorage.getItem("sly-ephemeral-marker")) === null;
  await second.close();
  await browser.close();

  const expectedValues = surfaceA.top.userAgent === expected.userAgent && surfaceA.top.language === expected.locale &&
    JSON.stringify(surfaceA.top.languages) === JSON.stringify(expected.languages) && surfaceA.top.timezone === expected.timezone &&
    JSON.stringify(surfaceA.top.screen) === JSON.stringify(expected.screen) &&
    surfaceA.top.hardwareConcurrency === expected.hardwareConcurrency && surfaceA.top.deviceMemory === expected.deviceMemory;
  const checks = {
    persistentContextCoherent: coherent(surfaceA),
    separatePersistentContextCoherent: coherent(surfaceB),
    selectedProfileApplied: expectedValues,
    persistentStorageRestored: persistentRestored,
    separateProfileStorageIsolated: separateProfileIsolated,
    ephemeralContextsStorageIsolated: ephemeralIsolated,
    disabledFontConsistent: [surfaceA, surfaceB].every((surface) =>
      surface.top.fontArialDisabled && surface.frame.fontArialDisabled && surface.worker.fontArialDisabled),
  };
  const result = { schemaVersion: 1, status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", expected, checks, profileA: surfaceA, profileB: surfaceB };
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
} finally {
  await new Promise((accept) => probeServer.instance.close(() => accept()));
  await Promise.all(configFiles.map((path) => rm(path, { force: true })));
  await rm(root, { recursive: true, force: true });
}
