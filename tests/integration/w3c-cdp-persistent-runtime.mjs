import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { fetchCdpDiscovery, SlyWebDriverService } from "../../packages/node/dist/index.js";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--browser") options.browser = resolve(values[++index]);
    else if (value === "--driver") options.driver = resolve(values[++index]);
    else if (value === "--output") options.output = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.browser || !options.driver || !options.output) throw new Error("--browser, --driver and --output are required");
  return options;
}

async function listen() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/frame") {
      response.end("<!doctype html><title>Frame</title><button id='frame-target' onclick='window.clicked=(window.clicked||0)+1'>Frame target</button>");
    } else if (request.url === "/popup") {
      response.end("<!doctype html><title>W3C Popup</title><main>Popup</main>");
    } else {
      response.end("<!doctype html><title>W3C Main</title><a id='popup-link' href='/popup' target='_blank'>Open popup</a><iframe id='test-frame' src='/frame'></iframe>");
    }
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not allocate a port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  await new Promise((accept) => server.close(() => accept()));
}

async function openSession(options, profileDir) {
  const service = await SlyWebDriverService.start(options.driver, { commandTimeout: 10_000 });
  try {
    const session = await service.createSession(options.browser, {
      headless: true,
      viewport: { width: 800, height: 600 },
      profileDir,
      profileMode: "persistent",
    });
    await session.setTimeouts({ script: 5_000, pageLoad: 10_000, implicit: 0 });
    return session;
  } catch (error) {
    await service.close();
    throw error;
  }
}

async function waitForPopup(session, primary, expectedUrl) {
  const deadline = Date.now() + 5_000;
  let last = { handle: "", title: "", url: "" };
  while (Date.now() < deadline) {
    const handles = await session.windowHandles();
    for (const handle of handles.filter((value) => value !== primary)) {
      await session.switchToWindow(handle);
      last = { handle, title: await session.title(), url: await session.currentUrl() };
      if (last.title === "W3C Popup" || last.url === expectedUrl) return last;
    }
    await new Promise((accept) => setTimeout(accept, 50));
  }
  return last;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = performance.now();
  const profileDir = await mkdtemp(join(tmpdir(), "sly-w3c-persistent-"));
  const probe = await listen();
  let first;
  let second;
  try {
    first = await openSession(options, profileDir);
    const primary = await first.currentWindowHandle();
    const rect = await first.setWindowRect({ width: 920, height: 700 });
    const confirmedRect = await first.windowRect();
    await first.get(`${probe.origin}/main`);
    await first.executeScript("localStorage.setItem('sly-persistent', 'restored')");

    const frame = await first.findElement("#test-frame");
    await first.switchToFrame(frame);
    const frameTarget = await first.findElement("#frame-target");
    await frameTarget.click();
    const frameClicked = await first.executeScript("return window.clicked || 0");
    await first.switchToParentFrame();

    const popupLink = await first.findElement("#popup-link");
    await popupLink.click();
    const popup = await waitForPopup(first, primary, `${probe.origin}/popup`);
    const popupTitle = popup.title;
    const popupUrl = popup.url;
    await first.closeWindow();
    await first.switchToWindow(primary);

    const firstDiscovery = await fetchCdpDiscovery(first.capabilities);
    await first.close();
    first = undefined;

    second = await openSession(options, profileDir);
    await second.get(`${probe.origin}/main`);
    const restored = await second.executeScript("return localStorage.getItem('sly-persistent')");
    const secondDiscovery = await fetchCdpDiscovery(second.capabilities);

    const checks = {
      standardCdpDiscovery: typeof firstDiscovery.webSocketDebuggerUrl === "string"
        && typeof secondDiscovery.webSocketDebuggerUrl === "string",
      loopbackCdp: [firstDiscovery, secondDiscovery].every((item) => {
        const hostname = new URL(item.webSocketDebuggerUrl).hostname;
        return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
      }),
      w3cPopup: popupTitle === "W3C Popup",
      w3cFrame: frameClicked === 1,
      persistentProfile: restored === "restored",
      windowSize: rect.width === 920 && rect.height === 700 && confirmedRect.width === 920 && confirmedRect.height === 700,
    };
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
      checks,
      contexts: { newPage: true, popup: { title: popupTitle, url: popupUrl }, frameClicked, persistentRestored: restored, windowRect: confirmedRect },
      discovery: {
        first: { Browser: firstDiscovery.Browser, ProtocolVersion: firstDiscovery["Protocol-Version"] },
        second: { Browser: secondDiscovery.Browser, ProtocolVersion: secondDiscovery["Protocol-Version"] },
      },
      durationMs: Math.round(performance.now() - started),
    };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    console.log(`artifact: ${options.output}`);
    if (report.status !== "PASS") process.exitCode = 1;
  } finally {
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    await closeServer(probe.server);
    await rm(profileDir, { recursive: true, force: true });
  }
}

await main();
