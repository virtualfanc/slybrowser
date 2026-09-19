import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJson, hashObject, matchGlob } from "../../scripts/delivery/core.mjs";
import { git, initializeRepository, makeGateReceipt, runNode, writeJson } from "./helpers.mjs";

const scripts = resolve("scripts/delivery");
const canonicalRoot = resolve("contracts/delivery");
const scannerRunner = resolve("scripts/delivery/scanner-runner.mjs");

const contractFiles = {
  aggregatePolicy: "aggregate-policy.json",
  featureCoverage: "feature-coverage.json",
  fourBindingPlan: "four-binding-test-plan.json",
  historyPolicy: "history-audit.json",
  publicSurface: "public-surface.json",
  rgrReceiptSchema: "rgr-receipt.schema.json",
  scannerPlan: "scanner-plan.json",
  securityPolicy: "security-policy.json",
  stagedFilePolicy: "staged-file-policy.json",
};

function fixtureRepository({ contractNames = Object.keys(contractFiles) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sly-delivery-e2e-repo-"));
  const files = { "README.md": "# Fixture\n" };
  for (const name of contractNames) {
    const filename = contractFiles[name];
    files[`contracts/delivery/${filename}`] = readFileSync(join(canonicalRoot, filename), "utf8");
  }
  initializeRepository(root, files);
  return root;
}

function captureCandidate(root) {
  const output = join(root, "candidate.json");
  const result = runNode(join(scripts, "candidate.mjs"), ["--repo", root, "--output", output], root);
  assert.equal(result.status, 0, result.stderr);
  return { path: output, value: JSON.parse(readFileSync(output, "utf8")) };
}

function gateReceipt(gateId, candidate, overrides = {}) {
  return {
    schemaVersion: 1,
    gateId,
    candidateId: candidate.candidateId,
    candidateManifestDigest: candidate.indexManifestDigest,
    status: "pass",
    observedAt: new Date().toISOString(),
    subject: "fixture-exact-candidate-gate",
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    rawEvidenceReference: `artifact://fixture/${gateId.replaceAll(":", "-")}.json`,
    rawEvidenceDigest: `sha256:${"b".repeat(64)}`,
    commandDigest: `sha256:${"c".repeat(64)}`,
    exitCode: 0,
    ...overrides,
  };
}

test("candidate CLI emits an exact staged-tree receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-delivery-e2e-candidate-"));
  initializeRepository(root);
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const receipt = captureCandidate(root).value;
  assert.equal(receipt.status, "pass");
  assert.match(receipt.candidateId, /^git-tree:[0-9a-f]{40,64}$/);
});

test("scanner runner CLI produces candidate-bound raw evidence without caller-supplied status or digest", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-delivery-e2e-scanner-"));
  initializeRepository(root, {
    "README.md": "# Fixture\n",
    "contracts/delivery/scanner-plan.json": readFileSync(join(canonicalRoot, "scanner-plan.json"), "utf8"),
  });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureCandidate(root);
  const raw = join(root, "git-diff-check.raw.json");
  const output = join(root, "git-diff-check.result.json");
  const result = runNode(scannerRunner, [
    "--repo", root,
    "--candidate", candidate.path,
    "--id", "git-diff-check",
    "--raw-evidence", raw,
    "--raw-evidence-reference", "evidence://fixture/git-diff-check.raw.json",
    "--output", output,
  ], root);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.gateId, "scanner:git-diff-check");
  assert.equal(receipt.candidateId, candidate.value.candidateId);
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.subject, "exact-staged-tree");
  assert.match(receipt.rawEvidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(receipt, "signature"), false);
});

test("the public current tree contains no private-owner paths", () => {
  const candidatePaths = git(resolve("."), ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { inheritGitIndex: true })
    .split("\0")
    .filter(Boolean)
    .filter((entry) => existsSync(resolve(entry)));
  const surface = JSON.parse(readFileSync(resolve("contracts/delivery/public-surface.json"), "utf8"));
  assert.deepEqual(candidatePaths.filter((entry) => surface.deny.some((pattern) => matchGlob(entry, pattern))), []);
});

