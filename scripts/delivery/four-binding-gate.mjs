import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashObject, normalizeRepositoryPath, parseArgs, readJson, readJsonDirectory, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContract } from "./contracts.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";
import { validateFourBindingReceipts } from "./validation.mjs";
import { verifyReleaseManifest } from "./release-manifest.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "receipts", "raw-evidence-root", "release-manifest", "release-public-key", "release-key-id", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const root = resolve(options.repo);
  const candidate = readJson(options.candidate);
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed before four-binding validation");
  }
  const plan = loadCanonicalContract(root, "fourBindingPlan", { candidate });
  const caseReceipts = readJsonDirectory(options.receipts);
  const expectedArtifacts = verifyReleaseManifest(
    resolve(options["release-manifest"]),
    resolve(options["release-public-key"]),
    options["release-key-id"],
    candidate.candidateId,
  );
  const rawRoot = resolve(options["raw-evidence-root"]);
  const rawEvidenceByCase = new Map(caseReceipts.map((receipt) => {
    const relativePath = normalizeRepositoryPath(receipt.rawEvidence?.path ?? "");
    const path = resolve(rawRoot, ...relativePath.split("/"));
    const prefix = `${rawRoot.toLowerCase()}${rawRoot.endsWith("\\") ? "" : "\\"}`;
    if (!path.toLowerCase().startsWith(prefix)) throw new Error(`raw evidence path escapes root for ${receipt.caseId}`);
    return [receipt.caseId, readFileSync(path)];
  }));
  const result = validateFourBindingReceipts(plan.value, caseReceipts, candidate.candidateId, {
    maxAgeMs: (plan.value.maximumReceiptAgeSeconds ?? 86_400) * 1000,
    candidateManifestDigest: candidate.indexManifestDigest,
    expectedArtifacts,
    rawEvidenceByCase,
  });
  const receipt = {
    schemaVersion: 1,
    gateId: "four-binding",
    candidateId: candidate.candidateId,
    candidateManifestDigest: candidate.indexManifestDigest,
    contractDigests: {
      fourBindingPlan: plan.digest,
      releaseManifest: expectedArtifacts.manifestDigest,
      releasePublicKey: expectedArtifacts.publicKeyDigest,
    },
    status: result.errors.length ? "fail" : "pass",
    observedAt: new Date().toISOString(),
    subject: "four-bindings-unit-integration-exact-package-e2e",
    ...result,
    evidenceDigest: hashObject({
      planDigest: plan.digest,
      receipts: caseReceipts.map((receipt) => ({ caseId: receipt.caseId, status: receipt.status, evidenceDigest: receipt.evidenceDigest })),
    }),
  };
  writeJson(options.output, receipt);
  process.stdout.write(`four-binding: ${receipt.status}; cases=${result.observedCaseCount}/${result.expectedCaseCount}\n`);
  process.exitCode = receipt.status === "pass" ? 0 : 1;
} catch (error) {
  process.stderr.write(`four-binding: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
