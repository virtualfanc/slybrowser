import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { hashObject } from "./core.mjs";
import { captureStagedCandidate, readIndexBlob } from "./git-candidate.mjs";
import { SCANNER_IDS, parseScannerPlan } from "./scanner-plan.mjs";

export const CANONICAL_CONTRACT_PATHS = Object.freeze({
  aggregatePolicy: "contracts/delivery/aggregate-policy.json",
  featureCoverage: "contracts/delivery/feature-coverage.json",
  fourBindingPlan: "contracts/delivery/four-binding-test-plan.json",
  historyPolicy: "contracts/delivery/history-audit.json",
  publicSurface: "contracts/delivery/public-surface.json",
  rgrReceiptSchema: "contracts/delivery/rgr-receipt.schema.json",
  scannerPlan: "contracts/delivery/scanner-plan.json",
  securityPolicy: "contracts/delivery/security-policy.json",
  stagedFilePolicy: "contracts/delivery/staged-file-policy.json",
});

export const CANONICAL_BINDINGS = Object.freeze(["node", "python", "java", "dotnet"]);
export const CANONICAL_LEVELS = Object.freeze(["unit", "integration", "e2e"]);
export const CANONICAL_SUBJECTS = Object.freeze({
  unit: "exact-staged-tree",
  integration: "shared-contract-and-real-boundary",
  e2e: "exact-packaged-browser-driver",
});
export const CANONICAL_BASE_GATES = Object.freeze([
  "security", "documentation", "rgr", "governance", "staged-file-audit",
]);
export const CANONICAL_SCANNERS = SCANNER_IDS;

const ACTIVE_FEATURE_IDS = Object.freeze([
  "installation-and-sdk-bindings",
  "authorized-release-delivery",
  "browser-webdriver-pairing",
  "profile-configuration",
  "native-humanize",
  "automation-backends",
  "plans-and-licensing",
  "error-contract-and-troubleshooting",
  "platform-support",
  "network-and-proxy-boundaries",
  "detection-qa",
]);

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function canonicalFourBindingCases() {
  return CANONICAL_BINDINGS.flatMap((binding) => CANONICAL_LEVELS.map((level) => ({
    id: `${binding}:${level}`,
    binding,
    level,
    subject: CANONICAL_SUBJECTS[level],
  })));
}

export function validateCanonicalFourBindingPlan(plan) {
  const errors = [];
  const cases = Array.isArray(plan?.requiredCases) ? plan.requiredCases : [];
  const canonical = canonicalFourBindingCases();
  if (plan?.schemaVersion !== 1 || plan?.id !== "public-four-binding-v1") {
    errors.push("four-binding plan identity is not canonical");
  }
  if (!positiveInteger(plan?.maximumReceiptAgeSeconds)) errors.push("four-binding receipt age is invalid");
  if (plan?.requiredStatus !== "pass") errors.push("four-binding required status must be pass");
  if (!sameSet(plan?.forbiddenRequiredStatuses ?? [], ["fail", "blocked", "not_evaluated", "skip"])) {
    errors.push("four-binding forbidden statuses are not canonical");
  }
  const ids = cases.map((item) => item?.id);
  if (new Set(ids).size !== ids.length) errors.push("four-binding plan contains duplicate case IDs");
  if (cases.length !== canonical.length) errors.push("four-binding plan must contain the canonical 12 cases");
  for (const expected of canonical) {
    const matches = cases.filter((item) => item?.id === expected.id);
    if (matches.length !== 1) {
      errors.push(`four-binding plan must contain exactly one ${expected.id} case`);
      continue;
    }
    const actual = matches[0];
    if (actual.binding !== expected.binding || actual.level !== expected.level) {
      errors.push(`${expected.id}: binding or level is not canonical`);
    }
    if (actual.subject !== expected.subject) errors.push(`${expected.id}: subject is not canonical`);
    const command = actual.command;
    if (!command?.executable || !command?.cwd ||
        (!Array.isArray(command.args) && !Array.isArray(command.argsPrefix))) {
      errors.push(`${expected.id}: canonical execution command is incomplete`);
    }
    if (expected.level === "e2e" && (!Array.isArray(command?.requiredOptions) || command.requiredOptions.length < 3)) {
      errors.push(`${expected.id}: E2E command must bind exact runtime options`);
    }
    if (expected.level === "e2e" && (!Array.isArray(command?.requiredOptionSets) || command.requiredOptionSets.length < 1 ||
        command.requiredOptionSets.some((set) => !Array.isArray(set) || set.length === 0))) {
      errors.push(`${expected.id}: E2E command must require a licensed runtime mode`);
    }
    if (!Array.isArray(actual.requiredAssertions) || actual.requiredAssertions.length < 2 ||
        new Set(actual.requiredAssertions).size !== actual.requiredAssertions.length) {
      errors.push(`${expected.id}: required assertions are incomplete`);
    }
    if (typeof actual.negativeCanary !== "string" || actual.negativeCanary.length === 0) {
      errors.push(`${expected.id}: negative canary is missing`);
    }
  }
  const inventory = plan?.bindingInventory ?? {};
  const expectedInventory = {
    node: "packages/node", python: "packages/python", java: "packages/java", dotnet: "packages/dotnet",
  };
  if (!sameSet(Object.keys(inventory), Object.keys(expectedInventory)) ||
      Object.entries(expectedInventory).some(([binding, path]) => inventory[binding] !== path)) {
    errors.push("four-binding inventory is not canonical");
  }
  return errors;
}

