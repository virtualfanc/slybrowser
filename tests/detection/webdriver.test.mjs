import assert from "node:assert/strict";
import test from "node:test";

import { redactLaunchArgument, validateDriverCompatibility } from "./run-webdriver.mjs";
import {
  evaluateCoreSignals,
  parseBrowserScan,
  parseDeviceInfo,
  parseDeviceInteractions,
} from "./webdriver-adapters.mjs";
import {
  buildSessionPayload,
  WebDriverClient,
  WebDriverProtocolError,
} from "./webdriver-client.mjs";

test("WebDriver session uses the explicit project browser and deterministic defaults", () => {
  const payload = buildSessionPayload("D:/build/SlyBrowser.exe", {
    headless: true,
    viewport: { width: 1600, height: 900 },
    args: ["--no-first-run"],
  });
  const options = payload.capabilities.alwaysMatch["goog:chromeOptions"];
  assert.equal(options.binary, "D:/build/SlyBrowser.exe");
  assert.deepEqual(options.args, ["--no-first-run", "--headless=new", "--window-size=1600,900"]);
  assert.equal(payload.capabilities.alwaysMatch["goog:loggingPrefs"], undefined);
});

test("WebDriver session does not duplicate caller-provided headless or window arguments", () => {
  const payload = buildSessionPayload("D:/build/SlyBrowser.exe", {
    headless: true,
    args: ["--headless=old", "--window-size=800,600"],
    excludeSwitches: ["enable-automation"],
    captureBrowserLogs: true,
  });
  const options = payload.capabilities.alwaysMatch["goog:chromeOptions"];
  assert.deepEqual(options.args, ["--headless=old", "--window-size=800,600"]);
  assert.deepEqual(options.excludeSwitches, ["enable-automation"]);
  assert.deepEqual(payload.capabilities.alwaysMatch["goog:loggingPrefs"], { browser: "ALL" });
});

test("WebDriver session forwards product-recommended excluded switches", () => {
  const payload = buildSessionPayload("D:/build/CloakBrowser.exe", {
    args: ["--fingerprint=42424"],
    excludeSwitches: ["enable-automation", "enable-unsafe-swiftshader"],
  });
  assert.deepEqual(
    payload.capabilities.alwaysMatch["goog:chromeOptions"].excludeSwitches,
    ["enable-automation", "enable-unsafe-swiftshader"],
  );
});

test("Humanize is negotiated with the native project WebDriver", () => {
  const payload = buildSessionPayload("D:/build/SlyBrowser.exe", {
    humanize: { enabled: true, preset: "careful", seed: 42424 },
  });
  assert.deepEqual(payload.capabilities.alwaysMatch["sly:options"], {
    humanize: { enabled: true, preset: "careful", seed: 42424 },
  });
  const client = new WebDriverClient("http://127.0.0.1:9515", "session", {
    "sly:features": { humanize: { enabled: true, version: 1, preset: "careful" } },
  }, { enabled: true, preset: "careful" });
  assert.equal(client.humanizeEnabled, true);
  assert.throws(() => new WebDriverClient(
    "http://127.0.0.1:9515",
    "session",
    {},
    { enabled: true },
  ), /did not enable the requested native Humanize capability/);
});

test("Humanize recovers a covered element with a real W3C wheel action", async () => {
  const client = new WebDriverClient("http://127.0.0.1:9515", "session", {
    "sly:features": { humanize: { enabled: true, version: 1, preset: "careful" } },
  }, { enabled: true, preset: "careful" });
  const requests = [];
  let clicks = 0;
  client.request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (path.endsWith("/click") && clicks++ === 0) {
      throw new WebDriverProtocolError("POST /element/click", {
        value: { error: "element click intercepted", message: "sticky banner covers target" },
      }, 400);
    }
    return undefined;
  };
  client.execute = async () => ({ deltaY: -96, coveringTag: "A" });
  await client.humanClick("element-id");
  assert.equal(clicks, 2);
  const wheel = requests.find((request) => request.path.endsWith("/actions"));
  assert.equal(wheel.body.actions[0].type, "wheel");
  assert.equal(wheel.body.actions[0].actions[0].deltaY, -96);
});

test("Humanize typing uses WebDriver focus without a redundant element click", async () => {
  const client = new WebDriverClient("http://127.0.0.1:9515", "session", {
    "sly:features": { humanize: { enabled: true, version: 1, preset: "careful" } },
  }, { enabled: true, preset: "careful" });
  const paths = [];
  client.request = async (_method, path) => { paths.push(path); };
  await client.humanType("email", "benchmark@example.test");
  assert.ok(paths.some((path) => path.endsWith("/clear")));
  assert.ok(paths.some((path) => path.endsWith("/value")));
  assert.ok(!paths.some((path) => path.endsWith("/click")));
});

