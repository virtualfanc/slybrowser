import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareRuns, renderMarkdown } from "./compare.mjs";
import { summarizeResults } from "./score.mjs";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));

function parseArguments(arguments_) {
  let directory = null;
  let sites = resolve(scriptDirectory, "sites.json");
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--directory") directory = resolve(arguments_[++index]);
    else if (arguments_[index] === "--sites") sites = resolve(arguments_[++index]);
    else throw new Error(`Unknown argument: ${arguments_[index]}`);
  }
  if (!directory) throw new Error("--directory is required");
  return { directory, sites };
}

export function normalizeLegacyResults(results, sites) {
  const siteMap = new Map(sites.map((site) => [site.id, site]));
  let changed = 0;
  const normalized = results.map((result) => {
    if (result.status === "ERROR" && typeof result.score === "number") {
      changed += 1;
      return { ...result, score: null };
    }
    const site = siteMap.get(result.siteId);
    const isLegacyMissingRecaptchaScore = site?.adapter === "recaptcha-v3"
      && result.status === "FAIL"
      && result.score === 0
      && result.metrics?.recaptchaScore === null;
    if (!isLegacyMissingRecaptchaScore) return result;
    changed += 1;
    return {
      ...result,
      status: "EVIDENCE",
      score: null,
      methodologyNote: "No parseable reCAPTCHA score was present; retained as ungraded evidence.",
    };
  });
  return { results: normalized, changed };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const siteDocument = JSON.parse(await readFile(options.sites, "utf8"));
  const files = (await readdir(options.directory))
    .filter((name) => name.endsWith(".json") && name !== "comparison.json")
    .sort();
  const runs = [];
  let normalizedCount = 0;
  for (const name of files) {
    const path = resolve(options.directory, name);
    const run = JSON.parse(await readFile(path, "utf8"));
    if (run.schemaVersion !== 1 || !run.browser?.id || !Array.isArray(run.results)) continue;
    const normalization = normalizeLegacyResults(run.results, siteDocument.sites);
    run.results = normalization.results;
    normalizedCount += normalization.changed;
    run.summary = summarizeResults(run.results, siteDocument.sites);
    await writeFile(path, JSON.stringify(run, null, 2), "utf8");
    runs.push(run);
  }
  if (!runs.length) throw new Error("No detection run JSON files were found");
  if (runs.length >= 2) {
    const comparison = compareRuns(runs);
    await Promise.all([
      writeFile(resolve(options.directory, "comparison.json"), JSON.stringify(comparison, null, 2), "utf8"),
      writeFile(resolve(options.directory, "comparison.md"), renderMarkdown(comparison), "utf8"),
    ]);
  }
  console.log(`Rescored ${runs.length} run(s), normalized ${normalizedCount} legacy result(s): ${options.directory}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
