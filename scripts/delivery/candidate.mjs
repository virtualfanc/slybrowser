import { resolve } from "node:path";

import { parseArgs, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  requireOptions(options, ["repo", "output"]);
  requireOnlyOptions(options, ["repo", "output", "comparison-base"]);
  const receipt = captureStagedCandidate(resolve(options.repo), { comparisonBaseCommit: options["comparison-base"] ?? null });
  writeJson(options.output, receipt);
  process.stdout.write(`candidate: pass (${receipt.candidateId})\n`);
} catch (error) {
  process.stderr.write(`candidate: fail (${safeCliError(error)})\n`);
  process.exitCode = 1;
}
