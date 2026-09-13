#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { randomUUID, createHash, createPrivateKey } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const webdriverModule = join(repoRoot, "packages", "node", "dist", "webdriver.js");
const { SlyWebDriverService, launch: launchWebDriver } = await import(pathToFileURL(webdriverModule).href);
let ReleaseCatalog;
let createLicenseHttpServer;
let EntitlementService;
let LeaseSigner;
let LicenseStore;

const DEFAULT_TIMEOUT_MS = 45_000;
const marker = "sly-runtime-handoff-ok";

function usage() {
  return [
    "Usage: node tests/release/signed-private-browser-license-only.mjs --browser FILE --driver FILE --license FILE --release-harness-module FILE --private-key-file FILE --key-id ID --output DIR [options]",
    "",
    "Runs the production launch gate for signed private-browser startup. The",
    "legacy filename is kept for CI compatibility; a valid browser session must",
    "now come through native runtime handoff, not a lease-only direct launch.",
    "",
    "Options:",
    "  --release-harness-module FILE",
    "                           Operator-supplied module exporting the release-service test harness.",
    "  --stock FILE             Optional stock Chrome/Chromium executable for pairing-fail test.",
    "  --private-key-file FILE  Ed25519 PKCS#8 PEM test key matching the compiled public key.",
    "  --key-id ID              Runtime lease signing key id compiled into the tested build.",
    "  --browser-version VALUE  Browser version for runtime handoff. Defaults to file version on Windows.",
    "  --timeout-ms VALUE       Per-case timeout. Defaults to 45000.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${value}`);
      return argv[++index];
    };
    if (value === "--browser") parsed.browser = next();
    else if (value === "--driver") parsed.driver = next();
    else if (value === "--license") parsed.license = next();
    else if (value === "--release-harness-module") parsed.releaseHarnessModule = next();
    else if (value === "--private-key-file") parsed.privateKeyFile = next();
    else if (value === "--key-id") parsed.keyId = next();
    else if (value === "--output") parsed.output = next();
    else if (value === "--stock") parsed.stock = next();
    else if (value === "--browser-version") parsed.browserVersion = next();
    else if (value === "--timeout-ms") parsed.timeoutMs = Number(next());
    else if (value === "--help" || value === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  for (const field of ["browser", "driver", "license", "releaseHarnessModule", "privateKeyFile", "keyId", "output"]) {
    if (!parsed[field]) throw new Error(`Missing required --${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 5_000 || parsed.timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be between 5000 and 300000");
  }
  return parsed;
}

async function loadReleaseHarness(modulePath) {
  const absolute = await assertFile(modulePath, "release harness module");
  const module = await import(pathToFileURL(absolute).href);
  const names = ["ReleaseCatalog", "createLicenseHttpServer", "EntitlementService", "LeaseSigner", "LicenseStore"];
  for (const name of names) {
    if (typeof module[name] !== "function") throw new Error(`Release harness module is missing export: ${name}`);
  }
  return module;
}

async function assertFile(path, label) {
  const absolute = resolve(path);
  await access(absolute, constants.R_OK);
  if (!(await stat(absolute)).isFile()) throw new Error(`${label} is not a file: ${absolute}`);
  return absolute;
}

async function protectPrivateFile(path) {
  await chmod(path, 0o600).catch(() => undefined);
  if (process.platform !== "win32") return;
  const { stdout } = await execFileAsync("whoami", [], { windowsHide: true });
  const identity = stdout.trim();
  if (!identity) throw new Error("Unable to determine current Windows identity");
  await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`], { windowsHide: true });
}

async function copyPrivateFile(source, directory, name) {
  const target = join(directory, `${name}-${randomUUID()}.json`);
  await copyFile(source, target);
  await protectPrivateFile(target);
  return target;
}

async function writePrivateJsonFile(directory, name, value) {
  const target = join(directory, `${name}-${randomUUID()}.json`);
  await writeFile(target, JSON.stringify(value), { mode: 0o600 });
  await protectPrivateFile(target);
  return target;
}

async function writePrivateTextFile(directory, name, value) {
  const target = join(directory, `${name}-${randomUUID()}.json`);
  await writeFile(target, value, { mode: 0o600 });
  await protectPrivateFile(target);
  return target;
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

async function readLeaseClaims(licenseFile) {
  const envelope = JSON.parse(await readFile(licenseFile, "utf8"));
  if (!envelope || typeof envelope !== "object" || typeof envelope.payload !== "string") {
    throw new Error("Signed lease envelope does not contain a payload");
  }
  const claims = JSON.parse(base64UrlDecode(envelope.payload).toString("utf8"));
  return { envelope, claims };
}

async function writeTamperedLicense(source, directory) {
  const envelope = JSON.parse(await readFile(source, "utf8"));
  if (typeof envelope.signature !== "string" || envelope.signature.length < 8) {
    throw new Error("Signed lease envelope does not contain a mutable signature");
  }
  const last = envelope.signature.at(-1);
  envelope.signature = `${envelope.signature.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  const target = join(directory, `tampered-license-${randomUUID()}.json`);
  await writeFile(target, JSON.stringify(envelope), { mode: 0o600 });
  await protectPrivateFile(target);
  return target;
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileInfo(path) {
  const info = await stat(path);
  return {
    path,
    sha256: await fileSha256(path),
    size: info.size,
  };
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path, constants.R_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Try the next release-root candidate.
    }
  }
  throw new Error(`None of the expected release files exist: ${paths.join(", ")}`);
}

async function detectWindowsFileVersion(path) {
  if (process.platform !== "win32") return undefined;
  const script = `(Get-Item -LiteralPath ${JSON.stringify(path)}).VersionInfo.ProductVersion`;
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], { windowsHide: true });
  const version = stdout.trim();
  return version || undefined;
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Unable to resolve server listen address"));
        return;
      }
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(() => resolveClose()));
}

function makeCatalog({ browserVersion, archive, browser, driver, module, resource }) {
  const artifactName = `${archive.sha256}.zip`;
  return new ReleaseCatalog([{
    schemaVersion: 1,
    browserVersion,
    sdkCompatibility: ">=0.1.0 <1.0.0",
    status: "available",
    publishedAt: new Date().toISOString(),
    artifacts: [{
      platform: "windows",
      arch: "x64",
      url: `https://api.slybrowser.test/v1/releases/artifacts/${artifactName}`,
      sha256: archive.sha256,
      size: archive.size,
      archiveFormat: "zip",
      browserExecutable: basename(browser.path),
      driverExecutable: basename(driver.path),
      browserSha256: browser.sha256,
      driverSha256: driver.sha256,
      privateModules: [{
        path: basename(module.path),
        sha256: module.sha256,
        size: module.size,
        abi: "windows-x64",
      }],
      resources: [{
        path: basename(resource.path),
        sha256: resource.sha256,
        size: resource.size,
      }],
    }],
    signature: { algorithm: "ed25519", keyId: "local-release-test", value: "test-signature" },
  }]);
}

