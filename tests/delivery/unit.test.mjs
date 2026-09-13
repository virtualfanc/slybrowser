import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJson, hashObject, matchGlob } from "../../scripts/delivery/core.mjs";
import { classifyPublicPath, isAllowedSecurityPlaceholderPath, scanCommitMetadata } from "../../scripts/delivery/security.mjs";
import { SCANNER_IDS, buildScannerInvocation, loadBundledScannerPlan } from "../../scripts/delivery/scanner-plan.mjs";
import { classifySpdxExpression } from "../../scripts/delivery/scanner-runner-lib.mjs";
import * as scannerRunner from "../../scripts/delivery/scanner-runner-lib.mjs";
import {
  aggregateReceipts,
  validateFourBindingReceipts,
  validateRgrReceipt,
} from "../../scripts/delivery/validation.mjs";

const now = new Date("2026-09-01T04:00:00.000Z");
const candidateId = "git-tree:0123456789012345678901234567890123456789";

test("canonical hashing is independent of object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }));
});

test("glob matching is repository-relative and segment aware", () => {
  assert.equal(matchGlob("packages/node/src/index.ts", "packages/node/**"), true);
  assert.equal(matchGlob("packages/node-secret/index.ts", "packages/node/**"), false);
  assert.equal(matchGlob("README.md", "README.md"), true);
});

test("public surface deny and unresolved rules take precedence over allow rules", () => {
  const policy = {
    allow: ["README.md", "packages/node/**"],
    deny: ["packages/license-service/**"],
    reviewRequired: ["legacy/**"],
  };
  assert.equal(classifyPublicPath("packages/node/src/index.ts", policy).classification, "allowed");
  assert.equal(classifyPublicPath("packages/license-service/src/server.ts", policy).classification, "denied");
  assert.equal(classifyPublicPath("legacy/public-copy.ts", policy).classification, "review_required");
  assert.equal(classifyPublicPath("unknown.txt", policy).classification, "unclassified");
});

test("canonical public surface classifies the public ESLint configuration", () => {
  const policy = JSON.parse(readFileSync(
    new URL("../../contracts/delivery/public-surface.json", import.meta.url),
    "utf8",
  ));
  assert.equal(classifyPublicPath("eslint.config.mjs", policy).classification, "allowed");
});

test("canonical scanner plan fixes all seven scanners without a shell escape hatch", () => {
  const plan = loadBundledScannerPlan();
  assert.deepEqual(plan.scanners.map((item) => item.id), SCANNER_IDS);
  for (const id of SCANNER_IDS) {
    const invocation = buildScannerInvocation(plan, id, {
      repositoryRoot: "C:/fixture/repository",
      candidateRoot: "C:/fixture/candidate",
      rawEvidencePath: "C:/fixture/evidence.json",
    });
    assert.equal(invocation.shell, false);
    assert.equal(typeof invocation.executable, "string");
    assert.ok(invocation.args.every((argument) => typeof argument === "string"));
    assert.doesNotMatch(invocation.args.join(" "), /(?:^|\s)(?:-c|-Command|\/c)(?:\s|$)/i);
  }
  assert.notDeepEqual(
    buildScannerInvocation(plan, "lint", { repositoryRoot: "r", candidateRoot: "c", rawEvidencePath: "e" }).args,
    buildScannerInvocation(plan, "typecheck", { repositoryRoot: "r", candidateRoot: "c", rawEvidencePath: "e" }).args,
  );
  assert.throws(() => buildScannerInvocation(plan, "sast", {
    repositoryRoot: "C:/fixture/repository",
    candidateRoot: "C:/fixture/candidate",
    toolPaths: { sast: "relative/semgrep" },
  }), /controlled tool path override must be absolute/i);
  if (process.platform === "win32") {
    const wsl = buildScannerInvocation(plan, "sast", {
      repositoryRoot: "C:/fixture/repository",
      candidateRoot: "C:/fixture/candidate",
      toolPaths: { sast: "C:/Windows/System32/wsl.exe" },
    });
    assert.deepEqual(wsl.args.slice(0, 2), ["--exec", "semgrep"]);
    assert.equal(wsl.adapter, "wsl-exec");
    assert.equal(wsl.shell, false);
    assert.ok(wsl.args.some((argument) => argument === "/mnt/c/fixture/candidate"));
  }
  const license = buildScannerInvocation(plan, "dependency-license", {
    repositoryRoot: "C:/fixture/repository",
    candidateRoot: "C:/fixture/candidate",
    rawEvidencePath: "C:/fixture/evidence.json",
  });
  assert.equal(license.network, "required");
  assert.ok(license.args.includes("--override-default-catalogers"));
  assert.ok(license.args.includes("--enrich"));
  assert.deepEqual(
    license.supportingVersionInvocations.map((item) => item.tool.name),
    ["pnpm", "maven", "java", "dotnet"],
  );
});

