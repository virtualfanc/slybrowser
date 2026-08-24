#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid SHA-256 value: ${value}`);
  return value;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptionalJson(path) {
  return path ? readJson(path) : undefined;
}

function gate(id, label, status, details = {}) {
  if (!["PASS", "FAIL", "PENDING"].includes(status)) throw new Error(`Invalid gate status for ${id}`);
  return { id, label, status, ...details };
}

function redactMessage(value) {
  return String(value ?? "")
    .replace(/sly_(?:live|test)_[A-Za-z0-9_.-]+/g, "[redacted-license-key]")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, "[redacted-token]")
    .slice(0, 240);
}

function summarizeLicenseOnly(report) {
  if (!report) return gate("signed-private-browser", "Signed private-browser native runtime handoff matrix", "PENDING");
  const cases = Array.isArray(report.cases) ? report.cases : [];
  const failed = cases.filter((item) => item.passed !== true);
  return gate(
    "signed-private-browser",
    "Signed private-browser native runtime handoff matrix",
    report.passed === true && failed.length === 0 ? "PASS" : "FAIL",
    {
      caseCount: cases.length,
      failedCaseIds: failed.map((item) => String(item.id ?? "unknown")),
    },
  );
}

function expectedReportHash(report, topLevelName, artifactName = topLevelName) {
  if (!report) return undefined;
  const value = report[topLevelName] ?? report.artifact?.[artifactName];
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function summarizeReleaseBundle(report, expectedHashes) {
  if (!report) return gate("release-bundle", "Signed release bundle verification", "PENDING");
  const mismatchedFields = [];
  for (const [field, expected] of Object.entries(expectedHashes)) {
    const actual = expectedReportHash(report, field, field === "artifactSha256" ? "sha256" : field);
    if (actual && actual !== expected) mismatchedFields.push(field);
  }
  return gate(
    "release-bundle",
    "Signed release bundle verification",
    report.status === "QUALIFIED" && mismatchedFields.length === 0 ? "PASS" : "FAIL",
    {
      keyId: typeof report.keyId === "string" ? report.keyId : undefined,
      manifestSha256: typeof report.manifest?.sha256 === "string" ? report.manifest.sha256 : undefined,
      artifactUrl: typeof report.artifact?.url === "string" ? report.artifact.url : undefined,
      mismatchedFields,
    },
  );
}

function summarizeKernelUpdate(report) {
  if (!report) {
    return gate(
      "kernel-update-score-gate",
      "Kernel update score gate",
      "PENDING",
      { reason: "No kernel-update score gate report was supplied" },
    );
  }
  const failed = Array.isArray(report.gates)
    ? report.gates.filter((item) => item.status !== "PASS")
    : [{ id: "missing-gates" }];
  return gate(
    "kernel-update-score-gate",
    "Kernel update score gate",
    report.status === "PASS" && failed.length === 0 ? "PASS" : "FAIL",
    {
      failedGateIds: failed.map((item) => String(item.id ?? "unknown")),
      sameMajorComparison: report.results?.sameMajorComparison === true,
      scoreDelta: Number.isFinite(report.results?.scoreDelta) ? report.results.scoreDelta : undefined,
    },
  );
}

function summarizeCleanMachineValidation(report) {
  if (!report) {
    return gate(
      "clean-machine-release-validation",
      "Clean-machine install, update, rollback and fail-closed validation",
      "PENDING",
      { reason: "No clean-machine validation report was supplied" },
    );
  }
  const results = Array.isArray(report.results) ? report.results : [];
  const failed = results.filter((item) => item.status !== "PASS");
  return gate(
    "clean-machine-release-validation",
    "Clean-machine install, update, rollback and fail-closed validation",
    report.status === "PASS" && failed.length === 0 && report.authFileRemoved === true ? "PASS" : "FAIL",
    {
      resultCount: results.length,
      failedCaseIds: failed.map((item) => String(item.id ?? item.name ?? "unknown")),
      selectedVersion: typeof report.selectedVersion === "string" ? report.selectedVersion : undefined,
      authFileRemoved: report.authFileRemoved === true,
    },
  );
}

function summarizeProductionSecurity(report) {
  if (!report) {
    return gate(
      "production-security-matrix",
      "Production-like normal and bypass security matrix",
      "PENDING",
      { reason: "No production-like native/security matrix report was supplied" },
    );
  }
  const cases = Array.isArray(report.cases) ? report.cases : [];
  const failed = cases.filter((item) => item.passed !== true);
  return gate(
    "production-security-matrix",
    "Production-like normal and bypass security matrix",
    report.passed === true && failed.length === 0 ? "PASS" : "FAIL",
    {
      caseCount: cases.length,
      failedCaseIds: failed.map((item) => String(item.id ?? "unknown")),
    },
  );
}

function optionalVersion(...values) {
  for (const value of values) {
    if (typeof value === "string" && /^\d+(?:\.\d+){1,7}$/.test(value)) return value;
  }
  return "not-provided";
}

async function summarizeSecurityMatrix(path) {
  const text = await readFile(path, "utf8");
  const required = ["Redacted report template", "production-like build", "Do not include"];
  const missing = required.filter((item) => !text.includes(item));
  return gate(
    "redacted-report-contract",
    "Redacted security report contract",
    missing.length === 0 ? "PASS" : "FAIL",
    {
      source: basename(path),
      missing,
      sourceSha256: createHash("sha256").update(text).digest("hex"),
    },
  );
}

function overallStatus(gates) {
  if (gates.some((item) => item.status === "FAIL")) return "BLOCKED";
  if (gates.some((item) => item.status === "PENDING")) return "PENDING";
  return "QUALIFIED";
}

function markdown(report) {
  const lines = [
    "# SlyBrowser release qualification report",
    "",
    `Generated at: ${report.generatedAt}`,
    `Overall status: ${report.status}`,
    "",
    "This report includes saved browser/kernel versions when supplied and intentionally omits raw secrets.",
    "",
    "## Release identity",
    "",
    `- Channel: ${report.release.channel}`,
    `- Platform: ${report.release.platform}`,
    `- Architecture: ${report.release.arch}`,
    `- Browser version: ${report.release.browserVersion}`,
    `- Kernel version: ${report.release.kernelVersion}`,
    `- WebDriver version: ${report.release.driverVersion}`,
    `- Artifact SHA-256: ${report.release.artifactSha256}`,
    `- Browser SHA-256: ${report.release.browserSha256}`,
    `- WebDriver SHA-256: ${report.release.driverSha256}`,
    `- Verified manifest SHA-256: ${report.release.signedManifestSha256}`,
    `- Artifact URL: ${report.release.artifactUrl}`,
    "",
    "## Gates",
    "",
    "| Gate | Status | Evidence |",
    "| --- | --- | --- |",
  ];
  for (const gateItem of report.gates) {
    const evidence = [
      gateItem.caseCount !== undefined ? `${gateItem.caseCount} cases` : undefined,
      gateItem.failedCaseIds?.length ? `failed: ${gateItem.failedCaseIds.join(", ")}` : undefined,
      gateItem.failedGateIds?.length ? `failed gates: ${gateItem.failedGateIds.join(", ")}` : undefined,
      gateItem.mismatchedFields?.length ? `hash mismatch: ${gateItem.mismatchedFields.join(", ")}` : undefined,
      gateItem.reason ? redactMessage(gateItem.reason) : undefined,
      gateItem.keyId ? `key ${gateItem.keyId}` : undefined,
      gateItem.manifestSha256 ? `manifest ${gateItem.manifestSha256}` : undefined,
      gateItem.sameMajorComparison !== undefined ? `same-major: ${gateItem.sameMajorComparison ? "yes" : "no"}` : undefined,
      gateItem.scoreDelta !== undefined ? `score delta ${gateItem.scoreDelta}` : undefined,
      gateItem.resultCount !== undefined ? `${gateItem.resultCount} results` : undefined,
      gateItem.selectedVersion ? `selected ${gateItem.selectedVersion}` : undefined,
      gateItem.authFileRemoved !== undefined ? `auth removed: ${gateItem.authFileRemoved ? "yes" : "no"}` : undefined,
    ].filter(Boolean).join("; ");
    lines.push(`| ${gateItem.label} | ${gateItem.status} | ${evidence || "-"} |`);
  }
  lines.push("");
  lines.push("## Release decision");
  lines.push("");
  if (report.status === "QUALIFIED") {
    lines.push("All supplied qualification gates passed. Final publish still requires the operator to confirm external release controls.");
  } else if (report.status === "PENDING") {
    lines.push("Release is not qualified yet because one or more required production-like gates are still pending.");
  } else {
    lines.push("Release is blocked because one or more gates failed.");
  }
  lines.push("");
  lines.push("Do not include license keys, runtime tokens, activation tickets, download tickets, payment identifiers, raw customer emails, private signing material, or bypass recipes in attached evidence.");
  return `${lines.join("\n")}\n`;
}

const outputDir = resolve(required("--output"));
const releaseBundleReport = await readOptionalJson(option("--release-bundle"));
const kernelUpdateGateReport = await readOptionalJson(option("--kernel-update-score-gate"));
const cleanMachineValidationReport = await readOptionalJson(option("--clean-machine-validation"));
const nativeRuntimeHandoffReport = await readOptionalJson(option("--native-runtime-handoff") ?? option("--license-only"));
const productionSecurityReport = await readOptionalJson(option("--production-security-matrix"));
const securityMatrixPath = resolve(option("--security-matrix") ?? "docs/security-regression-matrix.md");
const expectedHashes = {
  artifactSha256: sha256(required("--artifact-sha256")),
  browserSha256: sha256(required("--browser-sha256")),
  driverSha256: sha256(required("--driver-sha256")),
};

const gates = [
  summarizeReleaseBundle(releaseBundleReport, expectedHashes),
  summarizeKernelUpdate(kernelUpdateGateReport),
  summarizeCleanMachineValidation(cleanMachineValidationReport),
  summarizeLicenseOnly(nativeRuntimeHandoffReport),
  await summarizeSecurityMatrix(securityMatrixPath),
  summarizeProductionSecurity(productionSecurityReport),
];

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: overallStatus(gates),
  release: {
    product: "SlyBrowser",
    channel: required("--channel"),
    platform: required("--platform"),
    arch: required("--arch"),
    browserVersion: optionalVersion(releaseBundleReport?.browserVersion),
    kernelVersion: optionalVersion(releaseBundleReport?.kernelVersion, releaseBundleReport?.chromiumVersion, releaseBundleReport?.browserVersion),
    driverVersion: optionalVersion(releaseBundleReport?.driverVersion, kernelUpdateGateReport?.results?.slybrowser?.driverVersion),
    artifactSha256: expectedHashes.artifactSha256,
    browserSha256: expectedHashes.browserSha256,
    driverSha256: expectedHashes.driverSha256,
    signedManifestSha256: typeof releaseBundleReport?.manifest?.sha256 === "string" ? releaseBundleReport.manifest.sha256 : "not-provided",
    artifactUrl: typeof releaseBundleReport?.artifact?.url === "string" ? releaseBundleReport.artifact.url : "not-provided",
    sdkCompatibility: typeof releaseBundleReport?.sdkCompatibility === "string" ? releaseBundleReport.sdkCompatibility : "not-provided",
    privateFieldsOmitted: ["rawTokens", "licenseKeys", "privateSigningMaterial"],
  },
  gates,
};

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "release-qualification.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(outputDir, "release-qualification.md"), markdown(report));
console.log(JSON.stringify({ output: outputDir, status: report.status, gates: gates.length }, null, 2));
