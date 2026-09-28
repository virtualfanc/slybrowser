import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { launch, type SlyBrowserOptions, type SlyWebDriverSession } from "slybrowser";

const AUTHORIZATION_VARIABLE = "SLYBROWSER_AUTHORIZATION_FILE";

/**
 * Keep the authorization certificate out of source control and CLI history. The SDK
 * reads it from disk and performs the service exchange; examples never print it.
 */
export async function authorizationFile(): Promise<string> {
  const configured = process.env[AUTHORIZATION_VARIABLE]?.trim();
  if (!configured) {
    throw new Error(`Set ${AUTHORIZATION_VARIABLE} to the path of your authorization file.`);
  }
  const absolute = resolve(configured);
  await access(absolute);
  return absolute;
}

/** Reject local files, browser-internal URLs, and credentials in URL authority. */
export function httpTarget(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only HTTP and HTTPS pages are supported: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Put website credentials in an approved application flow, not a URL.");
  }
  return url;
}

/**
 * Accept a few URLs directly or a UTF-8 text file via --file. Keeping the file local
 * is useful for repeatable runs without publishing private customer URLs.
 */
export async function pageTargets(arguments_: readonly string[]): Promise<URL[]> {
  let inputs: string[];
  if (arguments_[0] === "--file") {
    const file = arguments_[1];
    if (!file || arguments_.length !== 2) {
      throw new Error("Usage: --file <UTF-8 file with one HTTP(S) URL per line>");
    }
    const text = await readFile(resolve(file), "utf8");
    inputs = text.split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } else {
    inputs = [...arguments_];
  }
  if (inputs.length === 0) throw new Error("Provide at least one HTTP(S) URL.");
  if (inputs.length > 100) throw new Error("Limit a run to 100 pages; split larger jobs.");
  return inputs.map(httpTarget);
}

/** Use one browser session and close it even when a page fails. */
export async function withWebDriver<T>(
  options: SlyBrowserOptions,
  action: (browser: SlyWebDriverSession) => Promise<T>,
): Promise<T> {
  const browser = await launch(await authorizationFile(), options);
  try {
    return await action(browser);
  } finally {
    await browser.close();
  }
}

/** Avoid putting URL paths, query strings, or fragments into output filenames. */
export function safePageName(url: URL, index: number): string {
  const host = url.hostname.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").slice(0, 48);
  const digest = createHash("sha256").update(url.href).digest("hex").slice(0, 10);
  return `${String(index + 1).padStart(3, "0")}-${host || "page"}-${digest}`;
}

/** Log an error without including authorization file contents or URL credentials. */
export function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${basename(process.argv[1] ?? "example")}: ${message}\n`);
  process.exitCode = 1;
}
