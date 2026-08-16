import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { SlyWebDriverService } from "../../packages/node/dist/index.js";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--browser") options.browser = resolve(values[++index]);
    else if (value === "--driver") options.driver = resolve(values[++index]);
    else if (value === "--output") options.output = resolve(values[++index]);
    else if (value === "--headed") options.headed = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.browser || !options.driver || !options.output) {
    throw new Error("--browser, --driver and --output are required");
  }
  return options;
}

function dataUrl(markup) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = performance.now();
  const service = await SlyWebDriverService.start(options.driver, { commandTimeout: 3_000 });
  let session;
  try {
    session = await service.createSession(options.browser, {
      headless: !options.headed,
      viewport: { width: 800, height: 600 },
      args: ["--force-device-scale-factor=1.25"],
      humanize: true,
      humanPreset: "careful",
      humanSeed: 42424,
    });
    await session.setTimeouts({ script: 3_000, pageLoad: 10_000, implicit: 0 });
    await session.get(dataUrl(`
      <input id="name" style="position:absolute;left:40px;top:40px;width:240px;height:40px" onclick="window.inputClicks=(window.inputClicks||0)+1">
      <button id="target" style="position:absolute;left:420px;top:260px;width:220px;height:90px" onclick="window.clicked=(window.clicked||0)+1">Target</button>
      <iframe id="test-frame" style="position:absolute;left:80px;top:380px;width:500px;height:180px"
        srcdoc="<button id='frame-target' style='position:absolute;left:120px;top:40px;width:180px;height:70px' onclick='window.clicked=(window.clicked||0)+1'>Frame target</button>"></iframe>
    `));

    const input = await session.findElement("#name");
    await input.type("node-humanize");
    const target = await session.findElement("#target");
    await target.click();
    const geometry = await session.executeScript(`
      const target = document.querySelector('#target');
      const bounding = target.getBoundingClientRect();
      const client = target.getClientRects()[0];
      return {
        dpr: devicePixelRatio,
        bounding: {x: bounding.x, y: bounding.y, width: bounding.width, height: bounding.height},
        client: {x: client.x, y: client.y, width: client.width, height: client.height},
        clicked: window.clicked || 0,
        inputClicks: window.inputClicks || 0,
        typed: document.querySelector('#name').value,
      };
    `);

    const frame = await session.findElement("#test-frame");
    await session.switchToFrame(frame);
    const frameTarget = await session.findElement("#frame-target");
    await frameTarget.click();
    const frameClicked = await session.executeScript("return window.clicked || 0");
    await session.switchToParentFrame();
    await session.performActions([{
      type: "pointer",
      id: "node-sdk-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 20, x: 40, y: 40, origin: "viewport" },
        { type: "pointerMove", duration: 20, x: 180, y: 120, origin: "viewport" },
      ],
    }]);

    const consistent = ["x", "y", "width", "height"].every(
      (name) => Math.abs(geometry.bounding[name] - geometry.client[name]) <= 0.01,
    );
    if (!consistent || geometry.dpr !== 1.25 || geometry.clicked !== 1 || geometry.inputClicks !== 0 || geometry.typed !== "node-humanize" || frameClicked !== 1) {
      throw new Error(`Node SDK Humanize matrix mismatch: ${JSON.stringify({ geometry, frameClicked })}`);
    }
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: "PASS",
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      matrix: { sdk: "node", headed: options.headed === true, page: true, frame: true, elementClick: true, elementType: true, dpi: 1.25, commandTimeoutMs: 3_000 },
      geometry,
      frameClicked,
      durationMs: Math.round(performance.now() - started),
    };
    await mkdir(resolve(options.output, ".."), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS Node SDK Native Humanize (${report.durationMs} ms)`);
    console.log(`artifact: ${options.output}`);
  } finally {
    if (session) await session.close();
    else await service.close();
  }
}

await main();
