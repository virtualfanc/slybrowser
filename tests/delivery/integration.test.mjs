import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

import { captureStagedCandidate } from "../../scripts/delivery/git-candidate.mjs";
import { hashObject } from "../../scripts/delivery/core.mjs";
import { evaluateSecurityGate } from "../../scripts/delivery/security.mjs";
import { evaluateStagedFileAudit } from "../../scripts/delivery/staged-files.mjs";
import { validateFeatureCoverage } from "../../scripts/delivery/documentation.mjs";
import {
  evaluateProductionLicenseDocument,
  materializeExactIndex,
  readNuGetProductionComponents,
  runScanner,
} from "../../scripts/delivery/scanner-runner-lib.mjs";
import * as scannerRunner from "../../scripts/delivery/scanner-runner-lib.mjs";
import { git, initializeRepository, makeGateReceipt } from "./helpers.mjs";

// The real repository is intentionally validated through an alternate index. Fixture
// repositories must never inherit that absolute index path: doing so would make their
// Git commands read or mutate another repository's candidate instead of `.git/index`.
const runnerGitIndexFile = process.env.GIT_INDEX_FILE;
delete process.env.GIT_INDEX_FILE;
after(() => {
  if (runnerGitIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
  else process.env.GIT_INDEX_FILE = runnerGitIndexFile;
});

function tempRepository(files) {
  const root = mkdtempSync(join(tmpdir(), "sly-delivery-integration-"));
  initializeRepository(root, files);
  return root;
}

const securityPolicy = {
  schemaVersion: 1,
  maximumTextBlobBytes: 1024 * 1024,
  publicSurface: {
    allow: ["README.md", "docs/**", "packages/node/**"],
    deny: ["packages/license-service/**", "website/**"],
    reviewRequired: [],
  },
  forbiddenPathPatterns: ["**/*.exe", "**/*.zip"],
  contentPatterns: [
    { id: "private-key", expression: "BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY", flags: "i" },
    { id: "private-path", expression: "[A-Za-z]:\\\\(?:Users|closed)(?:\\\\|/)", flags: "i" },
  ],
  requiredExternalScanners: ["repository-guard", "typecheck", "lint", "sast", "dependency-vulnerability", "dependency-license"],
};

test("candidate identity follows the exact index and ignores unstaged working-tree bytes", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Staged\n");
  git(root, ["add", "README.md"]);
  const staged = captureStagedCandidate(root);
  writeFileSync(join(root, "README.md"), "# Unstaged replacement\n");
  assert.equal(captureStagedCandidate(root).candidateId, staged.candidateId);
  git(root, ["add", "README.md"]);
  assert.notEqual(captureStagedCandidate(root).candidateId, staged.candidateId);
});

test("scanner materialization and execution use staged bytes and bind raw evidence themselves", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "staged-secret-shaped-value\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  writeFileSync(join(root, "README.md"), "safe unstaged replacement\n");
  const destination = mkdtempSync(join(tmpdir(), "sly-exact-index-"));
  materializeExactIndex({ root, candidate, destination });
  assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "staged-secret-shaped-value\n");

  const calls = [];
  const result = runScanner({
    root,
    candidate,
    scannerId: "git-diff-check",
    rawEvidenceReference: "evidence://fixture/git-diff-check.json",
    execute(invocation) {
      calls.push(invocation);
      return { exitCode: 0, stdout: "", stderr: "", toolVersion: "git version 2.55.0.fixture" };
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.subject, "exact-staged-tree");
  assert.match(result.rawEvidenceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.commandDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shell, false);
});

test("scanner materialization reads the controlled alternate Git index", () => {
  const root = tempRepository({ "README.md": "# Default index\n" });
  const alternateIndex = join(mkdtempSync(join(tmpdir(), "sly-alternate-index-")), "candidate.index");
  copyFileSync(join(root, ".git", "index"), alternateIndex);
  const previousIndex = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = alternateIndex;
    writeFileSync(join(root, "README.md"), "# Alternate index candidate\n");
    git(root, ["add", "README.md"], { inheritGitIndex: true });
    const candidate = captureStagedCandidate(root);
    writeFileSync(join(root, "README.md"), "# Safer unstaged bytes\n");
    const destination = mkdtempSync(join(tmpdir(), "sly-alternate-materialized-"));
    materializeExactIndex({ root, candidate, destination });
    assert.equal(readFileSync(join(destination, "README.md"), "utf8"), "# Alternate index candidate\n");
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
  }
});

test("scanner materialization preserves exact index bytes across checkout EOL attributes", () => {
  const root = tempRepository({
    ".gitattributes": "*.ps1 text eol=crlf\n",
    "scripts/check.ps1": "Write-Output 'exact index bytes'\n",
  });
  const candidate = captureStagedCandidate(root);
  const destination = mkdtempSync(join(tmpdir(), "sly-eol-materialized-"));

  materializeExactIndex({ root, candidate, destination });

  assert.equal(
    readFileSync(join(destination, "scripts", "check.ps1"), "utf8"),
    "Write-Output 'exact index bytes'\n",
  );
});

