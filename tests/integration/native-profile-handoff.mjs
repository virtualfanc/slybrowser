import { constants } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { chromium } from "playwright-core";

function parseArguments(arguments_) {
  const options = { output: undefined };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--browser") options.browser = resolve(arguments_[++index]);
    else if (argument === "--output") options.output = resolve(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.browser) throw new Error("--browser is required");
  return options;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writePrivateConfig(payload) {
  const path = resolve(tmpdir(), `sly-native-profile-${randomUUID()}.json`);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

async function collectWorkerMetrics(page) {
  return page.evaluate(() => new Promise((resolveWorker, rejectWorker) => {
    const source = `postMessage({
      language: navigator.language,
      languages: Array.from(navigator.languages),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory
    });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = ({ data }) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      resolveWorker(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      rejectWorker(new Error(event.message));
    };
  }));
}

async function startProbeServer() {
  let requestHeaders;
  const server = createServer((request, response) => {
    requestHeaders = request.headers;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>SlyBrowser native profile test</title>");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe server did not expose a TCP address");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
    headers: () => requestHeaders,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!(await stat(options.browser)).isFile()) throw new Error(`Browser is missing: ${options.browser}`);

  const expected = {
    locale: "fr-FR",
    languages: ["fr-FR", "fr"],
    timezone: "Europe/Paris",
    screen: { width: 1600, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    userAgentFullVersion: "123.0.4567.89",
    hardwareConcurrency: 12,
    deviceMemory: 8,
    webgl: {
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA GeForce RTX 3060 Direct3D11)",
    },
    webgpu: { vendor: "nvidia", architecture: "ampere" },
    clientRects: { width: 100.125, height: 49.875 },
  };
  const configuration = {
    profile: {
      userAgent: expected.userAgent,
      userAgentFullVersion: expected.userAgentFullVersion,
      clientHints: [
        { brand: "Chromium", version: "123" },
        { brand: "Google Chrome", version: "123" },
        { brand: "Not_A Brand", version: "99" },
      ],
      osVersion: "10.0.0",
      locale: expected.locale,
      languages: expected.languages,
      timezone: { zone: expected.timezone, utc: "UTC+01:00", locale: expected.locale },
      screen: expected.screen,
      webrtc: "default",
      disabledFonts: ["Arial"],
      canvasNoise: { r: 1, g: -1, b: 2, a: 0 },
      webglImageNoise: { r: 1, g: 1, b: -1, a: 0 },
      webgl: expected.webgl,
      webgpu: { vendor: "nvidia", architecture: "ampere" },
      audioContext: { channel: 0.0000001, analyzer: 0.0000002 },
      disabledCipherSuites: ["0x0004"],
      disabledMediaDevices: ["fixture-device-id"],
      clientRects: { width: 0.125, height: -0.125 },
      speechVoices: [{
        default: true,
        lang: "fr-FR",
        localService: true,
        name: "SlyBrowser Fixture Voice",
        voiceURI: "SlyBrowser Fixture Voice",
      }],
      cookies: [{
        name: "sly_fixture",
        value: "configured",
        domain: ".example.test",
        path: "/",
        session: true,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      }],
      hardwareConcurrency: expected.hardwareConcurrency,
      deviceMemory: expected.deviceMemory,
      deviceName: "DESKTOP-SLY-FIXTURE",
      macAddress: "02:00:00:00:00:01",
      doNotTrack: true,
      allowedPorts: [80, 443, 8080],
      gpuEnabled: true,
      homepages: ["https://example.test/"],
    },
  };
  const configFile = await writePrivateConfig(configuration);
  const probe = await startProbeServer();
  let browser;
  let context;
  try {
    browser = await chromium.launch({
      executablePath: options.browser,
      headless: true,
      args: [`--sly-config-file=${configFile}`],
    });
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(probe.url);
    const windowMetrics = await page.evaluate(async () => {
      const probeElement = document.createElement("div");
      probeElement.style.cssText = "position:absolute;width:100px;height:50px";
      document.body.append(probeElement);
      const rect = probeElement.getClientRects()[0];

      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const context2d = canvas.getContext("2d");
      const gradient = context2d.createLinearGradient(0, 0, 32, 32);
      gradient.addColorStop(0, "#f00");
      gradient.addColorStop(1, "#00f");
      context2d.fillStyle = gradient;
      context2d.fillRect(0, 0, 32, 32);
      const canvasReadback = Array.from(context2d.getImageData(0, 0, 1, 1).data);

      const glCanvas = document.createElement("canvas");
      const gl = glCanvas.getContext("webgl");
      const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
      const webgl = debugInfo ? {
        vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
      } : null;

      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      const webgpu = adapter ? {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
      } : null;

      return {
        language: navigator.language,
        languages: Array.from(navigator.languages),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screen: { width: screen.width, height: screen.height },
        userAgent: navigator.userAgent,
        brands: navigator.userAgentData ? Array.from(navigator.userAgentData.brands) : [],
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        doNotTrack: navigator.doNotTrack,
        fontDisabled: !document.fonts.check("16px Arial"),
        clientRect: { width: rect.width, height: rect.height },
        canvasReadback,
        webgl,
        webgpu,
      };
    });
    const iframeMetrics = await page.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.srcdoc = "<!doctype html><body></body>";
      document.body.append(frame);
      await new Promise((accept) => frame.addEventListener("load", accept, { once: true }));
      const frameWindow = frame.contentWindow;
      const frameDocument = frame.contentDocument;
      const probeElement = frameDocument.createElement("div");
      probeElement.style.cssText = "position:absolute;width:100px;height:50px";
      frameDocument.body.append(probeElement);
      const rect = probeElement.getClientRects()[0];
      const glCanvas = frameDocument.createElement("canvas");
      const gl = glCanvas.getContext("webgl");
      const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
      const adapter = frameWindow.navigator.gpu ? await frameWindow.navigator.gpu.requestAdapter() : null;
      const result = {
        language: frameWindow.navigator.language,
        languages: Array.from(frameWindow.navigator.languages),
        timezone: frameWindow.Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: frameWindow.navigator.userAgent,
        hardwareConcurrency: frameWindow.navigator.hardwareConcurrency,
        deviceMemory: frameWindow.navigator.deviceMemory,
        webdriver: frameWindow.navigator.webdriver,
        fontDisabled: !frameDocument.fonts.check("16px Arial"),
        clientRect: { width: rect.width, height: rect.height },
        webgl: debugInfo ? {
          vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
          renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
        } : null,
        webgpu: adapter ? {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
        } : null,
      };
      frame.remove();
      return result;
    });
    const workerMetrics = await collectWorkerMetrics(page);
    const acceptLanguage = probe.headers()?.["accept-language"] ?? "";
    const profileConsumed = !(await exists(configFile));
    const checks = {
      profileConsumed,
      windowLanguage: windowMetrics.language === expected.locale,
      workerLanguage: workerMetrics.language === expected.locale,
      iframeLanguage: iframeMetrics.language === expected.locale,
      languageConsistency: windowMetrics.language === iframeMetrics.language
        && windowMetrics.language === workerMetrics.language,
      windowLanguages: JSON.stringify(windowMetrics.languages) === JSON.stringify(expected.languages),
      workerLanguages: JSON.stringify(workerMetrics.languages) === JSON.stringify(expected.languages),
      iframeLanguages: JSON.stringify(iframeMetrics.languages) === JSON.stringify(expected.languages),
      windowTimezone: windowMetrics.timezone === expected.timezone,
      workerTimezone: workerMetrics.timezone === expected.timezone,
      iframeTimezone: iframeMetrics.timezone === expected.timezone,
      timezoneConsistency: windowMetrics.timezone === iframeMetrics.timezone
        && windowMetrics.timezone === workerMetrics.timezone,
      screen: windowMetrics.screen.width === expected.screen.width
        && windowMetrics.screen.height === expected.screen.height,
      windowUserAgent: windowMetrics.userAgent === expected.userAgent,
      workerUserAgent: workerMetrics.userAgent === expected.userAgent,
      iframeUserAgent: iframeMetrics.userAgent === expected.userAgent,
      browserFullVersion: browser.version() === expected.userAgentFullVersion,
      hardwareConcurrency: windowMetrics.hardwareConcurrency === expected.hardwareConcurrency
        && iframeMetrics.hardwareConcurrency === expected.hardwareConcurrency
        && workerMetrics.hardwareConcurrency === expected.hardwareConcurrency,
      deviceMemory: windowMetrics.deviceMemory === expected.deviceMemory
        && iframeMetrics.deviceMemory === expected.deviceMemory
        && workerMetrics.deviceMemory === expected.deviceMemory,
      doNotTrack: windowMetrics.doNotTrack === "1",
      clientRects: Math.abs(windowMetrics.clientRect.width - expected.clientRects.width) < 0.001
        && Math.abs(windowMetrics.clientRect.height - expected.clientRects.height) < 0.001
        && Math.abs(iframeMetrics.clientRect.width - expected.clientRects.width) < 0.001
        && Math.abs(iframeMetrics.clientRect.height - expected.clientRects.height) < 0.001,
      webgl: windowMetrics.webgl?.vendor === expected.webgl.vendor
        && windowMetrics.webgl?.renderer === expected.webgl.renderer
        && iframeMetrics.webgl?.vendor === expected.webgl.vendor
        && iframeMetrics.webgl?.renderer === expected.webgl.renderer,
      webgpu: windowMetrics.webgpu?.vendor === expected.webgpu.vendor
        && windowMetrics.webgpu?.architecture === expected.webgpu.architecture
        && iframeMetrics.webgpu?.vendor === expected.webgpu.vendor
        && iframeMetrics.webgpu?.architecture === expected.webgpu.architecture,
      iframeFontDisabled: iframeMetrics.fontDisabled,
      acceptLanguageHeader: acceptLanguage.startsWith(expected.locale),
      userAgentHeader: probe.headers()?.["user-agent"] === expected.userAgent,
      doNotTrackHeader: probe.headers()?.dnt === "1",
      clientHintsHeader: (probe.headers()?.["sec-ch-ua"] ?? "").includes("Google Chrome"),
      directNetwork: Boolean(probe.headers()),
    };
    const passed = Object.values(checks).every(Boolean);
    const result = {
      schemaVersion: 1,
      status: passed ? "PASS" : "FAIL",
      browserVersion: browser.version(),
      executable: options.browser,
      expected,
      window: windowMetrics,
      iframe: iframeMetrics,
      worker: workerMetrics,
      configuredParameterGroups: 27,
      runtimeCheckedGroups: [
        "ua", "ua-full-version", "sec-ch-ua", "time-zone",
        "ua-language", "screen", "webgl", "webgpu", "client-rects", "fonts", "cpu", "memory", "dnt",
      ],
      contextMatrix: {
        page: true,
        iframe: true,
        worker: true,
        gpu: { webgl: windowMetrics.webgl, webgpu: windowMetrics.webgpu },
        network: true,
      },
      network: {
        acceptLanguage,
        userAgent: probe.headers()?.["user-agent"] ?? "",
        clientHints: probe.headers()?.["sec-ch-ua"] ?? "",
        doNotTrack: probe.headers()?.dnt ?? "",
      },
      checks,
    };
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(result, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await new Promise((resolveClose) => probe.server.close(resolveClose));
    await rm(configFile, { force: true });
  }
}

await main();
