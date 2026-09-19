import { hashObject, sha256, validateFreshReceipt, validDate } from "./core.mjs";
import {
  CANONICAL_BASE_GATES,
  canonicalFourBindingCases,
  validateCanonicalFourBindingPlan,
} from "./contracts.mjs";

const RETIRED_RECEIPT_FIELDS = ["producer", "signature", "receiptDigest", "trustRegistryDigest"];

function retiredReceiptField(receipt) {
  return RETIRED_RECEIPT_FIELDS.find((field) => Object.hasOwn(receipt ?? {}, field));
}

export function validateRgrReceipt(receipt, candidateId) {
  const errors = [];
  if (receipt?.candidateId !== candidateId) errors.push("RGR receipt candidate does not match");
  if (receipt?.changeKind === "behavior") {
    if (receipt.phases?.red?.status !== "fail") errors.push("Red phase must record the observed target failure");
    if (!Number.isInteger(receipt.phases?.red?.exitCode) || receipt.phases.red.exitCode === 0) errors.push("Red phase must retain a non-zero exit code");
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.phases?.red?.failureFingerprint ?? "")) errors.push("Red phase failure fingerprint is missing");
  } else if (receipt?.phases?.red?.status === "historical_unavailable" && !receipt?.historicalRedReason) {
    errors.push("historical Red unavailability requires a reason");
  }
  const started = validDate(receipt?.productionImplementationStartedAt);
  const red = validDate(receipt?.phases?.red?.observedAt);
  const green = validDate(receipt?.phases?.green?.observedAt);
  const refactor = validDate(receipt?.phases?.refactor?.observedAt);
  if ([started, red, green, refactor].some((value) => value === null)) errors.push("RGR timestamps are incomplete or invalid");
  else if (!(red < started && started <= green && green <= refactor)) errors.push("RGR phase order is invalid");
  if (receipt?.phases?.green?.status !== "pass") errors.push("Green phase must pass");
  if (receipt?.phases?.green?.exitCode !== 0) errors.push("Green phase exit code must be zero");
  if (receipt?.phases?.refactor?.status !== "pass") errors.push("Refactor phase must pass");
  if (receipt?.phases?.refactor?.exitCode !== 0) errors.push("Refactor phase exit code must be zero");
  for (const level of ["unit", "integration", "e2e"]) {
    const result = receipt?.phases?.refactor?.levels?.[level];
    if (result?.status !== "pass") errors.push(`Refactor ${level} result must pass`);
    if (!/^sha256:[0-9a-f]{64}$/i.test(result?.evidenceDigest ?? "")) errors.push(`Refactor ${level} evidence digest is missing`);
  }
  for (const phase of ["red", "green", "refactor"]) {
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt?.phases?.[phase]?.commandDigest ?? "")) errors.push(`${phase} command digest is missing`);
  }
  if (receipt?.cleanupAudit?.status !== "pass") errors.push("referenced-code/document cleanup audit must pass separately");
  if (!Array.isArray(receipt?.cleanupAudit?.reviewedPaths) || receipt.cleanupAudit.reviewedPaths.length === 0) {
    errors.push("cleanup audit must list reviewed paths");
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(receipt?.cleanupAudit?.referenceScanDigest ?? "")) errors.push("cleanup reference scan digest is missing");
  if (!/^sha256:[0-9a-f]{64}$/i.test(receipt?.cleanupAudit?.documentationAuditDigest ?? "")) errors.push("cleanup documentation audit digest is missing");
  for (const deletion of receipt?.cleanupAudit?.deletions ?? []) {
    if (!deletion.path || !deletion.reason || !deletion.rollback || !deletion.referenceEvidence) {
      errors.push("every deletion needs path, reason, rollback, and reference evidence");
    }
  }
  return { errors };
}

