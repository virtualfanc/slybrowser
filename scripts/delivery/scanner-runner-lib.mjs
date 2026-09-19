import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, hashObject, sha256 } from "./core.mjs";
import { captureStagedCandidate, readIndexBlobs } from "./git-candidate.mjs";
import {
  buildScannerInvocation,
  loadBundledScannerPlan,
  parseScannerPlan,
  scannerPlanDigest,
} from "./scanner-plan.mjs";

const SAFE_REFERENCE = /^(?:(?:artifact|evidence|https):\/\/|urn:)[A-Za-z0-9]/;
const DIGEST = /^sha256:[0-9a-f]{64}$/i;
const ANSI_CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const GENERATED_OR_PRIVATE_PATH = [
  { ruleId: "agent-instruction", expression: /(^|\/)(?:AGENTS(?:\.override)?|CLAUDE)\.md$/i },
  { ruleId: "agent-state", expression: /(^|\/)(?:\.codex|\.claude|\.cursor|\.continue|\.aider|\.windsurf|\.agent|\.agents|\.ai)(\/|$)/i },
  { ruleId: "generated-output", expression: /(^|\/)(?:dist|coverage|TestResults|node_modules|target|bin|obj)(\/|$)/i },
  { ruleId: "secret-or-database", expression: /(^|\/)(?:secrets)(\/|$)|\.(?:key|pem|pfx|sqlite|sqlite-shm|sqlite-wal)$|\.authorization\.json$/i },
  { ruleId: "binary-or-archive", expression: /\.(?:exe|dll|pdb|dSYM|zip|7z|rar|tar|tgz|gz)$/i },
];
const SECRET_CONTENT = [
  { ruleId: "private-key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { ruleId: "cloud-key", expression: /AIza[0-9A-Za-z_-]{20,}/ },
];

function sameCandidate(left, right) {
  return left?.candidateId === right?.candidateId
    && (left?.indexManifestDigest ?? left?.candidateManifestDigest)
      === (right?.indexManifestDigest ?? right?.candidateManifestDigest);
}

function currentCandidate(root, candidate, phase) {
  const current = captureStagedCandidate(root);
  if (!sameCandidate(current, candidate)) throw new Error(`candidate changed before or during scanner ${phase}`);
  return current;
}

function controlledGitIndexFile(environment = process.env) {
  const value = environment.GIT_INDEX_FILE;
  if (value === undefined || value === "") return null;
  if (!isAbsolute(value)) throw new Error("GIT_INDEX_FILE must be an absolute path");
  const absolute = resolve(value);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
    throw new Error("GIT_INDEX_FILE must identify a real index file");
  }
  return absolute;
}

function runProcess(invocation) {
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    encoding: "utf8",
    env: buildScannerEnvironment({ includeGitIndex: invocation.useGitIndex === true }),
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    timeout: invocation.timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    const timeout = result.error.code === "ETIMEDOUT";
    return {
      exitCode: timeout ? 124 : 127,
      stdout: result.stdout ?? "",
      stderr: timeout ? "scanner timed out" : "scanner executable is unavailable",
      blockedReason: timeout ? "timeout" : "tool-unavailable",
    };
  }
  return {
    exitCode: Number.isInteger(result.status) ? result.status : 127,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function buildScannerEnvironment({ includeGitIndex = false, environment = process.env } = {}) {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "CI", "NO_COLOR",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  ];
  const selected = { GIT_CONFIG_NOSYSTEM: "1", NO_COLOR: "1" };
  for (const name of allowed) {
    if (environment[name] !== undefined) selected[name] = environment[name];
  }
  if (includeGitIndex) {
    const indexFile = controlledGitIndexFile(environment);
    if (indexFile) selected.GIT_INDEX_FILE = indexFile;
  }
  return selected;
}

function internalRepositoryGuard(root, candidate) {
  const current = currentCandidate(root, candidate, "repository guard");
  const findings = [];
  const regular = current.entries.filter((entry) => ["100644", "100755"].includes(entry.mode));
  const blobs = readIndexBlobs(root, regular.map((entry) => entry.oid));
  for (const entry of current.entries) {
    if (!["100644", "100755"].includes(entry.mode)) {
      findings.push({ ruleId: "non-regular-index-entry", path: entry.path, mode: entry.mode });
      continue;
    }
    for (const rule of GENERATED_OR_PRIVATE_PATH) {
      if (rule.expression.test(entry.path)) findings.push({ ruleId: rule.ruleId, path: entry.path });
    }
    const blob = blobs.get(entry.oid);
    if (!blob) {
      findings.push({ ruleId: "index-blob-unavailable", path: entry.path });
      continue;
    }
    if (blob.subarray(0, Math.min(blob.length, 8192)).includes(0)) {
      if (!/^(?:assets|docs\/site-concepts|docs\/site-concepts-v2)\//.test(entry.path)) {
        findings.push({ ruleId: "binary-blob", path: entry.path });
      }
      continue;
    }
    if (blob.length <= 2_000_000) {
      const text = blob.toString("utf8");
      for (const rule of SECRET_CONTENT) {
        if (rule.expression.test(text)) findings.push({ ruleId: rule.ruleId, path: entry.path });
      }
    }
  }
  return {
    exitCode: findings.length === 0 ? 0 : 1,
    stdout: `${JSON.stringify({ findings })}\n`,
    stderr: "",
    toolVersion: "1.0.0",
    parsedFindings: findings,
  };
}