test("aggregate CLI recomputes the index and requires candidate-bound gate receipts", () => {
  const gates = ["security", "documentation", "four-binding", "rgr", "governance", "staged-file-audit"];
  const root = fixtureRepository();
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureCandidate(root);
  const receipts = join(root, "receipts");
  mkdirSync(receipts);
  const digests = Object.fromEntries(Object.entries(contractFiles).map(([name, filename]) => [
    name,
    hashObject(JSON.parse(readFileSync(join(root, "contracts", "delivery", filename), "utf8"))),
  ]));
  const contractsByGate = {
    security: { securityPolicy: digests.securityPolicy, publicSurface: digests.publicSurface },
    documentation: { featureCoverage: digests.featureCoverage },
    "four-binding": { fourBindingPlan: digests.fourBindingPlan },
    rgr: { rgrReceiptSchema: digests.rgrReceiptSchema },
    "staged-file-audit": { stagedFilePolicy: digests.stagedFilePolicy },
    governance: {},
  };
  for (const gateId of gates.slice(0, -2)) {
    writeJson(join(receipts, `${gateId}.json`), gateReceipt(gateId, candidate.value, { contractDigests: contractsByGate[gateId] }));
  }
  writeJson(join(receipts, "staged-file-audit.json"), gateReceipt("staged-file-audit", candidate.value, { contractDigests: contractsByGate["staged-file-audit"] }));
  const context = join(root, "context.json");
  writeJson(context, { fourBindingRequired: true, fourBindingReason: "fixture shared contract change" });
  const blockedOutput = join(root, "blocked.json");
  const blocked = runNode(join(scripts, "aggregate-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--context", context,
    "--receipts", receipts, "--output", blockedOutput,
  ], root);
  assert.notEqual(blocked.status, 0);
  assert.equal(JSON.parse(readFileSync(blockedOutput, "utf8")).eligibleForAuthorizedCommit, false);

  writeJson(join(receipts, "governance.json"), gateReceipt("governance", candidate.value, { contractDigests: {} }));
  const passOutput = join(root, "pass.json");
  const passed = runNode(join(scripts, "aggregate-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--context", context,
    "--receipts", receipts, "--output", passOutput,
  ], root);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(readFileSync(passOutput, "utf8")).eligibleForAuthorizedCommit, true);

  writeFileSync(join(root, "README.md"), "# Changed after receipt\n");
  git(root, ["add", "README.md"]);
  const stale = runNode(join(scripts, "aggregate-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--context", context,
    "--receipts", receipts, "--output", join(root, "stale.json"),
  ], root);
  assert.notEqual(stale.status, 0);
});

test("Wiki publisher defaults to dry-run and never claims remote publication", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-delivery-e2e-wiki-"));
  const wiki = join(root, "wiki");
  mkdirSync(wiki);
  writeFileSync(join(wiki, "Home.md"), "# Home\n");
  const output = join(root, "wiki-publication.json");
  const result = runNode(join(scripts, "wiki-publisher.mjs"), ["--source", wiki, "--output", output, "--dry-run"], root);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.status, "not_evaluated");
  assert.equal(receipt.remotePublished, false);
});

