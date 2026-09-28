import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { startChromeDriver } from "../detection/webdriver-client.mjs";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--browser") options.browser = resolve(values[++index]);
    else if (value === "--driver") options.driver = resolve(values[++index]);
    else if (value === "--stock-browser") options.stockBrowser = resolve(values[++index]);
    else if (value === "--output") options.output = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.browser || !options.driver || !options.stockBrowser || !options.output) {
    throw new Error("--browser, --driver, --stock-browser and --output are required");
  }
  return options;
}

async function attempt(driverExecutable, browserExecutable) {
  const driver = await startChromeDriver(driverExecutable);
  let client;
  try {
    client = await driver.createSession(browserExecutable, {
      headless: true,
      viewport: { width: 640, height: 480 },
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    return { accepted: true, browserVersion: client.capabilities.browserVersion ?? null };
  } catch (error) {
    return { accepted: false, error: String(error?.message ?? error) };
  } finally {
    await client?.quit().catch(() => undefined);
    await driver.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporary = await mkdtemp(join(tmpdir(), "sly-pairing-runtime-"));
  try {
    const copiedDriver = join(temporary, basename(options.driver));
    await copyFile(options.driver, copiedDriver);
    const copiedBrowser = join(temporary, basename(options.browser));
    await copyFile(options.browser, copiedBrowser);
    await appendFile(copiedBrowser, Buffer.from([0]));
    const renamedBrowser = join(dirname(options.driver), `renamed-${basename(options.browser)}`);
    await copyFile(options.browser, renamedBrowser);
    try {
      const exact = await attempt(options.driver, options.browser);
      const systemChrome = await attempt(options.driver, options.stockBrowser);
      const copiedAndModified = await attempt(copiedDriver, copiedBrowser);
      const renamed = await attempt(options.driver, renamedBrowser);
      const checks = {
        exactPairAccepted: exact.accepted,
        systemChromeRejected: !systemChrome.accepted && /pairing failed/i.test(systemChrome.error ?? ""),
        copiedModifiedPairRejected: !copiedAndModified.accepted && /pairing failed/i.test(copiedAndModified.error ?? ""),
        renamedBrowserRejected: !renamed.accepted && /pairing failed/i.test(renamed.error ?? ""),
      };
      const result = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
        checks,
        attempts: { exact, systemChrome, copiedAndModified, renamed },
      };
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result, null, 2));
      console.log(`artifact: ${options.output}`);
      if (result.status !== "PASS") process.exitCode = 1;
    } finally {
      await rm(renamedBrowser, { force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