function executeInvocation(invocation, root, candidate) {
  if (invocation.executable === "internal:sly-exact-index-guard") {
    return internalRepositoryGuard(root, candidate);
  }
  const missingInputs = [];
  for (const [ecosystem, paths] of Object.entries(invocation.requiredInputs ?? {})) {
    for (const path of paths) {
      if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
        missingInputs.push({ ecosystem, path: relative(invocation.cwd, path).replaceAll("\\", "/") });
      }
    }
  }
  if (missingInputs.length) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "",
      blockedReason: "dependency-resolution-input-missing",
      missingInputs,
      toolVersion: "unavailable",
    };
  }
  const supportingToolVersions = {};
  for (const item of invocation.supportingVersionInvocations ?? []) {
    const observed = runProcess(item);
    const observedVersion = `${observed.stdout ?? ""}\n${observed.stderr ?? ""}`.trim().slice(0, 512);
    supportingToolVersions[item.tool.name] = observedVersion;
    if (observed.exitCode !== 0) {
      return {
        ...observed,
        blockedReason: observed.blockedReason ?? "supporting-tool-version-unavailable",
        toolVersion: "unavailable",
        supportingToolVersions,
      };
    }
    if (!observedVersion.includes(item.tool.requiredVersion)) {
      return {
        exitCode: 127, stdout: "", stderr: "", blockedReason: "supporting-tool-version-mismatch",
        toolVersion: "unavailable", supportingToolVersions,
      };
    }
  }
  const preparations = [];
  if (invocation.productionEvidence) {
    mkdirSync(dirname(invocation.productionEvidence.mavenList), { recursive: true });
    mkdirSync(invocation.productionEvidence.nuget.packageRoot, { recursive: true });
  }
  for (const preparationInvocation of invocation.prepareInvocations ?? []) {
    const execution = runProcess(preparationInvocation);
    preparations.push({ id: preparationInvocation.id, tool: preparationInvocation.tool.tool, execution });
    if (execution.exitCode !== 0) {
      return {
        ...execution,
        blockedReason: execution.blockedReason ?? "production-dependency-resolution-failed",
        toolVersion: "unavailable",
        supportingToolVersions,
        preparations,
      };
    }
  }
  let preparation = null;
  if (invocation.prepareInvocation) {
    preparation = runProcess(invocation.prepareInvocation);
    if (preparation.exitCode !== 0) {
      return { ...preparation, blockedReason: preparation.blockedReason ?? "candidate-dependencies-unavailable", toolVersion: "unavailable" };
    }
  }
  let supportingToolVersion = null;
  let supportingExecution = null;
  let sbomDocument = null;
  let coverageMissing = [];
  if (invocation.supportingInvocation) {
    const supportingVersion = runProcess(invocation.supportingInvocation.versionInvocation);
    if (supportingVersion.exitCode !== 0) {
      return { ...supportingVersion, blockedReason: supportingVersion.blockedReason ?? "supporting-tool-version-unavailable", toolVersion: "unavailable" };
    }
    supportingToolVersion = `${supportingVersion.stdout ?? ""}\n${supportingVersion.stderr ?? ""}`.trim().slice(0, 512);
    if (!supportingToolVersion.includes(invocation.supportingInvocation.tool.requiredVersion)) {
      return { exitCode: 127, stdout: "", stderr: "", blockedReason: "supporting-tool-version-mismatch", toolVersion: "unavailable", supportingToolVersion };
    }
    supportingExecution = runProcess(invocation.supportingInvocation);
    if (supportingExecution.exitCode !== 0) {
      return { ...supportingExecution, blockedReason: supportingExecution.blockedReason ?? "sbom-generation-failed", toolVersion: "unavailable", supportingToolVersion };
    }
    sbomDocument = safeJson(supportingExecution.stdout);
    if (!sbomDocument) {
      return { exitCode: 2, stdout: "", stderr: "", blockedReason: "sbom-output-invalid", toolVersion: "unavailable", supportingToolVersion };
    }
    coverageMissing = missingSbomEcosystems(sbomDocument, invocation.requiredEcosystems ?? []);
    if (coverageMissing.length) {
      return { exitCode: 2, stdout: "", stderr: "", blockedReason: "sbom-ecosystem-coverage-incomplete", toolVersion: "unavailable", supportingToolVersion, coverageMissing };
    }
    if (existsSync(invocation.sbomPath)) {
      return { exitCode: 2, stdout: "", stderr: "", blockedReason: "sbom-output-path-collision", toolVersion: "unavailable", supportingToolVersion };
    }
    writeFileSync(invocation.sbomPath, `${JSON.stringify(sbomDocument)}\n`, { encoding: "utf8", flag: "wx" });
  }
  const version = invocation.versionInvocation ? runProcess(invocation.versionInvocation) : { exitCode: 0, stdout: "" };
  if (version.exitCode !== 0) {
    return { ...version, blockedReason: version.blockedReason ?? "tool-version-unavailable", toolVersion: "unavailable" };
  }
  const execution = runProcess(invocation);
  let productionInventory = null;
  if (invocation.productionEvidence && execution.exitCode === 0) {
    productionInventory = buildProductionInventory(invocation, preparations);
    const document = safeJson(execution.stdout);
    if (!document || !Array.isArray(document.components)) {
      productionInventory.issues.push("Syft production SBOM output is invalid");
    } else {
      document.components.push(...productionInventory.nugetComponents);
      execution.stdout = JSON.stringify(document);
    }
  }
  return {
    ...execution,
    toolVersion: `${version.stdout ?? ""}\n${version.stderr ?? ""}`.trim().slice(0, 512),
    supportingToolVersion,
    supportingToolVersions,
    preparation,
    preparations,
    supportingExecution,
    sbomDocument,
    coverageMissing,
    productionInventory,
  };
}

