import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const packageJsonPaths = [
  "package.json",
  "packages/node/package.json",
  "packages/license-service/package.json",
  "website/package.json",
];

const forbiddenLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "prepare",
]);

const forbiddenScriptPatterns = [
  /\b(?:curl|wget|npx)\b/i,
  /\b(?:npm\s+(?:install|i)|pnpm\s+(?:add|install)|yarn\s+(?:add|install)|pip\s+install)\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  /\b(?:bash|sh|powershell|pwsh)\s+-c\b/i,
];

const requiredIgnorePatterns = [
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
  "*.pfx",
  "secrets/",
  "*.sqlite",
  "*.sqlite-shm",
  "*.sqlite-wal",
  "*.authorization.json",
  "artifacts/",
  "private/",
  "release-staging/",
  "tmp/",
  ".cache/",
  "*.exe",
  "*.dll",
  "*.pdb",
  "*.dSYM/",
  "/AGENTS.md",
  "/.codex/",
  "**/*-codex-scratch.*",
];

const publicBrandScanRoots = [
  "README.md",
  "ROADMAP.md",
  "docs",
  "legal",
  "scripts",
  "contracts",
  "packages",
  "website/src",
];

const forbiddenLegacyBrandPatterns = [
  /virtualbrowser/i,
  /Virtual Browser/,
  /inherited VB/i,
  /\bVB parser\b/i,
  /\bVB field\b/i,
  /\bVB profile\b/i,
  /\bVB parameter\b/i,
];

function isPinnedVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isScannedTextFile(file) {
  return /\.(?:css|cs|java|json|md|mjs|ps1|py|ts|tsx|txt|xml|yml|yaml)$/i.test(file);
}

async function collectPublicBrandFiles(entry) {
  const root = resolve(entry);
  const metadata = await stat(root);
  if (metadata.isFile()) return isScannedTextFile(root) ? [root] : [];

  const files = [];
  for (const child of await readdir(root)) {
    if (
      child === "node_modules"
      || child === "dist"
      || child === "artifacts"
      || child === "memory"
      || child === "target"
      || child === "bin"
      || child === "obj"
      || child === "coverage"
      || child === "TestResults"
    ) continue;
    files.push(...await collectPublicBrandFiles(`${entry}/${child}`));
  }
  return files;
}

test("package scripts do not install dependencies or run remote shell snippets", async () => {
  for (const file of packageJsonPaths) {
    const document = JSON.parse(await readFile(resolve(file), "utf8"));
    for (const [name, command] of Object.entries(document.scripts ?? {})) {
      assert.equal(
        forbiddenLifecycleScripts.has(name),
        false,
        `${file} must not define lifecycle script ${name}`,
      );
      for (const pattern of forbiddenScriptPatterns) {
        assert.equal(pattern.test(String(command)), false, `${file} script ${name} is unsafe: ${command}`);
      }
    }
  }
});

test("installable package dependencies are pinned and lockfile-managed", async () => {
  const root = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(root.packageManager, "pnpm@10.15.1");
  await readFile(resolve("pnpm-lock.yaml"), "utf8");

  for (const file of packageJsonPaths) {
    const document = JSON.parse(await readFile(resolve(file), "utf8"));
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(document[group] ?? {})) {
        assert.equal(isPinnedVersion(version), true, `${file} ${group}.${name} must be an exact pinned version`);
      }
    }
  }
});

test("local ignore rules exclude secrets, private binaries, release staging, and AI scratch files", async () => {
  const ignore = await readFile(resolve(".gitignore"), "utf8");
  for (const pattern of requiredIgnorePatterns) {
    assert.ok(ignore.includes(pattern), `.gitignore must include ${pattern}`);
  }
});

test("public-facing comparison copy discloses saved browser versions instead of hiding them", async () => {
  const files = [
    "README.md",
    "docs/benchmark-latest.md",
    "website/src/siteData.ts",
    "website/src/sections.tsx",
  ];
  const text = (await Promise.all(files.map((file) => readFile(resolve(file), "utf8")))).join("\n");
  assert.match(text, /148\.0\.7778\.179/);
  assert.match(text, /153\.0\.8003\.0/);
  assert.doesNotMatch(text, /intentionally absent from marketing pages/i);
  assert.doesNotMatch(text, /do not disclose the private browser kernel version/i);
});

test("public-facing docs and code do not reintroduce legacy product names", async () => {
  const files = (await Promise.all(publicBrandScanRoots.map((entry) => collectPublicBrandFiles(entry)))).flat();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of forbiddenLegacyBrandPatterns) {
      assert.doesNotMatch(text, pattern, `${file} must not contain ${pattern}`);
    }
  }
});