test("SPDX compound expressions classify every atom without weakening unknown policy", () => {
  const policy = {
    allowedSpdxExpressions: ["MIT", "Apache-2.0"],
    deniedSpdxExpressions: ["AGPL-3.0-only"],
    reviewRequiredSpdxExpressions: ["PSF-2.0"],
  };
  assert.equal(classifySpdxExpression("MIT AND Apache-2.0", policy).classification, "allowed");
  assert.equal(classifySpdxExpression('"Apache-2.0";link="https://www.apache.org/licenses/LICENSE-2.0.txt"', policy).classification, "allowed");
  assert.equal(classifySpdxExpression('"Apache 2.0";link="http://www.apache.org/licenses/LICENSE-2.0.txt"', policy).classification, "allowed");
  assert.equal(classifySpdxExpression("MIT OR AGPL-3.0-only", policy).classification, "denied");
  assert.equal(classifySpdxExpression("MIT AND PSF-2.0", policy).classification, "review_required");
  assert.equal(classifySpdxExpression("Bouncy Castle Licence", policy).classification, "allowed");
  assert.equal(classifySpdxExpression("MIT WITH Classpath-exception-2.0", policy).classification, "unknown");
});

test("Windows-safe Maven preparation uses Java classworlds and rejects command wrappers", () => {
  const home = mkdtempSync(join(tmpdir(), "sly-maven-home-"));
  mkdirSync(join(home, "boot"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "boot", "plexus-classworlds-2.11.0.jar"), "fixture");
  writeFileSync(join(home, "bin", "m2.conf"), "fixture");
  const plan = loadBundledScannerPlan();
  const invocation = buildScannerInvocation(plan, "dependency-license", {
    repositoryRoot: "C:/fixture/repository",
    candidateRoot: "C:/fixture/candidate",
    toolPaths: {
      "dependency-license": process.execPath,
      "dependency-license:pnpm": process.execPath,
      "dependency-license:maven": home,
      "dependency-license:java": process.execPath,
      "dependency-license:dotnet": process.execPath,
    },
  });
  const maven = invocation.prepareInvocations.find((item) => item.id === "maven-runtime-copy");
  assert.equal(maven.executable, process.execPath);
  assert.equal(maven.adapter, "maven-classworlds");
  assert.ok(maven.args.includes("org.codehaus.plexus.classworlds.launcher.Launcher"));
  assert.ok(maven.args.includes("-Djansi.force=false"));
  assert.ok(maven.args.includes("-Dstyle.color=never"));
  assert.ok(maven.args.includes("-Dmdep.copyPom=true"));
  assert.equal(maven.shell, false);
  assert.throws(() => buildScannerInvocation(plan, "dependency-license", {
    repositoryRoot: "C:/fixture/repository",
    candidateRoot: "C:/fixture/candidate",
    toolPaths: { "dependency-license:maven": join(home, "mvn.cmd") },
  }), /shell wrapper is not allowed/i);
});

