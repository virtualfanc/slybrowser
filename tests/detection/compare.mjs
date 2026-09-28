import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(arguments_) {
  const inputs = [];
  let output = "detection-comparison.md";
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === "--input") inputs.push(arguments_[++index]);
    else if (arguments_[index] === "--output") output = arguments_[++index];
    else throw new Error(`Unknown argument: ${arguments_[index]}`);
  }
  if (inputs.length < 2) throw new Error("At least two --input result files are required");
  return { inputs, output };
}

function cell(result) {
  if (!result) return "—";
  if ((result.status === "PASS" || result.status === "FAIL") && typeof result.score === "number") {
    return `${result.status} ${result.score.toFixed(1)}`;
  }
  return result.status;
}

function major(version) {
  const match = String(version ?? "").match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function tlsFingerprint(run) {
  const result = run.results.find((item) => item.siteId === "tls-peet");
  return result?.metrics?.fingerprints ?? null;
}

export function compareRuns(runs) {
  const warnings = [];
  const majorEntries = runs.map((run) => ({
    browserId: run.browser.id,
    browserVersion: run.browser.browserVersion ?? null,
    major: major(run.browser.browserVersion),
  }));
  const missingMajors = majorEntries.filter((entry) => entry.major === null);
  const majors = new Set(majorEntries.map((entry) => entry.major).filter((value) => value !== null));
  const scoreComparisonsAllowed = missingMajors.length === 0 && majors.size === 1;
  if (missingMajors.length > 0) {
    warnings.push(`Browser major version is missing for ${missingMajors.map((entry) => entry.browserId).join(", ")}; score differences are evidence-only.`);
  }
  if (majors.size > 1) warnings.push("Browser major versions differ; TLS, JavaScript fingerprint, and score comparisons are not like-for-like.");
  if (!scoreComparisonsAllowed) warnings.push("Numeric score differences are suppressed until every run uses the same browser major.");
  if (runs.some((run) => run.summary.qualification !== "qualified")) {
    warnings.push("At least one run has less than 80% required coverage; its score is provisional.");
  }

  const siteIds = [...new Set(runs.flatMap((run) => run.results.map((result) => result.siteId)))].sort();
  const rows = siteIds.map((siteId) => ({
    siteId,
    values: Object.fromEntries(runs.map((run) => [run.browser.id, run.results.find((item) => item.siteId === siteId)])),
  }));
  const baseline = runs.find((run) => run.browser.id === "stock-playwright") ?? runs[0];
  const baselineTls = tlsFingerprint(baseline);
  const tlsParity = Object.fromEntries(runs.map((run) => {
    const current = tlsFingerprint(run);
    const comparable = baselineTls && current && major(run.browser.browserVersion) === major(baseline.browser.browserVersion);
    return [run.browser.id, comparable ? JSON.stringify(current) === JSON.stringify(baselineTls) : null];
  }));
  const scoreDeltas = scoreComparisonsAllowed ? Object.fromEntries(runs.map((run) => [
    run.browser.id,
    {
      adjusted: Number((run.summary.score - baseline.summary.score).toFixed(2)),
      raw: Number((run.summary.rawScore - baseline.summary.rawScore).toFixed(2)),
    },
  ])) : null;
  return {
    runs,
    rows,
    warnings,
    baseline: baseline.browser.id,
    tlsParity,
    comparisonMode: scoreComparisonsAllowed ? "same-major" : "evidence-only",
    scoreComparisonsAllowed,
    browserMajors: majorEntries,
    scoreDeltas,
  };
}

export function renderMarkdown(comparison) {
  const { runs, rows, warnings, baseline, tlsParity, scoreComparisonsAllowed } = comparison;
  const scoreLabel = scoreComparisonsAllowed ? "Adjusted score" : "Adjusted score (evidence only; not comparable)";
  const rawScoreLabel = scoreComparisonsAllowed ? "Raw score" : "Raw score (evidence only; not comparable)";
  const lines = [
    "# Detection benchmark comparison",
    "",
    `Baseline: \`${baseline}\`. Scores include only configured graded tests; evidence-only pages are shown without invented scores.`,
    "",
  ];
  for (const warning of warnings) lines.push(`> WARNING: ${warning}`, "");
  lines.push(
    `| Metric | ${runs.map((run) => run.browser.name).join(" | ")} |`,
    `| --- | ${runs.map(() => "---:").join(" | ")} |`,
    `| ${scoreLabel} | ${runs.map((run) => run.summary.score.toFixed(2)).join(" | ")} |`,
    `| ${rawScoreLabel} | ${runs.map((run) => run.summary.rawScore.toFixed(2)).join(" | ")} |`,
    `| Coverage | ${runs.map((run) => `${run.summary.coverage.toFixed(2)}%`).join(" | ")} |`,
    `| Qualification | ${runs.map((run) => run.summary.qualification).join(" | ")} |`,
    `| TLS parity with baseline | ${runs.map((run) => tlsParity[run.browser.id] === null ? "N/A" : tlsParity[run.browser.id] ? "MATCH" : "DIFF").join(" | ")} |`,
    "",
    `| Test | ${runs.map((run) => run.browser.name).join(" | ")} |`,
    `| --- | ${runs.map(() => "---").join(" | ")} |`,
  );
  for (const row of rows) {
    lines.push(`| ${row.siteId} | ${runs.map((run) => cell(row.values[run.browser.id])).join(" | ")} |`);
  }
  lines.push("", "Generated from saved JSON evidence. Live services can change; compare runs made on the same date, network, host, and browser major.", "");
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const runs = await Promise.all(options.inputs.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const comparison = compareRuns(runs);
  await writeFile(options.output, renderMarkdown(comparison), "utf8");
  const jsonOutput = options.output.slice(0, -extname(options.output).length) + ".json";
  await writeFile(jsonOutput, JSON.stringify(comparison, null, 2), "utf8");
  console.log(`${basename(options.output)}\n${basename(jsonOutput)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
