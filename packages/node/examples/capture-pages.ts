import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { pageTargets, reportFailure, safePageName, withWebDriver } from "./common.js";

/**
 * Capture screenshots for a list of customer-approved pages. The example uses the
 * SDK's own WebDriver and keeps output filenames free of URL paths and query data.
 * It does not upload images or place them in the repository.
 *
 * SLYBROWSER_AUTHORIZATION_FILE=/secure/authorization.json \
 *   node capture-pages.js ./captures https://example.com
 */
async function main(): Promise<void> {
  const [outputArgument, ...pageArguments] = process.argv.slice(2);
  if (!outputArgument) {
    throw new Error("Usage: capture-pages <output-directory> <HTTP(S) URL> [...]");
  }
  const targets = await pageTargets(pageArguments);
  const outputDirectory = resolve(outputArgument);
  await mkdir(outputDirectory, { recursive: true });

  await withWebDriver(
    {
      launch: { headless: true, profileMode: "ephemeral" },
      profile: { screen: { width: 1440, height: 900 } },
    },
    async (browser) => {
      await browser.setTimeouts({ pageLoad: 30_000 });
      for (const [index, target] of targets.entries()) {
        await browser.get(target.href);
        const name = `${safePageName(target, index)}.png`;
        const destination = resolve(outputDirectory, name);
        await browser.screenshot(destination);
        const title = await browser.title();
        process.stdout.write(`${JSON.stringify({ host: target.host, title, file: destination })}\n`);
      }
    },
  );
}

void main().catch(reportFailure);
