import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function comparison(overrides = {}) {
  return {
    schemaVersion: 1,
    verifiedDate: "2026-08-23",
    browsers: [
      {
        id: "slybrowser",
        name: "SlyBrowser",
        browserVersion: overrides.slyBrowserVersion ?? "148.0.7778.179",
        driverVersion: overrides.slyDriverVersion ?? "148.0.7778.179",
        score: overrides.slyScore ?? 91.25,
        rawScore: overrides.slyRawScore ?? 94.5,
        coverage: overrides.slyCoverage ?? 100,
        qualification: overrides.slyQualification ?? "qualified",
        counts: { pass: 18, fail: 1, evidence: 3, skip: 18, error: 0 },
      },
      {
        id: "stock-chromium",
        name: "Stock Chromium",
        browserVersion: overrides.stockBrowserVersion ?? "148.0.8003.0",
        score: overrides.stockScore ?? 72.1,
        rawScore: overrides.stockRawScore ?? 75,
        coverage: overrides.stockCoverage ?? 100,
        qualification: overrides.stockQualification ?? "qualified",
        counts: { pass: 10, fail: 9, evidence: 3, skip: 18, error: 0 },
      },
    ],
    sdk: {
      node: { status: "PASS", score: 100 },
      python: { status: "PASS", score: 100 },
      java: { status: "PASS", score: 100 },
      dotnet: { status: "PASS", score: 100 },
    },
    tests: [],
  };
}

test("kernel update score gate passes and emits saved browser identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-kernel-score-gate-"));
  try {
    const input = join(root, "comparison.json");
    await writeFile(input, JSON.stringify(comparison()), "utf8");
    execFileSync(process.execPath, [
      resolve("scripts/release/Build-KernelUpdateScoreGate.mjs"),
      "--comparison", input,
      "--output-dir", root,
      "--minimum-sly-score", "80",
      "--minimum-delta", "1",
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(join(root, "kernel-update-score-gate.json"), "utf8"));
    const human = await readFile(join(root, "kernel-update-score-gate.md"), "utf8");
    assert.equal(machine.status, "PASS");
    assert.equal(machine.results.scoreDelta, 19.15);
    assert.equal(machine.results.slybrowser.browserVersion, "148.0.7778.179");
    assert.equal(machine.results.slybrowser.driverVersion, "148.0.7778.179");
    assert.equal(machine.results.stockChromium.browserVersion, "148.0.8003.0");
    assert.equal(machine.results.sameMajorComparison, true);
    assert.deepEqual(machine.gates.map((gate) => gate.status), ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    const rendered = `${JSON.stringify(machine)}\n${human}`;
    assert.equal(rendered.includes("148.0.7778.179"), true);
    assert.equal(rendered.includes("148.0.8003.0"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kernel update score gate fails cross-major comparisons without inventing a delta", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-kernel-score-gate-cross-major-"));
  try {
    const input = join(root, "comparison.json");
    await writeFile(input, JSON.stringify(comparison({ stockBrowserVersion: "153.0.8003.0" })), "utf8");
    execFileSync(process.execPath, [
      resolve("scripts/release/Build-KernelUpdateScoreGate.mjs"),
      "--comparison", input,
      "--output-dir", root,
      "--minimum-sly-score", "80",
      "--minimum-delta", "1",
      "--report-only",
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(join(root, "kernel-update-score-gate.json"), "utf8"));
    const human = await readFile(join(root, "kernel-update-score-gate.md"), "utf8");
    assert.equal(machine.status, "FAIL");
    assert.equal(machine.results.sameMajorComparison, false);
    assert.equal(machine.results.scoreDelta, null);
    assert.equal(machine.results.rawScoreDelta, null);
    assert.deepEqual(
      machine.gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id),
      ["stock-baseline", "stock-delta"],
    );
    assert.match(human, /same-major baseline required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kernel update score gate accepts latest stock baseline when explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-kernel-score-gate-latest-"));
  try {
    const input = join(root, "comparison.json");
    await writeFile(input, JSON.stringify(comparison({ stockBrowserVersion: "154.0.8013.2" })), "utf8");
    execFileSync(process.execPath, [
      resolve("scripts/release/Build-KernelUpdateScoreGate.mjs"),
      "--comparison", input,
      "--output-dir", root,
      "--minimum-sly-score", "80",
      "--minimum-delta", "1",
      "--allow-latest-stock-baseline",
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(join(root, "kernel-update-score-gate.json"), "utf8"));
    const human = await readFile(join(root, "kernel-update-score-gate.md"), "utf8");
    assert.equal(machine.status, "PASS");
    assert.equal(machine.criteria.allowLatestStockBaseline, true);
    assert.equal(machine.results.sameMajorComparison, false);
    assert.equal(machine.results.latestStockBaselineAccepted, true);
    assert.equal(machine.results.scoreDelta, null);
    assert.equal(machine.results.informationalLatestScoreDelta, 19.15);
    assert.deepEqual(machine.gates.map((gate) => gate.status), ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    assert.match(human, /latest stock baseline accepted/);
    assert.match(human, /not used as a public win\/loss delta/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kernel update score gate can create report-only failure evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-kernel-score-gate-fail-"));
  try {
    const input = join(root, "comparison.json");
    await writeFile(input, JSON.stringify(comparison({ slyScore: 75, stockScore: 80, slyQualification: "provisional" })), "utf8");
    execFileSync(process.execPath, [
      resolve("scripts/release/Build-KernelUpdateScoreGate.mjs"),
      "--comparison", input,
      "--output-dir", root,
      "--minimum-sly-score", "80",
      "--minimum-delta", "0",
      "--report-only",
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(join(root, "kernel-update-score-gate.json"), "utf8"));
    assert.equal(machine.status, "FAIL");
    assert.deepEqual(
      machine.gates.filter((gate) => gate.status === "FAIL").map((gate) => gate.id),
      ["sly-score-floor", "stock-delta", "sly-qualification"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