test("scanner execution fails closed on candidate drift", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  writeFileSync(join(root, "README.md"), "# Drifted\n");
  git(root, ["add", "README.md"]);
  assert.throws(() => runScanner({
    root,
    candidate,
    scannerId: "typecheck",
    rawEvidenceReference: "evidence://fixture/typecheck.json",
    execute() { throw new Error("must not execute"); },
  }), /candidate.*changed|drift/i);
});

test("scanner execution rejects candidate drift introduced while the tool runs", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  assert.throws(() => runScanner({
    root,
    candidate,
    scannerId: "git-diff-check",
    rawEvidenceReference: "evidence://fixture/git-diff-check.json",
    execute() {
      writeFileSync(join(root, "README.md"), "# Drifted during execution\n");
      git(root, ["add", "README.md"]);
      return { exitCode: 0, stdout: "", stderr: "", toolVersion: "git version 2.55.0.fixture" };
    },
  }), /candidate.*changed|drift/i);
});

test("Semgrep ERROR findings map to unresolved high findings and fail", () => {
  const root = tempRepository({
    "README.md": "# Candidate\n",
    "contracts/delivery/semgrep-rules.yml": "rules: []\n",
  });
  const candidate = captureStagedCandidate(root);
  const result = runScanner({
    root,
    candidate,
    scannerId: "sast",
    rawEvidenceReference: "evidence://fixture/semgrep.json",
    execute() {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          results: [{ check_id: "fixture.error", extra: { severity: "ERROR" } }],
          errors: [],
        }),
        stderr: "",
        toolVersion: "1.172.0",
      };
    },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.findings.critical, 0);
  assert.equal(result.findings.high, 1);
});

test("OSV parser requires all four exact-candidate ecosystems and maps high/critical advisories", () => {
  const root = tempRepository({
    "README.md": "# Candidate\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "packages/python/requirements-security.txt": "fixture==1.0.0\n",
    "packages/java/pom.xml": "<project/>\n",
    "packages/dotnet/src/SlyBrowser/packages.lock.json": "{}\n",
  });
  const candidate = captureStagedCandidate(root);
  const scan = (omitEcosystem = null) => runScanner({
    root,
    candidate,
    scannerId: "dependency-vulnerability",
    rawEvidenceReference: `evidence://fixture/osv-${omitEcosystem ?? "complete"}.json`,
    execute(invocation) {
      const sources = Object.entries(invocation.requiredInputs)
        .filter(([ecosystem]) => ecosystem !== omitEcosystem)
        .map(([ecosystem, [path]], index) => ({
          source: { path, type: "lockfile" },
          packages: [{
            package: { name: `fixture-${ecosystem}`, version: "1.0.0", ecosystem: {
              npm: "npm", pypi: "PyPI", maven: "Maven", nuget: "NuGet",
            }[ecosystem] },
            vulnerabilities: index < 2 ? [{
              id: `OSV-FIXTURE-${index}`,
              database_specific: { severity: index === 0 ? "CRITICAL" : "HIGH" },
            }] : [],
          }],
        }));
      return {
        exitCode: omitEcosystem === null ? 1 : 0,
        stdout: JSON.stringify({ results: sources }),
        stderr: "",
        toolVersion: "osv-scanner version: 2.4.0",
      };
    },
  });
  const complete = scan();
  assert.equal(complete.status, "fail");
  assert.equal(complete.findings.critical, 1);
  assert.equal(complete.findings.high, 1);
  const incomplete = scan("pypi");
  assert.equal(incomplete.status, "blocked");
});

test("OSV zero-advisory diagnostics prove canonical input coverage and fail closed on mismatch", () => {
  const root = tempRepository({
    "README.md": "# Candidate\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "packages/python/requirements-security.txt": "fixture==1.0.0\n",
    "packages/java/pom.xml": "<project/>\n",
    "packages/dotnet/src/SlyBrowser/packages.lock.json": "{}\n",
  });
  const candidate = captureStagedCandidate(root);
  const scan = (mode = "complete") => runScanner({
    root,
    candidate,
    scannerId: "dependency-vulnerability",
    rawEvidenceReference: `evidence://fixture/osv-zero-${mode}.json`,
    execute(invocation) {
      const diagnostics = Object.entries(invocation.requiredInputs).flatMap(([ecosystem, paths]) =>
        paths.flatMap((path) => {
          if (mode === `missing-${ecosystem}`) return [];
          const observedPath = mode === `mismatch-${ecosystem}` ? `${path}.different` : path;
          return [`Scanned ${observedPath} file and found 1 packages`];
        }),
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ results: [] }),
        stderr: diagnostics.join("\n"),
        toolVersion: "osv-scanner version: 2.4.0",
      };
    },
  });

  assert.equal(scan().status, "pass");
  assert.equal(scan("missing-pypi").status, "blocked");
  assert.equal(scan("mismatch-nuget").status, "blocked");
});

