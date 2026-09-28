import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { httpTarget, reportFailure, withWebDriver } from "./common.js";

interface FieldDraft {
  selector: string;
  value: string;
}

/**
 * Fill a draft form through native WebDriver typing. The script deliberately does
 * not submit the form, capture a screenshot, or print field values. Keep the local
 * JSON input private if it contains customer data or credentials.
 *
 * SLYBROWSER_AUTHORIZATION_FILE=/secure/authorization.json \
 *   node form-draft.js https://example.com/form ./fields.json
 *
 * fields.json: [{"selector":"input[name=company]","value":"Example Ltd"}]
 */
async function loadFields(file: string): Promise<FieldDraft[]> {
  const parsed: unknown = JSON.parse(await readFile(resolve(file), "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50) {
    throw new Error("The field file must contain 1 to 50 entries.");
  }
  return parsed.map((entry: unknown, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Field ${index + 1} must be an object.`);
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.selector !== "string" || !candidate.selector.trim()) {
      throw new Error(`Field ${index + 1} needs a CSS selector.`);
    }
    if (typeof candidate.value !== "string" || candidate.value.length > 4096) {
      throw new Error(`Field ${index + 1} needs a string value of at most 4096 characters.`);
    }
    return { selector: candidate.selector, value: candidate.value };
  });
}

async function main(): Promise<void> {
  const [urlArgument, fieldsArgument, extra] = process.argv.slice(2);
  if (!urlArgument || !fieldsArgument || extra) {
    throw new Error("Usage: form-draft <HTTP(S) form URL> <local fields.json>");
  }
  const target = httpTarget(urlArgument);
  const fields = await loadFields(fieldsArgument);

  await withWebDriver(
    {
      launch: { headless: false, profileMode: "ephemeral" },
      humanize: { enabled: true, preset: "careful" },
    },
    async (browser) => {
      await browser.get(target.href);
      for (const field of fields) {
        const element = await browser.findElement(field.selector);
        await element.type(field.value);
      }
      process.stdout.write(`${JSON.stringify({ host: target.host, title: await browser.title(), fieldsFilled: fields.length, submitted: false })}\n`);
    },
  );
}

void main().catch(reportFailure);
