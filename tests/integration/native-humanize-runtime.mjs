import { mkdir, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

import { startChromeDriver } from "../detection/webdriver-client.mjs";

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--browser") options.browser = resolve(arguments_[++index]);
    else if (argument === "--driver") options.driver = resolve(arguments_[++index]);
    else if (argument === "--only") options.only = new Set(arguments_[++index].split(","));
    else if (argument === "--output") options.output = resolve(arguments_[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.browser || !options.driver) throw new Error("--browser and --driver are required");
  return options;
}

const pointerActions = [{
  type: "pointer",
  id: "humanize-runtime-pointer",
  parameters: { pointerType: "mouse" },
  actions: [
    { type: "pointerMove", duration: 20, x: 40, y: 40, origin: "viewport" },
    { type: "pointerMove", duration: 20, x: 180, y: 120, origin: "viewport" },
  ],
}];

const singlePointerAction = [{
  type: "pointer",
  id: "humanize-runtime-single-pointer",
  parameters: { pointerType: "mouse" },
  actions: [{ type: "pointerMove", duration: 0, x: 40, y: 40, origin: "viewport" }],
}];

const wheelActions = [{
  type: "wheel",
  id: "humanize-runtime-wheel",
  actions: [{ type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: 120, duration: 20, origin: "viewport" }],
}];

const dpiFactors = new Map([
  ["dpi-100-element-click", 1],
  ["dpi-125-element-click", 1.25],
  ["dpi-150-element-click", 1.5],
  ["dpi-200-element-click", 2],
  ["dpi-200-frame-element-click", 2],
]);

function dataUrl(markup) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;
}

function assertGeometry(diagnostics, expectedScale) {
  if (Math.abs(diagnostics.devicePixelRatio - expectedScale) > 0.01) {
    throw new Error(`Expected devicePixelRatio ${expectedScale}, got ${diagnostics.devicePixelRatio}`);
  }
  for (const property of ["left", "top", "width", "height"]) {
    if (Math.abs(diagnostics.rect[property] - diagnostics.clientRect[property]) > 0.01) {
      throw new Error(`getClientRects/getBoundingClientRect mismatch for ${property}: ${JSON.stringify(diagnostics)}`);
    }
  }
  if (diagnostics.hit?.id !== "target") {
    throw new Error(`Target center is not actionable: ${JSON.stringify(diagnostics.hit)}`);
  }
}

async function captureGeometry(client) {
  return client.execute(`
    const target = document.querySelector('#target');
    const rect = target.getBoundingClientRect();
    const clientRect = target.getClientRects()[0];
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      devicePixelRatio,
      innerWidth,
      innerHeight,
      visualViewportScale: visualViewport?.scale ?? null,
      visualViewportWidth: visualViewport?.width ?? null,
      visualViewportHeight: visualViewport?.height ?? null,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      clientRect: clientRect ? { left: clientRect.left, top: clientRect.top, width: clientRect.width, height: clientRect.height } : null,
      hit: hit ? { id: hit.id, tagName: hit.tagName } : null,
    };
  `);
}