test("license evaluation is production-only, deduplicates purls, and blocks every mismatch or unresolved atom", () => {
  const policy = {
    allowedSpdxExpressions: ["MIT", "Apache-2.0"],
    deniedSpdxExpressions: ["AGPL-3.0-only"],
    reviewRequiredSpdxExpressions: ["PSF-2.0"],
  };
  const expected = [
    { ecosystem: "npm", name: "fixture", version: "1.0.0", purl: "pkg:npm/fixture@1.0.0" },
    { ecosystem: "pypi", name: "greenlet", version: "3.5.5", purl: "pkg:pypi/greenlet@3.5.5" },
    { ecosystem: "maven", name: "org.bouncycastle/bcprov-jdk18on", version: "1.84", purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.84" },
    { ecosystem: "nuget", name: "Example.Package", version: "2.0.0", purl: "pkg:nuget/Example.Package@2.0.0" },
  ];
  const document = {
    components: [
      { name: "fixture", version: "1.0.0", purl: "pkg:npm/fixture@1.0.0", licenses: [{ expression: "MIT" }], properties: [{ name: "syft:location:0:path", value: "\\node_modules\\fixture\\package.json" }] },
      { name: "fixture", version: "1.0.0", purl: "pkg:npm/fixture@1.0.0", licenses: [{ expression: "MIT" }], properties: [{ name: "syft:location:0:path", value: "\\node_modules\\fixture\\package.json" }] },
      { name: "greenlet", version: "3.5.5", purl: "pkg:pypi/greenlet@3.5.5", licenses: [{ expression: "MIT AND PSF-2.0" }], properties: [{ name: "syft:location:0:path", value: "\\packages\\python\\requirements-security.txt" }] },
      { name: "bcprov-jdk18on", version: "1.84", purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.84", licenses: [{ license: { name: "Bouncy Castle Licence" } }], properties: [{ name: "syft:location:0:path", value: "\\.scanner-production\\maven\\bcprov-jdk18on-1.84.jar" }] },
      { name: "Example.Package", version: "2.0.0", purl: "pkg:nuget/Example.Package@2.0.0", licenses: [{ expression: "Fixture-Unknown" }] },
      { name: "checkout", version: "v4", purl: "pkg:github/actions/checkout@v4" },
    ],
  };
  const result = evaluateProductionLicenseDocument(document, expected, policy);
  assert.deepEqual(result.missingComponents, []);
  assert.deepEqual(result.unexpectedComponents, []);
  assert.equal(result.reviewRequired.length, 1);
  assert.equal(result.unknown.length, 1);
  assert.equal(result.evaluatedComponentCount, 4);

  document.components.push({
    name: "junit-jupiter", version: "5.11.4",
    purl: "pkg:maven/org.junit.jupiter/junit-jupiter@5.11.4",
    licenses: [{ expression: "EPL-2.0" }],
    properties: [{ name: "syft:location:0:path", value: "\\.scanner-production\\maven\\junit-jupiter-5.11.4.jar" }],
  });
  const mismatch = evaluateProductionLicenseDocument(document, expected, policy);
  assert.deepEqual(mismatch.unexpectedComponents, ["pkg:maven/org.junit.jupiter/junit-jupiter@5.11.4"]);
});

test("license evaluation reconciles controlled Maven jars and ignores non-production embedded manifests", () => {
  const policy = {
    allowedSpdxExpressions: ["MIT", "Apache-2.0"],
    deniedSpdxExpressions: [],
    reviewRequiredSpdxExpressions: [],
  };
  const expected = [
    {
      ecosystem: "npm",
      name: "playwright-core",
      version: "1.62.1",
      purl: "pkg:npm/playwright-core@1.62.1",
    },
    {
      ecosystem: "maven",
      name: "io.opentelemetry/opentelemetry-api",
      version: "1.64.0",
      purl: "pkg:maven/io.opentelemetry/opentelemetry-api@1.64.0",
    },
  ];
  const productionDocument = {
    components: [
      {
        name: "playwright-core",
        version: "1.62.1",
        purl: "pkg:npm/playwright-core@1.62.1",
        licenses: [{ expression: "Apache-2.0" }],
        properties: [{ name: "syft:location:0:path", value: "\\node_modules\\playwright-core\\package.json" }],
      },
      {
        name: "opentelemetry-api",
        version: "1.64.0",
        purl: "pkg:maven/io.opentelemetry.api/opentelemetry-api@1.64.0",
        licenses: [{ license: { name: "The Apache License, Version 2.0" } }],
        properties: [{
          name: "syft:location:0:path",
          value: "\\.scanner-production\\maven\\opentelemetry-api-1.64.0.jar",
        }],
      },
      {
        name: "@slybrowser/workspace",
        version: "0.1.0",
        purl: "pkg:npm/%40slybrowser/workspace@0.1.0",
        properties: [{ name: "syft:location:0:path", value: "\\package.json" }],
      },
      {
        name: "playwright-core",
        version: "1.61.1-beta",
        purl: "pkg:npm/playwright-core@1.61.1-beta",
        licenses: [{ expression: "Apache-2.0" }],
        properties: [{
          name: "syft:location:0:path",
          value: "\\.scanner-production\\nuget\\microsoft.playwright\\package\\package.json",
        }],
      },
    ],
  };

  const reconciled = evaluateProductionLicenseDocument(productionDocument, expected, policy);
  assert.deepEqual(reconciled.missingComponents, []);
  assert.deepEqual(reconciled.unexpectedComponents, []);
  assert.deepEqual(reconciled.unknown, []);
  assert.equal(reconciled.evaluatedComponentCount, 2);

  productionDocument.components.push({
    name: "left-pad",
    version: "1.3.0",
    purl: "pkg:npm/left-pad@1.3.0",
    licenses: [{ expression: "MIT" }],
    properties: [{ name: "syft:location:0:path", value: "\\node_modules\\left-pad\\package.json" }],
  });
  const mismatch = evaluateProductionLicenseDocument(productionDocument, expected, policy);
  assert.deepEqual(mismatch.unexpectedComponents, ["pkg:npm/left-pad@1.3.0"]);
});

test("license evaluation uses controlled Maven POM evidence when Syft Java archive licenses are incomplete", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-maven-license-evidence-"));
  const productionRoot = join(root, ".scanner-production");
  const mavenDirectory = join(productionRoot, "maven");
  const listPath = join(productionRoot, "maven-dependencies.txt");
  mkdirSync(mavenDirectory, { recursive: true });
  writeFileSync(listPath, [
    "The following files have been resolved:",
    "   org.seleniumhq.selenium:selenium-api:jar:4.46.0:runtime",
    "   org.bouncycastle:bcprov-jdk18on:jar:1.84:runtime",
    "",
  ].join("\n"));
  writeFileSync(join(mavenDirectory, "selenium-api-4.46.0.pom"), [
    "<project><licenses><license>",
    "<name>The Apache Software License, Version 2.0</name>",
    "</license></licenses></project>",
  ].join(""));
  writeFileSync(join(mavenDirectory, "bcprov-jdk18on-1.84.pom"), [
    "<project><licenses><license>",
    "<name>Bouncy Castle Licence</name>",
    "</license></licenses></project>",
  ].join(""));

  const expected = scannerRunner.readMavenProductionComponents(listPath);
  assert.deepEqual(expected.issues, []);
  assert.deepEqual(
    expected.components.map((component) => component.licenses?.[0]?.license?.name),
    ["The Apache Software License, Version 2.0", "Bouncy Castle Licence"],
  );

  const policy = {
    allowedSpdxExpressions: ["Apache-2.0", "MIT"],
    deniedSpdxExpressions: [],
    reviewRequiredSpdxExpressions: [],
  };
  const productionDocument = {
    components: [
      {
        name: "selenium-api",
        version: "4.46.0",
        purl: "pkg:maven/selenium-api/selenium-api@4.46.0",
        properties: [{ name: "syft:location:0:path", value: "\\.scanner-production\\maven\\selenium-api-4.46.0.jar" }],
      },
      {
        name: "bcprov-jdk18on",
        version: "1.84",
        purl: "pkg:maven/org.bouncycastle/bcprov-jdk18on@1.84",
        properties: [{ name: "syft:location:0:path", value: "\\.scanner-production\\maven\\bcprov-jdk18on-1.84.jar" }],
      },
    ],
  };

  const result = evaluateProductionLicenseDocument(productionDocument, expected.components, policy);
  assert.deepEqual(result.missingComponents, []);
  assert.deepEqual(result.unexpectedComponents, []);
  assert.deepEqual(result.unknown, []);
  assert.equal(result.evaluatedComponentCount, 2);
});

test("NuGet production inventory requires locked hashes and expression licenses", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-nuget-license-"));
  const lockPath = join(root, "packages.lock.json");
  const assetsPath = join(root, "project.assets.json");
  const packageRoot = join(root, "packages");
  const installed = join(packageRoot, "example.package", "2.0.0");
  mkdirSync(installed, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({
    version: 1,
    dependencies: { "net8.0": { "Example.Package": { type: "Direct", resolved: "2.0.0", contentHash: "fixture-content-hash" } } },
  }));
  writeFileSync(assetsPath, JSON.stringify({ libraries: {
    "Example.Package/2.0.0": { type: "package", sha512: "fixture-content-hash" },
  } }));
  writeFileSync(join(installed, ".nupkg.metadata"), JSON.stringify({ contentHash: "fixture-content-hash" }));
  writeFileSync(join(installed, "example.package.nuspec"), "<package><metadata><id>Example.Package</id><version>2.0.0</version><license type=\"expression\">MIT</license></metadata></package>");
  const valid = readNuGetProductionComponents({ lockPath, assetsPath, packageRoot });
  assert.deepEqual(valid.issues, []);
  assert.equal(valid.components[0].licenses[0].expression, "MIT");

  writeFileSync(join(installed, ".nupkg.metadata"), JSON.stringify({ contentHash: "tampered" }));
  const tampered = readNuGetProductionComponents({ lockPath, assetsPath, packageRoot });
  assert.match(tampered.issues.join("\n"), /contentHash/i);

  writeFileSync(join(installed, ".nupkg.metadata"), JSON.stringify({ contentHash: "fixture-content-hash" }));
  writeFileSync(join(installed, "example.package.nuspec"), "<package><metadata><license type=\"file\">LICENSE.txt</license></metadata></package>");
  const fileLicense = readNuGetProductionComponents({ lockPath, assetsPath, packageRoot });
  assert.match(fileLicense.issues.join("\n"), /expression/i);
});