test("NuGet locked restore uses the dotnet 8 no-cache option without leaking an MSBuild switch", () => {
  const plan = loadBundledScannerPlan();
  const invocation = buildScannerInvocation(plan, "dependency-license", {
    repositoryRoot: "C:/fixture/repository",
    candidateRoot: "C:/fixture/candidate",
    rawEvidencePath: "C:/fixture/evidence.json",
  });
  const restore = invocation.prepareInvocations.find((item) => item.id === "nuget-locked-restore");
  assert.deepEqual(restore.args, [
    "restore",
    "--no-cache",
    "--locked-mode",
    "--packages",
    resolve("C:/fixture/candidate", ".scanner-production", "nuget"),
    resolve("C:/fixture/candidate", "packages", "dotnet", "src", "SlyBrowser", "SlyBrowser.csproj"),
  ]);
  assert.equal(restore.args.includes("--no-http-cache"), false);
});

test("controlled scanner environment retains only required Windows program roots", () => {
  const environment = scannerRunner.buildScannerEnvironment({
    environment: {
      PATH: "fixture-path",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramW6432: "C:\\Program Files",
      SLY_SECRET_TOKEN: "must-not-pass-through",
    },
  });
  assert.equal(environment.ProgramFiles, "C:\\Program Files");
  assert.equal(environment["ProgramFiles(x86)"], "C:\\Program Files (x86)");
  assert.equal(environment.ProgramW6432, "C:\\Program Files");
  assert.equal(environment.SLY_SECRET_TOKEN, undefined);
});

test("security path policy permits only declared placeholder env files", () => {
  const policy = { allowedPlaceholderPaths: ["**/.env.example"] };
  assert.equal(isAllowedSecurityPlaceholderPath("website/.env.example", policy), true);
  assert.equal(isAllowedSecurityPlaceholderPath("website/.env.local", policy), false);
  assert.equal(isAllowedSecurityPlaceholderPath("website/.env.production", policy), false);
});