async function assertAsyncScript(client) {
  const result = await client.executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.resolve().then(() => done({ ok: true, webdriver: navigator.webdriver ?? null }));
  `);
  if (result?.ok !== true || result.webdriver !== false) {
    throw new Error(`Unexpected async-script result: ${JSON.stringify(result)}`);
  }
}

async function runScenario(options, name, actions) {
  const started = performance.now();
  const driver = await startChromeDriver(options.driver, { verbose: true });
  let client;
  let diagnostics = null;
  try {
    const dpiFactor = dpiFactors.get(name);
    client = await driver.createSession(options.browser, {
      headless: true,
      viewport: { width: 800, height: 600 },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        ...(dpiFactor ? [`--force-device-scale-factor=${dpiFactor}`] : []),
      ],
      humanize: {
        enabled: true,
        preset: "careful",
        seed: 42424,
        commandTimeout: name === "timeout-boundary" ? 3_000 : 10_000,
      },
    });
    await client.setTimeouts({ pageLoad: 10_000, script: 10_000, implicit: 0 });
    if (name === "dpi-200-frame-element-click") {
      await client.navigate(dataUrl(`
        <iframe id="test-frame" style="position:absolute;left:120px;top:80px;width:500px;height:350px;border:8px solid #333"
          srcdoc="<button id='target' style='position:absolute;left:180px;top:120px;width:160px;height:70px' onclick='window.clicked=(window.clicked||0)+1'>Target</button>"></iframe>
      `));
      const frame = await client.findElement("css selector", "#test-frame");
      await client.switchToFrame(frame);
      const element = await client.findElement("css selector", "#target");
      diagnostics = await captureGeometry(client);
      assertGeometry(diagnostics, dpiFactor);
      await client.humanClick(element);
      const clicked = await client.execute("return window.clicked || 0");
      if (clicked !== 1) throw new Error(`High-DPI frame target received ${clicked} clicks`);
      await client.switchToParentFrame();
    } else if (dpiFactor) {
      await client.navigate(dataUrl("<button id='target' style='position:absolute;left:420px;top:260px;width:220px;height:90px' onclick='window.clicked=(window.clicked||0)+1'>Target</button>"));
      const element = await client.findElement("css selector", "#target");
      diagnostics = await captureGeometry(client);
      assertGeometry(diagnostics, dpiFactor);
      await client.humanClick(element);
      const clicked = await client.execute("return window.clicked || 0");
      if (clicked !== 1) throw new Error(`DPI ${dpiFactor} target received ${clicked} clicks`);
    } else {
      await client.navigate("data:text/html,<main style='height:2000px'>Humanize runtime</main>");
      for (const action of actions) {
        await client.request("POST", client.sessionPath("/actions"), { actions: action });
      }
      await assertAsyncScript(client);
    }
    return { name, status: "PASS", durationMs: Math.round(performance.now() - started), diagnostics };
  } catch (error) {
    return {
      name,
      status: "FAIL",
      durationMs: Math.round(performance.now() - started),
      error: String(error?.message ?? error),
      diagnostics,
      driverLog: [...driver.logs.stderr, ...driver.logs.stdout].join("").slice(-30000),
    };
  } finally {
    await client?.quit().catch(() => undefined);
    await driver.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await Promise.all([stat(options.browser), stat(options.driver)]);
  const scenarios = [
    ["no-actions", []],
    ["single-pointer", [singlePointerAction]],
    ["pointer-only", [pointerActions]],
    ["wheel-only", [wheelActions]],
    ["pointer-and-wheel", [pointerActions, wheelActions]],
    ["timeout-boundary", [singlePointerAction, pointerActions, wheelActions]],
    ["dpi-100-element-click", []],
    ["dpi-125-element-click", []],
    ["dpi-150-element-click", []],
    ["dpi-200-element-click", []],
    ["dpi-200-frame-element-click", []],
  ];
  const results = [];
  for (const [name, actions] of scenarios.filter(([name]) => !options.only || options.only.has(name))) {
    const result = await runScenario(options, name, actions);
    results.push(result);
    console.log(`${result.status} ${result.name} (${result.durationMs} ms)${result.error ? `: ${result.error}` : ""}`);
    if (result.diagnostics) console.log(`diagnostics: ${JSON.stringify(result.diagnostics)}`);
    if (result.driverLog) console.log(result.driverLog);
  }
  if (options.output) {
    await mkdir(resolve(options.output, ".."), { recursive: true });
    await writeFile(options.output, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      summary: {
        total: results.length,
        passed: results.filter((result) => result.status === "PASS").length,
        failed: results.filter((result) => result.status !== "PASS").length,
      },
      results,
    }, null, 2)}\n`);
    console.log(`artifact: ${options.output}`);
  }
  if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
}

await main();