test("production CLIs reject caller-supplied policy and manifest overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-delivery-e2e-overrides-"));
  const placeholder = join(root, "placeholder.json");
  const directory = join(root, "receipts");
  mkdirSync(directory);
  writeJson(placeholder, {});
  const docs = runNode(join(scripts, "docs-gate.mjs"), [
    "--repo", root, "--candidate", placeholder, "--context", placeholder,
    "--external-receipts", directory, "--output", join(root, "docs.json"), "--manifest", placeholder,
  ], root);
  assert.notEqual(docs.status, 0);
  assert.match(docs.stderr, /unsupported options/i);
  const staged = runNode(join(scripts, "staged-files-gate.mjs"), [
    "--repo", root, "--candidate", placeholder, "--output", join(root, "staged.json"), "--policy", placeholder,
  ], root);
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /unsupported options/i);
  const aggregate = runNode(join(scripts, "aggregate-gate.mjs"), [
    "--repo", root, "--candidate", placeholder, "--context", placeholder,
    "--receipts", directory, "--output", join(root, "aggregate.json"), "--policy", placeholder,
  ], root);
  assert.notEqual(aggregate.status, 0);
  assert.match(aggregate.stderr, /unsupported options/i);
});

test("security and staged-file CLIs use only canonical repository contracts", () => {
  const scanners = ["git-diff-check", "repository-guard", "typecheck", "lint", "sast", "dependency-vulnerability", "dependency-license"];
  const root = fixtureRepository({ contractNames: ["scannerPlan", "securityPolicy", "publicSurface", "stagedFilePolicy"] });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureCandidate(root);
  const metadata = join(root, "metadata.json");
  const scannerReceipts = join(root, "scanner-receipts");
  mkdirSync(scannerReceipts);
  writeJson(metadata, { message: "safe change", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" });
  const scannerPlan = JSON.parse(readFileSync(join(canonicalRoot, "scanner-plan.json"), "utf8"));
  const scannerPlanDigest = hashObject(scannerPlan);
  for (const id of scanners) {
    const planned = scannerPlan.scanners.find((item) => item.id === id);
    writeJson(join(scannerReceipts, `${id}.json`), gateReceipt(`scanner:${id}`, candidate.value, {
      subject: "exact-staged-tree",
      scannerPlanDigest,
      scanner: { id, scope: planned.scope, parser: planned.parser, network: planned.network },
      tool: { name: planned.tool, version: planned.version, observedVersion: planned.version },
      supportingTools: (planned.supportingTools ?? []).map((item) => ({ name: item.tool, version: item.version, observedVersion: item.version })),
      findings: { critical: 0, high: 0, deniedLicenses: 0, unknownLicenses: 0, reviewRequiredLicenses: 0 },
      scannerResultDigest: `sha256:${"d".repeat(64)}`,
      runnerResultVerified: true,
      rawEvidenceDigest: `sha256:${"a".repeat(64)}`,
    }));
  }
  writeFileSync(join(root, "contracts", "delivery", "security-policy.json"), "{}\n");
  const securityOutput = join(root, "security.json");
  const security = runNode(join(scripts, "security-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--metadata", metadata,
    "--scanner-receipts", scannerReceipts, "--output", securityOutput,
  ], root);
  assert.equal(security.status, 0, security.stderr);
  assert.equal(JSON.parse(readFileSync(securityOutput, "utf8")).status, "pass");
  const legacyOverride = runNode(join(scripts, "security-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--metadata", metadata,
    "--scanner-receipts", scannerReceipts, "--output", join(root, "legacy.json"), "--policy", join(root, "weak.json"),
  ], root);
  assert.notEqual(legacyOverride.status, 0);

  const lintPlan = scannerPlan.scanners.find((item) => item.id === "lint");
  writeJson(join(scannerReceipts, "lint.json"), gateReceipt("scanner:lint", candidate.value, {
    subject: "exact-staged-tree",
    scannerPlanDigest,
    scanner: { id: "lint", scope: lintPlan.scope, parser: lintPlan.parser, network: lintPlan.network },
    tool: { name: lintPlan.tool, version: "0.0.0", observedVersion: "0.0.0" },
    supportingTools: [],
    findings: { critical: 0, high: 0, deniedLicenses: 0, unknownLicenses: 0, reviewRequiredLicenses: 0 },
    scannerResultDigest: `sha256:${"d".repeat(64)}`,
    runnerResultVerified: true,
    rawEvidenceDigest: `sha256:${"a".repeat(64)}`,
  }));
  const mismatchedScannerOutput = join(root, "scanner-version-mismatch.json");
  const mismatchedScanner = runNode(join(scripts, "security-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--metadata", metadata,
    "--scanner-receipts", scannerReceipts, "--output", mismatchedScannerOutput,
  ], root);
  assert.notEqual(mismatchedScanner.status, 0);
  assert.match(JSON.parse(readFileSync(mismatchedScannerOutput, "utf8")).scannerErrors.join("\n"), /tool or version does not match/i);

  const stagedOutput = join(root, "staged.json");
  const staged = runNode(join(scripts, "staged-files-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--output", stagedOutput,
  ], root);
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(JSON.parse(readFileSync(stagedOutput, "utf8")).status, "pass");
});

test("scanner receipt CLI verifies raw evidence without producer signing", () => {
  const root = fixtureRepository({ contractNames: ["scannerPlan"] });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureCandidate(root);
  const raw = join(root, "git-diff-check.raw.json");
  const runnerOutput = join(root, "git-diff-check.result.json");
  const run = runNode(scannerRunner, [
    "--repo", root, "--candidate", candidate.path, "--id", "git-diff-check",
    "--raw-evidence", raw, "--raw-evidence-reference", "artifact://fixture/git-diff-check.json",
    "--output", runnerOutput,
  ], root);
  assert.equal(run.status, 0, run.stderr);
  const output = join(root, "scanner.json");
  const result = runNode(join(scripts, "scanner-receipt.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--runner-result", runnerOutput, "--raw-evidence", raw,
    "--output", output,
  ], root);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(receipt.runnerResultVerified, true);
  assert.equal(Object.hasOwn(receipt, "signature"), false);
  assert.equal(Object.hasOwn(receipt, "producer"), false);

  writeFileSync(raw, `${readFileSync(raw, "utf8")} `);
  const tampered = runNode(join(scripts, "scanner-receipt.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--runner-result", runnerOutput, "--raw-evidence", raw,
    "--output", join(root, "tampered-scanner.json"),
  ], root);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /raw evidence digest does not match/i);
});

test("four-binding and RGR CLIs use canonical contracts and one exact candidate", () => {
  const root = fixtureRepository({ contractNames: ["fourBindingPlan", "rgrReceiptSchema"] });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureCandidate(root);
  const receipts = join(root, "case-receipts");
  const rawEvidenceRoot = join(root, "case-raw");
  mkdirSync(receipts);
  mkdirSync(rawEvidenceRoot);
  const plan = JSON.parse(readFileSync(join(root, "contracts/delivery/four-binding-test-plan.json"), "utf8"));
  const manifestPayload = {
    schemaVersion: 1, browserVersion: "148.0.7778.179", driverVersion: "148.0.7778.179",
    candidateId: candidate.value.candidateId, sdkCompatibility: "^0.1.0", status: "available", artifacts: [{
      platform: "windows", arch: "x64", sha256: "c".repeat(64), browserSha256: "d".repeat(64), driverSha256: "e".repeat(64),
    }],
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const releaseKeyId = "fixture-release-key";
  const releaseManifest = join(root, "release-manifest.json");
  const releasePublicKey = join(root, "release-public.pem");
  writeJson(releaseManifest, { ...manifestPayload, signature: {
    algorithm: "ed25519", keyId: releaseKeyId,
    value: sign(null, Buffer.from(canonicalJson(manifestPayload)), privateKey).toString("base64url"),
  } });
  writeFileSync(releasePublicKey, publicKey.export({ format: "pem", type: "spki" }));
  const artifact = {
    packageSha256: `sha256:${"c".repeat(64)}`, browserSha256: `sha256:${"d".repeat(64)}`,
    driverSha256: `sha256:${"e".repeat(64)}`, pairingDigest: hashObject({
      browserVersion: "148.0.7778.179", driverVersion: "148.0.7778.179",
      browserSha256: "d".repeat(64), driverSha256: "e".repeat(64),
    }),
    browserVersion: "148.0.7778.179", driverVersion: "148.0.7778.179",
  };
  for (const binding of ["node", "python", "java", "dotnet"]) {
    for (const level of ["unit", "integration", "e2e"]) {
      const id = `${binding}:${level}`;
      const planned = plan.requiredCases.find((item) => item.id === id);
      const args = planned.command.args ?? [
        ...planned.command.argsPrefix,
        ...planned.command.requiredOptions.flatMap((option) => [option, `${option.slice(1)}-fixture`]),
        ...planned.command.requiredOptionSets.at(-1).flatMap((option) => [option, `${option.slice(1)}-fixture`]),
      ];
      const command = { executable: planned.command.executable, args, cwd: planned.command.cwd };
      const assertions = planned.requiredAssertions.map((assertionId) => ({ id: assertionId, status: "pass" }));
      const negativeCanary = { id: planned.negativeCanary, status: "pass", evidenceDigest: `sha256:${"2".repeat(64)}` };
      const cleanup = { status: "pass", evidenceDigest: `sha256:${"3".repeat(64)}` };
      const raw = Buffer.from(JSON.stringify({
        schemaVersion: 1, caseId: id, candidateId: candidate.value.candidateId, command, status: "pass", exitCode: 0,
        assertions, negativeCanary, cleanup, startedAt: new Date(Date.now() - 1_000).toISOString(),
        finishedAt: new Date().toISOString(), durationMs: 1_000, stdout: "fixture execution passed", stderr: "",
        candidateSnapshot: {
          before: { candidateId: candidate.value.candidateId, candidateManifestDigest: candidate.value.indexManifestDigest, capturedAt: new Date(Date.now() - 2_000).toISOString() },
          after: { candidateId: candidate.value.candidateId, candidateManifestDigest: candidate.value.indexManifestDigest, capturedAt: new Date(Date.now() + 1_000).toISOString() },
        },
      }));
      const rawName = `${binding}-${level}.json`;
      writeFileSync(join(rawEvidenceRoot, rawName), raw);
      const evidenceDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      writeJson(join(receipts, rawName), makeGateReceipt("case-producer", candidate.value.candidateId, {
        caseId: id,
        binding,
        level,
        subject: level === "e2e" ? "exact-packaged-browser-driver" : level === "integration" ? "shared-contract-and-real-boundary" : "exact-staged-tree",
        evidenceDigest,
        command: { ...command, digest: hashObject(command) },
        assertions,
        negativeCanary,
        rawEvidence: { path: rawName, sha256: evidenceDigest },
        cleanup,
        runner: { os: "windows", arch: "x64", identityDigest: `sha256:${"b".repeat(64)}` },
        ...(level === "e2e" ? { artifact } : {}),
      }));
    }
  }
  const fourOutput = join(root, "four.json");
  const four = runNode(join(scripts, "four-binding-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--receipts", receipts, "--raw-evidence-root", rawEvidenceRoot,
    "--release-manifest", releaseManifest, "--release-public-key", releasePublicKey, "--release-key-id", releaseKeyId, "--output", fourOutput,
  ], root);
  assert.equal(four.status, 0, four.stderr);
  const wrongManifestKey = runNode(join(scripts, "four-binding-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--receipts", receipts, "--raw-evidence-root", rawEvidenceRoot,
    "--release-manifest", releaseManifest, "--release-public-key", releasePublicKey, "--release-key-id", "wrong-key", "--output", join(root, "wrong-key-four.json"),
  ], root);
  assert.notEqual(wrongManifestKey.status, 0);
  assert.match(wrongManifestKey.stderr, /signature identity/i);
  const mismatchedManifestPayload = { ...manifestPayload, candidateId: "git-tree:0000000000000000000000000000000000000000" };
  const mismatchedManifest = join(root, "mismatched-release-manifest.json");
  writeJson(mismatchedManifest, { ...mismatchedManifestPayload, signature: {
    algorithm: "ed25519", keyId: releaseKeyId,
    value: sign(null, Buffer.from(canonicalJson(mismatchedManifestPayload)), privateKey).toString("base64url"),
  } });
  const mismatchedCandidate = runNode(join(scripts, "four-binding-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--receipts", receipts, "--raw-evidence-root", rawEvidenceRoot,
    "--release-manifest", mismatchedManifest, "--release-public-key", releasePublicKey, "--release-key-id", releaseKeyId, "--output", join(root, "mismatched-candidate-four.json"),
  ], root);
  assert.notEqual(mismatchedCandidate.status, 0);
  assert.match(mismatchedCandidate.stderr, /manifest candidate does not match/i);
  const rawToTamper = join(rawEvidenceRoot, "node-unit.json");
  const originalRaw = readFileSync(rawToTamper);
  writeFileSync(rawToTamper, Buffer.concat([originalRaw, Buffer.from(" ")]));
  const tamperedRaw = runNode(join(scripts, "four-binding-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--receipts", receipts, "--raw-evidence-root", rawEvidenceRoot,
    "--release-manifest", releaseManifest, "--release-public-key", releasePublicKey, "--release-key-id", releaseKeyId, "--output", join(root, "tampered-raw-four.json"),
  ], root);
  assert.notEqual(tamperedRaw.status, 0);
  assert.match(readFileSync(join(root, "tampered-raw-four.json"), "utf8"), /raw log is missing or its bytes do not match/i);
  writeFileSync(rawToTamper, originalRaw);
  const weakened = runNode(join(scripts, "four-binding-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--receipts", receipts, "--raw-evidence-root", rawEvidenceRoot,
    "--release-manifest", releaseManifest, "--release-public-key", releasePublicKey, "--release-key-id", releaseKeyId, "--output", join(root, "weak-four.json"),
    "--plan", join(root, "weak-plan.json"),
  ], root);
  assert.notEqual(weakened.status, 0);

  const red = new Date(Date.now() - 4_000).toISOString();
  const started = new Date(Date.now() - 3_000).toISOString();
  const green = new Date(Date.now() - 2_000).toISOString();
  const refactor = new Date(Date.now() - 1_000).toISOString();
  const rgrInput = join(root, "rgr-input.json");
  writeJson(rgrInput, {
    schemaVersion: 1, candidateId: candidate.value.candidateId, changeKind: "behavior", productionImplementationStartedAt: started,
    phases: {
      red: { status: "fail", exitCode: 1, observedAt: red, commandDigest: `sha256:${"1".repeat(64)}`, failureFingerprint: `sha256:${"2".repeat(64)}` },
      green: { status: "pass", exitCode: 0, observedAt: green, commandDigest: `sha256:${"3".repeat(64)}` },
      refactor: { status: "pass", exitCode: 0, observedAt: refactor, commandDigest: `sha256:${"4".repeat(64)}`, levels: {
        unit: { status: "pass", evidenceDigest: `sha256:${"5".repeat(64)}` }, integration: { status: "pass", evidenceDigest: `sha256:${"6".repeat(64)}` }, e2e: { status: "pass", evidenceDigest: `sha256:${"7".repeat(64)}` },
      } },
    },
    cleanupAudit: { status: "pass", reviewedPaths: ["scripts/delivery"], referenceScanDigest: `sha256:${"8".repeat(64)}`, documentationAuditDigest: `sha256:${"9".repeat(64)}`, deletions: [] },
  });
  const rgrOutput = join(root, "rgr.json");
  const rgr = runNode(join(scripts, "rgr-gate.mjs"), [
    "--repo", root, "--candidate", candidate.path, "--rgr-receipt", rgrInput, "--output", rgrOutput,
  ], root);
  assert.equal(rgr.status, 0, rgr.stderr);
  assert.equal(JSON.parse(readFileSync(rgrOutput, "utf8")).status, "pass");
});