test("metadata scanner reports field names without echoing sensitive values", () => {
  const findings = scanCommitMetadata({
    message: "publish from C:\\closed\\src",
    authorName: "Fixture",
    authorEmail: "fixture@example.invalid",
    branch: "feature/safe",
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "message");
  assert.doesNotMatch(JSON.stringify(findings), /closed|C:\\\\/i);
});

test("RGR validator rejects fabricated Red and enforces phase ordering", () => {
  const base = {
    schemaVersion: 1,
    candidateId,
    changeKind: "behavior",
    productionImplementationStartedAt: "2026-09-01T02:00:00.000Z",
    phases: {
      red: { status: "pass", exitCode: 1, observedAt: "2026-09-01T01:00:00.000Z", commandDigest: `sha256:${"1".repeat(64)}`, failureFingerprint: `sha256:${"2".repeat(64)}` },
      green: { status: "pass", exitCode: 0, observedAt: "2026-09-01T03:00:00.000Z", commandDigest: `sha256:${"3".repeat(64)}` },
      refactor: {
        status: "pass",
        exitCode: 0,
        observedAt: "2026-09-01T04:00:00.000Z",
        commandDigest: `sha256:${"4".repeat(64)}`,
        levels: {
          unit: { status: "pass", evidenceDigest: `sha256:${"5".repeat(64)}` },
          integration: { status: "pass", evidenceDigest: `sha256:${"6".repeat(64)}` },
          e2e: { status: "pass", evidenceDigest: `sha256:${"7".repeat(64)}` },
        },
      },
    },
    cleanupAudit: {
      status: "pass",
      reviewedPaths: ["scripts/delivery"],
      referenceScanDigest: `sha256:${"8".repeat(64)}`,
      documentationAuditDigest: `sha256:${"9".repeat(64)}`,
      deletions: [],
    },
  };
  assert.match(validateRgrReceipt(base, candidateId).errors.join("\n"), /Red.*fail/i);
  const valid = structuredClone(base);
  valid.phases.red.status = "fail";
  assert.deepEqual(validateRgrReceipt(valid, candidateId).errors, []);
  valid.phases.green.observedAt = "2026-09-01T00:30:00.000Z";
  assert.match(validateRgrReceipt(valid, candidateId).errors.join("\n"), /phase order/i);
});

test("four-binding gate rejects missing, skipped, stale, and mixed-tree cases", () => {
  const plan = {
    schemaVersion: 1,
    id: "public-four-binding-v1",
    maximumReceiptAgeSeconds: 3600,
    bindingInventory: { node: "packages/node", python: "packages/python", java: "packages/java", dotnet: "packages/dotnet" },
    requiredStatus: "pass",
    forbiddenRequiredStatuses: ["fail", "blocked", "not_evaluated", "skip"],
  };
  const bindings = ["node", "python", "java", "dotnet"];
  const levels = ["unit", "integration", "e2e"];
  plan.requiredCases = bindings.flatMap((binding) => levels.map((level) => {
    const args = level === "e2e"
      ? [binding, level, "--browser", "browser.exe", "--driver", "driver.exe", "--output", "out.json"]
      : [binding, level];
    return {
      id: `${binding}:${level}`,
      binding,
      level,
      subject: level === "e2e" ? "exact-packaged-browser-driver" : level === "integration" ? "shared-contract-and-real-boundary" : "exact-staged-tree",
      command: level === "e2e"
        ? { executable: "fixture", argsPrefix: [binding, level], requiredOptions: ["--browser", "--driver", "--output"], requiredOptionSets: [["--authorization"], ["--license"]], cwd: "." }
        : { executable: "fixture", args, cwd: "." },
      requiredAssertions: ["required-behavior", "resource-boundary"],
      negativeCanary: "reject-invalid-input",
    };
  }));
  const receipts = [];
  const rawEvidenceByCase = new Map();
  const artifact = {
    packageSha256: `sha256:${"c".repeat(64)}`,
    browserSha256: `sha256:${"d".repeat(64)}`,
    driverSha256: `sha256:${"e".repeat(64)}`,
    pairingDigest: `sha256:${"f".repeat(64)}`,
    browserVersion: "148.0.7778.179",
    driverVersion: "148.0.7778.179",
  };
  const expectedArtifacts = { schemaVersion: 2, candidateId, platforms: { "fixture-os-fixture-arch": artifact } };
  const candidateManifestDigest = `sha256:${"4".repeat(64)}`;
  for (const binding of bindings) {
    for (const level of levels) {
      const id = `${binding}:${level}`;
      const args = level === "e2e"
        ? [binding, level, "--browser", "browser.exe", "--driver", "driver.exe", "--output", "out.json", "--license", "lease.json"]
        : [binding, level];
      const command = { executable: "fixture", args, cwd: "." };
      const assertions = [{ id: "required-behavior", status: "pass" }, { id: "resource-boundary", status: "pass" }];
      const negativeCanary = { id: "reject-invalid-input", status: "pass", evidenceDigest: `sha256:${"2".repeat(64)}` };
      const cleanup = { status: "pass", evidenceDigest: `sha256:${"3".repeat(64)}` };
      const raw = Buffer.from(JSON.stringify({
        schemaVersion: 1, caseId: id, candidateId, command, status: "pass", exitCode: 0,
        assertions, negativeCanary, cleanup, startedAt: "2026-09-01T03:29:00.000Z",
        finishedAt: "2026-09-01T03:30:00.000Z", durationMs: 60_000, stdout: "fixture pass", stderr: "",
        candidateSnapshot: {
          before: { candidateId, candidateManifestDigest, capturedAt: "2026-09-01T03:28:59.000Z" },
          after: { candidateId, candidateManifestDigest, capturedAt: "2026-09-01T03:30:01.000Z" },
        },
      }));
      const evidenceDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      rawEvidenceByCase.set(id, raw);
      receipts.push({
        schemaVersion: 1,
        caseId: id,
        binding,
        level,
        candidateId,
        status: "pass",
        observedAt: "2026-09-01T03:30:00.000Z",
        subject: level === "e2e" ? "exact-packaged-browser-driver" : level === "integration" ? "shared-contract-and-real-boundary" : "exact-staged-tree",
        evidenceDigest,
        tool: { name: "fixture", version: "1.0.0" },
        command: { ...command, digest: hashObject(command) },
        assertions,
        negativeCanary,
        rawEvidence: { path: `${binding}/${level}.json`, sha256: evidenceDigest },
        cleanup,
        limitations: [],
        runner: { os: "fixture-os", arch: "fixture-arch", identityDigest: `sha256:${"b".repeat(64)}` },
        ...(level === "e2e" ? { artifact: structuredClone(artifact) } : {}),
      });
    }
  }
  const freshness = { now, maxAgeMs: 3_600_000, candidateManifestDigest, expectedArtifacts, rawEvidenceByCase };
  assert.deepEqual(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors, []);
  const durationReceipt = receipts.find((receipt) => receipt.caseId === "node:e2e");
  const durationOriginal = rawEvidenceByCase.get(durationReceipt.caseId);
  const durationRaw = JSON.parse(durationOriginal.toString("utf8"));
  durationRaw.durationMs = 20_000;
  const durationBytes = Buffer.from(JSON.stringify(durationRaw));
  const durationDigest = `sha256:${createHash("sha256").update(durationBytes).digest("hex")}`;
  rawEvidenceByCase.set(durationReceipt.caseId, durationBytes);
  durationReceipt.evidenceDigest = durationDigest;
  durationReceipt.rawEvidence.sha256 = durationDigest;
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /duration.*does not match/i);
  rawEvidenceByCase.set(durationReceipt.caseId, durationOriginal);
  durationReceipt.evidenceDigest = `sha256:${createHash("sha256").update(durationOriginal).digest("hex")}`;
  durationReceipt.rawEvidence.sha256 = durationReceipt.evidenceDigest;
  const unitReceipt = receipts.find((receipt) => receipt.caseId === "node:unit");
  const unitOriginal = rawEvidenceByCase.get(unitReceipt.caseId);
  const unitRaw = JSON.parse(unitOriginal.toString("utf8"));
  delete unitRaw.candidateSnapshot;
  const unitBytes = Buffer.from(JSON.stringify(unitRaw));
  const unitDigest = `sha256:${createHash("sha256").update(unitBytes).digest("hex")}`;
  rawEvidenceByCase.set(unitReceipt.caseId, unitBytes);
  unitReceipt.evidenceDigest = unitDigest;
  unitReceipt.rawEvidence.sha256 = unitDigest;
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /node:unit: candidate snapshots/i);
  rawEvidenceByCase.set(unitReceipt.caseId, unitOriginal);
  unitReceipt.evidenceDigest = `sha256:${createHash("sha256").update(unitOriginal).digest("hex")}`;
  unitReceipt.rawEvidence.sha256 = unitReceipt.evidenceDigest;
  const snapshotRaw = JSON.parse(durationOriginal.toString("utf8"));
  snapshotRaw.candidateSnapshot.before.candidateId = "git-tree:stale";
  const snapshotBytes = Buffer.from(JSON.stringify(snapshotRaw));
  const snapshotDigest = `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`;
  rawEvidenceByCase.set(durationReceipt.caseId, snapshotBytes);
  durationReceipt.evidenceDigest = snapshotDigest;
  durationReceipt.rawEvidence.sha256 = snapshotDigest;
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /candidate snapshots do not match/i);
  rawEvidenceByCase.set(durationReceipt.caseId, durationOriginal);
  durationReceipt.evidenceDigest = `sha256:${createHash("sha256").update(durationOriginal).digest("hex")}`;
  durationReceipt.rawEvidence.sha256 = durationReceipt.evidenceDigest;
  receipts.find((receipt) => receipt.caseId === "python:e2e").artifact.browserSha256 = `sha256:${"9".repeat(64)}`;
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /does not match the expected release artifact/i);
  receipts.find((receipt) => receipt.caseId === "python:e2e").artifact.browserSha256 = artifact.browserSha256;
  receipts[0].rawEvidence.sha256 = `sha256:${"9".repeat(64)}`;
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /raw log.*inconsistent/i);
  receipts[0].rawEvidence.sha256 = `sha256:${createHash("sha256").update(rawEvidenceByCase.get(receipts[0].caseId)).digest("hex")}`;
  receipts[0].command.digest = `sha256:${"1".repeat(64)}`;
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /command digest/i);
  receipts[0].command.digest = hashObject({ executable: receipts[0].command.executable, args: receipts[0].command.args, cwd: receipts[0].command.cwd });
  const savedRaw = rawEvidenceByCase.get(receipts[0].caseId);
  rawEvidenceByCase.delete(receipts[0].caseId);
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /raw log is missing/i);
  rawEvidenceByCase.set(receipts[0].caseId, savedRaw);
  receipts[0].status = "skip";
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /skip/i);
  receipts[0].status = "pass";
  receipts[0].candidateId = "git-tree:mixed";
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /candidate/i);
  receipts[0].candidateId = candidateId;
  receipts[0].subject = "unrelated-subject";
  assert.match(validateFourBindingReceipts(plan, receipts, candidateId, freshness).errors.join("\n"), /subject/i);
});

