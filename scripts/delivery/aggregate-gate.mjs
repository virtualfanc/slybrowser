import { resolve } from "node:path";

import { hashObject, parseArgs, readJson, readJsonDirectory, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContracts } from "./contracts.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";
import { aggregateReceipts } from "./validation.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "context", "receipts", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const root = resolve(options.repo);
  const candidate = readJson(options.candidate);
  const contracts = loadCanonicalContracts(root, [
    "aggregatePolicy", "featureCoverage", "fourBindingPlan", "publicSurface", "rgrReceiptSchema",
    "securityPolicy", "stagedFilePolicy",
  ], { candidate });
  const policy = contracts.aggregatePolicy.value;
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed before cumulative validation");
  }
  const receipts = readJsonDirectory(options.receipts);
  const requiredGates = [...(policy.requiredGates ?? [])];
  const applicability = [];
  if ((policy.conditionalGates ?? []).length) {
    const context = readJson(options.context);
    for (const conditional of policy.conditionalGates) {
      const required = context[conditional.contextField] === true;
      const reason = context[conditional.reasonField];
      if (!required && (typeof reason !== "string" || !reason.trim())) throw new Error(`conditional gate ${conditional.gateId} requires an applicability reason`);
      if (required) requiredGates.push(conditional.gateId);
      applicability.push({ gateId: conditional.gateId, required, reason });
    }
  }
  const expectedContractDigests = {
    security: {
      securityPolicy: contracts.securityPolicy.digest,
      publicSurface: contracts.publicSurface.digest,
    },
    documentation: {
      featureCoverage: contracts.featureCoverage.digest,
    },
    rgr: { rgrReceiptSchema: contracts.rgrReceiptSchema.digest },
    "staged-file-audit": { stagedFilePolicy: contracts.stagedFilePolicy.digest },
    "four-binding": { fourBindingPlan: contracts.fourBindingPlan.digest },
  };
  const result = aggregateReceipts(requiredGates, receipts, candidate.candidateId, {
    maxAgeMs: (policy.maximumAgeSeconds ?? 86_400) * 1000,
    candidateManifestDigest: candidate.indexManifestDigest,
    expectedContractDigests,
  });
  const cryptographicFailure = result.errors.some((error) => /verification fail|digest does not match|candidate manifest digest/i.test(error));
  const receipt = {
    schemaVersion: 1,
    gateId: "public-commit-cumulative",
    candidateId: candidate.candidateId,
    candidateManifestDigest: candidate.indexManifestDigest,
    contractDigests: {
      aggregatePolicy: contracts.aggregatePolicy.digest,
    },
    status: result.errors.length ? (cryptographicFailure ? "fail" : "blocked") : "pass",
    observedAt: new Date().toISOString(),
    subject: "cumulative-public-commit-eligibility",
    eligibleForAuthorizedCommit: result.errors.length === 0,
    authorizationGranted: false,
    authorizationNotice: "A passing receipt proves eligibility only; commit, push, publication, deployment, and release still require explicit authorization.",
    errors: result.errors,
    receiptCount: receipts.length,
    applicability,
    evidenceDigest: hashObject({
      candidateManifestDigest: candidate.indexManifestDigest,
      aggregatePolicyDigest: contracts.aggregatePolicy.digest,
      receipts: receipts.map((receipt) => ({ gateId: receipt.gateId, status: receipt.status, evidenceDigest: receipt.evidenceDigest })),
    }),
  };
  writeJson(options.output, receipt);
  process.stdout.write(`public-commit-cumulative: ${receipt.status}; eligibleForAuthorizedCommit=${receipt.eligibleForAuthorizedCommit}\n`);
  process.exitCode = receipt.eligibleForAuthorizedCommit ? 0 : 2;
} catch (error) {
  process.stderr.write(`public-commit-cumulative: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