async function createServiceContext({
  browser,
  driver,
  keyId,
  privateKeyFile,
  browserVersion,
  heartbeatAfterSeconds = 30,
  sessionTtlSeconds = 120,
  accountId = `signed-private-browser-${randomUUID()}`,
}) {
  const releaseRoot = dirname(browser);
  const archivePath = await firstExisting([join(releaseRoot, "chrome.7z"), browser]);
  const modulePath = await firstExisting([join(releaseRoot, "chrome.dll"), browser]);
  const resourcePath = await firstExisting([join(releaseRoot, "resources.pak"), driver]);
  const privateKey = createPrivateKey(await readFile(privateKeyFile));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("--private-key-file must contain an Ed25519 PKCS#8 PEM private key");
  }
  const catalog = makeCatalog({
    browserVersion,
    archive: await fileInfo(archivePath),
    browser: await fileInfo(browser),
    driver: await fileInfo(driver),
    module: await fileInfo(modulePath),
    resource: await fileInfo(resourcePath),
  });
  const store = new LicenseStore(":memory:", Buffer.alloc(32, 10));
  const service = new EntitlementService(store, catalog, new LeaseSigner(keyId, privateKey), {
    now: () => Math.floor(Date.now() / 1000),
    sessionTtlSeconds,
    heartbeatAfterSeconds,
  });
  const authorization = await service.issueAuthorization({
    accountId,
    plan: "basic",
    paidThrough: Math.floor(Date.now() / 1000) + 86_400,
    serviceUrl: "https://api.slybrowser.test",
  });
  return { service, catalog, releaseRoot, authorization, browserVersion };
}