function normalizeCommand(invocation, repositoryRoot, candidateRoot) {
  const wslRoot = (value) => {
    const normalized = resolve(value).replaceAll("\\", "/");
    const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
    return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : null;
  };
  const replaceRoots = (value) => {
    let normalized = String(value);
    const candidateWslRoot = wslRoot(candidateRoot);
    const repositoryWslRoot = wslRoot(repositoryRoot);
    if (candidateWslRoot) normalized = normalized.replaceAll(candidateWslRoot, "{candidateRoot}");
    if (repositoryWslRoot) normalized = normalized.replaceAll(repositoryWslRoot, "{repositoryRoot}");
    return normalized
      .replaceAll(resolve(candidateRoot), "{candidateRoot}")
      .replaceAll(resolve(repositoryRoot), "{repositoryRoot}")
      .replaceAll("\\", "/");
  };
  const normalizeSubprocess = (subprocess) => ({
    executable: subprocess.executable.startsWith("internal:")
      ? subprocess.executable
      : `sha256:${sha256(resolve(subprocess.executable)).slice("sha256:".length)}`,
    args: subprocess.args.map(replaceRoots),
    shell: false,
    timeoutMs: subprocess.timeoutMs,
  });
  const command = {
    scannerId: invocation.scannerId,
    ...normalizeSubprocess(invocation),
    cwd: invocation.scope,
    tool: invocation.tool,
    ...(invocation.adapter ? { adapter: invocation.adapter } : {}),
  };
  if (invocation.prepareInvocation) command.preparation = normalizeSubprocess(invocation.prepareInvocation);
  if (invocation.prepareInvocations) {
    command.preparations = invocation.prepareInvocations.map((item) => ({
      id: item.id,
      tool: { name: item.tool.tool, requiredVersion: item.tool.version },
      ...normalizeSubprocess(item),
    }));
  }
  if (invocation.supportingVersionInvocations) {
    command.supportingVersions = invocation.supportingVersionInvocations.map((item) => ({
      tool: item.tool,
      ...normalizeSubprocess(item),
    }));
  }
  if (invocation.supportingInvocation) {
    command.supporting = {
      ...normalizeSubprocess(invocation.supportingInvocation),
      tool: invocation.supportingInvocation.tool,
    };
  }
  return command;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function scannerRelativePath(value, invocation) {
  const source = String(value ?? "");
  if (!source) return { path: null, unsafe: false };
  const absolute = isAbsolute(source) ? resolve(source) : resolve(invocation.cwd, source);
  let root;
  let observed;
  try {
    root = realpathSync.native(invocation.cwd);
    observed = realpathSync.native(absolute);
  } catch {
    return { path: null, unsafe: true };
  }
  const boundary = relative(root, observed);
  if (boundary.startsWith("..") || isAbsolute(boundary)) return { path: null, unsafe: true };
  return { path: boundary.replaceAll("\\", "/").toLowerCase(), unsafe: false };
}

function inspectOsvDiagnostics(stderr, invocation) {
  const sourcePaths = new Set();
  let unsafeSourceCount = 0;
  for (const line of String(stderr ?? "").split(/\r?\n/)) {
    const match = /^Scanned (.+?) file and found (\d+) packages?$/i.exec(line.trim());
    if (!match) continue;
    const observed = scannerRelativePath(match[1], invocation);
    if (observed.unsafe) {
      unsafeSourceCount += 1;
      continue;
    }
    if (!observed.path) continue;
    sourcePaths.add(observed.path);
  }
  return { sourcePaths, unsafeSourceCount };
}

function inspectOsvReport(document, invocation, stderr) {
  const presentEcosystems = new Set();
  const sourcePaths = new Set();
  const advisories = new Map();
  let unsafeSourceCount = 0;
  for (const result of document?.results ?? []) {
    const source = String(result?.source?.path ?? "");
    if (source) {
      const observed = scannerRelativePath(source, invocation);
      if (observed.unsafe) unsafeSourceCount += 1;
      else if (observed.path) sourcePaths.add(observed.path);
    }
    for (const packageResult of result?.packages ?? []) {
      const ecosystem = String(packageResult?.package?.ecosystem ?? "").toLowerCase();
      if (ecosystem) presentEcosystems.add(ecosystem);
      for (const vulnerability of packageResult?.vulnerabilities ?? []) {
        const id = String(vulnerability?.id ?? "");
        const key = id || hashObject(vulnerability);
        if (!advisories.has(key)) advisories.set(key, vulnerability);
      }
    }
  }
  const diagnostics = inspectOsvDiagnostics(stderr, invocation);
  unsafeSourceCount += diagnostics.unsafeSourceCount;
  for (const path of diagnostics.sourcePaths) sourcePaths.add(path);
  for (const [ecosystem, paths] of Object.entries(invocation.requiredInputs ?? {})) {
    const required = paths.map((path) => relative(invocation.cwd, path).replaceAll("\\", "/").toLowerCase());
    if (required.length > 0 && required.every((path) => sourcePaths.has(path))) presentEcosystems.add(ecosystem);
  }
  const missingEcosystems = (invocation.requiredEcosystems ?? [])
    .filter((ecosystem) => !presentEcosystems.has(ecosystem.toLowerCase()));
  const expectedSources = Object.values(invocation.requiredInputs ?? {}).flat()
    .map((path) => relative(invocation.cwd, path).replaceAll("\\", "/").toLowerCase());
  const missingSources = expectedSources.filter((path) => !sourcePaths.has(path));
  const findings = { critical: 0, high: 0 };
  let unknownSeverity = 0;
  for (const vulnerability of advisories.values()) {
    const severity = String(vulnerability?.database_specific?.severity ?? "").toUpperCase();
    if (severity === "CRITICAL") findings.critical += 1;
    else if (severity === "HIGH") findings.high += 1;
    else if (!["LOW", "MODERATE", "MEDIUM"].includes(severity)) unknownSeverity += 1;
  }
  return {
    ...findings,
    advisoryCount: advisories.size,
    missingEcosystems,
    missingSources,
    unknownSeverity,
    unsafeSourceCount,
  };
}

function missingSbomEcosystems(document, required) {
  const present = new Set();
  for (const component of document?.components ?? []) {
    const purl = String(component?.purl ?? "").toLowerCase();
    for (const ecosystem of required) {
      if (purl.startsWith(`pkg:${ecosystem}/`)) present.add(ecosystem);
    }
  }
  return required.filter((ecosystem) => !present.has(ecosystem));
}

function componentLicense(component) {
  const licenses = component?.licenses ?? [];
  return licenses.map((item) => item?.expression ?? item?.license?.id ?? item?.license?.name).filter(Boolean);
}

const LICENSE_NAME_ALIASES = new Map([
  ["MIT License", "MIT"],
  ["Bouncy Castle Licence", "MIT"],
  ["Apache 2.0", "Apache-2.0"],
  ["Apache License, Version 2.0", "Apache-2.0"],
  ["The Apache License, Version 2.0", "Apache-2.0"],
  ["The Apache Software License, Version 2.0", "Apache-2.0"],
  ["Eclipse Public License v2.0", "EPL-2.0"],
]);

function spdxTokens(expression) {
  const tokens = [];
  const matcher = /\s*(\(|\)|AND\b|OR\b|WITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*)/gy;
  let position = 0;
  while (position < expression.length) {
    matcher.lastIndex = position;
    const match = matcher.exec(expression);
    if (!match || match.index !== position) return null;
    tokens.push(match[1]);
    position = matcher.lastIndex;
  }
  return tokens;
}

function parseSpdxAtoms(expression) {
  const linkedName = /^"([^"]+)";link="[^"]*"$/i.exec(expression)?.[1] ?? expression;
  const canonical = LICENSE_NAME_ALIASES.get(linkedName) ?? linkedName;
  const tokens = spdxTokens(canonical);
  if (!tokens || tokens.length === 0) return null;
  let position = 0;
  const atoms = [];
  let unsupportedWith = false;
  const factor = () => {
    if (tokens[position] === "(") {
      position += 1;
      if (!orExpression() || tokens[position] !== ")") return false;
      position += 1;
      return true;
    }
    const token = tokens[position];
    if (!token || [")", "AND", "OR", "WITH"].includes(token)) return false;
    atoms.push(token);
    position += 1;
    if (tokens[position] === "WITH") {
      unsupportedWith = true;
      position += 1;
      const exception = tokens[position];
      if (!exception || ["(", ")", "AND", "OR", "WITH"].includes(exception)) return false;
      position += 1;
    }
    return true;
  };
  const andExpression = () => {
    if (!factor()) return false;
    while (tokens[position] === "AND") {
      position += 1;
      if (!factor()) return false;
    }
    return true;
  };
  function orExpression() {
    if (!andExpression()) return false;
    while (tokens[position] === "OR") {
      position += 1;
      if (!andExpression()) return false;
    }
    return true;
  }
  if (!orExpression() || position !== tokens.length || unsupportedWith) return null;
  return { canonical, atoms: [...new Set(atoms)] };
}