test("Maven production inventory accepts plain and ANSI coordinates but rejects unexpected scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "sly-maven-inventory-"));
  const plainPath = join(root, "plain.txt");
  const ansiPath = join(root, "ansi.txt");
  const invalidPath = join(root, "invalid.txt");
  const mavenDirectory = join(root, "maven");
  const coordinate = "org.example:example-runtime:jar:1.2.3:compile";
  mkdirSync(mavenDirectory, { recursive: true });
  writeFileSync(join(mavenDirectory, "example-runtime-1.2.3.pom"), [
    "<project><licenses><license>",
    "<name>The Apache Software License, Version 2.0</name>",
    "</license></licenses></project>",
  ].join(""));
  writeFileSync(plainPath, `The following files have been resolved:\n   ${coordinate}\n`);
  writeFileSync(ansiPath, `The following files have been resolved:\n   ${coordinate}\u001b[36m\n`);
  writeFileSync(invalidPath, "The following files have been resolved:\n   org.example:test-only:jar:1.0.0:test\n");

  const plain = scannerRunner.readMavenProductionComponents(plainPath);
  const ansi = scannerRunner.readMavenProductionComponents(ansiPath);
  const invalid = scannerRunner.readMavenProductionComponents(invalidPath);
  assert.deepEqual(plain.issues, []);
  assert.deepEqual(ansi.issues, []);
  assert.deepEqual(plain.components, ansi.components);
  assert.equal(plain.components[0].purl, "pkg:maven/org.example/example-runtime@1.2.3");
  assert.equal(plain.components[0].licenses[0].license.name, "The Apache Software License, Version 2.0");
  assert.match(invalid.issues.join("\n"), /unexpected.*scope.*test/i);
});