async function createRuntimeGrant(context) {
  return await context.service.createRuntimeSession(context.authorization.licenseKey, {
    platform: "windows",
    arch: "x64",
    channel: "stable",
    sdkVersion: "0.1.0",
    kernelMajor: "latest",
    updateKernel: false,
    startupId: `st_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    automationBackend: "project-webdriver",
    browserVersion: context.browserVersion,
    versionPolicy: "exact",
  });
}

function runtimeHandoff(origin, grant, activationTicket = grant.activationTicket) {
  return {
    schemaVersion: 2,
    serviceUrl: origin,
    state: grant.state,
    startupId: grant.startupId,
    sessionId: grant.sessionId,
    bootstrapToken: grant.bootstrapToken,
    activationTicket,
    heartbeatAfterSeconds: grant.heartbeatAfterSeconds,
    expiresAt: grant.expiresAt,
    plan: grant.plan,
    features: [...grant.features],
    concurrencyLimit: grant.concurrencyLimit,
    activeSessions: grant.activeSessions,
    browserVersion: grant.browserVersion,
    automationBackend: grant.automationBackend ?? "project-webdriver",
  };
}

async function startLicenseServer(context, metrics) {
  const server = createLicenseHttpServer({
    service: context.service,
    catalog: context.catalog,
    artifactRoot: context.releaseRoot,
    rateLimits: false,
    failureBackoff: false,
    metrics: (event) => metrics.push(event),
  });
  const origin = await listen(server);
  return { server, origin };
}

function redactMetrics(metrics) {
  return metrics.map((event) => ({
    operation: event.operation,
    method: event.method,
    status: event.status,
    result: event.result,
    ...(event.plan === undefined ? {} : { plan: event.plan }),
  }));
}

async function waitForMetric(metrics, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (metrics.some(predicate)) return true;
    await new Promise((accept) => setTimeout(accept, 100));
  } while (Date.now() < deadline);
  return false;
}

function dataUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>${marker}</title><main>${marker}</main>`)}`;
}

async function runProcess(executable, args, timeoutMs, options = {}) {
  const startedAt = Date.now();
  const stdout = [];
  const stderr = [];
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let timedOut = false;
  let resolvedByStdout = false;
  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (stdout.join("").length < 16_384) stdout.push(text);
      if (options.resolveOnStdout && stdout.join("").includes(options.resolveOnStdout) && !resolvedByStdout) {
        resolvedByStdout = true;
        child.kill();
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.join("").length < 16_384) stderr.push(String(chunk));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
  return {
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    resolvedByStdout,
    durationMs: Date.now() - startedAt,
    stdout: stdout.join("").slice(-4000),
    stderr: stderr.join("").slice(-4000),
  };
}

function summarizeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code,
    message: String(error?.message ?? error).slice(0, 1000),
  };
}

function passedCase(details = {}) {
  return { passed: true, ...details };
}

function failedCase(details = {}) {
  return { passed: false, ...details };
}

async function directBrowserCase(browser, licenseFile, timeoutMs, resolveOnMarker = false) {
  const profile = await mkdtemp(join(tmpdir(), "sly-license-browser-profile-"));
  try {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${profile}`,
      ...(licenseFile ? [`--sly-license-file=${licenseFile}`] : []),
      "--dump-dom",
      dataUrl(),
    ];
    return await runProcess(browser, args, timeoutMs, resolveOnMarker ? { resolveOnStdout: marker } : {});
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function expectBrowserSuccess(browser, licenseFile, timeoutMs) {
  const result = await directBrowserCase(browser, licenseFile, timeoutMs, true);
  if ((result.exitCode === 0 || result.resolvedByStdout) && !result.timedOut && result.stdout.includes(marker)) {
    return passedCase({
      exitCode: result.exitCode,
      signal: result.signal,
      resolvedByStdout: result.resolvedByStdout,
      durationMs: result.durationMs,
    });
  }
  return failedCase({ expected: "exit 0 and marker in dump-dom", result });
}

async function expectBrowserFailClosed(browser, licenseFile, timeoutMs) {
  const result = await directBrowserCase(browser, licenseFile, timeoutMs);
  if (!result.timedOut && result.exitCode !== 0) {
    return passedCase({ exitCode: result.exitCode, durationMs: result.durationMs });
  }
  return failedCase({ expected: "non-zero exit without a usable browser", result });
}

