import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--sly") options.sly = resolve(values[++index]);
    else if (value === "--stock") options.stock = resolve(values[++index]);
    else if (value === "--node-sdk") options.nodeSdk = resolve(values[++index]);
    else if (value === "--python-sdk") options.pythonSdk = resolve(values[++index]);
    else if (value === "--java-sdk") options.javaSdk = resolve(values[++index]);
    else if (value === "--dotnet-sdk") options.dotnetSdk = resolve(values[++index]);
    else if (value === "--json") options.json = resolve(values[++index]);
    else if (value === "--markdown") options.markdown = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  for (const name of ["sly", "stock", "nodeSdk", "pythonSdk", "javaSdk", "dotnetSdk", "json", "markdown"]) {
    if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return options;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function browserMajor(version) {
  const match = String(version ?? "").match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function publicRun(run, id, name) {
  return {
    id,
    name,
    browserVersion: typeof run.browser?.browserVersion === "string" ? run.browser.browserVersion : null,
    driverVersion: typeof run.browser?.driverVersion === "string" ? run.browser.driverVersion : null,
    score: run.summary.score,
    rawScore: run.summary.rawScore,
    coverage: run.summary.coverage,
    qualification: run.summary.qualification,
    counts: run.summary.counts,
    categories: run.summary.categories,
  };
}

function scoreCell(result) {
  if (!result) return "—";
  if (Number.isFinite(result.score)) return `${result.status} ${result.score.toFixed(1)}`;
  return result.status;
}

function delta(sly, stock, comparable = true) {
  if (!comparable) return "Not comparable";
  const value = round(sly - stock);
  if (value === 0) return "Tie";
  return value > 0 ? `SlyBrowser +${value.toFixed(2)}` : `Stock +${Math.abs(value).toFixed(2)}`;
}

function sdkLine(label, sdk) {
  const score = Number.isFinite(sdk.score) ? `, score ${sdk.score.toFixed(2)}` : "";
  return `- ${label} package Native Humanize matrix: **${sdk.status}**${score} (Page, Frame, element click/type, headed, DPI).`;
}

function categoryRows(sly, stock, comparable) {
  const names = [...new Set([
    ...Object.keys(sly.summary.categories),
    ...Object.keys(stock.summary.categories),
  ])].sort();
  return names.map((name) => {
    const left = sly.summary.categories[name] ?? { score: 0, rawScore: 0, coverage: 0 };
    const right = stock.summary.categories[name] ?? { score: 0, rawScore: 0, coverage: 0 };
    return {
      category: name,
      slybrowser: left.score,
      stock: right.score,
      delta: comparable ? round(left.score - right.score) : null,
      slybrowserCoverage: left.coverage,
      stockCoverage: right.coverage,
    };
  });
}

function testRows(sly, stock) {
  const siteIds = [...new Set([...sly.results, ...stock.results].map((result) => result.siteId))].sort();
  return siteIds.map((siteId) => {
    const left = sly.results.find((result) => result.siteId === siteId);
    const right = stock.results.find((result) => result.siteId === siteId);
    return {
      siteId,
      name: left?.name ?? right?.name ?? siteId,
      category: left?.category ?? right?.category ?? "other",
      slybrowser: { status: left?.status ?? "MISSING", score: Number.isFinite(left?.score) ? round(left.score) : null },
      stock: { status: right?.status ?? "MISSING", score: Number.isFinite(right?.score) ? round(right.score) : null },
    };
  });
}

function renderMarkdown(report) {
  const [sly, stock] = report.browsers;
  const comparable = report.comparison?.sameMajor === true;
  const lines = [
    "# SlyBrowser vs stock Chromium: verified comparison",
    "",
    `Last verified: ${report.verifiedDate}.`,
    "",
    "Both browsers were tested on the same Windows x64 host, network and time window against the same 40-entry definition. SlyBrowser ran headed through the public Node package, its exact matched project WebDriver, Native Humanize in careful mode and the benchmark profile. The stock baseline ran headed through Playwright without SlyBrowser features.",
    "",
    ...((report.warnings ?? []).flatMap((warning) => [`> WARNING: ${warning}`, ""])),
    "## Comparison mode",
    "",
    comparable
      ? `Same-major comparison: Chromium ${report.comparison.slybrowserMajor}.`
      : `Cross-major evidence mode: SlyBrowser major ${report.comparison?.slybrowserMajor ?? "not provided"} vs stock major ${report.comparison?.stockChromiumMajor ?? "not provided"}. Numeric differences are suppressed.`,
    "",
    "## Browser versions",
    "",
    "| Browser | Version | Driver |",
    "| --- | --- | --- |",
    `| SlyBrowser | ${sly.browserVersion ?? "not provided"} | ${sly.driverVersion ?? "not provided"} |`,
    `| Stock Chromium | ${stock.browserVersion ?? "not provided"} | n/a |`,
    "",
    "## Headline results",
    "",
    "| Metric | SlyBrowser | Stock Chromium | Difference |",
    "| --- | ---: | ---: | ---: |",
    `| Coverage-adjusted score | ${sly.score.toFixed(2)} | ${stock.score.toFixed(2)} | ${delta(sly.score, stock.score, comparable)} |`,
    `| Raw measured score | ${sly.rawScore.toFixed(2)} | ${stock.rawScore.toFixed(2)} | ${delta(sly.rawScore, stock.rawScore, comparable)} |`,
    `| Required coverage | ${sly.coverage.toFixed(2)}% | ${stock.coverage.toFixed(2)}% | ${comparable ? (sly.coverage === stock.coverage ? "Tie" : `${delta(sly.coverage, stock.coverage)} pp`) : "Not comparable"} |`,
    "",
    "| Category | SlyBrowser | Stock Chromium | Difference | Coverage (Sly / stock) |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.categories.map((row) => `| ${row.category} | ${row.slybrowser.toFixed(2)} | ${row.stock.toFixed(2)} | ${row.delta === null ? "Not comparable" : delta(row.slybrowser, row.stock)} | ${row.slybrowserCoverage.toFixed(2)}% / ${row.stockCoverage.toFixed(2)}% |`),
    "",
    "## SDK and runtime proof",
    "",
    sdkLine("Node", report.sdk.node),
    sdkLine("Python", report.sdk.python),
    sdkLine("Java", report.sdk.java),
    sdkLine(".NET", report.sdk.dotnet),
    "- The SlyBrowser run rejects system-browser fallback and uses only the exact sibling browser/WebDriver pair.",
    "",
    "## All test outcomes",
    "",
    "| Test | Category | SlyBrowser | Stock Chromium |",
    "| --- | --- | ---: | ---: |",
    ...report.tests.map((row) => `| ${row.name.replace(/\|/g, "\\|")} | ${row.category} | ${scoreCell(row.slybrowser)} | ${scoreCell(row.stock)} |`),
    "",
    "> Live detection services can change. ERROR and EVIDENCE are not converted into invented zero scores. Owner-authorized protected-service endpoints remain SKIP unless explicitly configured.",
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [slyRaw, stockRaw, nodeSdk, pythonSdk, javaSdk, dotnetSdk] = await Promise.all([
    readFile(options.sly, "utf8").then(JSON.parse),
    readFile(options.stock, "utf8").then(JSON.parse),
    readFile(options.nodeSdk, "utf8").then(JSON.parse),
    readFile(options.pythonSdk, "utf8").then(JSON.parse),
    readFile(options.javaSdk, "utf8").then(JSON.parse),
    readFile(options.dotnetSdk, "utf8").then(JSON.parse),
  ]);
  const slyMajor = browserMajor(slyRaw.browser?.browserVersion);
  const stockMajor = browserMajor(stockRaw.browser?.browserVersion);
  const sameMajor = slyMajor !== null && stockMajor !== null && slyMajor === stockMajor;
  const report = {
    schemaVersion: 1,
    verifiedDate: new Date(slyRaw.completedAt).toISOString().slice(0, 10),
    methodology: {
      platform: "Windows x64",
      sameHost: true,
      sameNetwork: true,
      sameTimeWindow: true,
      siteCount: 40,
      slybrowser: "public Node package; exact project WebDriver pair; headed; Native Humanize careful; benchmark profile",
      stock: "Playwright; headed; stock Chromium baseline",
    },
    browsers: [
      publicRun(slyRaw, "slybrowser", "SlyBrowser"),
      publicRun(stockRaw, "stock-chromium", "Stock Chromium"),
    ],
    comparison: {
      mode: sameMajor ? "same-major" : "cross-major-evidence",
      sameMajor,
      slybrowserMajor: slyMajor,
      stockChromiumMajor: stockMajor,
      scoreDeltas: sameMajor ? {
        adjusted: round(slyRaw.summary.score - stockRaw.summary.score),
        raw: round(slyRaw.summary.rawScore - stockRaw.summary.rawScore),
        coveragePercentagePoints: round(slyRaw.summary.coverage - stockRaw.summary.coverage),
      } : null,
    },
    warnings: sameMajor ? [] : [
      "Browser major versions differ or are missing; public score and category differences are suppressed to avoid a cross-major claim.",
    ],
    categories: categoryRows(slyRaw, stockRaw, sameMajor),
    sdk: {
      node: { status: nodeSdk.status, score: nodeSdk.score, matrix: nodeSdk.matrix },
      python: { status: pythonSdk.status, score: pythonSdk.score, matrix: pythonSdk.matrix },
      java: { status: javaSdk.status, score: javaSdk.score, matrix: javaSdk.matrix },
      dotnet: { status: dotnetSdk.status, score: dotnetSdk.score, matrix: dotnetSdk.matrix },
    },
    tests: testRows(slyRaw, stockRaw),
    limitations: [
      "Live services can change after the verification date.",
      "ERROR and EVIDENCE do not receive invented scores.",
      "Owner-authorized protected-service endpoints remain SKIP when not configured.",
      "Numeric differences require a same-major stock Chromium baseline.",
    ],
  };
  await Promise.all([mkdir(dirname(options.json), { recursive: true }), mkdir(dirname(options.markdown), { recursive: true })]);
  await Promise.all([
    writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(options.markdown, renderMarkdown(report), "utf8"),
  ]);
  console.log(`public JSON: ${options.json}`);
  console.log(`public Markdown: ${options.markdown}`);
}

await main();
