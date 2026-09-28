import { spawnSync } from "node:child_process";

import { hashObject, matchGlob, normalizeRepositoryPath } from "./core.mjs";

function runGit(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status === null) throw new Error("git history inspection is unavailable");
  if (!allowFailure && result.status !== 0) throw new Error(`git history inspection failed: ${args[0]}`);
  return result;
}

function compileExpression(entry, label) {
  try {
    return new RegExp(entry.expression ?? entry, entry.flags ?? "");
  } catch {
    throw new Error(`invalid history policy regular expression: ${label}`);
  }
}

export function compileHistoryPolicy(policy) {
  if (!policy || typeof policy !== "object") throw new Error("history policy is required");
  const required = ["allowedRefPatterns", "allowedAuthorEmailPatterns", "allowedCommitterEmailPatterns"];
  for (const field of required) {
    if (!Array.isArray(policy[field]) || policy[field].length === 0) {
      throw new Error(`history policy ${field} must be a non-empty array`);
    }
  }
  return {
    allowedRefs: policy.allowedRefPatterns.map((expression, index) => compileExpression(expression, `allowedRefPatterns[${index}]`)),
    allowedAuthorEmails: policy.allowedAuthorEmailPatterns.map((expression, index) => compileExpression(expression, `allowedAuthorEmailPatterns[${index}]`)),
    allowedCommitterEmails: policy.allowedCommitterEmailPatterns.map((expression, index) => compileExpression(expression, `allowedCommitterEmailPatterns[${index}]`)),
    forbiddenMetadata: (policy.forbiddenMetadataPatterns ?? []).map((entry, index) => ({
      id: entry.id ?? `history-metadata-${index}`,
      regex: compileExpression(entry, `forbiddenMetadataPatterns[${index}]`),
    })),
  };
}

function listRefs(root) {
  const result = runGit(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ]);
  const refs = [];
  for (const record of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [name, objectId, objectType, symref] = record.split("\0");
    if (!name || symref) continue;
    refs.push({ name, objectId, objectType });
  }
  return refs.sort((left, right) => left.name.localeCompare(right.name));
}

function listCommits(root, refs) {
  if (refs.length === 0) return [];
  const result = runGit(root, ["rev-list", "--topo-order", "--reverse", ...refs.map((entry) => entry.name)]);
  return [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))];
}

function commitMetadata(root, commit) {
  const result = runGit(root, ["show", "-s", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B", commit]);
  const [objectId, authorName, authorEmail, committerName, committerEmail, ...messageParts] = result.stdout.split("\0");
  return { objectId, authorName, authorEmail, committerName, committerEmail, message: messageParts.join("\0") };
}

function treeEntries(root, commit) {
  const result = runGit(root, ["ls-tree", "-r", "-z", commit], { encoding: null });
  return result.stdout.toString("utf8").split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/.exec(record);
    if (!match) throw new Error("unexpected Git tree entry");
    return { mode: match[1], type: match[2], objectId: match[3], path: normalizeRepositoryPath(match[4]) };
  });
}

function blobContents(root, objectId, maximumBytes) {
  const size = Number(runGit(root, ["cat-file", "-s", objectId]).stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Git blob size is invalid");
  if (size > maximumBytes) return { size, kind: "large", text: null };
  const buffer = runGit(root, ["cat-file", "blob", objectId], { encoding: null }).stdout;
  if (buffer.includes(0)) return { size, kind: "binary", text: null };
  return { size, kind: "text", text: buffer.toString("utf8") };
}

function addFinding(findings, seen, finding) {
  const key = JSON.stringify(finding);
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}

export function auditGitHistory({ root, publicSurface, security, history }) {
  const compiled = compileHistoryPolicy(history);
  const findings = [];
  const seenFindings = new Set();
  const refs = listRefs(root);

  for (const ref of refs) {
    if (!compiled.allowedRefs.some((expression) => expression.test(ref.name))) {
      addFinding(findings, seenFindings, { ruleId: "history-unapproved-ref", ref: ref.name, objectId: ref.objectId });
    }
  }

  const commits = listCommits(root, refs);
  const blobPaths = new Map();
  const seenTrees = new Set();
  const allow = publicSurface.allow ?? [];
  const deny = publicSurface.deny ?? [];
  const forbiddenPaths = security.forbiddenPathPatterns ?? [];

  for (const commit of commits) {
    const metadata = commitMetadata(root, commit);
    if (!compiled.allowedAuthorEmails.some((expression) => expression.test(metadata.authorEmail))) {
      addFinding(findings, seenFindings, { ruleId: "history-author-email", commit: metadata.objectId });
    }
    if (!compiled.allowedCommitterEmails.some((expression) => expression.test(metadata.committerEmail))) {
      addFinding(findings, seenFindings, { ruleId: "history-committer-email", commit: metadata.objectId });
    }
    const metadataText = [metadata.authorName, metadata.authorEmail, metadata.committerName, metadata.committerEmail, metadata.message].join("\n");
    for (const rule of compiled.forbiddenMetadata) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(metadataText)) addFinding(findings, seenFindings, { ruleId: rule.id, commit: metadata.objectId });
    }

    const treeId = runGit(root, ["show", "-s", "--format=%T", commit]).stdout.trim();
    if (seenTrees.has(treeId)) continue;
    seenTrees.add(treeId);
    for (const entry of treeEntries(root, commit)) {
      if (deny.some((pattern) => matchGlob(entry.path, pattern))) {
        addFinding(findings, seenFindings, { ruleId: "history-denied-path", commit, objectId: entry.objectId, path: entry.path });
      } else if (!allow.some((pattern) => matchGlob(entry.path, pattern))) {
        addFinding(findings, seenFindings, { ruleId: "history-unclassified-path", commit, objectId: entry.objectId, path: entry.path });
      }
      if (forbiddenPaths.some((pattern) => matchGlob(entry.path, pattern))) {
        addFinding(findings, seenFindings, { ruleId: "history-forbidden-path", commit, objectId: entry.objectId, path: entry.path });
      }
      if (entry.type === "blob") {
        if (!blobPaths.has(entry.objectId)) blobPaths.set(entry.objectId, new Set());
        blobPaths.get(entry.objectId).add(entry.path);
      }
    }
  }

  const contentPatterns = (security.contentPatterns ?? []).map((entry, index) => ({
    id: entry.id ?? `history-content-${index}`,
    regex: compileExpression(entry, `security.contentPatterns[${index}]`),
  }));
  const maximumBytes = security.maximumTextBlobBytes ?? 2_000_000;
  for (const [objectId, paths] of blobPaths) {
    const blob = blobContents(root, objectId, maximumBytes);
    if (blob.kind !== "text") continue;
    for (const rule of contentPatterns) {
      rule.regex.lastIndex = 0;
      if (rule.regex.test(blob.text)) {
        addFinding(findings, seenFindings, { ruleId: rule.id, objectId, paths: [...paths].sort() });
      }
    }
  }

  findings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    schemaVersion: 1,
    gateId: "public-git-history-audit",
    status: findings.length ? "fail" : "pass",
    observedAt: new Date().toISOString(),
    refCount: refs.length,
    commitCount: commits.length,
    treeCount: seenTrees.size,
    blobCount: blobPaths.size,
    findings,
    evidenceDigest: hashObject({ refs, commits, trees: [...seenTrees].sort(), blobs: [...blobPaths.keys()].sort(), findings }),
  };
}