test("placeholder env exception does not suppress content scanning", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  mkdirSync(join(root, "config"));
  writeFileSync(join(root, "config", ".env.example"), `${["API_KEY", "=", "\"real-looking-secret-value\""].join("")}\n`);
  git(root, ["add", "config/.env.example"]);
  const candidate = captureStagedCandidate(root);
  const policy = structuredClone(securityPolicy);
  policy.publicSurface.allow.push("config/**");
  policy.forbiddenPathPatterns.push("**/.env.*");
  policy.allowedPlaceholderPaths = ["**/.env.example"];
  policy.contentPatterns.push({ id: "credential", expression: "API_KEY=\\\"[A-Za-z0-9-]{12,}\\\"", flags: "i" });
  const result = evaluateSecurityGate({
    root,
    candidate,
    policy: { ...policy, requiredExternalScanners: [] },
    metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" },
    scannerReceipts: [],
  });
  assert.equal(result.findings.some((finding) => finding.ruleId === "forbidden-artifact-path"), false);
  assert.equal(result.findings.some((finding) => finding.ruleId === "credential"), true);
  assert.equal(result.status, "fail");
});

test("security gate scans staged blobs, not safer unstaged replacements", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), `${["-----BEGIN PRIVATE", " KEY-----"].join("")}\nfixture-only\n`);
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  writeFileSync(join(root, "README.md"), "# Safe working copy\n");
  const scanners = securityPolicy.requiredExternalScanners.map((id) => makeGateReceipt(`scanner:${id}`, candidate.candidateId));
  const result = evaluateSecurityGate({ root, candidate, policy: securityPolicy, metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" }, scannerReceipts: scanners });
  assert.equal(result.status, "fail");
  assert.equal(result.findings.some((finding) => finding.ruleId === "private-key"), true);
});

