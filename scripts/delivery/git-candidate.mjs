import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { hashObject, normalizeRepositoryPath, sha256 } from "./core.mjs";

function runGit(root, args, { buffer = false, allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: buffer ? null : "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    windowsHide: true,
  });
  if (result.error) throw new Error("git executable is unavailable");
  if (result.status !== 0 && !allowFailure) throw new Error(`git operation failed: ${args[0]}`);
  return result;
}

function splitNull(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

export function readIndexEntries(root) {
  const result = runGit(root, ["ls-files", "--stage", "-z"], { buffer: true });
  const entries = [];
  for (const record of splitNull(result.stdout)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("unexpected Git index record");
    const [mode, oid, stage] = record.slice(0, separator).split(" ");
    const path = normalizeRepositoryPath(record.slice(separator + 1));
    if (stage !== "0") throw new Error("unmerged Git index entries are not eligible");
    entries.push({ mode, oid, path });
  }
  const portablePaths = new Set();
  for (const entry of entries) {
    const portable = entry.path.normalize("NFC").toLowerCase();
    if (portablePaths.has(portable)) throw new Error("Git index contains a cross-platform path collision");
    portablePaths.add(portable);
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function readIndexBlob(root, oid) {
  const result = runGit(root, ["cat-file", "blob", oid], { buffer: true });
  return result.stdout;
}

export function readIndexBlobs(root, oids) {
  const unique = [...new Set(oids)];
  if (unique.length === 0) return new Map();
  const result = spawnSync("git", ["-C", root, "cat-file", "--batch"], {
    input: `${unique.join("\n")}\n`,
    encoding: null,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("git batch object read failed");
  const blobs = new Map();
  let offset = 0;
  for (const oid of unique) {
    const headerEnd = result.stdout.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("git batch object header is incomplete");
    const [returnedOid, type, sizeText] = result.stdout.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number.parseInt(sizeText, 10);
    if (returnedOid !== oid || type !== "blob" || !Number.isInteger(size) || size < 0) throw new Error("git index object is not a readable blob");
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= result.stdout.length || result.stdout[end] !== 0x0a) throw new Error("git batch object payload is incomplete");
    blobs.set(oid, result.stdout.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

export function captureStagedCandidate(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const inside = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.stdout.trim() !== "true") throw new Error("candidate repository is not a Git worktree");
  const treeResult = runGit(root, ["write-tree"]);
  const tree = treeResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("Git did not return a valid index tree identity");
  const entries = readIndexEntries(root);
  const head = runGit(root, ["rev-parse", "HEAD"], { allowFailure: true });
  const headCommit = head.status === 0 ? head.stdout.trim() : null;
  const diff = runGit(root, ["diff", "--cached", "--raw", "-z", "--no-renames", ...(headCommit ? ["HEAD"] : ["--root"])], { buffer: true });
  const stagedPaths = splitNull(diff.stdout)
    .filter((record) => !record.startsWith(":"))
    .map(normalizeRepositoryPath);
  return {
    schemaVersion: 1,
    gateId: "candidate",
    status: "pass",
    subject: "exact-git-index",
    candidateId: `git-tree:${tree}`,
    tree,
    headCommit,
    indexManifestDigest: hashObject(entries),
    stagedDiffDigest: sha256(diff.stdout),
    trackedFileCount: entries.length,
    stagedPaths,
    entries,
    observedAt: new Date().toISOString(),
  };
}
