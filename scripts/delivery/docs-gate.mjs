import { resolve } from "node:path";

import { parseArgs, readJson, readJsonDirectory, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContracts } from "./contracts.mjs";
import { validateFeatureCoverage } from "./documentation.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "context", "external-receipts", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const candidate = readJson(options.candidate);
  const contracts = loadCanonicalContracts(resolve(options.repo), ["featureCoverage"], { candidate });
  const context = readJson(options.context);
  const receipt = validateFeatureCoverage(resolve(options.repo), contracts.featureCoverage.value, {
    ...context,
    candidate,
    candidateId: candidate.candidateId,
    externalReceipts: readJsonDirectory(options["external-receipts"]),
    contractDigests: {
      featureCoverage: contracts.featureCoverage.digest,
    },
  });
  writeJson(options.output, receipt);
  process.stdout.write(`documentation: ${receipt.status}; activeFeatures=${receipt.activeFeatureCount}\n`);
  process.exitCode = receipt.status === "pass" ? 0 : receipt.status === "blocked" || receipt.status === "not_evaluated" ? 2 : 1;
} catch (error) {
  process.stderr.write(`documentation: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