test("four-binding plan cannot shrink, duplicate, or weaken the canonical twelve cases", () => {
  const reducedPlan = {
    requiredCases: ["node", "python", "java", "dotnet"].map((binding) => ({
      id: `${binding}:unit`, binding, level: "unit", subject: "exact-staged-tree",
    })),
  };
  const reducedReceipts = reducedPlan.requiredCases.map((item) => ({
    schemaVersion: 1,
    caseId: item.id,
    binding: item.binding,
    level: item.level,
    subject: item.subject,
    candidateId,
    status: "pass",
    observedAt: "2026-09-01T03:30:00.000Z",
    evidenceDigest: `sha256:${"a".repeat(64)}`,
    tool: { name: "fixture", version: "1.0.0" },
  }));
  assert.match(
    validateFourBindingReceipts(reducedPlan, reducedReceipts, candidateId, { now, maxAgeMs: 3_600_000 }).errors.join("\n"),
    /canonical.*12|twelve|unit.*integration.*e2e/i,
  );

  const duplicatePlan = structuredClone(reducedPlan);
  duplicatePlan.requiredCases = [
    ...duplicatePlan.requiredCases,
    structuredClone(duplicatePlan.requiredCases[0]),
  ];
  assert.match(
    validateFourBindingReceipts(duplicatePlan, reducedReceipts, candidateId, { now, maxAgeMs: 3_600_000 }).errors.join("\n"),
    /duplicate/i,
  );

  const weakSubjectPlan = {
    requiredCases: ["node", "python", "java", "dotnet"].flatMap((binding) =>
      ["unit", "integration", "e2e"].map((level) => ({
        id: `${binding}:${level}`,
        binding,
        level,
        subject: "exact-staged-tree",
      })),
    ),
  };
  assert.match(
    validateFourBindingReceipts(weakSubjectPlan, [], candidateId, { now, maxAgeMs: 3_600_000 }).errors.join("\n"),
    /subject/i,
  );
});

