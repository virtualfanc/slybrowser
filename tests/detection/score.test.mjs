import assert from "node:assert/strict";
import test from "node:test";

import { compareRuns, renderMarkdown } from "./compare.mjs";
import { normalizeLegacyResults } from "./rescore.mjs";
import { summarizeResults } from "./score.mjs";

const sites = [
  { id: "a", category: "bot", grading: true, required: true, weight: 2 },
  { id: "b", category: "bot", grading: true, required: true, weight: 1 },
  { id: "optional", category: "tls", grading: true, required: false, weight: 1 },
  { id: "evidence", category: "tls", grading: false, required: false, weight: 0 },
];

test("scoring is weighted and reports coverage", () => {
  const summary = summarizeResults([
    { siteId: "a", status: "PASS", score: 100 },
    { siteId: "b", status: "FAIL", score: 0 },
    { siteId: "optional", status: "SKIP" },
    { siteId: "evidence", status: "EVIDENCE" },
  ], sites);
  assert.equal(summary.rawScore, 66.67);
  assert.equal(summary.coverage, 100);
  assert.equal(summary.score, 66.67);
  assert.equal(summary.qualification, "qualified");
});

test("missing required coverage makes a score provisional", () => {
  const summary = summarizeResults([
    { siteId: "a", status: "PASS", score: 100 },
    { siteId: "b", status: "SKIP" },
  ], sites);
  assert.equal(summary.rawScore, 100);
  assert.equal(summary.coverage, 66.67);
  assert.equal(summary.score, 66.67);
  assert.equal(summary.qualification, "provisional");
});

test("runner errors reduce coverage instead of inventing zero scores", () => {
  const summary = summarizeResults([
    { siteId: "a", status: "PASS", score: 100 },
    { siteId: "b", status: "ERROR", score: 0 },
  ], sites);
  assert.equal(summary.rawScore, 100);
  assert.equal(summary.coverage, 66.67);
  assert.equal(summary.score, 66.67);
  assert.equal(summary.qualification, "provisional");
});

test("legacy missing reCAPTCHA scores are retained as evidence", () => {
  const input = [{
    siteId: "recaptcha",
    status: "FAIL",
    score: 0,
    metrics: { recaptchaScore: null, threshold: 0.7 },
  }];
  const normalized = normalizeLegacyResults(input, [{ id: "recaptcha", adapter: "recaptcha-v3" }]);
  assert.equal(normalized.changed, 1);
  assert.equal(normalized.results[0].status, "EVIDENCE");
  assert.equal(normalized.results[0].score, null);
  assert.equal(input[0].status, "FAIL");
});

test("legacy runner errors lose their invented numeric score", () => {
  const normalized = normalizeLegacyResults([
    { siteId: "unreachable", status: "ERROR", score: 0 },
  ], []);
  assert.equal(normalized.changed, 1);
  assert.equal(normalized.results[0].status, "ERROR");
  assert.equal(normalized.results[0].score, null);
});

test("comparison warns when browser majors differ", () => {
  const base = {
    browser: { id: "stock-playwright", name: "Stock", browserVersion: "123.0.0.0" },
    summary: { score: 10, rawScore: 10, coverage: 100, qualification: "qualified" },
    results: [],
  };
  const other = {
    browser: { id: "slybrowser", name: "Sly", browserVersion: "149.0.0.0" },
    summary: { score: 90, rawScore: 90, coverage: 100, qualification: "qualified" },
    results: [],
  };
  const comparison = compareRuns([base, other]);
  assert.equal(comparison.scoreComparisonsAllowed, false);
  assert.equal(comparison.scoreDeltas, null);
  assert.equal(comparison.warnings.length, 2);
  assert.match(renderMarkdown(comparison), /Adjusted score \(evidence only; not comparable\)/);
});

test("comparison retains same-major deltas for controlled baselines", () => {
  const base = {
    browser: { id: "stock-playwright", name: "Stock", browserVersion: "149.0.0.0" },
    summary: { score: 10, rawScore: 20, coverage: 100, qualification: "qualified" },
    results: [],
  };
  const other = {
    browser: { id: "slybrowser", name: "Sly", browserVersion: "149.1.0.0" },
    summary: { score: 90, rawScore: 95, coverage: 100, qualification: "qualified" },
    results: [],
  };
  const comparison = compareRuns([base, other]);
  assert.equal(comparison.scoreComparisonsAllowed, true);
  assert.deepEqual(comparison.scoreDeltas.slybrowser, { adjusted: 80, raw: 75 });
  assert.equal(comparison.warnings.length, 0);
});

test("comparison does not display a numeric score for runner errors", () => {
  const run = {
    browser: { id: "stock-playwright", name: "Stock", browserVersion: "123.0.0.0" },
    summary: { score: 0, rawScore: 0, coverage: 0, qualification: "provisional" },
    results: [{ siteId: "unreachable", status: "ERROR", score: 0 }],
  };
  const markdown = renderMarkdown(compareRuns([run]));
  assert.match(markdown, /\| unreachable \| ERROR \|/);
  assert.doesNotMatch(markdown, /ERROR 0\.0/);
});