test("security gate rejects non-English project text", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "guide.md"), "# \u4ea7\u54c1\n");
  git(root, ["add", "docs/guide.md"]);
  const candidate = captureStagedCandidate(root);
  const policy = structuredClone(securityPolicy);
  policy.contentPatterns.push({ id: "non-english-letter", expression: "(?:(?!\\p{Script=Latin})\\p{Letter})", flags: "u" });
  const scanners = policy.requiredExternalScanners.map((id) => makeGateReceipt(`scanner:${id}`, candidate.candidateId));
  const result = evaluateSecurityGate({
    root,
    candidate,
    policy,
    metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" },
    scannerReceipts: scanners,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.findings.some((finding) => finding.ruleId === "non-english-letter"), true);
});

test("security gate recomputes index entries instead of trusting a tampered candidate body", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), `${["-----BEGIN PRIVATE", " KEY-----"].join("")}\nfixture-only\n`);
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  const tampered = { ...candidate, entries: [], trackedFileCount: 0 };
  const result = evaluateSecurityGate({
    root,
    candidate: tampered,
    policy: { ...securityPolicy, requiredExternalScanners: [] },
    metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" },
    scannerReceipts: [],
  });
  assert.equal(result.status, "fail");
  assert.equal(result.findings.some((finding) => finding.ruleId === "private-key"), true);
});

test("security gate blocks when a required external scanner receipt is absent", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  const result = evaluateSecurityGate({ root, candidate, policy: securityPolicy, metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" }, scannerReceipts: [] });
  assert.equal(result.status, "blocked");
  assert.equal(result.missingScanners.length, securityPolicy.requiredExternalScanners.length);
});

test("security gate rejects a scanner that reports unresolved high findings", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  const scanners = securityPolicy.requiredExternalScanners.map((id) => makeGateReceipt(`scanner:${id}`, candidate.candidateId));
  scanners[0].findings.high = 1;
  const result = evaluateSecurityGate({ root, candidate, policy: securityPolicy, metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" }, scannerReceipts: scanners });
  assert.equal(result.status, "fail");
  assert.match(result.scannerErrors.join("\n"), /high/i);
});

test("security gate rejects retired receipt-signing fields", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  const scanners = securityPolicy.requiredExternalScanners.map((id) => makeGateReceipt(`scanner:${id}`, candidate.candidateId));
  scanners[0].signature = { algorithm: "Ed25519", value: "retired" };
  const result = evaluateSecurityGate({
    root,
    candidate,
    policy: securityPolicy,
    metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" },
    scannerReceipts: scanners,
  });
  assert.notEqual(result.status, "pass");
  assert.match(result.scannerErrors.join("\n"), /retired.*signing/i);
});

test("public boundary is fail-closed for private service paths", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  const target = join(root, "packages", "license-service", "src", "server.ts");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "export const fixture = true;\n");
  git(root, ["add", "packages/license-service/src/server.ts"]);
  const candidate = captureStagedCandidate(root);
  const scanners = securityPolicy.requiredExternalScanners.map((id) => makeGateReceipt(`scanner:${id}`, candidate.candidateId));
  const result = evaluateSecurityGate({ root, candidate, policy: securityPolicy, metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" }, scannerReceipts: scanners });
  assert.equal(result.status, "fail");
  assert.equal(result.findings.some((finding) => finding.ruleId === "public-surface-denied"), true);
});

test("security gate rejects extensionless executable magic and staged symbolic links", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "payload"), Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x66, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65]));
  writeFileSync(join(root, "link-target.txt"), "README.md");
  const linkOid = git(root, ["hash-object", "-w", "link-target.txt"]);
  git(root, ["add", "payload"]);
  git(root, ["update-index", "--add", "--cacheinfo", `120000,${linkOid},public-link`]);
  const candidate = captureStagedCandidate(root);
  const policy = structuredClone(securityPolicy);
  policy.publicSurface.allow.push("payload", "public-link");
  const scanners = policy.requiredExternalScanners.map((id) => makeGateReceipt(`scanner:${id}`, candidate.candidateId));
  const result = evaluateSecurityGate({ root, candidate, policy, metadata: { message: "safe", authorName: "Fixture", authorEmail: "fixture@example.invalid", branch: "feature/safe" }, scannerReceipts: scanners });
  assert.equal(result.status, "fail");
  assert.equal(result.findings.some((finding) => finding.ruleId === "forbidden-binary-magic"), true);
  assert.equal(result.findings.some((finding) => finding.ruleId === "symbolic-link"), true);
});