export function validateFourBindingReceipts(plan, receipts, candidateId, freshness = {}) {
  const errors = [...validateCanonicalFourBindingPlan(plan)];
  const expectedArtifacts = freshness.expectedArtifacts;
  if (expectedArtifacts?.schemaVersion !== 2 || expectedArtifacts?.candidateId !== candidateId ||
      typeof expectedArtifacts?.platforms !== "object" || expectedArtifacts.platforms === null || Array.isArray(expectedArtifacts.platforms)) {
    errors.push("candidate-bound expected artifact inventory is missing or invalid");
  }
  const cases = canonicalFourBindingCases();
  const plannedCases = new Map((plan?.requiredCases ?? []).map((item) => [item.id, item]));
  const byId = new Map();
  for (const receipt of receipts) {
    if (byId.has(receipt.caseId)) errors.push(`duplicate case receipt: ${receipt.caseId}`);
    else byId.set(receipt.caseId, receipt);
  }
  for (const expected of cases) {
    const id = expected.id ?? `${expected.binding}:${expected.level}`;
    const receipt = byId.get(id);
    const planned = plannedCases.get(id);
    if (!receipt) {
      errors.push(`missing required case: ${id}`);
      continue;
    }
    errors.push(...validateFreshReceipt(receipt, candidateId, freshness).map((error) => `${id}: ${error}`));
    if (receipt.binding !== expected.binding || receipt.level !== expected.level) errors.push(`${id}: binding or level does not match plan`);
    if (typeof expected.subject === "string" && receipt.subject !== expected.subject) {
      errors.push(`${id}: subject does not match plan`);
    }
    if (receipt.status !== "pass") errors.push(`${id}: required status ${receipt.status} is not pass`);
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.evidenceDigest ?? "")) errors.push(`${id}: raw evidence digest is missing`);
    if (!receipt.tool?.name || !receipt.tool?.version) errors.push(`${id}: tool name/version is missing`);
    if (!receipt.command?.executable || !Array.isArray(receipt.command?.args) ||
        !/^sha256:[0-9a-f]{64}$/i.test(receipt.command?.digest ?? "")) {
      errors.push(`${id}: allowlisted execution command is incomplete`);
    } else {
      const commandIdentity = { executable: receipt.command.executable, args: receipt.command.args, cwd: receipt.command.cwd ?? "." };
      if (receipt.command.digest !== hashObject(commandIdentity)) errors.push(`${id}: command digest does not match the executed command`);
      const policy = planned?.command;
      if (!policy || receipt.command.executable !== policy.executable || (receipt.command.cwd ?? ".") !== (policy.cwd ?? ".")) {
        errors.push(`${id}: execution command is not allowlisted by the canonical plan`);
      } else if (Array.isArray(policy.args) && JSON.stringify(receipt.command.args) !== JSON.stringify(policy.args)) {
        errors.push(`${id}: execution arguments do not match the canonical plan`);
      } else if (Array.isArray(policy.argsPrefix) && JSON.stringify(receipt.command.args.slice(0, policy.argsPrefix.length)) !== JSON.stringify(policy.argsPrefix)) {
        errors.push(`${id}: execution arguments do not match the canonical plan prefix`);
      } else if (Array.isArray(policy.requiredOptions)) {
        for (const option of policy.requiredOptions) {
          const index = receipt.command.args.indexOf(option);
          if (index < 0 || index === receipt.command.args.length - 1 || receipt.command.args[index + 1].startsWith("-")) {
            errors.push(`${id}: execution command is missing required option ${option}`);
          }
        }
      }
      if (Array.isArray(policy?.requiredOptionSets) && !policy.requiredOptionSets.some((set) =>
        set.every((option) => {
          const index = receipt.command.args.indexOf(option);
          return index >= 0 && index < receipt.command.args.length - 1 && !receipt.command.args[index + 1].startsWith("-");
        }))) errors.push(`${id}: execution command does not select a canonical licensed runtime mode`);
    }
    if (!Array.isArray(receipt.assertions) || receipt.assertions.length === 0 ||
        receipt.assertions.some((assertion) => !assertion?.id || assertion?.status !== "pass")) {
      errors.push(`${id}: detailed passing assertions are incomplete`);
    }
    const actualAssertionIds = (receipt.assertions ?? []).map((item) => item.id).sort();
    const expectedAssertionIds = [...(planned?.requiredAssertions ?? [])].sort();
    if (JSON.stringify(actualAssertionIds) !== JSON.stringify(expectedAssertionIds)) {
      errors.push(`${id}: detailed assertions do not match the canonical plan`);
    }
    if (receipt.negativeCanary?.status !== "pass" || !receipt.negativeCanary?.id ||
        !/^sha256:[0-9a-f]{64}$/i.test(receipt.negativeCanary?.evidenceDigest ?? "")) {
      errors.push(`${id}: negative canary evidence is incomplete`);
    }
    if (receipt.negativeCanary?.id !== planned?.negativeCanary) errors.push(`${id}: negative canary does not match the canonical plan`);
    if (!receipt.rawEvidence?.path || !/^sha256:[0-9a-f]{64}$/i.test(receipt.rawEvidence?.sha256 ?? "") ||
        receipt.rawEvidence.sha256 !== receipt.evidenceDigest) {
      errors.push(`${id}: raw log path or digest is missing or inconsistent`);
    }
    const rawBytes = freshness.rawEvidenceByCase?.get(id);
    if (!rawBytes || receipt.rawEvidence?.sha256 !== sha256(rawBytes)) {
      errors.push(`${id}: raw log is missing or its bytes do not match the receipt`);
    } else {
      try {
        const raw = JSON.parse(Buffer.from(rawBytes).toString("utf8"));
        if (raw?.schemaVersion !== 1 || raw.caseId !== id || raw.candidateId !== candidateId || raw.status !== receipt.status || raw.exitCode !== 0) {
          errors.push(`${id}: raw execution identity, status, or exit code does not match`);
        }
        if (hashObject(raw.command) !== receipt.command?.digest || JSON.stringify(raw.command) !== JSON.stringify({
          executable: receipt.command?.executable,
          args: receipt.command?.args,
          cwd: receipt.command?.cwd ?? ".",
        })) errors.push(`${id}: raw execution command does not match the receipt`);
        if (JSON.stringify(raw.assertions) !== JSON.stringify(receipt.assertions)) errors.push(`${id}: raw assertion results do not match the receipt`);
        if (JSON.stringify(raw.negativeCanary) !== JSON.stringify(receipt.negativeCanary)) errors.push(`${id}: raw negative canary result does not match the receipt`);
        if (JSON.stringify(raw.cleanup) !== JSON.stringify(receipt.cleanup)) errors.push(`${id}: raw cleanup result does not match the receipt`);
        const rawStartedAt = validDate(raw.startedAt);
        const rawFinishedAt = validDate(raw.finishedAt);
        if (typeof raw.stdout !== "string" || typeof raw.stderr !== "string" || rawStartedAt === null || rawFinishedAt === null) {
          errors.push(`${id}: raw execution output or timestamps are incomplete`);
        } else if (rawStartedAt > rawFinishedAt) {
          errors.push(`${id}: raw execution timestamps are out of order`);
        } else {
          if (!Number.isSafeInteger(raw.durationMs) || raw.durationMs < 0 ||
              Math.abs((rawFinishedAt - rawStartedAt) - raw.durationMs) > 1_000) {
            errors.push(`${id}: raw execution duration does not match its timestamps`);
          }
          try {
            const executionOutput = JSON.parse(raw.stdout);
            if (Number.isSafeInteger(executionOutput?.durationMs) && executionOutput.durationMs >= 0 &&
                Math.abs((rawFinishedAt - rawStartedAt) - executionOutput.durationMs) > 1_000) {
              errors.push(`${id}: raw execution duration does not match the structured runner output`);
            }
          } catch {
            // Plain-text tool logs use the executor-recorded duration above.
          }
        }
        const before = raw.candidateSnapshot?.before;
        const after = raw.candidateSnapshot?.after;
        const beforeAt = validDate(before?.capturedAt);
        const afterAt = validDate(after?.capturedAt);
        if (before?.candidateId !== candidateId || after?.candidateId !== candidateId ||
            before?.candidateManifestDigest !== freshness.candidateManifestDigest ||
            after?.candidateManifestDigest !== freshness.candidateManifestDigest) {
          errors.push(`${id}: candidate snapshots do not match the exact staged candidate`);
        }
        if (beforeAt === null || afterAt === null || rawStartedAt === null || rawFinishedAt === null ||
            beforeAt > rawStartedAt || afterAt < rawFinishedAt) {
          errors.push(`${id}: candidate snapshots do not enclose the execution`);
        }
        if (expected.level === "e2e") {
          if ((raw.command?.args ?? []).some((argument) => /redacted|placeholder|<[^>]+>/i.test(argument))) {
            errors.push(`${id}: E2E command identity contains a substituted value`);
          }
        }
      } catch {
        errors.push(`${id}: raw log is not valid structured execution evidence`);
      }
    }
    if (receipt.cleanup?.status !== "pass" || !/^sha256:[0-9a-f]{64}$/i.test(receipt.cleanup?.evidenceDigest ?? "")) {
      errors.push(`${id}: cleanup evidence is incomplete`);
    }
    if (!Array.isArray(receipt.limitations)) errors.push(`${id}: limitations must be recorded`);
    if (expected.level === "e2e" && receipt.subject !== "exact-packaged-browser-driver") {
      errors.push(`${id}: E2E subject is not the exact packaged Browser/Driver`);
    }
    if (expected.level === "e2e") {
      if (!receipt.runner?.os || !receipt.runner?.arch || !/^sha256:[0-9a-f]{64}$/i.test(receipt.runner?.identityDigest ?? "")) {
        errors.push(`${id}: E2E runner identity is incomplete`);
      }
      for (const field of ["packageSha256", "browserSha256", "driverSha256", "pairingDigest"]) {
        if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.artifact?.[field] ?? "")) errors.push(`${id}: Artifact ${field} is missing`);
      }
      for (const field of ["browserVersion", "driverVersion"]) {
        if (typeof receipt.artifact?.[field] !== "string" || receipt.artifact[field].length === 0) errors.push(`${id}: Artifact ${field} is missing`);
      }
      const platformId = `${receipt.runner?.os}-${receipt.runner?.arch}`;
      const expectedArtifact = expectedArtifacts?.platforms?.[platformId];
      if (!expectedArtifact) {
        errors.push(`${id}: no expected artifact is registered for ${platformId}`);
      } else {
        for (const field of ["packageSha256", "browserSha256", "driverSha256", "pairingDigest", "browserVersion", "driverVersion"]) {
          if (receipt.artifact?.[field] !== expectedArtifact[field]) errors.push(`${id}: Artifact ${field} does not match the expected release artifact`);
        }
      }
    }
  }
  const unknown = [...byId.keys()].filter((id) => !cases.some((item) => (item.id ?? `${item.binding}:${item.level}`) === id));
  if (unknown.length) errors.push(`unknown case receipts: ${unknown.join(", ")}`);
  return { errors, expectedCaseCount: cases.length, observedCaseCount: receipts.length };
}

