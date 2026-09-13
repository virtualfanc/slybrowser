#!/usr/bin/env node
import { resolve } from "node:path";

import { parseArgs, requireOnlyOptions, requireOptions, safeCliError, writeJson } from "./core.mjs";
import { loadCanonicalContracts } from "./contracts.mjs";
import { auditGitHistory } from "./history-audit.mjs";

try {
  const options = parseArgs(process.argv.slice(2));
  requireOnlyOptions(options, ["repo", "output"]);
  requireOptions(options, ["repo", "output"]);
  const repositoryRoot = resolve(options.repo);
  const contracts = loadCanonicalContracts(repositoryRoot, ["publicSurface", "securityPolicy", "historyPolicy"]);
  const receipt = auditGitHistory({
    root: repositoryRoot,
    publicSurface: contracts.publicSurface.value,
    security: contracts.securityPolicy.value,
    history: contracts.historyPolicy.value,
  });
  writeJson(resolve(options.output), receipt);
  process.exitCode = receipt.status === "pass" ? 0 : 1;
} catch (error) {
  process.stderr.write(`${safeCliError(error)}\n`);
  process.exitCode = 2;
}