test("aggregate gate rejects missing, stale, blocked, and mixed receipts", () => {
  const required = ["security", "documentation", "four-binding", "rgr", "staged-file-audit", "governance"];
  const receipts = required.map((gateId) => ({
    schemaVersion: 1, gateId, candidateId, status: "pass", observedAt: "2026-09-01T03:30:00.000Z",
    evidenceDigest: `sha256:${"a".repeat(64)}`, rawEvidenceReference: `artifact://fixture/${gateId}.json`,
    rawEvidenceDigest: `sha256:${"b".repeat(64)}`, commandDigest: `sha256:${"c".repeat(64)}`, exitCode: 0,
  }));
  assert.deepEqual(aggregateReceipts(required, receipts, candidateId, { now, maxAgeMs: 3_600_000 }).errors, []);
  const retired = structuredClone(receipts);
  retired[0].signature = { algorithm: "Ed25519", value: "retired" };
  assert.match(aggregateReceipts(required, retired, candidateId, { now, maxAgeMs: 3_600_000 }).errors.join("\n"), /retired.*signing/i);
  receipts.pop();
  assert.match(aggregateReceipts(required, receipts, candidateId, { now, maxAgeMs: 3_600_000 }).errors.join("\n"), /missing.*governance/i);
});

test("aggregate gate never accepts an empty required-gate policy", () => {
  assert.match(aggregateReceipts([], [], candidateId, { now }).errors.join("\n"), /canonical|required gate/i);
});
