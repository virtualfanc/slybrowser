import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function git(cwd, args, options = {}) {
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  if (options.inheritGitIndex !== true) delete environment.GIT_INDEX_FILE;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: environment,
  }).trim();
}

export function initializeRepository(root, files = { "README.md": "# Fixture\n" }) {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Delivery Gate Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "fixture baseline"]);
}

export function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function runNode(script, args, cwd, options = {}) {
  const environment = { ...process.env, NO_COLOR: "1" };
  if (options.inheritGitIndex !== true) delete environment.GIT_INDEX_FILE;
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: environment,
  });
}

export function makeGateReceipt(gateId, candidateId, overrides = {}) {
  const evidenceDigest = `sha256:${"a".repeat(64)}`;
  return {
    schemaVersion: 1,
    gateId,
    candidateId,
    status: "pass",
    observedAt: new Date().toISOString(),
    subject: "exact-staged-tree",
    evidenceDigest,
    tool: { name: "fixture-scanner", version: "1.0.0" },
    command: { executable: "fixture-scanner", args: [gateId], digest: `sha256:${"1".repeat(64)}` },
    assertions: [{ id: "required-behavior", status: "pass" }],
    negativeCanary: { id: "reject-invalid-input", status: "pass", evidenceDigest: `sha256:${"2".repeat(64)}` },
    rawEvidence: { reference: `artifact://fixture/${gateId}.log`, sha256: evidenceDigest },
    cleanup: { status: "pass", evidenceDigest: `sha256:${"3".repeat(64)}` },
    limitations: [],
    findings: { critical: 0, high: 0 },
    ...overrides,
  };
}