function validateSecurityPolicy(policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1) errors.push("security policy schema version is invalid");
  if (!sameSet(policy?.requiredExternalScanners ?? [], CANONICAL_SCANNERS)) errors.push("security policy scanner set is not canonical");
  if (!positiveInteger(policy?.maximumScannerAgeSeconds)) errors.push("security scanner age is invalid");
  if (!positiveInteger(policy?.maximumTextBlobBytes)) errors.push("security text scan limit is invalid");
  const patternIds = (policy?.contentPatterns ?? []).map((item) => item?.id);
  for (const id of ["secret-private-key", "secret-cloud-key", "credential-literal", "pii-government-identifier", "private-local-path", "private-chromium-patch", "non-english-letter"]) {
    if (!patternIds.includes(id)) errors.push(`security content rule is missing: ${id}`);
  }
  if (!Array.isArray(policy?.forbiddenPathPatterns) || policy.forbiddenPathPatterns.length === 0) errors.push("security forbidden paths are empty");
  if (!Array.isArray(policy?.forbiddenBinaryExtensions) || policy.forbiddenBinaryExtensions.length === 0) errors.push("security forbidden binary extensions are empty");
  if (!sameSet(policy?.allowedPlaceholderPaths ?? [], ["**/.env.example"])) errors.push("security placeholder path exception is not canonical");
  if (policy?.requiredDisposition?.unresolvedCriticalFindings !== 0 || policy?.requiredDisposition?.unresolvedHighFindings !== 0 || policy?.requiredDisposition?.missingScannerStatus !== "blocked") {
    errors.push("security disposition is not fail-closed");
  }
  return errors;
}

