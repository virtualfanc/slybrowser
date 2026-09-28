import { resolve } from "node:path";

import { hashObject, parseArgs, readJson, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContract } from "./contracts.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";
import { validateRgrReceipt } from "./validation.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "rgr-receipt", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const root = resolve(options.repo);
  const candidate = readJson(options.candidate);
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed before RGR validation");
  }
  const schema = loadCanonicalContract(root, "rgrReceiptSchema", { candidate });
  const phaseReceipt = readJson(options["rgr-receipt"]);
  const result = validateRgrReceipt(phaseReceipt, candidate.candidateId);
  const receipt = {
    schemaVersion: 1,
    gateId: "rgr",
    candidateId: candidate.candidateId,
    candidateManifestDigest: candidate.indexManifestDigest,
    contractDigests: { rgrReceiptSchema: schema.digest },
    status: result.errors.length ? "fail" : "pass",
    observedAt: new Date().toISOString(),
    subject: "red-green-refactor-and-cleanup-audit",
    errors: result.errors,
    phaseReceiptDigest: phaseReceipt.commandSetDigest ?? null,
    evidenceDigest: hashObject({ phaseReceipt, schemaDigest: schema.digest }),
  };
  writeJson(options.output, receipt);
  process.stdout.write(`rgr: ${receipt.status}\n`);
  process.exitCode = receipt.status === "pass" ? 0 : 1;
} catch (error) {
  process.stderr.write(`rgr: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