test("staged-file audit binds the staged inventory and rejects forbidden untracked artifacts", () => {
  const root = tempRepository({ "README.md": "# Baseline\n" });
  writeFileSync(join(root, "README.md"), "# Candidate\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  const policy = { prohibitedUntrackedPatterns: ["**/.env"], prohibitedStagedPatterns: ["**/*.exe"] };
  assert.equal(evaluateStagedFileAudit(root, candidate, policy).status, "pass");
  mkdirSync(join(root, "local"));
  writeFileSync(join(root, "local", ".env"), "fixture\n");
  assert.equal(evaluateStagedFileAudit(root, candidate, policy).status, "fail");
});

test("staged-file audit permits forbidden-path deletion but rejects additions and rename destinations", () => {
  const policy = {
    prohibitedUntrackedPatterns: [],
    prohibitedStagedPatterns: ["**/.env.example"],
  };

  const deletionRoot = tempRepository({ "private/.env.example": "placeholder\n" });
  unlinkSync(join(deletionRoot, "private", ".env.example"));
  git(deletionRoot, ["add", "--all"]);
  const deletionCandidate = captureStagedCandidate(deletionRoot);
  const deletion = evaluateStagedFileAudit(deletionRoot, deletionCandidate, policy);
  assert.deepEqual(deletionCandidate.stagedPaths, ["private/.env.example"]);
  assert.equal(deletion.stagedFileCount, 1);
  assert.equal(deletion.status, "pass", deletion.errors.join("\n"));

  const additionRoot = tempRepository({ "README.md": "# Baseline\n" });
  mkdirSync(join(additionRoot, "private"));
  writeFileSync(join(additionRoot, "private", ".env.example"), "placeholder\n");
  git(additionRoot, ["add", "--all"]);
  const additionCandidate = captureStagedCandidate(additionRoot);
  const addition = evaluateStagedFileAudit(additionRoot, additionCandidate, policy);
  assert.equal(addition.status, "fail");
  assert.match(addition.errors.join("\n"), /forbidden staged artifact: private\/\.env\.example/);

  const renameRoot = tempRepository({ "safe-placeholder.txt": "placeholder\n" });
  mkdirSync(join(renameRoot, "private"));
  renameSync(join(renameRoot, "safe-placeholder.txt"), join(renameRoot, "private", ".env.example"));
  git(renameRoot, ["add", "--all"]);
  const renameCandidate = captureStagedCandidate(renameRoot);
  const rename = evaluateStagedFileAudit(renameRoot, renameCandidate, policy);
  assert.equal(rename.status, "fail");
  assert.equal(rename.errors.includes("staged path inventory does not match candidate receipt"), false);
  assert.match(rename.errors.join("\n"), /forbidden staged artifact: private\/\.env\.example/);
});

test("feature coverage requires every local surface and keeps remote publication distinct", () => {
  const root = tempRepository({
    "README.md": "# Feature fixture-token\n",
    "CHANGELOG.md": "fixture-token\n",
    "contracts/example.json": "{}\n",
    "docs/api.md": "# API fixture-token\n",
    "docs/config.md": "# Config fixture-token\n",
    "docs/example.md": "# Example fixture-token\n",
    "docs/support.md": "# Support fixture-token\n",
    "docs/wiki/Home.md": "# Home\n[Feature](Feature.md)\n",
    "docs/wiki/Feature.md": "# Feature\nfixture-token\n## Installation\nInstall.\n## Configuration\nConfigure.\n## API\nUse.\n## Errors\nFail.\n## Limitations\nLimited.\n## Platforms\nAll.\n",
  });
  const manifest = {
    schemaVersion: 1,
    features: [{
      id: "fixture",
      status: "active",
      coverageToken: "fixture-token",
      local: {
        contract: ["contracts/example.json"],
        readme: ["README.md"], api: ["docs/api.md"], configuration: ["docs/config.md"],
        examples: ["docs/example.md"], changelog: ["CHANGELOG.md"], support: ["docs/support.md"],
        wiki: ["docs/wiki/Feature.md"], githubFacing: ["README.md"],
      },
      external: { githubAbout: "receipt-required", remoteWiki: "receipt-required", officialWebsiteSource: "receipt-required", websiteDeployment: "receipt-required" },
    }],
  };
  const result = validateFeatureCoverage(root, manifest, { affectedFeatureIds: ["fixture"], externalReceipts: [] });
  assert.equal(result.localStatus, "pass");
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.missingExternalSurfaces.sort(), ["githubAbout", "officialWebsiteSource", "remoteWiki", "websiteDeployment"].sort());
});

