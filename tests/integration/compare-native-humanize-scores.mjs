import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const requiredLanguages = ["node", "python", "java", "dotnet"];

function parseArguments(values) {
  const options = { reports: new Map(), output: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--report") {
      const language = values[++index];
      const file = values[++index];
      if (!requiredLanguages.includes(language)) throw new Error(`Unsupported language: ${language}`);
      options.reports.set(language, resolve(file));
    } else if (value === "--output") {
      options.output = resolve(values[++index]);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  for (const language of requiredLanguages) {
    if (!options.reports.has(language)) throw new Error(`Missing --report ${language} <file>`);
  }
  if (!options.output) throw new Error("--output is required");
  return options;
}

function numericScore(language, report) {
  if (report.status !== "PASS") {
    throw new Error(`${language} Native Humanize matrix did not pass: ${report.status}`);
  }
  if (!Number.isFinite(report.score)) {
    throw new Error(`${language} Native Humanize matrix did not include a numeric score`);
  }
  return Math.round(report.score * 100) / 100;
}

function renderMarkdown(summary) {
  return [
    "# Native Humanize SDK score parity",
    "",
    `Generated: ${summary.generatedAt}.`,
    `Baseline: Node SDK score ${summary.baselineScore.toFixed(2)}.`,
    "",
    "| Language | Status | Score | Delta vs Node |",
    "| --- | --- | ---: | ---: |",
    ...summary.languages.map((row) => `| ${row.language} | ${row.status} | ${row.score.toFixed(2)} | ${row.deltaFromNode.toFixed(2)} |`),
    "",
    summary.pass
      ? "All SDK scores meet or exceed the Node SDK baseline."
      : "At least one SDK score is below the Node SDK baseline.",
    "",
  ].join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const reports = Object.fromEntries(await Promise.all(
    [...options.reports.entries()].map(async ([language, file]) => [
      language,
      { file, report: JSON.parse(await readFile(file, "utf8")) },
    ]),
  ));
  const baselineScore = numericScore("node", reports.node.report);
  const languages = requiredLanguages.map((language) => {
    const score = numericScore(language, reports[language].report);
    return {
      language,
      status: reports[language].report.status,
      score,
      deltaFromNode: Math.round((score - baselineScore) * 100) / 100,
      report: reports[language].file,
      runtime: reports[language].report.runtime,
      checks: reports[language].report.checks,
    };
  });
  const failures = languages.filter((row) => row.score < baselineScore);
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseline: "node",
    baselineScore,
    pass: failures.length === 0,
    languages,
    failures,
  };
  const markdownPath = options.output.replace(/\.json$/i, ".md");
  await Promise.all([mkdir(dirname(options.output), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
  await Promise.all([
    writeFile(options.output, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdown(summary), "utf8"),
  ]);
  console.log(`score parity JSON: ${options.output}`);
  console.log(`score parity Markdown: ${markdownPath}`);
  if (!summary.pass) {
    throw new Error(`SDK score parity failed: ${failures.map((row) => `${row.language} ${row.score}`).join(", ")}`);
  }
}

await main();