async function expectDriverStartFailClosed(driver, timeoutMs) {
  try {
    const service = await SlyWebDriverService.start(driver, { startTimeout: Math.min(timeoutMs, 15_000), commandTimeout: timeoutMs });
    await service.close();
    return failedCase({ expected: "WebDriver startup failure without license" });
  } catch (error) {
    return passedCase({ error: summarizeError(error) });
  }
}

async function expectWebDriverSessionSuccess(browser, driver, driverLicense, browserLicense, timeoutMs) {
  let service;
  let session;
  try {
    service = await SlyWebDriverService.start(driver, {
      startTimeout: Math.min(timeoutMs, 20_000),
      commandTimeout: timeoutMs,
      licenseFile: driverLicense,
    });
    session = await service.createSession(
      browser,
      { headless: true, commandTimeout: timeoutMs, args: ["--disable-gpu"] },
      [`--sly-license-file=${browserLicense}`],
    );
    await session.get(dataUrl());
    const webdriver = await session.executeScript("return navigator.webdriver");
    const userAgent = await session.executeScript("return navigator.userAgent");
    if (webdriver !== false) {
      return failedCase({ expected: "navigator.webdriver false", webdriver, userAgent });
    }
    return passedCase({
      sessionId: session.sessionId,
      browserVersion: session.versions.browserVersion,
      driverVersion: session.versions.driverVersion,
      webdriver,
      userAgent: String(userAgent).slice(0, 160),
    });
  } catch (error) {
    return failedCase({ error: summarizeError(error) });
  } finally {
    await session?.close().catch(() => undefined);
    await service?.close().catch(() => undefined);
  }
}

async function expectWebDriverSessionFailClosed(browser, driver, driverLicense, browserLicense, timeoutMs, expected) {
  let service;
  let session;
  try {
    service = await SlyWebDriverService.start(driver, {
      startTimeout: Math.min(timeoutMs, 20_000),
      commandTimeout: timeoutMs,
      ...(driverLicense ? { licenseFile: driverLicense } : {}),
    });
    session = await service.createSession(
      browser,
      { headless: true, commandTimeout: timeoutMs, args: ["--disable-gpu"] },
      browserLicense ? [`--sly-license-file=${browserLicense}`] : [],
    );
    return failedCase({ expected, sessionId: session.sessionId });
  } catch (error) {
    return passedCase({ error: summarizeError(error) });
  } finally {
    await session?.close().catch(() => undefined);
    await service?.close().catch(() => undefined);
  }
}

async function expectWebDriverMissingBrowserHandoffFailClosed(browser, driver, driverLicense, driverRuntime, timeoutMs) {
  let service;
  let session;
  try {
    service = await SlyWebDriverService.start(driver, {
      startTimeout: Math.min(timeoutMs, 20_000),
      commandTimeout: timeoutMs,
      licenseFile: driverLicense,
      runtimeFile: driverRuntime,
    });
    session = await service.createSession(
      browser,
      { headless: true, commandTimeout: timeoutMs, args: ["--disable-gpu"] },
      [],
    );
    return failedCase({ expected: "browser launch failure without browser lease and runtime handoff", sessionId: session.sessionId });
  } catch (error) {
    return passedCase({ error: summarizeError(error) });
  } finally {
    await session?.close().catch(() => undefined);
    await service?.close().catch(() => undefined);
  }
}