test("documentation source receipts accept candidate-bound evidence and reject retired signing fields", () => {
  const root = tempRepository({
    "README.md": "# Feature\n",
    "CHANGELOG.md": "feature\n",
    "contracts/example.json": "{}\n",
    "docs/api.md": "# API\n",
    "docs/config.md": "# Config\n",
    "docs/example.md": "# Example\n",
    "docs/support.md": "# Support\n",
    "docs/wiki/Home.md": "# Home\n[Feature](Feature.md)\n",
    "docs/wiki/Feature.md": "# Feature\n## Installation\nInstall.\n## Configuration\nConfigure.\n## API\nUse.\n## Errors\nFail.\n## Limitations\nLimited.\n## Platforms\nAll.\n",
  });
  writeFileSync(join(root, "README.md"), "# Candidate feature\n");
  git(root, ["add", "README.md"]);
  const candidate = captureStagedCandidate(root);
  const manifest = {
    schemaVersion: 1,
    externalCommitRequired: ["officialWebsiteSource"],
    features: [{
      id: "fixture", status: "active",
      local: {
        contract: ["contracts/example.json"], readme: ["README.md"], api: ["docs/api.md"],
        configuration: ["docs/config.md"], examples: ["docs/example.md"], changelog: ["CHANGELOG.md"],
        support: ["docs/support.md"], wiki: ["docs/wiki/Feature.md"], githubFacing: ["README.md"],
      },
      external: { officialWebsiteSource: "receipt-required" },
    }],
  };
  const gateId = "docs-external:fixture:officialWebsiteSource";
  const receipt = {
    schemaVersion: 1, gateId, candidateId: candidate.candidateId, candidateManifestDigest: candidate.indexManifestDigest,
    status: "pass", observedAt: new Date().toISOString(), subject: "official-website-source",
    evidenceDigest: `sha256:${"a".repeat(64)}`, rawEvidenceReference: "artifact://website/coverage.json",
    rawEvidenceDigest: `sha256:${"b".repeat(64)}`, commandDigest: `sha256:${"c".repeat(64)}`, exitCode: 0,
    remoteDeployment: "not_evaluated",
  };
  const context = {
    candidate, candidateId: candidate.candidateId, affectedFeatureIds: ["fixture"],
  };
  const passed = validateFeatureCoverage(root, manifest, { ...context, externalReceipts: [receipt] });
  assert.equal(passed.status, "pass", passed.externalErrors.join("\n"));
  const retired = { ...receipt, signature: { algorithm: "Ed25519", value: "retired" } };
  const blocked = validateFeatureCoverage(root, manifest, { ...context, externalReceipts: [retired] });
  assert.notEqual(blocked.status, "pass");
  assert.match(blocked.externalErrors.join("\n"), /retired.*signing/i);
});

test("the checked-in active feature inventory has complete local Wiki coverage", () => {
  const root = resolve(".");
  const manifest = JSON.parse(readFileSync(join(root, "contracts", "delivery", "feature-coverage.json"), "utf8"));
  const result = validateFeatureCoverage(root, manifest, { affectedFeatureIds: [], externalReceipts: [] });
  assert.equal(result.localStatus, "pass", result.errors.join("\n"));
  assert.equal(result.status, "pass", result.externalErrors.join("\n"));
  assert.ok(result.activeFeatureCount >= 10);
});

test("documentation coverage reads the exact staged Wiki blob instead of an unstaged replacement", () => {
  const root = tempRepository({
    "README.md": "# Feature\n",
    "CHANGELOG.md": "feature\n",
    "contracts/example.json": "{}\n",
    "docs/api.md": "# API\n",
    "docs/config.md": "# Config\n",
    "docs/example.md": "# Example\n",
    "docs/support.md": "# Support\n",
    "docs/wiki/Home.md": "# Home\n[Feature](Feature.md)\n",
    "docs/wiki/Feature.md": "# Feature\n## Installation\nInstall.\n## Configuration\nConfigure.\n## API\nUse.\n## Errors\nFail.\n## Limitations\nLimited.\n## Platforms\nAll.\n",
  });
  writeFileSync(join(root, "docs", "wiki", "Feature.md"), "# Staged feature\n## Installation\nInstall.\n## Configuration\nConfigure.\n## API\nUse.\n## Errors\nFail.\n## Limitations\nLimited.\n## Platforms\nAll.\n");
  git(root, ["add", "docs/wiki/Feature.md"]);
  const candidate = captureStagedCandidate(root);
  writeFileSync(join(root, "docs", "wiki", "Home.md"), "# Unstaged\n[Missing](Missing.md)\n");
  const manifest = {
    schemaVersion: 1,
    features: [{
      id: "fixture", status: "active",
      local: {
        contract: ["contracts/example.json"], readme: ["README.md"], api: ["docs/api.md"],
        configuration: ["docs/config.md"], examples: ["docs/example.md"], changelog: ["CHANGELOG.md"],
        support: ["docs/support.md"], wiki: ["docs/wiki/Feature.md"], githubFacing: ["README.md"],
      }, external: {},
    }],
  };
  const result = validateFeatureCoverage(root, manifest, { candidate, affectedFeatureIds: ["fixture"] });
  assert.equal(result.status, "pass", result.errors.join("\n"));
});