export function aggregateReceipts(requiredGateIds, receipts, candidateId, freshness = {}) {
  const errors = [];
  const required = [...requiredGateIds];
  const canonicalWithoutFour = [...CANONICAL_BASE_GATES];
  const canonicalWithFour = [...CANONICAL_BASE_GATES, "four-binding"];
  const sameSet = (left, right) => left.length === right.length && right.every((item) => left.includes(item));
  if (!(sameSet(required, canonicalWithoutFour) || sameSet(required, canonicalWithFour))) {
    errors.push("required gate set is not the canonical public commit policy");
  }
  const byId = new Map();
  for (const receipt of receipts) {
    if (byId.has(receipt.gateId)) errors.push(`duplicate gate receipt: ${receipt.gateId}`);
    else byId.set(receipt.gateId, receipt);
  }
  for (const gateId of required) {
    const receipt = byId.get(gateId);
    if (!receipt) {
      errors.push(`missing required gate receipt: ${gateId}`);
      continue;
    }
    errors.push(...validateFreshReceipt(receipt, candidateId, freshness).map((error) => `${gateId}: ${error}`));
    if (receipt.status !== "pass") errors.push(`${gateId}: required status ${receipt.status} is not pass`);
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.evidenceDigest ?? "")) errors.push(`${gateId}: evidence digest is missing`);
    if (freshness.candidateManifestDigest && receipt.candidateManifestDigest !== freshness.candidateManifestDigest) {
      errors.push(`${gateId}: candidate manifest digest does not match the current Git index`);
    }
    const retiredField = retiredReceiptField(receipt);
    if (retiredField) errors.push(`${gateId}: retired receipt-signing field is present: ${retiredField}`);
    const expectedContracts = freshness.expectedContractDigests?.[gateId] ?? {};
    for (const [name, digest] of Object.entries(expectedContracts)) {
      if (receipt.contractDigests?.[name] !== digest) errors.push(`${gateId}: canonical contract digest does not match for ${name}`);
    }
  }
  const unknown = [...byId.keys()].filter((gateId) => !required.includes(gateId));
  if (unknown.length) errors.push(`unknown gate receipts: ${unknown.join(", ")}`);
  return { errors };
}
