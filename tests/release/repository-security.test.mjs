import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const packageJsonPaths = [
  "package.json",
  "packages/node/package.json",
];

const privateRepositoryPrefixes = ["memory/", "packages/license-service/", "website/"];

const privateOperationalFiles = [
  "scripts/release/Publish-ReleaseBundleToServer.ps1",
  "scripts/release/Smoke-PayNowWebhook.mjs",
  "scripts/release/Sync-ReleaseRepository.ps1",
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
  "docs",
  "legal",
  "scripts",
  "contracts",
  "packages",
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

test("GitHub README exposes the official Free license claim", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.match(readme, /https:\/\/slybrowser\.com\/free-license/);
  assert.match(readme, /90-day Free license certificate by email/i);
  assert.match(readme, /one concurrent browser process/i);
  assert.match(readme, /does not renew automatically/i);
  assert.match(readme, /once per email/i);
});

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
      || child === ".pytest_cache"
      || child === "__pycache__"
      || child === ".mypy_cache"
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

test("the public workspace and tracked tree exclude private service, website, and research sources", async () => {
  const root = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const workspace = await readFile(resolve("pnpm-workspace.yaml"), "utf8");
  const serializedScripts = JSON.stringify(root.scripts ?? {});
  assert.doesNotMatch(serializedScripts, /@slybrowser\/license-service|packages\/license-service|\bwebsite\b/i);
  assert.doesNotMatch(workspace, /packages\/license-service|(?:^|\s)-\s+website(?:\s|$)/m);

  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const deleted = spawnSync("git", ["diff", "--name-only", "--diff-filter=D", "-z"], { cwd: resolve("."), encoding: "utf8" });
  assert.equal(deleted.status, 0, deleted.stderr);
  const deletedPaths = new Set(deleted.stdout.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/")));
  const paths = tracked.stdout.split("\0").filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !deletedPaths.has(path));
  for (const prefix of privateRepositoryPrefixes) {
    assert.equal(paths.some((path) => path.startsWith(prefix)), false, `public Git index must exclude ${prefix}`);
  }
});

test("the public current tree excludes private server operations", async () => {
  for (const file of privateOperationalFiles) {
    await assert.rejects(stat(resolve(file)), { code: "ENOENT" }, `${file} belongs in the private website repository`);
  }
});

test("the public surface denies internal plans and governance material", async () => {
  const policy = JSON.parse(await readFile(resolve("contracts/delivery/public-surface.json"), "utf8"));
  for (const pattern of [
    "AGENTS.md",
    "PROJECT_REQUIREMENTS.md",
    "PROJECT_STATUS.md",
    "ROADMAP.md",
    "docs/*-backlog.md",
    "docs/*-design-draft.md",
    "docs/*-plan.md",
    "docs/*-proposal.md",
    "docs/*-requirements.md",
    "docs/*-todo.md",
    "governance/**",
    "internal/**",
    "legal/*-DRAFT.md",
    "planning/**",
  ]) {
    assert.ok(policy.deny.includes(pattern), `public surface must deny ${pattern}`);
  }
});

test("lint is a real pinned ESLint gate and is distinct from typecheck", async () => {
  const root = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const nodePackage = JSON.parse(await readFile(resolve("packages/node/package.json"), "utf8"));
  for (const [file, document] of [["package.json", root], ["packages/node/package.json", nodePackage]]) {
    assert.match(String(document.scripts?.lint ?? ""), /\beslint\b/, `${file} lint must execute ESLint`);
    assert.notEqual(document.scripts?.lint, document.scripts?.typecheck, `${file} lint must not alias typecheck`);
    for (const dependency of ["eslint", "@typescript-eslint/parser", "@typescript-eslint/eslint-plugin"]) {
      assert.match(
        String(document.devDependencies?.[dependency] ?? ""),
        /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
        `${file} must pin ${dependency}`,
      );
    }
  }
  await stat(resolve("eslint.config.mjs"));
});

test("GitHub workflows pin every external action to an immutable commit", async () => {
  const workflowFiles = (await readdir(resolve(".github/workflows"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => `.github/workflows/${entry.name}`)
    .sort();
  assert.ok(workflowFiles.length > 0, "public repository must contain GitHub workflows");
  for (const file of workflowFiles) {
    const source = await readFile(resolve(file), "utf8");
    const actionReferences = [...source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
    assert.ok(actionReferences.length > 0, `${file} must contain action references`);
    for (const reference of actionReferences) {
      assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/i, `${file} action must be pinned: ${reference}`);
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
