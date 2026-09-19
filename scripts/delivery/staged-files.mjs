import { spawnSync } from "node:child_process";

import { hashObject, matchGlob, normalizeRepositoryPath } from "./core.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: null,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    windowsHide: true,
  });
  if (result.error || result.status === null) throw new Error("git status operation is unavailable");
  return result;
}

function statusEntries(root) {
  const result = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.status !== 0) throw new Error("git status failed");
  const records = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) throw new Error("unexpected git status record");
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const path = normalizeRepositoryPath(record.slice(3));
    let originalPath = null;
    if (indexStatus === "R" || indexStatus === "C") {
      index += 1;
      if (index >= records.length) throw new Error("rename or copy status is missing its source path");
      originalPath = normalizeRepositoryPath(records[index]);
    }
    entries.push({ indexStatus, worktreeStatus, path, ...(originalPath ? { originalPath } : {}) });
  }
  return entries;
}

export function evaluateStagedFileAudit(root, candidate, policy, { contractDigests = {} } = {}) {
  const current = captureStagedCandidate(root);
  const errors = [];
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    errors.push("candidate changed before staged-file audit");
  }
  const entries = statusEntries(root);
  const staged = entries.flatMap((entry) => {
    if ([" ", "?"].includes(entry.indexStatus)) return [];
    return entry.indexStatus === "R" ? [entry.path, entry.originalPath] : [entry.path];
  }).sort();
  const candidateStaged = [...(candidate.stagedPaths ?? [])].sort();
  if (JSON.stringify(staged) !== JSON.stringify(candidateStaged)) errors.push("staged path inventory does not match candidate receipt");
  if (staged.length === 0) errors.push("candidate has no staged paths");

  const prohibitedUntracked = policy.prohibitedUntrackedPatterns ?? [];
  const prohibitedStaged = policy.prohibitedStagedPatterns ?? [];
  const candidatePaths = new Set(current.entries.map((entry) => entry.path));
  for (const entry of entries) {
    if (entry.indexStatus === "?" && prohibitedUntracked.some((pattern) => matchGlob(entry.path, pattern))) {
      errors.push(`forbidden untracked artifact: ${entry.path}`);
    }
    if (![" ", "?"].includes(entry.indexStatus)
      && candidatePaths.has(entry.path)
      && prohibitedStaged.some((pattern) => matchGlob(entry.path, pattern))) {
      errors.push(`forbidden staged artifact: ${entry.path}`);
    }
  }
  const diffCheck = runGit(root, ["diff", "--cached", "--check"]);
  if (diffCheck.status !== 0) errors.push("git diff --cached --check failed");
  return {
    schemaVersion: 1,
    gateId: "staged-file-audit",
    candidateId: candidate.candidateId,
    candidateManifestDigest: candidate.indexManifestDigest,
    contractDigests,
    status: errors.length ? "fail" : "pass",
    observedAt: new Date().toISOString(),
    subject: "exact-staged-file-inventory-and-worktree-status",
    stagedFileCount: staged.length,
    unstagedTrackedCount: entries.filter((entry) => ![" ", "?"].includes(entry.worktreeStatus)).length,
    untrackedFileCount: entries.filter((entry) => entry.indexStatus === "?").length,
    errors,
    evidenceDigest: hashObject({ candidate: candidate.indexManifestDigest, contractDigests, entries, diffCheckStatus: diffCheck.status }),
  };
}
