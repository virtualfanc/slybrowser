import { resolve } from "node:path";

import { parseArgs, readJson, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContract } from "./contracts.mjs";
import { evaluateStagedFileAudit } from "./staged-files.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const candidate = readJson(options.candidate);
  const policy = loadCanonicalContract(resolve(options.repo), "stagedFilePolicy", { candidate });
  const receipt = evaluateStagedFileAudit(resolve(options.repo), candidate, policy.value, {
    contractDigests: { stagedFilePolicy: policy.digest },
  });
  writeJson(options.output, receipt);
  process.stdout.write(`staged-file-audit: ${receipt.status}; stagedFiles=${receipt.stagedFileCount}\n`);
  process.exitCode = receipt.status === "pass" ? 0 : 1;
} catch (error) {
  process.stderr.write(`staged-file-audit: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
