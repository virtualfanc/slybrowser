import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { hashObject } from "./core.mjs";

export const SCANNER_IDS = Object.freeze([
  "git-diff-check",
  "repository-guard",
  "typecheck",
  "lint",
  "sast",
  "dependency-vulnerability",
  "dependency-license",
]);

const NETWORK_POLICIES = new Set(["none", "required"]);

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function normalizeScanner(scanner) {
  if (!scanner || typeof scanner !== "object" || Array.isArray(scanner)) throw new Error("scanner plan entry must be an object");
  const timeoutMs = scanner.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new Error(`${scanner.id ?? "scanner"}: timeout must be between 1000 and 3600000 milliseconds`);
  }
  if (!NETWORK_POLICIES.has(scanner.network)) throw new Error(`${scanner.id ?? "scanner"}: network policy is invalid`);
  if (scanner.toolPathEnvironment !== undefined && scanner.toolPathEnvironment !== null
      && !/^SLY_SCANNER_[A-Z0-9_]+_PATH$/.test(scanner.toolPathEnvironment)) {
    throw new Error(`${scanner.id ?? "scanner"}: tool path environment name is invalid`);
  }
  const limitations = scanner.limitations ?? [];
  if (!Array.isArray(limitations) || limitations.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${scanner.id ?? "scanner"}: limitations must be non-empty strings`);
  }
  const supportingTools = scanner.supportingTools ?? [];
  if (!Array.isArray(supportingTools) || supportingTools.some((item) => !item || typeof item !== "object"
      || typeof item.tool !== "string" || typeof item.version !== "string"
      || !/^SLY_SCANNER_[A-Z0-9_]+_PATH$/.test(item.toolPathEnvironment ?? ""))) {
    throw new Error(`${scanner.id ?? "scanner"}: supporting tools are invalid`);
  }
  const requiredEcosystems = scanner.requiredEcosystems ?? [];
  if (!Array.isArray(requiredEcosystems) || requiredEcosystems.some((item) => !["npm", "pypi", "maven", "nuget"].includes(item))
      || new Set(requiredEcosystems).size !== requiredEcosystems.length) {
    throw new Error(`${scanner.id ?? "scanner"}: required ecosystems are invalid`);
  }
  return {
    id: nonEmptyString(scanner.id, "scanner id"),
    tool: nonEmptyString(scanner.tool, `${scanner.id ?? "scanner"} tool`),
    version: nonEmptyString(scanner.version, `${scanner.id ?? "scanner"} version`),
    scope: nonEmptyString(scanner.scope, `${scanner.id ?? "scanner"} scope`),
    parser: nonEmptyString(scanner.parser, `${scanner.id ?? "scanner"} parser`),
    network: scanner.network,
    timeoutMs,
    toolPathEnvironment: scanner.toolPathEnvironment ?? null,
    supportingTools: supportingTools.map((item) => ({ ...item })),
    requiredEcosystems: [...requiredEcosystems],
    limitations: [...limitations],
  };
}

export function parseScannerPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scanner plan must be an object");
  if (value.schemaVersion !== 1) throw new Error("scanner plan schema version is invalid");
  if (!Array.isArray(value.scanners)) throw new Error("scanner plan scanners must be an array");
  const scanners = value.scanners.map(normalizeScanner);
  const ids = scanners.map((scanner) => scanner.id);
  if (new Set(ids).size !== ids.length) throw new Error("scanner plan contains duplicate scanner IDs");
  if (ids.length !== SCANNER_IDS.length || SCANNER_IDS.some((id, index) => ids[index] !== id)) {
    throw new Error("scanner plan must contain the canonical seven scanners in canonical order");
  }
  return {
    schemaVersion: 1,
    ...(value.id === undefined ? {} : { id: nonEmptyString(value.id, "scanner plan id") }),
    ...(value.subject === undefined ? {} : { subject: nonEmptyString(value.subject, "scanner plan subject") }),
    scanners,
  };
}

export function loadScannerPlan(path) {
  return parseScannerPlan(JSON.parse(readFileSync(path, "utf8")));
}

export function loadBundledScannerPlan() {
  return loadScannerPlan(new URL("../../contracts/delivery/scanner-plan.json", import.meta.url));
}

export function scannerPlanDigest(plan) {
  return hashObject(parseScannerPlan(plan));
}

function controlledToolPath(scanner, context, fallback) {
  const explicit = context.toolPaths?.[scanner.id];
  const environmentValue = scanner.toolPathEnvironment
    ? (context.environment ?? process.env)[scanner.toolPathEnvironment]
    : undefined;
  const selected = explicit ?? environmentValue;
  if (selected !== undefined) {
    if (typeof selected !== "string" || !isAbsolute(selected)) {
      throw new Error(`${scanner.id}: controlled tool path override must be absolute`);
    }
    return resolve(selected);
  }
  return fallback;
}

function controlledSupportingToolPath(scanner, tool, context, fallback) {
  const explicit = context.toolPaths?.[`${scanner.id}:${tool.tool}`]
    ?? (tool.tool === "pnpm" ? context.toolPaths?.typecheck : undefined);
  const environmentValue = (context.environment ?? process.env)[tool.toolPathEnvironment];
  const selected = explicit ?? environmentValue;
  if (selected !== undefined) {
    if (typeof selected !== "string" || !isAbsolute(selected)) {
      throw new Error(`${scanner.id}:${tool.tool}: controlled supporting tool path must be absolute`);
    }
    return resolve(selected);
  }
  return fallback;
}

function directInvocation(scanner, executable, args, cwd) {
  return {
    scannerId: scanner.id,
    executable,
    args,
    cwd,
    shell: false,
    timeoutMs: scanner.timeoutMs,
    versionInvocation: { executable, args: ["--version"], cwd, shell: false, timeoutMs: 30_000 },
  };
}

function nodeScriptInvocation(scanner, script, args, cwd) {
  return {
    scannerId: scanner.id,
    executable: process.execPath,
    args: [script, ...args],
    cwd,
    shell: false,
    timeoutMs: scanner.timeoutMs,
    versionInvocation: {
      executable: process.execPath,
      args: [script, "--version"],
      cwd,
      shell: false,
      timeoutMs: 30_000,
    },
  };
}

function pnpmInvocation(scanner, toolPath, args, cwd) {
  if (/\.(?:cmd|bat)$/i.test(toolPath)) {
    throw new Error(`${scanner.id}: pnpm shell wrapper is not allowed; provide the absolute pnpm .cjs or .mjs entry point`);
  }
  return /\.(?:c?js|mjs)$/i.test(toolPath)
    ? nodeScriptInvocation(scanner, toolPath, args, cwd)
    : directInvocation(scanner, toolPath, args, cwd);
}

function mavenInvocation(scanner, mavenPath, javaPath, args, cwd) {
  if (isAbsolute(mavenPath) && existsSync(mavenPath) && lstatSync(mavenPath).isDirectory()) {
    const bootDirectory = resolve(mavenPath, "boot");
    const launchers = existsSync(bootDirectory)
      ? readdirSync(bootDirectory).filter((name) => /^plexus-classworlds-[0-9.]+\.jar$/.test(name))
      : [];
    const configuration = resolve(mavenPath, "bin", "m2.conf");
    if (launchers.length !== 1 || !existsSync(configuration)) {
      throw new Error("dependency-license:maven: controlled Maven home is incomplete");
    }
    const prefix = [
      `-Dmaven.multiModuleProjectDirectory=${resolve(cwd, "packages", "java")}`,
      `-Dclassworlds.conf=${configuration}`,
      `-Dmaven.home=${mavenPath}`,
      `-Dlibrary.jansi.path=${resolve(mavenPath, "lib", "jansi-native")}`,
      "-Djansi.force=false",
      "-Dstyle.color=never",
      "-classpath", resolve(bootDirectory, launchers[0]),
      "org.codehaus.plexus.classworlds.launcher.Launcher",
    ];
    const invocation = directInvocation(scanner, javaPath, [...prefix, ...args], cwd);
    invocation.versionInvocation.args = [...prefix, "--version"];
    invocation.adapter = "maven-classworlds";
    return invocation;
  }
  if (/\.(?:cmd|bat)$/i.test(mavenPath)) {
    throw new Error("dependency-license:maven: shell wrapper is not allowed; provide the absolute Maven home directory");
  }
  return directInvocation(scanner, mavenPath, args, cwd);
}

function windowsPathForWsl(path) {
  const normalized = resolve(path).replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) throw new Error("sast: WSL adapter requires a drive-letter candidate path");
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function dependencyInputs(candidateRoot) {
  return {
    npm: [resolve(candidateRoot, "pnpm-lock.yaml")],
    pypi: [resolve(candidateRoot, "packages", "python", "requirements-security.txt")],
    maven: [resolve(candidateRoot, "packages", "java", "pom.xml")],
    nuget: [resolve(candidateRoot, "packages", "dotnet", "src", "SlyBrowser", "packages.lock.json")],
  };
}

export function buildScannerInvocation(plan, scannerId, context) {
  const parsed = parseScannerPlan(plan);
  const scanner = parsed.scanners.find((item) => item.id === scannerId);
  if (!scanner) throw new Error("scanner ID is not present in the canonical plan");
  const repositoryRoot = nonEmptyString(context?.repositoryRoot, "repository root");
  const candidateRoot = nonEmptyString(context?.candidateRoot, "candidate root");
  const cwd = scanner.scope === "staged-diff" ? repositoryRoot : candidateRoot;
  let invocation;
  switch (scanner.id) {
    case "git-diff-check": {
      const executable = controlledToolPath(scanner, context, "git");
      invocation = directInvocation(scanner, executable, ["diff", "--cached", "--check"], repositoryRoot);
      invocation.versionInvocation.args = ["--version"];
      invocation.useGitIndex = true;
      break;
    }
    case "repository-guard":
      invocation = {
        scannerId: scanner.id,
        executable: "internal:sly-exact-index-guard",
        args: [],
        cwd: repositoryRoot,
        shell: false,
        timeoutMs: scanner.timeoutMs,
        versionInvocation: null,
      };
      break;
    case "typecheck": {
      const toolPath = controlledToolPath(scanner, context, "pnpm");
      invocation = pnpmInvocation(scanner, toolPath, ["typecheck"], candidateRoot);
      invocation.prepareInvocation = pnpmInvocation(scanner, toolPath, [
        "install", "--offline", "--frozen-lockfile", "--ignore-scripts",
      ], candidateRoot);
      break;
    }
    case "lint": {
      const defaultPath = resolve(candidateRoot, "node_modules", "eslint", "bin", "eslint.js");
      const toolPath = controlledToolPath(scanner, context, defaultPath);
      invocation = nodeScriptInvocation(scanner, toolPath, [".", "--format", "json", "--max-warnings", "0", "--no-error-on-unmatched-pattern"], candidateRoot);
      const pnpmPath = context.toolPaths?.typecheck
        ?? (context.environment ?? process.env).SLY_SCANNER_PNPM_PATH
        ?? "pnpm";
      if (pnpmPath !== "pnpm" && !isAbsolute(pnpmPath)) throw new Error("lint: pnpm path override must be absolute");
      invocation.prepareInvocation = pnpmInvocation(scanner, pnpmPath, [
        "install", "--offline", "--frozen-lockfile", "--ignore-scripts",
      ], candidateRoot);
      break;
    }
    case "sast": {
      const executable = controlledToolPath(scanner, context, "semgrep");
      const wslAdapter = /^wsl(?:\.exe)?$/i.test(basename(executable));
      const scanRoot = wslAdapter ? windowsPathForWsl(candidateRoot) : candidateRoot;
      const rules = wslAdapter
        ? `${scanRoot}/contracts/delivery/semgrep-rules.yml`
        : resolve(candidateRoot, "contracts", "delivery", "semgrep-rules.yml");
      const prefix = wslAdapter ? ["--exec", "semgrep"] : [];
      invocation = directInvocation(scanner, executable, [
        ...prefix, "scan", "--config", rules,
        "--json", "--error", "--strict", "--metrics=off", scanRoot,
      ], candidateRoot);
      if (wslAdapter) {
        invocation.versionInvocation.args = ["--exec", "semgrep", "--version"];
        invocation.adapter = "wsl-exec";
      }
      break;
    }
    case "dependency-vulnerability": {
      const executable = controlledToolPath(scanner, context, "osv-scanner");
      invocation = directInvocation(scanner, executable, ["scan", "source", "-r", candidateRoot, "--format", "json"], candidateRoot);
      invocation.requiredEcosystems = scanner.requiredEcosystems;
      invocation.requiredInputs = dependencyInputs(candidateRoot);
      break;
    }
    case "dependency-license": {
      const executable = controlledToolPath(scanner, context, "syft");
      const tools = Object.fromEntries(scanner.supportingTools.map((item) => [item.tool, item]));
      const pnpmPath = controlledSupportingToolPath(scanner, tools.pnpm, context, "pnpm");
      const mavenPath = controlledSupportingToolPath(scanner, tools.maven, context, "mvn");
      const javaPath = controlledSupportingToolPath(scanner, tools.java, context, "java");
      const dotnetPath = controlledSupportingToolPath(scanner, tools.dotnet, context, "dotnet");
      const productionRoot = resolve(candidateRoot, ".scanner-production");
      const mavenOutput = resolve(productionRoot, "maven");
      const mavenList = resolve(productionRoot, "maven-dependencies.txt");
      const nugetPackages = resolve(productionRoot, "nuget");
      const dotnetProject = resolve(candidateRoot, "packages", "dotnet", "src", "SlyBrowser", "SlyBrowser.csproj");
      const dotnetAssets = resolve(candidateRoot, "packages", "dotnet", "src", "SlyBrowser", "obj", "project.assets.json");
      invocation = directInvocation(scanner, executable, [
        "scan", `dir:${candidateRoot}`,
        "--override-default-catalogers", "javascript-package-cataloger,python-package-cataloger,java-archive-cataloger",
        "--enrich", "java,javascript,python",
        "--exclude", "./package.json",
        "--exclude", "./packages/node/package.json",
        "--exclude", "./packages/python/pyproject.toml",
        "-o", "cyclonedx-json",
      ], candidateRoot);
      const pnpmInstall = pnpmInvocation(scanner, pnpmPath, [
        "install", "--prod", "--frozen-lockfile", "--ignore-scripts",
      ], candidateRoot);
      const pnpmList = pnpmInvocation(scanner, pnpmPath, [
        "--filter", "slybrowser", "list", "--prod", "--depth", "Infinity", "--json",
      ], candidateRoot);
      const mavenPrefix = ["-q", "-f", resolve(candidateRoot, "packages", "java", "pom.xml")];
      const mavenCopy = mavenInvocation(scanner, mavenPath, javaPath, [
        ...mavenPrefix, "org.apache.maven.plugins:maven-dependency-plugin:3.7.0:copy-dependencies",
        "-DincludeScope=runtime", "-Dmdep.copyPom=true", `-DoutputDirectory=${mavenOutput}`,
      ], candidateRoot);
      const mavenResolve = mavenInvocation(scanner, mavenPath, javaPath, [
        ...mavenPrefix, "org.apache.maven.plugins:maven-dependency-plugin:3.7.0:list",
        "-DincludeScope=runtime", "-DexcludeTransitive=false", `-DoutputFile=${mavenList}`, "-DappendOutput=false",
      ], candidateRoot);
      const dotnetRestore = directInvocation(scanner, dotnetPath, [
        "restore", "--no-cache", "--locked-mode", "--packages", nugetPackages, dotnetProject,
      ], candidateRoot);
      invocation.prepareInvocations = [
        { id: "pnpm-production-install", tool: tools.pnpm, ...pnpmInstall },
        { id: "pnpm-production-list", tool: tools.pnpm, ...pnpmList },
        { id: "maven-runtime-copy", tool: tools.maven, ...mavenCopy },
        { id: "maven-runtime-list", tool: tools.maven, ...mavenResolve },
        { id: "nuget-locked-restore", tool: tools.dotnet, ...dotnetRestore },
      ];
      invocation.supportingVersionInvocations = [
        { tool: { name: tools.pnpm.tool, requiredVersion: tools.pnpm.version }, ...pnpmInstall.versionInvocation },
        { tool: { name: tools.maven.tool, requiredVersion: tools.maven.version }, ...mavenCopy.versionInvocation },
        { tool: { name: tools.java.tool, requiredVersion: tools.java.version }, ...directInvocation(scanner, javaPath, ["-version"], candidateRoot).versionInvocation, args: ["-version"] },
        { tool: { name: tools.dotnet.tool, requiredVersion: tools.dotnet.version }, ...dotnetRestore.versionInvocation },
      ];
      invocation.productionEvidence = {
        pnpmListPreparationId: "pnpm-production-list",
        mavenList,
        nuget: {
          lockPath: resolve(candidateRoot, "packages", "dotnet", "src", "SlyBrowser", "packages.lock.json"),
          assetsPath: dotnetAssets,
          packageRoot: nugetPackages,
        },
      };
      invocation.licensePolicyPath = resolve(candidateRoot, "contracts", "delivery", "license-policy.json");
      invocation.requiredEcosystems = scanner.requiredEcosystems;
      invocation.requiredInputs = dependencyInputs(candidateRoot);
      break;
    }
    default:
      throw new Error("scanner invocation is not implemented");
  }
  invocation.tool = { name: scanner.tool, requiredVersion: scanner.version };
  invocation.scope = scanner.scope;
  invocation.parser = scanner.parser;
  invocation.network = scanner.network;
  return invocation;
}
