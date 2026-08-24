#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serviceRoot = join(repoRoot, "packages", "license-service", "dist");

const { ReleaseCatalog } = await import(pathToFileURL(join(serviceRoot, "catalog.js")).href);
const { createLicenseHttpServer } = await import(pathToFileURL(join(serviceRoot, "server.js")).href);
const { EntitlementService } = await import(pathToFileURL(join(serviceRoot, "service.js")).href);
const { LeaseSigner } = await import(pathToFileURL(join(serviceRoot, "signer.js")).href);
const { LicenseStore } = await import(pathToFileURL(join(serviceRoot, "store.js")).href);
const webdriverModule = join(repoRoot, "packages", "node", "dist", "webdriver.js");
const { launch: launchWebDriver } = await import(pathToFileURL(webdriverModule).href);

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_REVOCATION_TIMEOUT_MS = 70_000;
const DEFAULT_TRANSIENT_EXPIRY_TIMEOUT_MS = 170_000;
const marker = "sly-native-watchdog-ok";

function usage() {
  return [
    "Usage: node tests/release/native-runtime-watchdog-matrix.mjs --browser FILE --driver FILE --private-key-file FILE --key-id ID --output DIR [options]",
    "",
    "Runs a production-like native license matrix against a real localhost",
    "authorization service. The signing private key must match the public key",
    "compiled into the tested browser/WebDriver build.",
    "",
    "Options:",
    "  --browser-version VALUE       Defaults to ProductVersion on Windows.",
    "  --timeout-ms VALUE            Per short case timeout; default 45000.",
    "  --revocation-timeout-ms VALUE Revocation/heartbeat exit timeout; default 70000.",
    "  --include-revocation-exit     Run the longer heartbeat revocation exit case.",
    "  --transient-expiry-timeout-ms VALUE",
    "                                Network/5xx lease-expiry timeout; default 170000.",
    "  --include-transient-expiry    Run the longer 5xx retry-until-expiry case.",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    revocationTimeoutMs: DEFAULT_REVOCATION_TIMEOUT_MS,
    transientExpiryTimeoutMs: DEFAULT_TRANSIENT_EXPIRY_TIMEOUT_MS,
    includeRevocationExit: false,
    includeTransientExpiry: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${value}`);
      return argv[++index];
    };
    if (value === "--browser") parsed.browser = next();
    else if (value === "--driver") parsed.driver = next();
    else if (value === "--private-key-file") parsed.privateKeyFile = next();
    else if (value === "--key-id") parsed.keyId = next();
    else if (value === "--output") parsed.output = next();
    else if (value === "--browser-version") parsed.browserVersion = next();
    else if (value === "--timeout-ms") parsed.timeoutMs = Number(next());
    else if (value === "--revocation-timeout-ms") parsed.revocationTimeoutMs = Number(next());
    else if (value === "--transient-expiry-timeout-ms") parsed.transientExpiryTimeoutMs = Number(next());
    else if (value === "--include-revocation-exit") parsed.includeRevocationExit = true;
    else if (value === "--include-transient-expiry") parsed.includeTransientExpiry = true;
    else if (value === "--help" || value === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  for (const field of ["browser", "driver", "privateKeyFile", "keyId", "output"]) {
    if (!parsed[field]) throw new Error(`Missing required --${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (!Number.isSafeInteger(parsed.timeoutMs) || parsed.timeoutMs < 5_000 || parsed.timeoutMs > 300_000) {
    throw new Error("--timeout-ms must be between 5000 and 300000");
  }
  if (!Number.isSafeInteger(parsed.revocationTimeoutMs) ||
      parsed.revocationTimeoutMs < 20_000 ||
      parsed.revocationTimeoutMs > 300_000) {
    throw new Error("--revocation-timeout-ms must be between 20000 and 300000");
  }
  if (!Number.isSafeInteger(parsed.transientExpiryTimeoutMs) ||
      parsed.transientExpiryTimeoutMs < 120_000 ||
      parsed.transientExpiryTimeoutMs > 300_000) {
    throw new Error("--transient-expiry-timeout-ms must be between 120000 and 300000");
  }
  return parsed;
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

function dataUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>${marker}</title><main>${marker}</main>`)}`;
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
  accountId = `native-matrix-${randomUUID()}`,
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
  const store = new LicenseStore(":memory:", Buffer.alloc(32, 9));
  const service = new EntitlementService(store, catalog, new LeaseSigner(keyId, privateKey), {
    now: () => Math.floor(Date.now() / 1000),
    sessionTtlSeconds,
    heartbeatAfterSeconds,
  });
  const authorization = await service.issueAuthorization({
    accountId,
    plan: "launch",
    paidThrough: Math.floor(Date.now() / 1000) + 86_400,
    serviceUrl: "https://api.slybrowser.test",
  });
  return { service, catalog, store, releaseRoot, authorization, browserVersion };
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

function decodeLeaseClaims(lease) {
  return JSON.parse(Buffer.from(lease.payload, "base64url").toString("utf8"));
}

function resignLease(context, lease, overrides) {
  return context.service.signer.sign({
    ...decodeLeaseClaims(lease),
    ...overrides,
  });
}

function corruptLeaseSignature(lease) {
  const suffix = lease.signature.endsWith("A") ? "B" : "A";
  return { ...lease, signature: `${lease.signature.slice(0, -1)}${suffix}` };
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

async function startTerminalServer(statusCode, requests) {
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: `terminal-${statusCode}` }));
  });
  const origin = await listen(server);
  return { server, origin };
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function forwardHttpRequest(upstreamOrigin, request, response) {
  const target = new URL(request.url ?? "/", upstreamOrigin);
  const headers = { ...request.headers };
  delete headers.host;
  const body = ["GET", "HEAD"].includes(request.method ?? "GET")
    ? undefined
    : await readRequestBody(request);
  const upstream = await fetch(target, { method: request.method, headers, body });
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function startHeartbeatFailureProxy(context, metrics, statusCode = 503) {
  const upstreamServer = createLicenseHttpServer({
    service: context.service,
    catalog: context.catalog,
    artifactRoot: context.releaseRoot,
    rateLimits: false,
    failureBackoff: false,
    metrics: (event) => metrics.push(event),
  });
  const upstreamOrigin = await listen(upstreamServer);
  const proxyServer = createServer(async (request, response) => {
    if (request.url?.includes("/heartbeat")) {
      await readRequestBody(request);
      metrics.push({
        operation: "runtime_session_heartbeat",
        method: request.method,
        status: statusCode,
        result: "transient_failure",
      });
      response.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: `transient-${statusCode}` }));
      return;
    }
    try {
      await forwardHttpRequest(upstreamOrigin, request, response);
    } catch (error) {
      metrics.push({
        operation: "runtime_proxy_forward",
        method: request.method,
        status: 0,
        result: summarizeError(error).message,
      });
      response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "proxy-forward-failed" }));
    }
  });
  const origin = await listen(proxyServer);
  return {
    origin,
    async close() {
      await closeServer(proxyServer);
      await closeServer(upstreamServer);
    },
  };
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

