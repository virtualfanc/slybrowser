import { resolve } from "node:path";

import { parseArgs, readJson, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContract } from "./contracts.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";
import { runScanner } from "./scanner-runner-lib.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const required = ["repo", "candidate", "id", "raw-evidence", "raw-evidence-reference", "output"];
  const allowed = [...required, "tool-paths"];
  requireOptions(options, required);
  requireOnlyOptions(options, allowed);
  const root = resolve(options.repo);
  const candidate = readJson(options.candidate);
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed before scanner execution");
  }
  const scannerPlan = loadCanonicalContract(root, "scannerPlan", { candidate });
  const result = runScanner({
    root,
    candidate,
    scannerId: options.id,
    rawEvidenceReference: options["raw-evidence-reference"],
    rawEvidencePath: resolve(options["raw-evidence"]),
    plan: scannerPlan.value,
    planDigest: scannerPlan.digest,
    toolPaths: options["tool-paths"] ? readJson(options["tool-paths"]) : {},
  });
  writeJson(options.output, result);
  process.stdout.write(`scanner:${options.id}: ${result.status}; signed=false\n`);
  process.exitCode = result.status === "pass" ? 0 : result.status === "fail" ? 1 : 2;
} catch (error) {
  process.stderr.write(`scanner-runner: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