test("browser and project WebDriver must report the same major version", () => {
  assert.deepEqual(validateDriverCompatibility({
    browserVersion: "148.0.7778.179",
    chrome: { chromedriverVersion: "148.0.7778.179 (abcdef)" },
  }), {
    browserVersion: "148.0.7778.179",
    driverVersion: "148.0.7778.179",
    browserMajor: 148,
  });
  assert.throws(() => validateDriverCompatibility({
    browserVersion: "148.0.7778.179",
    chrome: { chromedriverVersion: "149.0.1.0" },
  }), /different major versions/);
});

test("protocol errors retain the command, status, and remote message", () => {
  const error = new WebDriverProtocolError("POST /session", {
    value: { error: "session not created", message: "binary mismatch" },
  }, 500);
  assert.equal(error.command, "POST /session");
  assert.equal(error.status, 500);
  assert.match(error.message, /session not created: binary mismatch/);
});

test("sensitive one-time file and proxy arguments are redacted from reports", () => {
  assert.equal(
    redactLaunchArgument("--sly-license-file=C:/secure/lease.json"),
    "--sly-license-file=<redacted>",
  );
  assert.equal(
    redactLaunchArgument("--sly-config-file=C:/secure/profile.json"),
    "--sly-config-file=<redacted>",
  );
  assert.equal(
    redactLaunchArgument("--proxy-server=http://user:password@example.test:8080"),
    "--proxy-server=<redacted>",
  );
  assert.equal(redactLaunchArgument("--no-first-run"), "--no-first-run");
});

test("WebDriver adapters score core, BrowserScan, and device flags", () => {
  const core = evaluateCoreSignals({
    webdriver: false,
    pluginsLength: 5,
    windowChromeType: "object",
    userAgent: "Mozilla/5.0 Chrome/148.0.0.0 Safari/537.36",
    cdpGlobals: [],
  });
  assert.equal(core.status, "PASS");
  assert.equal(core.score, 100);

  const browserScan = parseBrowserScan("Test Results: Normal Webdriver User-Agent CDP Navigator");
  assert.equal(browserScan.status, "PASS");
  assert.equal(browserScan.metrics.normal, 4);

  const browserScanRobot = parseBrowserScan("Test Results:\nRobot\nWebDriver\nNormal\nSelenium\nRobot");
  assert.equal(browserScanRobot.status, "FAIL");
  assert.equal(browserScanRobot.score, 0);
  assert.equal(browserScanRobot.metrics.mainVerdict, "Robot");

  const device = parseDeviceInfo('isBot: false\nhasWebdriverTrue: false\nisAutomatedWithCDP: true');
  assert.equal(device.status, "FAIL");
  assert.equal(device.metrics.trueCount, 1);
});

test("device info adapter includes the current complete detail set", () => {
  const details = {
    hasBotUserAgent: false,
    hasWebdriverTrue: false,
    hasWebdriverInFrameTrue: false,
    isPlaywright: false,
    hasInconsistentChromeObject: false,
    isPhantom: false,
    isNightmare: false,
    isSequentum: false,
    isSeleniumChromeDefault: true,
    isHeadlessChrome: false,
    isWebGLInconsistent: false,
    hasInconsistentWebGLShaderLang: false,
    hasInconsistentTimingResolution: true,
    isAutomatedWithCDP: false,
    isAutomatedWithCDPInWebWorker: false,
    hasInconsistentClientHints: false,
    hasInconsistentGPUFeatures: false,
    isIframeOverridden: false,
    hasInconsistentWorkerValues: false,
    hasHighHardwareConcurrency: false,
    hasHeadlessChromeDefaultScreenResolution: false,
    hasSuspiciousWeakSignals: false,
  };
  const device = parseDeviceInfo(JSON.stringify({ isBot: true, details }));
  assert.equal(device.metrics.knownCount, 23);
  assert.equal(device.metrics.detailKnownCount, 22);
  assert.deepEqual(device.metrics.trueDetails, ["isSeleniumChromeDefault", "hasInconsistentTimingResolution"]);
  assert.equal(device.metrics.detailTrueCount, 2);
  assert.ok(Math.abs(device.metrics.detailScore - 90.9090909090909) < 1e-9);
  assert.ok(Math.abs(device.score - 86.95652173913044) < 1e-9);
});

test("device interaction adapter scores submitted behavior results", () => {
  const interaction = parseDeviceInteractions(JSON.stringify({
    isBot: true,
    details: {
      suspiciousClientSideBehavior: false,
      superHumanSpeed: false,
      hasCDPMouseLeak: true,
      hasWebdriverTrue: false,
    },
  }));
  assert.equal(interaction.status, "FAIL");
  assert.equal(interaction.metrics.knownCount, 5);
  assert.equal(interaction.metrics.trueCount, 2);
  assert.deepEqual(interaction.metrics.trueDetails, ["hasCDPMouseLeak"]);
  assert.equal(interaction.score, 60);
});