async function runBrowserDump({ browser, lease, handoff, scratch, timeoutMs }) {
  const profile = await mkdtemp(join(tmpdir(), "sly-native-watchdog-profile-"));
  const licenseFile = await writePrivateTextFile(scratch, "lease", JSON.stringify(lease));
  const runtimeFile = await writePrivateJsonFile(scratch, "runtime", handoff);
  try {
    return await runProcess(browser, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      `--user-data-dir=${profile}`,
      `--sly-license-file=${licenseFile}`,
      `--sly-runtime-file=${runtimeFile}`,
      "--dump-dom",
      dataUrl(),
    ], timeoutMs, { resolveOnStdout: marker });
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function runBrowserLong({ browser, lease, handoff, scratch }) {
  const profile = await mkdtemp(join(tmpdir(), "sly-native-watchdog-long-profile-"));
  const licenseFile = await writePrivateTextFile(scratch, "lease", JSON.stringify(lease));
  const runtimeFile = await writePrivateJsonFile(scratch, "runtime", handoff);
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--user-data-dir=${profile}`,
    `--sly-license-file=${licenseFile}`,
    `--sly-runtime-file=${runtimeFile}`,
    dataUrl(),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const stdout = [];
  const stderr = [];
  child.stdout?.on("data", (chunk) => { if (stdout.join("").length < 16_384) stdout.push(String(chunk)); });
  child.stderr?.on("data", (chunk) => { if (stderr.join("").length < 16_384) stderr.push(String(chunk)); });
  return {
    child,
    profile,
    stdout,
    stderr,
    async cleanup() {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolveCleanupExit) => {
          const timer = setTimeout(resolveCleanupExit, 2_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolveCleanupExit();
          });
        });
      }
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await rm(profile, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt === 5) return;
          await new Promise((accept) => setTimeout(accept, 250 * (attempt + 1)));
        }
      }
    },
  };
}

function summarizeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code,
    message: String(error?.message ?? error).slice(0, 1000),
  };
}

function passed(details = {}) {
  return { passed: true, ...details };
}

function failed(details = {}) {
  return { passed: false, ...details };
}

async function runCase(cases, id, expectation, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    cases.push({
      id,
      expectation,
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

async function waitForMetric(metrics, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (metrics.some(predicate)) return true;
    await new Promise((accept) => setTimeout(accept, 100));
  } while (Date.now() < deadline);
  return false;
}

async function expectDirectBrowserSuccess(browser, context, origin, scratch, timeoutMs, metrics) {
  const grant = await createRuntimeGrant(context);
  const result = await runBrowserDump({
    browser,
    lease: grant.lease,
    handoff: runtimeHandoff(origin, grant),
    scratch,
    timeoutMs,
  });
  const activated = metrics.some((event) => event.operation === "runtime_session_activate" && event.status === 200);
  if ((result.exitCode === 0 || result.resolvedByStdout) && result.stdout.includes(marker) && activated) {
    return passed({
      exitCode: result.exitCode,
      sessionId: grant.sessionId,
      activated,
      metrics: redactMetrics(metrics),
    });
  }
  return failed({ expected: "browser activates over localhost and emits marker", result, metrics: redactMetrics(metrics) });
}

async function expectWebDriverSuccess(browser, driver, context, origin, timeoutMs, metrics) {
  const grant = await createRuntimeGrant(context);
  let session;
  try {
    session = await launchWebDriver(browser, grant.lease, {
      driverExecutable: driver,
      headless: true,
      commandTimeout: timeoutMs,
      driverStartTimeout: Math.min(timeoutMs, 30_000),
      args: ["--disable-gpu"],
      runtimeHandoff: runtimeHandoff(origin, grant),
      driverRuntimeHandoff: runtimeHandoff(origin, grant, grant.driverActivationTicket),
      allowRuntimeActivationTicket: true,
      nativeReady: true,
      nativeReadyTimeout: Math.min(timeoutMs, 20_000),
    });
    await session.get(dataUrl());
    const webdriver = await session.executeScript("return navigator.webdriver");
    const title = await session.executeScript("return document.title");
    const activateCount = metrics.filter((event) => event.operation === "runtime_session_activate" && event.status === 200).length;
    const webdriverSessionId = session.sessionId;
    const browserVersion = session.versions.browserVersion;
    const driverVersion = session.versions.driverVersion;
    await session.close();
    session = undefined;
    const released = await waitForMetric(metrics, (event) =>
      event.operation === "runtime_session_release" && event.status === 204, 5_000);
    const releaseCount = metrics.filter((event) =>
      event.operation === "runtime_session_release" && event.status === 204).length;
    if (webdriver === false && title === marker && activateCount >= 2 && released) {
      return passed({
        sessionId: webdriverSessionId,
        runtimeSessionId: grant.sessionId,
        webdriver,
        activateCount,
        released,
        releaseCount,
        browserVersion,
        driverVersion,
        metrics: redactMetrics(metrics),
      });
    }
    return failed({ expected: "WebDriver starts driver/browser with native activation and releases on shutdown", webdriver, title, activateCount, released, releaseCount, metrics: redactMetrics(metrics) });
  } catch (error) {
    return failed({ error: summarizeError(error), metrics: redactMetrics(metrics) });
  } finally {
    await session?.close().catch(() => undefined);
  }
}

async function expectMismatchedRuntimeRejected(browser, driver, context, origin, timeoutMs) {
  const driverGrant = await createRuntimeGrant(context);
  const browserGrant = await createRuntimeGrant(context);
  let session;
  try {
    session = await launchWebDriver(browser, browserGrant.lease, {
      driverExecutable: driver,
      headless: true,
      commandTimeout: timeoutMs,
      driverStartTimeout: Math.min(timeoutMs, 30_000),
      args: ["--disable-gpu"],
      runtimeHandoff: runtimeHandoff(origin, browserGrant),
      driverRuntimeHandoff: runtimeHandoff(origin, driverGrant, driverGrant.driverActivationTicket),
      allowRuntimeActivationTicket: true,
    });
    return failed({ expected: "session creation must reject mismatched browser/WebDriver runtime sessions", sessionId: session.sessionId });
  } catch (error) {
    return passed({ error: summarizeError(error), driverSessionId: driverGrant.sessionId, browserSessionId: browserGrant.sessionId });
  } finally {
    await session?.close().catch(() => undefined);
  }
}

async function expectTerminalStatus(browser, context, scratch, timeoutMs, statusCode) {
  const requests = [];
  const { server, origin } = await startTerminalServer(statusCode, requests);
  try {
    const grant = await createRuntimeGrant(context);
    const result = await runBrowserDump({
      browser,
      lease: grant.lease,
      handoff: runtimeHandoff(origin, grant),
      scratch,
      timeoutMs,
    });
    if (!result.timedOut && result.exitCode !== 0 && requests.some((item) => item.url?.endsWith("/activate"))) {
      return passed({ exitCode: result.exitCode, statusCode, requests: requests.map((item) => ({ method: item.method, url: item.url })) });
    }
    return failed({ expected: `browser exits fail-closed on activate HTTP ${statusCode}`, result, requests });
  } finally {
    await closeServer(server);
  }
}

async function expectTamperedLeaseRejected(browser, context, origin, scratch, timeoutMs, metrics) {
  const grant = await createRuntimeGrant(context);
  const result = await runBrowserDump({
    browser,
    lease: corruptLeaseSignature(grant.lease),
    handoff: runtimeHandoff(origin, grant),
    scratch,
    timeoutMs,
  });
  const activated = metrics.some((event) => event.operation === "runtime_session_activate" && event.status === 200);
  if (!result.timedOut && result.exitCode !== 0 && !activated) {
    return passed({ exitCode: result.exitCode, activated, stderr: result.stderr.slice(-1000), metrics: redactMetrics(metrics) });
  }
  return failed({ expected: "tampered signed lease is rejected before native activation", result, activated, metrics: redactMetrics(metrics) });
}

async function expectExpiredLeaseRejected(browser, context, origin, scratch, timeoutMs, metrics) {
  const grant = await createRuntimeGrant(context);
  const now = Math.floor(Date.now() / 1000);
  const expiredAt = now - 30;
  const expiredLease = resignLease(context, grant.lease, {
    issuedAt: now - 120,
    notBefore: now - 120,
    expiresAt: expiredAt,
    paidThrough: now + 86_400,
    leaseGeneration: expiredAt,
  });
  const result = await runBrowserDump({
    browser,
    lease: expiredLease,
    handoff: { ...runtimeHandoff(origin, grant), expiresAt: expiredAt },
    scratch,
    timeoutMs,
  });
  const activated = metrics.some((event) => event.operation === "runtime_session_activate" && event.status === 200);
  if (!result.timedOut && result.exitCode !== 0 && !activated) {
    return passed({ exitCode: result.exitCode, activated, stderr: result.stderr.slice(-1000), metrics: redactMetrics(metrics) });
  }
  return failed({ expected: "expired signed lease is rejected before native activation", result, activated, metrics: redactMetrics(metrics) });
}

async function expectRevokedHeartbeatExit(browser, context, origin, scratch, timeoutMs, metrics) {
  const grant = await createRuntimeGrant(context);
  const runtime = await runBrowserLong({
    browser,
    lease: grant.lease,
    handoff: runtimeHandoff(origin, grant),
    scratch,
  });
  const startedAt = Date.now();
  try {
    const activated = await waitForMetric(metrics, (event) =>
      event.operation === "runtime_session_activate" && event.status === 200, 30_000);
    if (!activated) {
      return failed({ expected: "long-running browser activates before revocation", metrics: redactMetrics(metrics) });
    }
    await context.service.revokeRuntimeSessions({
      target: { scope: "session", sessionId: grant.sessionId },
      now: Math.floor(Date.now() / 1000),
    });
    const exit = await new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit({ timedOut: true }), timeoutMs);
      runtime.child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal, timedOut: false });
      });
    });
    const heartbeatDenied = metrics.some((event) =>
      event.operation === "runtime_session_heartbeat" && event.status >= 400);
    if (!exit.timedOut && exit.code === 30 && heartbeatDenied) {
      return passed({
        exitCode: exit.code,
        durationMs: Date.now() - startedAt,
        heartbeatDenied,
        metrics: redactMetrics(metrics),
      });
    }
    return failed({
      expected: "revoked runtime session stops the browser on the next native heartbeat",
      exit,
      stdout: runtime.stdout.join("").slice(-4000),
      stderr: runtime.stderr.join("").slice(-4000),
      metrics: redactMetrics(metrics),
    });
  } finally {
    await runtime.cleanup();
  }
}

async function expectTransientHeartbeatExpiry(browser, context, origin, scratch, timeoutMs, metrics) {
  const grant = await createRuntimeGrant(context);
  const runtime = await runBrowserLong({
    browser,
    lease: grant.lease,
    handoff: runtimeHandoff(origin, grant),
    scratch,
  });
  const startedAt = Date.now();
  try {
    const activated = await waitForMetric(metrics, (event) =>
      event.operation === "runtime_session_activate" && event.status === 200, 30_000);
    if (!activated) {
      return failed({ expected: "long-running browser activates before transient heartbeat failures", metrics: redactMetrics(metrics) });
    }
    const exit = await new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit({ timedOut: true }), timeoutMs);
      runtime.child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal, timedOut: false });
      });
    });
    const heartbeatTransient = metrics.some((event) =>
      event.operation === "runtime_session_heartbeat" && event.status === 503);
    if (!exit.timedOut && exit.code === 30 && heartbeatTransient) {
      return passed({
        exitCode: exit.code,
        durationMs: Date.now() - startedAt,
        heartbeatTransient,
        metrics: redactMetrics(metrics),
      });
    }
    return failed({
      expected: "transient 5xx heartbeat failures retry only until the signed lease expires",
      exit,
      stdout: runtime.stdout.join("").slice(-4000),
      stderr: runtime.stderr.join("").slice(-4000),
      metrics: redactMetrics(metrics),
    });
  } finally {
    await runtime.cleanup();
  }
}

function markdown(report) {
  const lines = [
    "# Native runtime watchdog production-like matrix",
    "",
    `Generated at: ${report.generatedAt}`,
    "",
    "| Case | Expectation | Result | Evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const item of report.cases) {
    const evidence = item.exitCode !== undefined ? `exit ${item.exitCode}` :
      item.activateCount !== undefined ? `${item.activateCount} activations` :
      item.error?.code || item.error?.message || item.statusCode || "";
    lines.push(`| ${item.id} | ${item.expectation} | ${item.passed ? "PASS" : "FAIL"} | ${String(evidence).replaceAll("|", "\\|")} |`);
  }
  lines.push("");
  lines.push(`Overall: ${report.passed ? "PASS" : "FAIL"}`);
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const browser = await assertFile(options.browser, "browser");
const driver = await assertFile(options.driver, "driver");
const privateKeyFile = await assertFile(options.privateKeyFile, "private key");
await assertFile(webdriverModule, "built Node WebDriver module");
const browserVersion = options.browserVersion || await detectWindowsFileVersion(browser);
if (!browserVersion) throw new Error("Unable to determine browser version. Pass --browser-version.");
const output = resolve(options.output);
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "sly-native-watchdog-matrix-"));
const cases = [];

try {
  await runCase(cases, "browser-http-401-fail-closed", "native activate rejects HTTP 401 before profile/page use", async () => {
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    try {
      return await expectTerminalStatus(browser, context, scratch, options.timeoutMs, 401);
    } finally {
      context.store.close?.();
    }
  });

  await runCase(cases, "browser-http-403-fail-closed", "native activate rejects HTTP 403 before profile/page use", async () => {
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    try {
      return await expectTerminalStatus(browser, context, scratch, options.timeoutMs, 403);
    } finally {
      context.store.close?.();
    }
  });

  await runCase(cases, "browser-http-409-fail-closed", "native activate rejects HTTP 409/session conflict before profile/page use", async () => {
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    try {
      return await expectTerminalStatus(browser, context, scratch, options.timeoutMs, 409);
    } finally {
      context.store.close?.();
    }
  });

  await runCase(cases, "browser-tampered-lease-rejected", "signature/hash tampering is rejected before native activate", async () => {
    const metrics = [];
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    const { server, origin } = await startLicenseServer(context, metrics);
    try {
      return await expectTamperedLeaseRejected(browser, context, origin, scratch, options.timeoutMs, metrics);
    } finally {
      await closeServer(server);
      context.store.close?.();
    }
  });

  await runCase(cases, "browser-expired-lease-rejected", "expired signed lease is rejected before native activate", async () => {
    const metrics = [];
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    const { server, origin } = await startLicenseServer(context, metrics);
    try {
      return await expectExpiredLeaseRejected(browser, context, origin, scratch, options.timeoutMs, metrics);
    } finally {
      await closeServer(server);
      context.store.close?.();
    }
  });

  await runCase(cases, "browser-native-activate-marker", "browser performs real localhost activate before page use", async () => {
    const metrics = [];
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    const { server, origin } = await startLicenseServer(context, metrics);
    try {
      return await expectDirectBrowserSuccess(browser, context, origin, scratch, options.timeoutMs, metrics);
    } finally {
      await closeServer(server);
      context.store.close?.();
    }
  });

  await runCase(cases, "webdriver-native-activate-pairing", "WebDriver and browser activate as paired child processes of one runtime session", async () => {
    const metrics = [];
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    const { server, origin } = await startLicenseServer(context, metrics);
    try {
      return await expectWebDriverSuccess(browser, driver, context, origin, options.timeoutMs, metrics);
    } finally {
      await closeServer(server);
      context.store.close?.();
    }
  });

  await runCase(cases, "webdriver-mismatched-runtime-rejected", "WebDriver rejects browser handoff from another runtime session before launch", async () => {
    const metrics = [];
    const context = await createServiceContext({ browser, driver, keyId: options.keyId, privateKeyFile, browserVersion });
    const { server, origin } = await startLicenseServer(context, metrics);
    try {
      return await expectMismatchedRuntimeRejected(browser, driver, context, origin, options.timeoutMs);
    } finally {
      await closeServer(server);
      context.store.close?.();
    }
  });

  if (options.includeRevocationExit) {
    await runCase(cases, "browser-revoked-heartbeat-exit", "revoked runtime session exits on native heartbeat with code 30", async () => {
      const metrics = [];
      const context = await createServiceContext({
        browser,
        driver,
        keyId: options.keyId,
        privateKeyFile,
        browserVersion,
        heartbeatAfterSeconds: 30,
        sessionTtlSeconds: 120,
      });
      const { server, origin } = await startLicenseServer(context, metrics);
      try {
        return await expectRevokedHeartbeatExit(browser, context, origin, scratch, options.revocationTimeoutMs, metrics);
      } finally {
        await closeServer(server);
        context.store.close?.();
      }
    });
  } else {
    cases.push({
      id: "browser-revoked-heartbeat-exit",
      expectation: "revoked runtime session exits on native heartbeat with code 30",
      passed: true,
      skipped: true,
      reason: "pass --include-revocation-exit to run the longer heartbeat case",
      durationMs: 0,
    });
  }

  if (options.includeTransientExpiry) {
    await runCase(cases, "browser-5xx-heartbeat-expires", "native 5xx heartbeat retries only until lease expiry, then exits code 30", async () => {
      const metrics = [];
      const context = await createServiceContext({
        browser,
        driver,
        keyId: options.keyId,
        privateKeyFile,
        browserVersion,
        heartbeatAfterSeconds: 15,
        sessionTtlSeconds: 120,
      });
      const proxy = await startHeartbeatFailureProxy(context, metrics, 503);
      try {
        return await expectTransientHeartbeatExpiry(browser, context, proxy.origin, scratch, options.transientExpiryTimeoutMs, metrics);
      } finally {
        await proxy.close();
        context.store.close?.();
      }
    });
  } else {
    cases.push({
      id: "browser-5xx-heartbeat-expires",
      expectation: "native 5xx heartbeat retries only until lease expiry, then exits code 30",
      passed: true,
      skipped: true,
      reason: "pass --include-transient-expiry to run the longer expiry case",
      durationMs: 0,
    });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  matrix: "native-runtime-watchdog-production-like",
  browser: {
    fileName: basename(browser),
    version: browserVersion,
    sha256: await fileSha256(browser),
  },
  driver: {
    fileName: basename(driver),
    sha256: await fileSha256(driver),
  },
  keyId: options.keyId,
  cases,
  passed: cases.every((item) => item.passed === true),
};

await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(output, "report.md"), markdown(report));
console.log(JSON.stringify({ output, passed: report.passed, cases: cases.length }, null, 2));
if (!report.passed) process.exitCode = 1;