async function expectRuntimeHandoffSuccess(browser, driver, grant, runtimeHandoff, driverRuntimeHandoff, timeoutMs, metrics) {
  let session;
  try {
    session = await launchWebDriver(browser, grant.lease, {
      driverExecutable: driver,
      headless: true,
      commandTimeout: timeoutMs,
      driverStartTimeout: Math.min(timeoutMs, 20_000),
      args: ["--disable-gpu"],
      runtimeHandoff,
      driverRuntimeHandoff,
      allowRuntimeActivationTicket: true,
      nativeReady: true,
      nativeReadyTimeout: Math.min(timeoutMs, 20_000),
    });
    await session.get(dataUrl());
    const webdriver = await session.executeScript("return navigator.webdriver");
    const title = await session.executeScript("return document.title");
    const activateCount = metrics.filter((event) =>
      event.operation === "runtime_session_activate" && event.status === 200).length;
    const webdriverSessionId = session.sessionId;
    const browserVersion = session.versions.browserVersion;
    const driverVersion = session.versions.driverVersion;
    await session.close();
    session = undefined;
    const released = await waitForMetric(metrics, (event) =>
      event.operation === "runtime_session_release" && event.status === 204, 5_000);
    const releaseCount = metrics.filter((event) =>
      event.operation === "runtime_session_release" && event.status === 204).length;
    if (webdriver !== false || title !== marker || activateCount < 2 || !released) {
      return failedCase({
        expected: "runtime handoff session with webdriver false plus native activate/release",
        webdriver,
        title,
        activateCount,
        released,
        releaseCount,
        metrics: redactMetrics(metrics),
      });
    }
    return passedCase({
      sessionId: webdriverSessionId,
      runtimeSessionId: grant.sessionId,
      browserVersion,
      driverVersion,
      runtimeServiceUrl: runtimeHandoff.serviceUrl,
      runtimeState: runtimeHandoff.state,
      activateCount,
      released,
      releaseCount,
      metrics: redactMetrics(metrics),
    });
  } catch (error) {
    return failedCase({ error: summarizeError(error), metrics: redactMetrics(metrics) });
  } finally {
    await session?.close().catch(() => undefined);
  }
}

async function expectRuntimeHandoffFailClosed(browser, driver, grant, runtimeHandoff, driverRuntimeHandoff, timeoutMs, expected) {
  let session;
  try {
    session = await launchWebDriver(browser, grant.lease, {
      driverExecutable: driver,
      headless: true,
      commandTimeout: timeoutMs,
      driverStartTimeout: Math.min(timeoutMs, 20_000),
      args: ["--disable-gpu"],
      runtimeHandoff,
      driverRuntimeHandoff,
      allowRuntimeActivationTicket: true,
    });
    return failedCase({ expected, sessionId: session.sessionId });
  } catch (error) {
    return passedCase({ error: summarizeError(error) });
  } finally {
    await session?.close().catch(() => undefined);
  }
}

async function runCase(cases, id, expectation, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    cases.push({
      id,
      expectation,
      passed: result.passed === true,
      durationMs: Date.now() - startedAt,
      ...result,
    });
  } catch (error) {
    cases.push({
      id,
      expectation,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: summarizeError(error),
    });
  }
}

function markdown(report) {
  const lines = [
    "# Signed private-browser native runtime handoff matrix",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "| Case | Expectation | Result | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.cases) {
    const evidence = item.resolvedByStdout ? "authorized marker observed" :
      item.error?.code || item.error?.message || item.exitCode !== undefined && `exit ${item.exitCode}` ||
      item.browserVersion && `browser ${item.browserVersion}` || "";
    lines.push(`| ${item.id} | ${item.expectation} | ${item.passed ? "PASS" : "FAIL"} | ${String(evidence).replaceAll("|", "\\|")} |`);
  }
  lines.push("");
  lines.push(`Overall: ${report.passed ? "PASS" : "FAIL"}`);
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
({ ReleaseCatalog, createLicenseHttpServer, EntitlementService, LeaseSigner, LicenseStore } =
  await loadReleaseHarness(options.releaseHarnessModule));
const browser = await assertFile(options.browser, "browser");
const driver = await assertFile(options.driver, "driver");
const license = await assertFile(options.license, "license");
const privateKeyFile = await assertFile(options.privateKeyFile, "private key");
let stock;
if (options.stock) {
  try {
    stock = await assertFile(options.stock, "stock browser");
  } catch {
    stock = undefined;
  }
}
await assertFile(webdriverModule, "built Node WebDriver module");
const output = resolve(options.output);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "sly-runtime-handoff-matrix-"));

