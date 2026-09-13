import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseArgs, readJson, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContracts } from "./contracts.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";
import { verifyScannerRunnerResult } from "./scanner-runner-lib.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "runner-result", "raw-evidence", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const root = resolve(options.repo);
  const candidate = readJson(options.candidate);
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed before scanner receipt creation");
  }
  const contracts = loadCanonicalContracts(root, ["scannerPlan"], { candidate });
  const runnerResult = readJson(options["runner-result"]);
  if (["producer", "signature", "receiptDigest", "trustRegistryDigest"].some((field) => Object.hasOwn(runnerResult, field))
      || runnerResult.runnerResultVerified !== undefined) {
    throw new Error("scanner runner result contains retired receipt-signing fields or prior verification state");
  }
  const rawEvidenceBytes = readFileSync(resolve(options["raw-evidence"]));
  const verificationErrors = verifyScannerRunnerResult({
    result: runnerResult,
    rawEvidenceBytes,
    candidate,
    plan: contracts.scannerPlan.value,
    planDigest: contracts.scannerPlan.digest,
  });
  if (verificationErrors.length) throw new Error(`scanner runner result is not verified: ${verificationErrors.join("; ")}`);
  const receipt = {
    ...runnerResult,
    runnerResultVerified: true,
    contractDigests: {
      scannerPlan: contracts.scannerPlan.digest,
    },
  };
  const after = captureStagedCandidate(root);
  if (after.candidateId !== candidate.candidateId || after.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed during scanner receipt creation");
  }
  writeJson(options.output, receipt);
  process.stdout.write(`${runnerResult.gateId}: ${runnerResult.status}; runnerVerified=true\n`);
  process.exitCode = runnerResult.status === "pass" ? 0 : runnerResult.status === "fail" ? 1 : 2;
} catch (error) {
  process.stderr.write(`scanner-receipt: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
