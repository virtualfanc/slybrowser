import { pageTargets, reportFailure, withWebDriver } from "./common.js";

interface PageSummary {
  host: string;
  title: string;
  description: string | null;
  heading: string | null;
  linkCount: number;
}

/**
 * Read a small collection of pages through the matched Sly WebDriver. This is a
 * practical starting point for customer-owned content inventories: it keeps one
 * licensed browser open, visits pages serially, and emits one JSON object per page.
 *
 * SLYBROWSER_AUTHORIZATION_FILE=/secure/authorization.json \
 *   node collect-pages.js https://example.com https://example.org
 *
 * A text file can be passed as `--file pages.txt`. Page URLs and captured content
 * can be sensitive; direct the JSON output to a private destination.
 */
async function main(): Promise<void> {
  const targets = await pageTargets(process.argv.slice(2));
  await withWebDriver(
    {
      launch: { headless: true, profileMode: "ephemeral" },
      profile: { locale: "en-US", languages: ["en-US", "en"] },
    },
    async (browser) => {
      await browser.setTimeouts({ pageLoad: 30_000, script: 10_000 });
      for (const target of targets) {
        await browser.get(target.href);
        const title = await browser.title();
        const metadata = await browser.executeScript(`
          const description = document.querySelector('meta[name="description"]');
          const heading = document.querySelector('h1');
          return {
            description: description?.getAttribute('content') ?? null,
            heading: heading?.textContent?.trim() ?? null,
            linkCount: document.querySelectorAll('a[href]').length,
          };
        `) as { description: string | null; heading: string | null; linkCount: number };
        const summary: PageSummary = {
          host: target.host,
          title,
          description: metadata.description,
          heading: metadata.heading,
          linkCount: metadata.linkCount,
        };
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      }
    },
  );
}

void main().catch(reportFailure);