const leaseText = await readFile(license, "utf8");
const { claims } = await readLeaseClaims(license);
const browserVersion = options.browserVersion || await detectWindowsFileVersion(browser);
if (!browserVersion) throw new Error("Unable to determine browser version. Pass --browser-version.");
const serviceContext = await createServiceContext({
  browser,
  driver,
  keyId: options.keyId,
  privateKeyFile,
  browserVersion,
});
const metrics = [];
const { server: licenseServer, origin } = await startLicenseServer(serviceContext, metrics);
const cases = [];
try {
  const browserLicense = await copyPrivateFile(license, scratch, "browser-license");
  await runCase(cases, "browser-license-only-rejected", "private browser rejects a valid signed lease unless native runtime handoff is present", () =>
    expectBrowserFailClosed(browser, browserLicense, options.timeoutMs));

  await runCase(cases, "browser-missing-license", "browser fails closed when no signed lease is handed off", () =>
    expectBrowserFailClosed(browser, undefined, options.timeoutMs));

  const tamperedLicense = await writeTamperedLicense(license, scratch);
  await runCase(cases, "browser-tampered-license", "browser rejects modified signed lease", () =>
    expectBrowserFailClosed(browser, tamperedLicense, options.timeoutMs));

  await runCase(cases, "webdriver-missing-driver-license", "project WebDriver fails closed without its own signed lease", () =>
    expectDriverStartFailClosed(driver, options.timeoutMs));

  const driverLicense = await copyPrivateFile(license, scratch, "driver-license");
  const sessionBrowserLicense = await copyPrivateFile(license, scratch, "session-browser-license");
  await runCase(cases, "webdriver-license-only-rejected", "project WebDriver and browser reject dual signed leases without native runtime handoff", () =>
    expectWebDriverSessionFailClosed(browser, driver, driverLicense, sessionBrowserLicense, options.timeoutMs, "session creation failure without native runtime handoff"));

  const driverOnlyGrant = await createRuntimeGrant(serviceContext);
  const driverOnlyLicense = await writePrivateTextFile(scratch, "driver-only-license", JSON.stringify(driverOnlyGrant.lease));
  const driverOnlyRuntime = await writePrivateJsonFile(scratch, "driver-only-runtime", runtimeHandoff(origin, driverOnlyGrant, driverOnlyGrant.driverActivationTicket));
  await runCase(cases, "webdriver-missing-browser-handoff", "WebDriver session fails closed if browser lease and runtime handoff are not handed off", () =>
    expectWebDriverMissingBrowserHandoffFailClosed(browser, driver, driverOnlyLicense, driverOnlyRuntime, options.timeoutMs));

  if (stock) {
    const mismatchGrant = await createRuntimeGrant(serviceContext);
    await runCase(cases, "webdriver-rejects-unpaired-browser", "project WebDriver rejects an unpaired system browser", () =>
      expectRuntimeHandoffFailClosed(
        stock,
        driver,
        mismatchGrant,
        runtimeHandoff(origin, mismatchGrant),
        runtimeHandoff(origin, mismatchGrant, mismatchGrant.driverActivationTicket),
        options.timeoutMs,
        "pairing mismatch against stock browser",
      ));
  } else {
    cases.push({
      id: "webdriver-rejects-unpaired-browser",
      expectation: "project WebDriver rejects an unpaired system browser",
      passed: true,
      skipped: true,
      reason: "stock browser executable was not provided or not readable",
      durationMs: 0,
    });
  }

  const successGrant = await createRuntimeGrant(serviceContext);
  await runCase(cases, "native-runtime-handoff", "runtime service URL and bootstrap token are handed off to native browser/WebDriver startup", () =>
    expectRuntimeHandoffSuccess(
      browser,
      driver,
      successGrant,
      runtimeHandoff(origin, successGrant),
      runtimeHandoff(origin, successGrant, successGrant.driverActivationTicket),
      options.timeoutMs,
      metrics,
    ));
} finally {
  await closeServer(licenseServer).catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  matrix: "signed-private-browser-native-runtime-handoff",
  browser: {
    fileName: basename(browser),
    sha256: await fileSha256(browser),
    version: browserVersion,
  },
  driver: {
    fileName: basename(driver),
    sha256: await fileSha256(driver),
  },
  stock: stock ? { fileName: basename(stock), sha256: await fileSha256(stock) } : null,
  lease: {
    keyId: JSON.parse(leaseText).keyId,
    licenseId: claims.licenseId,
    sessionId: claims.sessionId,
    expiresAt: claims.expiresAt,
    features: claims.features,
  },
  runtimeService: {
    origin,
    metrics: redactMetrics(metrics),
  },
  cases,
  passed: cases.every((item) => item.passed === true),
};

await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(output, "report.md"), markdown(report));
console.log(JSON.stringify({ output, passed: report.passed, cases: cases.length }, null, 2));
if (!report.passed) process.exitCode = 1;