export function classifySpdxExpression(expression, policy) {
  if (typeof expression !== "string" || expression.trim() === "") return { classification: "unknown", atoms: [] };
  const parsed = parseSpdxAtoms(expression.trim());
  if (!parsed) return { classification: "unknown", atoms: [] };
  const allowed = new Set(policy?.allowedSpdxExpressions ?? []);
  const denied = new Set(policy?.deniedSpdxExpressions ?? []);
  const review = new Set(policy?.reviewRequiredSpdxExpressions ?? []);
  let classification = "allowed";
  if (parsed.atoms.some((atom) => denied.has(atom))) classification = "denied";
  else if (parsed.atoms.some((atom) => review.has(atom))) classification = "review_required";
  else if (parsed.atoms.some((atom) => !allowed.has(atom))) classification = "unknown";
  return { classification, atoms: parsed.atoms, canonicalExpression: parsed.canonical };
}

function componentIdentity(component) {
  const purl = String(component?.purl ?? "");
  const match = /^pkg:(npm|pypi|maven|nuget)\/(.+)@([^?#]+)(?:[?#].*)?$/i.exec(purl);
  if (!match) return null;
  let name;
  try {
    name = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  const ecosystem = match[1].toLowerCase();
  if (ecosystem === "pypi") name = name.toLowerCase().replace(/[-_.]+/g, "-");
  else if (["npm", "nuget"].includes(ecosystem)) name = name.toLowerCase();
  return { ecosystem, name, version: match[3], key: `${ecosystem}|${name}|${match[3]}`, purl };
}

function componentLocations(component) {
  return (component?.properties ?? [])
    .filter((property) => /^syft:(?:location:\d+:path|metadata:virtualPath)$/.test(String(property?.name ?? "")))
    .map((property) => `/${String(property?.value ?? "").replaceAll("\\", "/").replace(/^\/+/, "")}`.toLowerCase());
}

function belongsToProductionEvidence(component, ecosystem) {
  const locations = componentLocations(component);
  if (ecosystem === "npm") {
    return locations.some((location) => location.includes("/node_modules/")
      && !location.includes("/.scanner-production/nuget/")
      && !location.includes("/.scanner-production/maven/"));
  }
  if (ecosystem === "pypi") {
    return locations.some((location) => location.endsWith("/packages/python/requirements-security.txt"));
  }
  if (ecosystem === "maven") {
    return locations.some((location) => location.includes("/.scanner-production/maven/") && location.endsWith(".jar"));
  }
  if (ecosystem === "nuget") {
    return locations.length === 0 || locations.some((location) => location.includes("/.scanner-production/nuget/"));
  }
  return false;
}

function mavenArtifact(identity) {
  return identity.name.slice(identity.name.lastIndexOf("/") + 1);
}

export function evaluateProductionLicenseDocument(document, expectedComponents, policy) {
  if (!document || !Array.isArray(document.components)) {
    return { parseError: "Syft did not emit a CycloneDX component inventory" };
  }
  if (!Array.isArray(expectedComponents) || expectedComponents.length === 0) {
    return { parseError: "production dependency inventory is unavailable" };
  }
  const expected = new Map();
  for (const component of expectedComponents) {
    const identity = componentIdentity(component);
    if (!identity) return { parseError: "production dependency inventory contains an invalid purl" };
    if (expected.has(identity.key)) return { parseError: "production dependency inventory contains a duplicate purl" };
    expected.set(identity.key, { ...component, ...identity });
  }
  const requiredEcosystems = new Set([...expected.values()].map((item) => item.ecosystem));
  const expectedMavenByArtifactVersion = new Map();
  for (const item of expected.values()) {
    if (item.ecosystem !== "maven") continue;
    const key = `${mavenArtifact(item)}|${item.version}`;
    const matches = expectedMavenByArtifactVersion.get(key) ?? [];
    matches.push(item);
    expectedMavenByArtifactVersion.set(key, matches);
  }
  const actual = new Map();
  for (const component of document.components) {
    let identity = componentIdentity(component);
    if (!identity || !requiredEcosystems.has(identity.ecosystem)
      || !belongsToProductionEvidence(component, identity.ecosystem)) continue;
    if (identity.ecosystem === "maven" && !expected.has(identity.key)) {
      const candidates = expectedMavenByArtifactVersion.get(`${mavenArtifact(identity)}|${identity.version}`) ?? [];
      if (candidates.length === 1) identity = candidates[0];
    }
    const expectedComponent = expected.get(identity.key);
    const current = actual.get(identity.key) ?? { ...identity, licenses: new Set() };
    const licenses = componentLicense(component);
    if (licenses.length === 0 && identity.ecosystem === "maven" && expectedComponent) {
      licenses.push(...componentLicense(expectedComponent));
    }
    for (const license of licenses) current.licenses.add(String(license));
    actual.set(identity.key, current);
  }
  const missingComponents = [...expected.entries()]
    .filter(([key]) => !actual.has(key)).map(([, item]) => item.purl).sort();
  const unexpectedComponents = [...actual.entries()]
    .filter(([key]) => !expected.has(key)).map(([, item]) => item.purl).sort();
  const result = {
    denied: [], unknown: [], reviewRequired: [], missingComponents, unexpectedComponents,
    evaluatedComponentCount: 0,
  };
  for (const [key, expectedComponent] of expected) {
    const component = actual.get(key);
    if (!component) continue;
    result.evaluatedComponentCount += 1;
    const licenses = [...component.licenses];
    if (licenses.length === 0) {
      result.unknown.push(expectedComponent.purl);
      continue;
    }
    for (const license of licenses) {
      const classified = classifySpdxExpression(license, policy);
      const finding = `${expectedComponent.purl}:${license}`;
      if (classified.classification === "denied") result.denied.push(finding);
      else if (classified.classification === "review_required") result.reviewRequired.push(finding);
      else if (classified.classification === "unknown") result.unknown.push(finding);
    }
  }
  for (const field of ["denied", "unknown", "reviewRequired"]) result[field].sort();
  return result;
}

function decodeXmlText(value) {
  return value
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&").trim();
}

function readXmlTag(source, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(source);
  return match ? decodeXmlText(match[1]) : "";
}

function mavenPomPath(listPath, artifact, version) {
  return resolve(dirname(listPath), "maven", `${artifact}-${version}.pom`);
}

function readMavenPomLicenses(pomPath, coordinate) {
  let source;
  try {
    source = readFileSync(pomPath, "utf8");
  } catch {
    return { licenses: [], issues: [`${coordinate}: copied Maven POM license evidence is unavailable`] };
  }
  const licenses = [];
  for (const match of source.matchAll(/<license(?:\s[^>]*)?>([\s\S]*?)<\/license>/gi)) {
    const name = readXmlTag(match[1], "name");
    const url = readXmlTag(match[1], "url");
    if (!name) continue;
    licenses.push({ license: { name, ...(url ? { url } : {}) } });
  }
  return { licenses, issues: [] };
}

export function readNuGetProductionComponents({ lockPath, assetsPath, packageRoot }) {
  const issues = [];
  let lock;
  let assets;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
    assets = JSON.parse(readFileSync(assetsPath, "utf8"));
  } catch {
    return { components: [], issues: ["NuGet lock or assets evidence is invalid"] };
  }
  const packages = new Map();
  for (const target of Object.values(lock?.dependencies ?? {})) {
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    for (const [name, dependency] of Object.entries(target)) {
      if (dependency?.type === "Project") continue;
      const version = dependency?.resolved;
      const contentHash = dependency?.contentHash;
      if (typeof version !== "string" || typeof contentHash !== "string") {
        issues.push(`${name}: NuGet resolved version or contentHash is missing`);
        continue;
      }
      const key = `${name.toLowerCase()}|${version}`;
      const existing = packages.get(key);
      if (existing && existing.contentHash !== contentHash) issues.push(`${name}@${version}: NuGet contentHash conflicts across targets`);
      packages.set(key, { name, version, contentHash });
    }
  }
  const assetPackages = new Map();
  for (const [identity, value] of Object.entries(assets?.libraries ?? {})) {
    if (value?.type !== "package") continue;
    const separator = identity.lastIndexOf("/");
    if (separator <= 0) continue;
    assetPackages.set(`${identity.slice(0, separator).toLowerCase()}|${identity.slice(separator + 1)}`, value.sha512);
  }
  const components = [];
  for (const [key, dependency] of [...packages.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (assetPackages.get(key) !== dependency.contentHash) {
      issues.push(`${dependency.name}@${dependency.version}: project.assets.json contentHash mismatch`);
      continue;
    }
    const directory = resolve(packageRoot, dependency.name.toLowerCase(), dependency.version.toLowerCase());
    const metadataPath = resolve(directory, ".nupkg.metadata");
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    } catch {
      issues.push(`${dependency.name}@${dependency.version}: restored NuGet metadata is unavailable`);
      continue;
    }
    if (metadata?.contentHash !== dependency.contentHash) {
      issues.push(`${dependency.name}@${dependency.version}: restored NuGet contentHash mismatch`);
      continue;
    }
    let nuspecFiles = [];
    try {
      nuspecFiles = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".nuspec"));
    } catch {
      // Reported below as a missing package manifest.
    }
    if (nuspecFiles.length !== 1) {
      issues.push(`${dependency.name}@${dependency.version}: exactly one restored nuspec is required`);
      continue;
    }
    const nuspec = readFileSync(resolve(directory, nuspecFiles[0]), "utf8");
    const match = /<license\s+[^>]*type\s*=\s*["']expression["'][^>]*>([\s\S]*?)<\/license>/i.exec(nuspec);
    if (!match) {
      issues.push(`${dependency.name}@${dependency.version}: nuspec license must be an SPDX expression`);
      continue;
    }
    const expression = decodeXmlText(match[1]);
    if (!expression) {
      issues.push(`${dependency.name}@${dependency.version}: nuspec SPDX expression is empty`);
      continue;
    }
    components.push({
      type: "library",
      ecosystem: "nuget",
      name: dependency.name,
      version: dependency.version,
      purl: `pkg:nuget/${encodeURIComponent(dependency.name)}@${dependency.version}`,
      licenses: [{ expression }],
    });
  }
  for (const key of assetPackages.keys()) {
    if (!packages.has(key)) issues.push(`${key.replace("|", "@")} is present in assets but absent from the source lock`);
  }
  return { components, issues: [...new Set(issues)].sort() };
}

function npmPurl(name, version) {
  if (name.startsWith("@") && name.includes("/")) {
    const separator = name.indexOf("/");
    return `pkg:npm/%40${encodeURIComponent(name.slice(1, separator))}/${encodeURIComponent(name.slice(separator + 1))}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

function pnpmProductionComponents(stdout) {
  const parsed = safeJson(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]?.dependencies) {
    return { components: [], issues: ["pnpm production dependency output is invalid"] };
  }
  const components = new Map();
  const visit = (dependencies) => {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      if (typeof dependency?.version !== "string") {
        components.set(`invalid:${name}`, null);
        continue;
      }
      const purl = npmPurl(name, dependency.version);
      const identity = componentIdentity({ purl });
      components.set(identity.key, { ecosystem: "npm", name, version: dependency.version, purl });
      visit(dependency.dependencies);
    }
  };
  visit(parsed[0].dependencies);
  const issues = components.has("invalid") || [...components.keys()].some((key) => key.startsWith("invalid:"))
    ? ["pnpm production dependency output contains an unresolved package"] : [];
  return { components: [...components.values()].filter(Boolean), issues };
}

function pythonProductionComponents(requirementsPath) {
  const components = new Map();
  const issues = [];
  for (const line of readFileSync(requirementsPath, "utf8").split(/\r?\n/)) {
    if (/^\s|^#|^--|^$/.test(line)) continue;
    const match = /^([A-Za-z0-9_.-]+)==([^\s\\;]+)(?:\s|\\|;|$)/.exec(line);
    if (!match) {
      issues.push("hashed Python production requirements contain an unpinned entry");
      continue;
    }
    const name = match[1].toLowerCase().replace(/[-_.]+/g, "-");
    const purl = `pkg:pypi/${encodeURIComponent(name)}@${match[2]}`;
    const identity = componentIdentity({ purl });
    components.set(identity.key, { ecosystem: "pypi", name, version: match[2], purl });
  }
  if (components.size === 0) issues.push("hashed Python production requirements are empty");
  return { components: [...components.values()], issues: [...new Set(issues)] };
}

export function readMavenProductionComponents(listPath) {
  const components = new Map();
  const issues = [];
  let source;
  try {
    source = readFileSync(listPath, "utf8");
  } catch {
    return { components: [], issues: ["Maven runtime dependency evidence is unavailable"] };
  }
  for (const original of source.split(/\r?\n/)) {
    const line = original.replace(ANSI_CSI_SEQUENCE, "").trim().split(/\s+--\s+/, 1)[0];
    if (!line || line.startsWith("The following")) continue;
    const fields = line.split(":");
    if (![5, 6].includes(fields.length)) continue;
    const [group, artifact] = fields;
    const version = fields.length === 5 ? fields[3] : fields[4];
    const scope = fields.length === 5 ? fields[4] : fields[5];
    if (!["compile", "runtime"].includes(scope)) {
      issues.push(`Maven runtime dependency evidence contains an unexpected scope: ${scope || "empty"}`);
      continue;
    }
    const name = `${group}/${artifact}`;
    const purl = `pkg:maven/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}@${version}`;
    const identity = componentIdentity({ purl });
    const licenseEvidence = readMavenPomLicenses(mavenPomPath(listPath, artifact, version), `${group}:${artifact}:${version}`);
    issues.push(...licenseEvidence.issues);
    components.set(identity.key, {
      ecosystem: "maven",
      name,
      version,
      purl,
      ...(licenseEvidence.licenses.length ? { licenses: licenseEvidence.licenses } : {}),
    });
  }
  if (components.size === 0) issues.push("Maven runtime dependency evidence is empty");
  return { components: [...components.values()], issues: [...new Set(issues)].sort() };
}

function buildProductionInventory(invocation, preparations) {
  const evidence = invocation.productionEvidence;
  if (!evidence) return { components: [], issues: ["production dependency evidence plan is unavailable"] };
  const pnpmResult = preparations.find((item) => item.id === evidence.pnpmListPreparationId)?.execution;
  const npm = pnpmProductionComponents(pnpmResult?.stdout ?? "");
  const python = pythonProductionComponents(invocation.requiredInputs.pypi[0]);
  const maven = readMavenProductionComponents(evidence.mavenList);
  const nuget = readNuGetProductionComponents(evidence.nuget);
  const components = [...npm.components, ...python.components, ...maven.components, ...nuget.components];
  const ecosystems = new Set(components.map((item) => item.ecosystem));
  const missingEcosystems = (invocation.requiredEcosystems ?? []).filter((ecosystem) => !ecosystems.has(ecosystem));
  const issues = [...npm.issues, ...python.issues, ...maven.issues, ...nuget.issues];
  if (missingEcosystems.length) issues.push(`production dependency ecosystems are missing: ${missingEcosystems.join(",")}`);
  return { components, nugetComponents: nuget.components, issues: [...new Set(issues)].sort() };
}

function evaluateLicenseOutput(stdout, policyPath, productionInventory) {
  const document = safeJson(stdout);
  if (!document || !Array.isArray(document.components)) return { parseError: "Syft did not emit a CycloneDX component inventory" };
  if (!existsSync(policyPath)) return { parseError: "license policy is unavailable" };
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch {
    return { parseError: "license policy is invalid" };
  }
  if ((productionInventory?.issues ?? []).length > 0) {
    return { inventoryError: "production dependency evidence is inconsistent", inventoryIssues: productionInventory.issues };
  }
  return evaluateProductionLicenseDocument(document, productionInventory?.components, policy);
}

function parseExecution(scanner, execution, invocation) {
  const findings = {
    critical: 0,
    high: 0,
    deniedLicenses: 0,
    unknownLicenses: 0,
    reviewRequiredLicenses: 0,
  };
  if (execution.blockedReason) return {
    status: "blocked",
    findings,
    details: {
      reason: execution.blockedReason,
      ...(execution.coverageMissing?.length ? { missingEcosystems: execution.coverageMissing } : {}),
      ...(execution.missingInputs?.length ? { missingInputs: execution.missingInputs } : {}),
    },
  };
  if (!String(execution.toolVersion ?? "").includes(scanner.version)) {
    return { status: "blocked", findings, details: { reason: "tool-version-mismatch" } };
  }
  if (scanner.parser === "repository-guard") {
    findings.high = execution.parsedFindings?.length ?? 0;
  } else if (scanner.parser === "eslint-json") {
    const report = safeJson(execution.stdout);
    if (!Array.isArray(report)) return { status: "blocked", findings, details: { reason: "eslint-output-invalid" } };
    findings.high = report.reduce((total, file) => total + (file.errorCount ?? 0) + (file.warningCount ?? 0), 0);
  } else if (scanner.parser === "semgrep-json") {
    const report = safeJson(execution.stdout);
    if (!report || !Array.isArray(report.results)) return { status: "blocked", findings, details: { reason: "semgrep-output-invalid" } };
    if ((report.errors?.length ?? 0) > 0) {
      return { status: "blocked", findings, details: { reason: "semgrep-analysis-error" } };
    }
    for (const result of report.results) {
      const severity = String(result?.extra?.severity ?? "ERROR").toUpperCase();
      if (severity === "CRITICAL") findings.critical += 1;
      else findings.high += 1;
    }
  } else if (scanner.parser === "osv-json") {
    const report = safeJson(execution.stdout);
    if (!report) {
      const networkFailure = /(?:network|registry|connect|dns|timeout|certificate)/i.test(`${execution.stdout}\n${execution.stderr}`);
      return { status: "blocked", findings, details: { reason: networkFailure ? "vulnerability-database-unavailable" : "osv-output-invalid" } };
    }
    if (!Array.isArray(report.results)) return { status: "blocked", findings, details: { reason: "osv-output-invalid" } };
    const inspection = inspectOsvReport(report, invocation, execution.stderr);
    if (inspection.unsafeSourceCount > 0) {
      return { status: "blocked", findings, details: { reason: "osv-source-outside-exact-candidate" } };
    }
    if (inspection.missingEcosystems.length || inspection.missingSources.length) {
      return {
        status: "blocked",
        findings,
        details: {
          reason: "osv-four-ecosystem-coverage-incomplete",
          missingEcosystems: inspection.missingEcosystems,
          missingSources: inspection.missingSources,
        },
      };
    }
    if (inspection.unknownSeverity > 0) {
      return { status: "blocked", findings, details: { reason: "osv-vulnerability-severity-unavailable", count: inspection.unknownSeverity } };
    }
    findings.critical = inspection.critical;
    findings.high = inspection.high;
    if (execution.exitCode > 1) {
      return { status: "blocked", findings, details: { reason: "osv-operational-error", advisoryCount: inspection.advisoryCount } };
    }
    if (inspection.advisoryCount > 0) {
      return { status: "fail", findings, details: { advisoryCount: inspection.advisoryCount } };
    }
  } else if (scanner.parser === "syft-license-policy") {
    const evaluation = evaluateLicenseOutput(execution.stdout, invocation.licensePolicyPath, execution.productionInventory);
    if (evaluation.parseError) return { status: "blocked", findings, details: { reason: evaluation.parseError } };
    if (evaluation.inventoryError) {
      return { status: "blocked", findings, details: { reason: evaluation.inventoryError, inventoryIssues: evaluation.inventoryIssues } };
    }
    if (evaluation.missingComponents.length || evaluation.unexpectedComponents.length) {
      return {
        status: "blocked",
        findings,
        details: {
          reason: "production-dependency-closure-mismatch",
          missingComponents: evaluation.missingComponents,
          unexpectedComponents: evaluation.unexpectedComponents,
        },
      };
    }
    const presentEcosystems = new Set((execution.productionInventory?.components ?? []).map((item) => item.ecosystem));
    const missing = (invocation.requiredEcosystems ?? []).filter((ecosystem) => !presentEcosystems.has(ecosystem));
    if (missing.length) return { status: "blocked", findings, details: { reason: "sbom-ecosystem-coverage-incomplete", missingEcosystems: missing } };
    findings.deniedLicenses = evaluation.denied.length;
    findings.unknownLicenses = evaluation.unknown.length;
    findings.reviewRequiredLicenses = evaluation.reviewRequired.length;
    findings.high = findings.deniedLicenses;
    if (findings.unknownLicenses || findings.reviewRequiredLicenses) {
      return { status: "blocked", findings, details: evaluation };
    }
  }
  if (scanner.parser !== "exit-zero" && execution.exitCode !== 0 && findings.critical === 0 && findings.high === 0) {
    return { status: "blocked", findings, details: { reason: "scanner-exit-without-findings" } };
  }
  const status = execution.exitCode === 0 && findings.critical === 0 && findings.high === 0 ? "pass" : "fail";
  return { status, findings, details: {} };
}

function emptyDirectory(path) {
  mkdirSync(path, { recursive: true });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("materialization destination is not a real directory");
  if (readdirSync(path).length !== 0) throw new Error("materialization destination must be empty");
}

export function materializeExactIndex({ root, candidate, destination }) {
  const repositoryRoot = resolve(root);
  const target = resolve(destination);
  const current = currentCandidate(repositoryRoot, candidate, "materialization");
  if (current.entries.some((entry) => !["100644", "100755"].includes(entry.mode))) {
    throw new Error("exact index contains an unsafe non-regular entry");
  }
  emptyDirectory(target);
  const blobs = readIndexBlobs(repositoryRoot, current.entries.map((entry) => entry.oid));
  for (const entry of current.entries) {
    const absolute = resolve(target, entry.path);
    const boundary = relative(target, absolute);
    if (boundary.startsWith("..") || resolve(absolute) === target) throw new Error("materialized path escaped its destination");
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, blobs.get(entry.oid), {
      flag: "wx",
      mode: entry.mode === "100755" ? 0o755 : 0o644,
    });
    if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isFile()) {
      throw new Error("materialized candidate contains an unsafe file");
    }
    const actual = readFileSync(absolute);
    if (!actual.equals(blobs.get(entry.oid))) throw new Error("materialized candidate bytes do not match the exact index");
  }
  currentCandidate(repositoryRoot, candidate, "materialization verification");
  return target;
}

function safeRemoveScannerWorkspace(workspace) {
  const absolute = resolve(workspace);
  const tempRoot = `${resolve(tmpdir())}${sep}`;
  if (!absolute.startsWith(tempRoot) || !basename(absolute).startsWith("sly-scanner-")) {
    throw new Error("scanner workspace cleanup target is not a verified temporary directory");
  }
  rmSync(absolute, { recursive: true, force: true });
}

function serializeRawEvidence(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function runScanner({
  root,
  candidate,
  scannerId,
  rawEvidenceReference,
  rawEvidencePath,
  plan = loadBundledScannerPlan(),
  planDigest,
  toolPaths = {},
  environment = process.env,
  execute,
}) {
  if (!SAFE_REFERENCE.test(rawEvidenceReference ?? "")) throw new Error("raw evidence reference is missing or unsafe");
  const repositoryRoot = resolve(root);
  const parsedPlan = parseScannerPlan(plan);
  const scanner = parsedPlan.scanners.find((item) => item.id === scannerId);
  if (!scanner) throw new Error("scanner ID is not allowlisted");
  const effectivePlanDigest = planDigest ?? scannerPlanDigest(parsedPlan);
  currentCandidate(repositoryRoot, candidate, "execution");
  const workspace = mkdtempSync(resolve(tmpdir(), "sly-scanner-"));
  const candidateRoot = resolve(workspace, "candidate");
  let result;
  try {
    materializeExactIndex({ root: repositoryRoot, candidate, destination: candidateRoot });
    const invocation = buildScannerInvocation(parsedPlan, scannerId, {
      repositoryRoot,
      candidateRoot,
      rawEvidencePath,
      toolPaths,
      environment,
    });
    const command = normalizeCommand(invocation, repositoryRoot, candidateRoot);
    const startedAt = new Date().toISOString();
    const execution = execute
      ? execute(invocation)
      : executeInvocation(invocation, repositoryRoot, candidate);
    const endedAt = new Date().toISOString();
    currentCandidate(repositoryRoot, candidate, "post-execution verification");
    const parsed = parseExecution(scanner, execution, invocation);
    const rawEvidence = {
      schemaVersion: 1,
      scannerId,
      candidateId: candidate.candidateId,
      candidateManifestDigest: candidate.indexManifestDigest,
      scannerPlanDigest: effectivePlanDigest,
      subject: "exact-staged-tree",
      scope: scanner.scope,
      parser: scanner.parser,
      network: scanner.network,
      tool: {
        name: scanner.tool,
        requiredVersion: scanner.version,
        observedVersion: String(execution.toolVersion ?? "unavailable").slice(0, 512),
      },
      supportingTools: scanner.supportingTools.map((item) => ({
        name: item.tool,
        requiredVersion: item.version,
        observedVersion: String(
          execution.supportingToolVersions?.[item.tool] ?? execution.supportingToolVersion ?? "unavailable",
        ).slice(0, 512),
      })),
      command,
      execution: {
        exitCode: execution.exitCode,
        stdout: execution.stdout ?? "",
        stderr: execution.stderr ?? "",
        startedAt,
        endedAt,
        ...(execution.preparation ? { preparation: execution.preparation } : {}),
        ...(execution.preparations ? { preparations: execution.preparations } : {}),
        ...(execution.supportingExecution ? { supporting: execution.supportingExecution } : {}),
        ...(execution.coverageMissing?.length ? { missingEcosystems: execution.coverageMissing } : {}),
        ...(execution.productionInventory ? { productionInventory: execution.productionInventory } : {}),
      },
      status: parsed.status,
      findings: parsed.findings,
      details: parsed.details,
    };
    const rawBytes = serializeRawEvidence(rawEvidence);
    const rawEvidenceDigest = sha256(rawBytes);
    if (rawEvidencePath) {
      mkdirSync(dirname(resolve(rawEvidencePath)), { recursive: true });
      writeFileSync(resolve(rawEvidencePath), rawBytes, { encoding: "utf8", flag: "wx" });
    }
    const base = {
      schemaVersion: 1,
      gateId: `scanner:${scannerId}`,
      candidateId: candidate.candidateId,
      candidateManifestDigest: candidate.indexManifestDigest,
      scannerPlanDigest: effectivePlanDigest,
      status: parsed.status,
      observedAt: endedAt,
      subject: "exact-staged-tree",
      scanner: { id: scannerId, scope: scanner.scope, parser: scanner.parser, network: scanner.network },
      tool: { name: scanner.tool, version: scanner.version, observedVersion: rawEvidence.tool.observedVersion },
      supportingTools: rawEvidence.supportingTools.map((item) => ({
        name: item.name,
        version: item.requiredVersion,
        observedVersion: item.observedVersion,
      })),
      evidenceDigest: rawEvidenceDigest,
      rawEvidenceReference,
      rawEvidenceDigest,
      commandDigest: hashObject(command),
      exitCode: execution.exitCode,
      findings: parsed.findings,
    };
    result = { ...base, scannerResultDigest: hashObject(base) };
  } finally {
    safeRemoveScannerWorkspace(workspace);
  }
  return result;
}

export function verifyScannerRunnerResult({ result, rawEvidenceBytes, candidate, plan, planDigest }) {
  const errors = [];
  const parsedPlan = parseScannerPlan(plan);
  const scannerId = typeof result?.gateId === "string" && result.gateId.startsWith("scanner:")
    ? result.gateId.slice("scanner:".length)
    : null;
  const scanner = parsedPlan.scanners.find((item) => item.id === scannerId);
  const effectivePlanDigest = planDigest ?? scannerPlanDigest(parsedPlan);
  if (!scanner) errors.push("runner result scanner ID is not canonical");
  if (!sameCandidate(result, candidate)) errors.push("runner result candidate does not match the exact index");
  if (result?.scannerPlanDigest !== effectivePlanDigest) errors.push("runner result scanner plan digest does not match");
  if (result?.subject !== "exact-staged-tree") errors.push("runner result subject is not exact-staged-tree");
  if (!SAFE_REFERENCE.test(result?.rawEvidenceReference ?? "")) errors.push("runner result raw evidence reference is unsafe");
  const bytes = Buffer.isBuffer(rawEvidenceBytes) ? rawEvidenceBytes : Buffer.from(rawEvidenceBytes ?? "");
  if (result?.rawEvidenceDigest !== sha256(bytes) || result?.evidenceDigest !== result?.rawEvidenceDigest) {
    errors.push("runner result raw evidence digest does not match the supplied evidence bytes");
  }
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    errors.push("runner raw evidence is not valid JSON");
  }
  if (raw) {
    if (!sameCandidate(raw, candidate) || raw.scannerId !== scannerId) errors.push("runner raw evidence identity does not match");
    if (raw.scannerPlanDigest !== effectivePlanDigest) errors.push("runner raw evidence scanner plan digest does not match");
    if (result?.commandDigest !== hashObject(raw.command)) errors.push("runner command digest does not match raw evidence");
    if (raw.status !== result?.status || raw.execution?.exitCode !== result?.exitCode) errors.push("runner status or exit code does not match raw evidence");
    if (canonicalJson(raw.findings) !== canonicalJson(result?.findings)) errors.push("runner findings do not match raw evidence");
    if (raw.execution?.endedAt !== result?.observedAt) errors.push("runner observation time does not match raw evidence");
    if (scanner && (raw.subject !== "exact-staged-tree" || raw.scope !== scanner.scope
        || raw.parser !== scanner.parser || raw.network !== scanner.network)) {
      errors.push("runner raw evidence scanner metadata does not match the canonical plan");
    }
    if (scanner && (raw.tool?.name !== scanner.tool || raw.tool?.requiredVersion !== scanner.version
        || raw.tool?.observedVersion !== result?.tool?.observedVersion)) {
      errors.push("runner raw evidence tool identity does not match the result");
    }
    if (canonicalJson(raw.supportingTools ?? []) !== canonicalJson((result?.supportingTools ?? []).map((item) => ({
      name: item.name,
      requiredVersion: item.version,
      observedVersion: item.observedVersion,
    })))) {
      errors.push("runner raw evidence supporting tools do not match the result");
    }
  }
  if (scanner) {
    if (result?.scanner?.id !== scanner.id || result?.scanner?.scope !== scanner.scope
        || result?.scanner?.parser !== scanner.parser || result?.scanner?.network !== scanner.network) {
      errors.push("runner scanner metadata does not match the canonical plan");
    }
    if (result?.tool?.name !== scanner.tool || result?.tool?.version !== scanner.version
        || !String(result?.tool?.observedVersion ?? "").includes(scanner.version)) {
      errors.push("runner tool identity or version does not match the canonical plan");
    }
    if (canonicalJson(result?.supportingTools ?? []) !== canonicalJson(scanner.supportingTools.map((item) => ({
      name: item.tool,
      version: item.version,
      observedVersion: result?.supportingTools?.find((actual) => actual.name === item.tool)?.observedVersion,
    }))) || scanner.supportingTools.some((item) => !String(
      result?.supportingTools?.find((actual) => actual.name === item.tool)?.observedVersion ?? "",
    ).includes(item.version))) {
      errors.push("runner supporting tool identity or version does not match the canonical plan");
    }
  }
  if (!DIGEST.test(result?.commandDigest ?? "") || !DIGEST.test(result?.scannerResultDigest ?? "")) {
    errors.push("runner result digest is missing");
  } else {
    const base = structuredClone(result);
    delete base.scannerResultDigest;
    if (hashObject(base) !== result.scannerResultDigest) errors.push("runner result digest does not match its body");
  }
  if (!["pass", "fail", "blocked"].includes(result?.status)) errors.push("runner result status is invalid");
  if (!Number.isInteger(result?.exitCode)) errors.push("runner result exit code is invalid");
  const counts = ["critical", "high", "deniedLicenses", "unknownLicenses", "reviewRequiredLicenses"];
  if (counts.some((name) => !Number.isInteger(result?.findings?.[name]) || result.findings[name] < 0)) {
    errors.push("runner finding counts are invalid");
  }
  if (result?.status === "pass" && (result.exitCode !== 0 || counts.some((name) => result.findings[name] !== 0))) {
    errors.push("passing runner result contains a non-zero exit or blocking findings");
  }
  return errors;
}