function validateScannerPlan(plan) {
  let parsed;
  try {
    parsed = parseScannerPlan(plan);
  } catch (error) {
    return [error instanceof Error ? error.message : "scanner plan is invalid"];
  }
  const errors = [];
  if (parsed.id !== "public-security-scanners-v1" || parsed.subject !== "exact-staged-tree") {
    errors.push("scanner plan identity or subject is not canonical");
  }
  const expected = {
    "git-diff-check": ["git", "2.55.0", "staged-diff", "exit-zero", "none", "SLY_SCANNER_GIT_PATH"],
    "repository-guard": ["sly-exact-index-guard", "1.0.0", "exact-index", "repository-guard", "none", null],
    typecheck: ["pnpm", "10.15.1", "exact-index", "exit-zero", "none", "SLY_SCANNER_PNPM_PATH"],
    lint: ["eslint", "10.8.1", "exact-index", "eslint-json", "none", "SLY_SCANNER_ESLINT_PATH"],
    sast: ["semgrep", "1.172.0", "exact-index", "semgrep-json", "none", "SLY_SCANNER_SEMGREP_PATH"],
    "dependency-vulnerability": ["osv-scanner", "2.4.0", "exact-index", "osv-json", "required", "SLY_SCANNER_OSV_PATH"],
    "dependency-license": ["syft", "1.51.0", "exact-index", "syft-license-policy", "required", "SLY_SCANNER_SYFT_PATH"],
  };
  for (const scanner of parsed.scanners) {
    const actual = [scanner.tool, scanner.version, scanner.scope, scanner.parser, scanner.network, scanner.toolPathEnvironment];
    if (JSON.stringify(actual) !== JSON.stringify(expected[scanner.id])) {
      errors.push(`${scanner.id}: scanner tool, version, scope, parser or network policy is not canonical`);
    }
    if (!Number.isInteger(scanner.timeoutMs) || scanner.limitations.length === 0) {
      errors.push(`${scanner.id}: scanner timeout or limitations are incomplete`);
    }
    if (["dependency-vulnerability", "dependency-license"].includes(scanner.id)
        && !sameSet(scanner.requiredEcosystems, ["npm", "pypi", "maven", "nuget"])) {
      errors.push(`${scanner.id}: four-ecosystem production dependency coverage is incomplete`);
    }
    const expectedSupporting = scanner.id === "dependency-license"
      ? [
          ["pnpm", "10.15.1", "SLY_SCANNER_PNPM_PATH"],
          ["maven", "3.9.16", "SLY_SCANNER_MAVEN_PATH"],
          ["java", "21.0.9", "SLY_SCANNER_JAVA_PATH"],
          ["dotnet", "8.0.424", "SLY_SCANNER_DOTNET_PATH"],
        ]
      : [];
    const actualSupporting = scanner.supportingTools.map((item) => [item.tool, item.version, item.toolPathEnvironment]);
    if (JSON.stringify(actualSupporting) !== JSON.stringify(expectedSupporting)) {
      errors.push(`${scanner.id}: supporting tool set is not canonical`);
    }
  }
  return errors;
}

function validatePublicSurface(surface) {
  const errors = [];
  if (surface?.schemaVersion !== 1 || surface?.classificationDefault !== "unclassified") errors.push("public surface default is not fail-closed");
  for (const denied of ["packages/license-service/**", "website/**"]) {
    if (!(surface?.deny ?? []).includes(denied)) errors.push(`public surface deny rule is missing: ${denied}`);
  }
  if (surface?.baseline?.status !== "unresolved" || surface?.baseline?.historyRewriteAuthorized !== false) {
    errors.push("public surface baseline must remain unresolved without history authorization");
  }
  return errors;
}

function validateHistoryPolicy(policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1) errors.push("history policy schema version is invalid");
  for (const field of ["allowedRefPatterns", "allowedAuthorEmailPatterns", "allowedCommitterEmailPatterns"]) {
    const patterns = policy?.[field];
    if (!Array.isArray(patterns) || patterns.length === 0) {
      errors.push(`history policy ${field} is empty`);
      continue;
    }
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || !pattern.startsWith("^") || !pattern.endsWith("$")) {
        errors.push(`history policy ${field} contains an unanchored pattern`);
      }
      try {
        new RegExp(pattern);
      } catch {
        errors.push(`history policy ${field} contains an invalid pattern`);
      }
    }
  }
  const metadataIds = (policy?.forbiddenMetadataPatterns ?? []).map((item) => item?.id);
  for (const id of ["history-metadata-private-path", "history-metadata-private-repository"]) {
    if (!metadataIds.includes(id)) errors.push(`history metadata rule is missing: ${id}`);
  }
  return errors;
}

