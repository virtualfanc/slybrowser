import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

function parse(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--sly-browser") options.sly = resolve(values[++index]);
    else if (values[index] === "--stock-browser") options.stock = resolve(values[++index]);
    else if (values[index] === "--output") options.output = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  if (!options.sly || !options.stock) throw new Error("--sly-browser and --stock-browser are required");
  return options;
}

async function run(executable, url) {
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const webauthn = await page.evaluate(() => ({
      publicKeyCredential: typeof PublicKeyCredential === "function",
      credentialsCreate: typeof navigator.credentials?.create === "function",
      credentialsGet: typeof navigator.credentials?.get === "function",
    }));
    const dialogPromise = new Promise((accept) => page.once("dialog", async (dialog) => {
      const value = { type: dialog.type(), message: dialog.message() };
      await dialog.dismiss();
      accept(value);
    }));
    await page.evaluate(() => setTimeout(() => alert("SlyBrowser dialog contract"), 0));
    const dialog = await dialogPromise;
    let externalProtocolRejected = false;
    try {
      await page.goto("slybrowser-compatibility-test://open", { timeout: 5000, waitUntil: "commit" });
    } catch {
      externalProtocolRejected = true;
    }
    const rendererResponsive = await page.evaluate(() => 2 + 2).catch(() => null) === 4;
    return { webauthn, dialog, externalProtocolRejected, rendererResponsive };
  } finally {
    await browser.close();
  }
}

const options = parse(process.argv.slice(2));
await Promise.all([options.sly, options.stock].map(async (path) => {
  if (!(await stat(path)).isFile()) throw new Error(`Browser is missing: ${path}`);
}));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>browser API compatibility</title><body>ready</body>");
});
await new Promise((accept, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", accept);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Probe server did not bind");
try {
  const url = `http://127.0.0.1:${address.port}/`;
  const [sly, stock] = await Promise.all([run(options.sly, url), run(options.stock, url)]);
  const checks = {
    webauthnMatchesStock: JSON.stringify(sly.webauthn) === JSON.stringify(stock.webauthn),
    dialogMatchesStock: JSON.stringify(sly.dialog) === JSON.stringify(stock.dialog),
    externalProtocolMatchesStock: sly.externalProtocolRejected === stock.externalProtocolRejected,
    slyRemainsResponsive: sly.rendererResponsive,
  };
  const result = { schemaVersion: 1, status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, sly, stock };
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
} finally {
  await new Promise((accept) => server.close(() => accept()));
}
