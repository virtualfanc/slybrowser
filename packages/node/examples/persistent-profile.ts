import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { httpTarget, reportFailure, withWebDriver } from "./common.js";

/**
 * Reuse one local profile across separate SlyBrowser launches. A persistent profile
 * can retain site state, so select a private directory dedicated to this account.
 * Browser launches remain serial to respect a one-process Free license.
 *
 * SLYBROWSER_AUTHORIZATION_FILE=/secure/authorization.json \
 *   node persistent-profile.js ./profiles/customer-a https://example.com
 */
async function main(): Promise<void> {
  const [directoryArgument, urlArgument, extra] = process.argv.slice(2);
  if (!directoryArgument || !urlArgument || extra) {
    throw new Error("Usage: persistent-profile <profile-directory> <HTTP(S) URL>");
  }
  const profileDirectory = resolve(directoryArgument);
  const target = httpTarget(urlArgument);
  await mkdir(profileDirectory, { recursive: true });

  const options = {
    launch: {
      headless: true,
      profileMode: "persistent" as const,
      profileDirectory,
      updateKernel: false,
    },
    profile: { locale: "en-US", languages: ["en-US", "en"] },
  };

  await withWebDriver(options, async (browser) => {
    await browser.get(target.href);
    process.stdout.write(`${JSON.stringify({ phase: "first", host: target.host, title: await browser.title() })}\n`);
  });

  // The first browser has closed before the second launch acquires a new session.
  await withWebDriver(options, async (browser) => {
    await browser.get(target.href);
    process.stdout.write(`${JSON.stringify({ phase: "reopened", host: target.host, title: await browser.title() })}\n`);
  });
}

void main().catch(reportFailure);
