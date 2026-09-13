import { resolve } from "node:path";

import { parseArgs, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { captureStagedCandidate } from "./git-candidate.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  requireOptions(options, ["repo", "output"]);
  const receipt = captureStagedCandidate(resolve(options.repo));
  writeJson(options.output, receipt);
  process.stdout.write(`candidate: pass (${receipt.candidateId})\n`);
} catch (error) {
  process.stderr.write(`candidate: fail (${safeCliError(error)})\n`);
  process.exitCode = 1;
}