function validateAggregatePolicy(policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1 || policy?.id !== "public-commit-cumulative-v1") errors.push("aggregate policy identity is not canonical");
  if (!sameSet(policy?.requiredGates ?? [], CANONICAL_BASE_GATES)) errors.push("aggregate required gates are not canonical");
  const four = (policy?.conditionalGates ?? []).filter((item) => item?.gateId === "four-binding");
  if (four.length !== 1 || policy.conditionalGates.length !== 1 || four[0].contextField !== "fourBindingRequired" || four[0].reasonField !== "fourBindingReason") {
    errors.push("aggregate four-binding condition is not canonical");
  }
  if (!positiveInteger(policy?.maximumAgeSeconds) || policy?.acceptedRequiredStatus !== "pass") errors.push("aggregate pass/freshness policy is invalid");
  return errors;
}

function validateFeatureCoverageManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== 1 || manifest?.id !== "active-public-feature-coverage-v1") errors.push("feature coverage identity is not canonical");
  const active = (manifest?.features ?? []).filter((feature) => feature?.status === "active").map((feature) => feature.id);
  if (!sameSet(active, ACTIVE_FEATURE_IDS)) errors.push("active public feature inventory is incomplete or non-canonical");
  if (!Array.isArray(manifest?.featurePathRules) || manifest.featurePathRules.length === 0) errors.push("feature path rules are empty");
  if (!sameSet(manifest?.externalCommitRequired ?? [], ["officialWebsiteSource"])) errors.push("official website source synchronization requirement is missing");
  return errors;
}

function validateStagedFilePolicy(policy) {
  const errors = [];
  if (policy?.schemaVersion !== 1) errors.push("staged-file policy schema version is invalid");
  for (const field of ["prohibitedUntrackedPatterns", "prohibitedStagedPatterns"]) {
    if (!Array.isArray(policy?.[field]) || policy[field].length === 0) errors.push(`${field} is empty`);
    for (const required of ["**/.env", "**/*.exe", "**/AGENTS.md", "**/node_modules/**"]) {
      if (!(policy?.[field] ?? []).includes(required)) errors.push(`${field} is missing ${required}`);
    }
  }
  return errors;
}

const VALIDATORS = Object.freeze({
  aggregatePolicy: validateAggregatePolicy,
  featureCoverage: validateFeatureCoverageManifest,
  fourBindingPlan: validateCanonicalFourBindingPlan,
  historyPolicy: validateHistoryPolicy,
  publicSurface: validatePublicSurface,
  scannerPlan: validateScannerPlan,
  securityPolicy: validateSecurityPolicy,
  stagedFilePolicy: validateStagedFilePolicy,
});

export function loadCanonicalContract(repositoryRoot, name, { candidate } = {}) {
  const repositoryPath = CANONICAL_CONTRACT_PATHS[name];
  if (!repositoryPath) throw new Error("unknown canonical delivery contract");
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, repositoryPath);
  const boundary = relative(root, absolute).replaceAll("\\", "/");
  if (boundary.startsWith("../") || boundary === "..") throw new Error("canonical delivery contract escapes repository");
  let source;
  if (candidate) {
    const current = captureStagedCandidate(root);
    if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
      throw new Error("candidate changed before canonical contract loading");
    }
    const entry = current.entries.find((item) => item.path === repositoryPath);
    if (!entry || entry.mode !== "100644") throw new Error(`${name} is missing from the exact Git index`);
    source = readIndexBlob(root, entry.oid).toString("utf8");
  } else {
    source = readFileSync(absolute, "utf8");
  }
  const value = JSON.parse(source);
  const errors = VALIDATORS[name]?.(value) ?? [];
  if (errors.length) throw new Error(`${name} is not canonical: ${errors.join("; ")}`);
  return { value, digest: hashObject(value), repositoryPath };
}

export function loadCanonicalContracts(repositoryRoot, names, options = {}) {
  return Object.fromEntries(names.map((name) => [name, loadCanonicalContract(repositoryRoot, name, options)]));
}
