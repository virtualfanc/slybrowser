const COMPLETE_STATUSES = new Set(["PASS", "FAIL"]);

function round(value) {
  return Math.round(value * 100) / 100;
}

export function summarizeResults(results, sites) {
  const siteMap = new Map(sites.map((site) => [site.id, site]));
  const activeOptional = new Set(
    results
      .filter((result) => result.status !== "SKIP")
      .map((result) => result.siteId),
  );
  const expected = sites.filter(
    (site) => site.grading && (site.required || activeOptional.has(site.id)),
  );
  const expectedWeight = expected.reduce((sum, site) => sum + site.weight, 0);
  let completedWeight = 0;
  let points = 0;
  const categories = new Map();

  for (const result of results) {
    const site = siteMap.get(result.siteId);
    if (!site?.grading || (!site.required && !activeOptional.has(site.id))) continue;
    const category = categories.get(site.category) ?? { expectedWeight: 0, completedWeight: 0, points: 0 };
    categories.set(site.category, category);
  }
  for (const site of expected) {
    const category = categories.get(site.category) ?? { expectedWeight: 0, completedWeight: 0, points: 0 };
    category.expectedWeight += site.weight;
    categories.set(site.category, category);
  }
  for (const result of results) {
    const site = siteMap.get(result.siteId);
    if (!site?.grading || !COMPLETE_STATUSES.has(result.status)) continue;
    if (!site.required && !activeOptional.has(site.id)) continue;
    const score = Number.isFinite(result.score)
      ? Math.max(0, Math.min(100, result.score))
      : result.status === "PASS" ? 100 : 0;
    completedWeight += site.weight;
    points += site.weight * score;
    const category = categories.get(site.category);
    category.completedWeight += site.weight;
    category.points += site.weight * score;
  }

  const coverage = expectedWeight ? completedWeight / expectedWeight : 0;
  const rawScore = completedWeight ? points / completedWeight : 0;
  const adjustedScore = rawScore * coverage;
  const categoryScores = Object.fromEntries(
    [...categories.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
      const categoryCoverage = value.expectedWeight ? value.completedWeight / value.expectedWeight : 0;
      const categoryRaw = value.completedWeight ? value.points / value.completedWeight : 0;
      return [name, {
        score: round(categoryRaw * categoryCoverage),
        rawScore: round(categoryRaw),
        coverage: round(categoryCoverage * 100),
      }];
    }),
  );

  return {
    score: round(adjustedScore),
    rawScore: round(rawScore),
    coverage: round(coverage * 100),
    qualification: coverage >= 0.8 ? "qualified" : "provisional",
    counts: {
      pass: results.filter((result) => result.status === "PASS").length,
      fail: results.filter((result) => result.status === "FAIL").length,
      error: results.filter((result) => result.status === "ERROR").length,
      evidence: results.filter((result) => result.status === "EVIDENCE").length,
      skip: results.filter((result) => result.status === "SKIP").length,
    },
    categories: categoryScores,
  };
}
