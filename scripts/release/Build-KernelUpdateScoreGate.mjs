import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

function parseArguments(values) {
  const options = {
    minimumSlyScore: 80,
    minimumDelta: 0,
    allowProvisional: false,
    allowLatestStockBaseline: false,
    reportOnly: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--comparison") options.comparison = resolve(values[++index]);
    else if (value === "--output-dir") options.outputDir = resolve(values[++index]);
    else if (value === "--run-dir") options.runDir = resolve(values[++index]);
    else if (value === "--minimum-sly-score") options.minimumSlyScore = Number(values[++index]);
    else if (value === "--minimum-delta") options.minimumDelta = Number(values[++index]);
    else if (value === "--allow-provisional") options.allowProvisional = true;
    else if (value === "--allow-latest-stock-baseline") options.allowLatestStockBaseline = true;
    else if (value === "--report-only") options.reportOnly = true;
    else if (value === "--sly-browser") options.slyBrowser = resolve(values[++index]);
    else if (value === "--sly-driver") options.slyDriver = resolve(values[++index]);
    else if (value === "--stock-browser") options.stockBrowser = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.comparison) throw new Error("--comparison is required");
  if (!options.outputDir) throw new Error("--output-dir is required");
  if (!Number.isFinite(options.minimumSlyScore)) throw new Error("--minimum-sly-score must be numeric");
  if (!Number.isFinite(options.minimumDelta)) throw new Error("--minimum-delta must be numeric");
  return options;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatScore(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "not comparable";
}

function majorVersion(value) {
  const match = String(value ?? "").match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function findBrowser(report, id) {
  const browser = report.browsers?.find((item) => item.id === id);
  if (!browser) throw new Error(`Comparison report does not include ${id}`);
  return browser;
}

function sdkRows(report) {
  return Object.entries(report.sdk ?? {}).map(([language, sdk]) => ({
    language,
    status: sdk?.status ?? "MISSING",
    score: Number.isFinite(sdk?.score) ? round(sdk.score) : null,
  }));
}

function pushGate(gates, id, label, passed, details = {}) {
  gates.push({ id, label, status: passed ? "PASS" : "FAIL", ...details });
}

async function fileDigest(path) {
  if (!path) return null;
  const [metadata, data] = await Promise.all([stat(path), readFile(path)]);
  return {
    file: basename(path),
    sizeBytes: metadata.size,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function renderMarkdown(summary) {
  const sly = summary.results.slybrowser;
  const stock = summary.results.stockChromium;
  const deltaGate = summary.results.sameMajorComparison
    ? `minimum ${summary.criteria.minimumDelta.toFixed(2)}`
    : summary.results.latestStockBaselineAccepted
      ? "latest stock baseline accepted; delta informational only"
      : "same-major baseline required";
  const lines = [
    "# Kernel update score gate",
    "",
    `Generated: ${summary.generatedAt}.`,
    `Status: **${summary.status}**.`,
    "",
    "| Metric | SlyBrowser | Stock Chromium | Gate |",
    "| --- | ---: | ---: | --- |",
    `| Coverage-adjusted score | ${sly.score.toFixed(2)} | ${stock.score.toFixed(2)} | minimum SlyBrowser ${summary.criteria.minimumSlyScore.toFixed(2)} |`,
    `| Raw measured score | ${sly.rawScore.toFixed(2)} | ${stock.rawScore.toFixed(2)} | informational |`,
    `| Score delta | ${formatScore(summary.results.scoreDelta)} | — | ${deltaGate} |`,
    `| Latest baseline informational delta | ${formatScore(summary.results.informationalLatestScoreDelta)} | — | not used for public win/loss claims |`,
    `| Required coverage | ${sly.coverage.toFixed(2)}% | ${stock.coverage.toFixed(2)}% | ${summary.criteria.allowProvisional ? "provisional allowed" : "qualified required"} |`,
    "",
    "## Browser identity",
    "",
    "| Browser | Version | Driver |",
    "| --- | --- | --- |",
    `| SlyBrowser | ${sly.browserVersion ?? "not provided"} | ${sly.driverVersion ?? "not provided"} |`,
    `| Stock Chromium | ${stock.browserVersion ?? "not provided"} | n/a |`,
    "",
    "| Gate | Status | Notes |",
    "| --- | --- | --- |",
    ...summary.gates.map((gate) => `| ${gate.label} | ${gate.status} | ${gate.notes ?? ""} |`),
    "",
    "## SDK runtime evidence",
    "",
    "| Language | Status | Score |",
    "| --- | --- | ---: |",
    ...summary.sdk.map((row) => `| ${row.language} | ${row.status} | ${row.score === null ? "—" : row.score.toFixed(2)} |`),
    "",
    "Browser version fields are copied from the saved comparison evidence when supplied. Keep raw secrets, local source paths and private signing material out of public artifacts.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = JSON.parse(await readFile(options.comparison, "utf8"));
  const sly = findBrowser(report, "slybrowser");
  const stock = findBrowser(report, "stock-chromium");
  const slyMajor = majorVersion(sly.browserVersion);
  const stockMajor = majorVersion(stock.browserVersion);
  const sameMajorComparison = slyMajor !== null && stockMajor !== null && slyMajor === stockMajor;
  const latestStockBaselineAccepted = !sameMajorComparison && options.allowLatestStockBaseline;
  const stockBaselineAccepted = sameMajorComparison || latestStockBaselineAccepted;
  const scoreDelta = sameMajorComparison ? round(sly.score - stock.score) : null;
  const informationalLatestScoreDelta = latestStockBaselineAccepted ? round(sly.score - stock.score) : null;
  const sdk = sdkRows(report);
  const gates = [];

  pushGate(
    gates,
    "sly-score-floor",
    "SlyBrowser score floor",
    sly.score >= options.minimumSlyScore,
    { notes: `${round(sly.score).toFixed(2)} >= ${options.minimumSlyScore.toFixed(2)}` },
  );
  pushGate(
    gates,
    "stock-baseline",
    "Accepted stock Chromium baseline",
    stockBaselineAccepted,
    {
      notes: sameMajorComparison
        ? `same Chromium major ${slyMajor}`
        : latestStockBaselineAccepted
          ? `latest stock baseline accepted for current release policy; SlyBrowser ${sly.browserVersion ?? "not provided"} vs stock ${stock.browserVersion ?? "not provided"}`
          : `same-major baseline required; SlyBrowser ${sly.browserVersion ?? "not provided"} vs stock ${stock.browserVersion ?? "not provided"}`,
    },
  );
  pushGate(
    gates,
    "stock-delta",
    "SlyBrowser delta versus stock Chromium",
    sameMajorComparison ? scoreDelta >= options.minimumDelta : latestStockBaselineAccepted,
    {
      notes: sameMajorComparison
        ? `${scoreDelta.toFixed(2)} >= ${options.minimumDelta.toFixed(2)}`
        : latestStockBaselineAccepted
          ? "not used as a public win/loss delta because the accepted latest stock baseline differs in major version"
          : "not comparable until an accepted stock baseline is supplied",
    },
  );
  pushGate(
    gates,
    "sly-qualification",
    "SlyBrowser required coverage qualification",
    options.allowProvisional || sly.qualification === "qualified",
    { notes: sly.qualification },
  );
  pushGate(
    gates,
    "stock-qualification",
    "Stock Chromium required coverage qualification",
    options.allowProvisional || stock.qualification === "qualified",
    { notes: stock.qualification },
  );
  const sdkFailures = sdk.filter((row) => row.status !== "PASS");
  pushGate(
    gates,
    "sdk-native-humanize",
    "SDK Native Humanize parity",
    sdk.length >= 4 && sdkFailures.length === 0,
    { notes: sdkFailures.length ? sdkFailures.map((row) => `${row.language}:${row.status}`).join(", ") : "all configured SDKs PASS" },
  );

  const status = gates.every((gate) => gate.status === "PASS") ? "PASS" : "FAIL";
  const outputJson = resolve(options.outputDir, "kernel-update-score-gate.json");
  const outputMarkdown = resolve(options.outputDir, "kernel-update-score-gate.md");
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    mode: "kernel-update-score-gate",
    criteria: {
      minimumSlyScore: options.minimumSlyScore,
      minimumDelta: options.minimumDelta,
      allowProvisional: options.allowProvisional,
      allowLatestStockBaseline: options.allowLatestStockBaseline,
      sameMajorRequired: !options.allowLatestStockBaseline,
    },
    evidence: {
      comparison: options.comparison,
      runDirectory: options.runDir ?? dirname(options.comparison),
      publicOutputs: {
        comparisonJson: options.comparison,
        comparisonMarkdown: options.comparison.replace(/\.json$/i, ".md"),
      },
      binaries: {
        slyBrowser: await fileDigest(options.slyBrowser),
        slyDriver: await fileDigest(options.slyDriver),
        stockBrowser: await fileDigest(options.stockBrowser),
      },
    },
    results: {
      slybrowser: {
        browserVersion: typeof sly.browserVersion === "string" ? sly.browserVersion : null,
        driverVersion: typeof sly.driverVersion === "string" ? sly.driverVersion : null,
        browserMajor: slyMajor,
        score: round(sly.score),
        rawScore: round(sly.rawScore),
        coverage: round(sly.coverage),
        qualification: sly.qualification,
        counts: sly.counts,
      },
      stockChromium: {
        browserVersion: typeof stock.browserVersion === "string" ? stock.browserVersion : null,
        driverVersion: typeof stock.driverVersion === "string" ? stock.driverVersion : null,
        browserMajor: stockMajor,
        score: round(stock.score),
        rawScore: round(stock.rawScore),
        coverage: round(stock.coverage),
        qualification: stock.qualification,
        counts: stock.counts,
      },
      sameMajorComparison,
      latestStockBaselineAccepted,
      scoreDelta,
      informationalLatestScoreDelta,
      rawScoreDelta: sameMajorComparison ? round(sly.rawScore - stock.rawScore) : null,
    },
    sdk,
    gates,
  };
  await mkdir(options.outputDir, { recursive: true });
  await Promise.all([
    writeFile(outputJson, `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
    writeFile(outputMarkdown, renderMarkdown(summary), "utf8"),
  ]);
  console.log(`kernel update gate JSON: ${outputJson}`);
  console.log(`kernel update gate Markdown: ${outputMarkdown}`);
  if (status !== "PASS" && !options.reportOnly) {
    throw new Error(`Kernel update score gate failed: ${gates.filter((gate) => gate.status !== "PASS").map((gate) => gate.id).join(", ")}`);
  }
}

await main();
