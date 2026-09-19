import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { auditGitHistory, compileHistoryPolicy } from "../../scripts/delivery/history-audit.mjs";
import { git, initializeRepository, runNode, writeJson } from "./helpers.mjs";

const cli = resolve("scripts/delivery/history-audit-cli.mjs");
const canonicalRoot = resolve("contracts/delivery");

function policies(overrides = {}) {
  return {
    publicSurface: {
      classificationDefault: "unclassified",
      allow: ["README.md", "src/**"],
      deny: ["private/**", "memory/**", "packages/license-service/**", "website/**"],
    },
    security: {
      maximumTextBlobBytes: 1024 * 1024,
      forbiddenPathPatterns: ["**/*.pem", "**/*.key", "**/*.zip"],
      contentPatterns: [
        { id: "fixture-secret", expression: "SECRET_[A-Z]+=[A-Za-z0-9]{12,}", flags: "" },
        { id: "private-local-path", expression: "[A-Za-z]:\\\\(?:Users|multilogin)\\\\", flags: "i" },
      ],
    },
    history: {
      schemaVersion: 1,
      allowedRefPatterns: ["^refs/heads/main$"],
      allowedAuthorEmailPatterns: ["^fixture@example\\.invalid$"],
      allowedCommitterEmailPatterns: ["^fixture@example\\.invalid$"],
      forbiddenMetadataPatterns: [
        { id: "metadata-private-path", expression: "[A-Za-z]:\\\\(?:Users|multilogin)\\\\", flags: "i" },
      ],
      ...overrides,
    },
  };
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "sly-history-audit-"));
  initializeRepository(root);
  git(root, ["branch", "-M", "main"]);
  return root;
}

function commitFile(root, path, contents, message = "fixture change") {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
  git(root, ["add", "--", path]);
  git(root, ["commit", "--quiet", "-m", message]);
}

test("unit: history policy compiles only anchored email and ref allowlists", () => {
  const policy = compileHistoryPolicy(policies().history);
  assert.equal(policy.allowedRefs[0].test("refs/heads/main"), true);
  assert.equal(policy.allowedRefs[0].test("refs/heads/main/private"), false);
  assert.equal(policy.allowedAuthorEmails[0].test("fixture@example.invalid"), true);
  assert.equal(policy.allowedAuthorEmails[0].test("person@gmail.com"), false);
  assert.throws(
    () => compileHistoryPolicy({ allowedRefPatterns: ["refs/heads/main"], allowedAuthorEmailPatterns: ["("], allowedCommitterEmailPatterns: ["x"] }),
    /invalid history policy regular expression/,
  );
});

test("integration: clean reachable history passes", () => {
  const root = repository();
  try {
    commitFile(root, "src/index.js", "export const ready = true;\n");
    const result = auditGitHistory({ root, ...policies() });
    assert.equal(result.status, "pass");
    assert.equal(result.findings.length, 0);
    assert.ok(result.commitCount >= 2);
    assert.ok(result.blobCount >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: deleted private paths and secret blobs still fail from earlier commits", () => {
  const root = repository();
  try {
    commitFile(root, "packages/license-service/server.js", "const credential = 'SECRET_TOKEN=abcdefghijklmnop';\n", "add private service");
    rmSync(join(root, "packages"), { recursive: true, force: true });
    git(root, ["add", "--all"]);
    git(root, ["commit", "--quiet", "-m", "remove private service"]);
    const result = auditGitHistory({ root, ...policies() });
    assert.equal(result.status, "fail");
    assert.ok(result.findings.some((finding) => finding.ruleId === "history-denied-path"));
    assert.ok(result.findings.some((finding) => finding.ruleId === "fixture-secret"));
    assert.ok(result.findings.every((finding) => !JSON.stringify(finding).includes("abcdefghijklmnop")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("integration: unexpected refs and personal commit email fail closed", () => {
  const root = repository();
  try {
    git(root, ["checkout", "-q", "-b", "codex/private-work"]);
    git(root, ["config", "user.email", "person@gmail.com"]);
    commitFile(root, "src/private.js", "export const value = 1;\n", "work from C:\\Users\\person");
    const result = auditGitHistory({ root, ...policies() });
    assert.equal(result.status, "fail");
    assert.ok(result.findings.some((finding) => finding.ruleId === "history-unapproved-ref"));
    assert.ok(result.findings.some((finding) => finding.ruleId === "history-author-email"));
    assert.ok(result.findings.some((finding) => finding.ruleId === "metadata-private-path"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("e2e: CLI writes a redacted receipt and exits nonzero for contaminated history", () => {
  const root = repository();
  try {
    commitFile(root, "private/config.txt", "SECRET_TOKEN=abcdefghijklmnop\n", "private fixture");
    const configRoot = join(root, "contracts", "delivery");
    const output = join(root, "receipt.json");
    mkdirSync(configRoot, { recursive: true });
    for (const filename of ["public-surface.json", "security-policy.json", "history-audit.json"]) {
      writeFileSync(join(configRoot, filename), readFileSync(join(canonicalRoot, filename)));
    }
    const result = runNode(cli, [
      "--repo", root,
      "--output", output,
    ], resolve("."));
    assert.equal(result.status, 1);
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(receipt.status, "fail");
    assert.ok(receipt.findings.length >= 2);
    assert.equal(JSON.stringify(receipt).includes("abcdefghijklmnop"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("e2e: CLI rejects caller-supplied history policy overrides", () => {
  const root = repository();
  try {
    const output = join(root, "receipt.json");
    const weakPolicy = join(root, "weak-policy.json");
    writeJson(weakPolicy, {});
    const result = runNode(cli, [
      "--repo", root,
      "--output", output,
      "--history-policy", weakPolicy,
    ], resolve("."));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported options/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
