import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function runReport(browserVersion, score, rawScore = score) {
  return {
    completedAt: "2026-08-23T00:00:00.000Z",
    browser: { browserVersion, driverVersion: browserVersion },
    summary: {
      score,
      rawScore,
      coverage: 100,
      qualification: "qualified",
      counts: { pass: 1, fail: 0, evidence: 0, skip: 0, error: 0 },
      categories: { bot: { score, rawScore, coverage: 100 } },
    },
    results: [
      { siteId: "local-core-signals", name: "Local core signals", category: "bot", status: "PASS", score },
    ],
  };
}

async function writeSdk(root, name) {
  const path = join(root, `${name}.json`);
  await writeFile(path, JSON.stringify({ status: "PASS", score: 100, matrix: [] }), "utf8");
  return path;
}

test("public comparison suppresses score differences for cross-major evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-public-comparison-"));
  try {
    const sly = join(root, "sly.json");
    const stock = join(root, "stock.json");
    const json = join(root, "comparison.json");
    const markdown = join(root, "comparison.md");
    await writeFile(sly, JSON.stringify(runReport("149.0.0.0", 90, 92)), "utf8");
    await writeFile(stock, JSON.stringify(runReport("123.0.0.0", 40, 42)), "utf8");
    const sdks = await Promise.all(["node", "python", "java", "dotnet"].map((name) => writeSdk(root, name)));

    execFileSync(process.execPath, [
      resolve("tests/detection/publish-comparison.mjs"),
      "--sly", sly,
      "--stock", stock,
      "--node-sdk", sdks[0],
      "--python-sdk", sdks[1],
      "--java-sdk", sdks[2],
      "--dotnet-sdk", sdks[3],
      "--json", json,
      "--markdown", markdown,
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(json, "utf8"));
    const human = await readFile(markdown, "utf8");
    assert.equal(machine.comparison.mode, "cross-major-evidence");
    assert.equal(machine.comparison.scoreDeltas, null);
    assert.equal(machine.categories[0].delta, null);
    assert.match(human, /Cross-major evidence mode/);
    assert.match(human, /Not comparable/);
    assert.doesNotMatch(human, /SlyBrowser \+50/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
