import { resolve } from "node:path";

import { parseArgs, readJson, readJsonDirectory, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContracts } from "./contracts.mjs";
import { evaluateSecurityGate } from "./security.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  const optionNames = ["repo", "candidate", "metadata", "scanner-receipts", "output"];
  requireOptions(options, optionNames);
  requireOnlyOptions(options, optionNames);
  const candidate = readJson(options.candidate);
  const contracts = loadCanonicalContracts(resolve(options.repo), ["securityPolicy", "publicSurface"], { candidate });
  const policy = structuredClone(contracts.securityPolicy.value);
  policy.publicSurface = contracts.publicSurface.value;
  const receipt = evaluateSecurityGate({
    root: resolve(options.repo),
    candidate,
    policy,
    metadata: readJson(options.metadata),
    scannerReceipts: readJsonDirectory(options["scanner-receipts"]),
    contractDigests: {
      securityPolicy: contracts.securityPolicy.digest,
      publicSurface: contracts.publicSurface.digest,
    },
  });
  writeJson(options.output, receipt);
  process.stdout.write(`security: ${receipt.status}; findings=${receipt.findingCount ?? 0}; missingScanners=${receipt.missingScanners.length}\n`);
  process.exitCode = receipt.status === "pass" ? 0 : receipt.status === "blocked" || receipt.status === "not_evaluated" ? 2 : 1;
} catch (error) {
  process.stderr.write(`security: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
