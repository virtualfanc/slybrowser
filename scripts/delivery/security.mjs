import { extname } from "node:path";

import { hashObject, matchGlob, validateFreshReceipt } from "./core.mjs";
import { loadCanonicalContract } from "./contracts.mjs";
import { captureStagedCandidate, readIndexBlobs } from "./git-candidate.mjs";
import { parseScannerPlan, scannerPlanDigest } from "./scanner-plan.mjs";

const METADATA_RULES = [
  { ruleId: "metadata-private-path", expression: /(?:[A-Za-z]:\\|\/(?:Users|home)\/)/i },
  { ruleId: "metadata-credential", expression: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]/i },
  { ruleId: "metadata-private-patch", expression: /(?:private|internal)[-_ ]?(?:chromium|patch|source)/i },
];

export function classifyPublicPath(path, policy) {
  if ((policy.deny ?? []).some((pattern) => matchGlob(path, pattern))) return { classification: "denied" };
  if ((policy.reviewRequired ?? []).some((pattern) => matchGlob(path, pattern))) return { classification: "review_required" };
  if ((policy.allow ?? []).some((pattern) => matchGlob(path, pattern))) return { classification: "allowed" };
  return { classification: "unclassified" };
}

export function isAllowedSecurityPlaceholderPath(path, policy) {
  return (policy?.allowedPlaceholderPaths ?? []).some((pattern) => matchGlob(path, pattern));
}

export function scanCommitMetadata(metadata) {
  const findings = [];
  const limits = { message: 10_000, authorName: 200, authorEmail: 320, branch: 255 };
  for (const field of ["message", "authorName", "authorEmail", "branch"]) {
    const value = metadata?.[field];
    if (typeof value !== "string" || value.length === 0) {
      findings.push({ ruleId: "metadata-missing", field });
      continue;
    }
    if (value.length > limits[field]) findings.push({ ruleId: "metadata-too-long", field });
    if (field !== "message" && /[\u0000-\u001f\u007f]/.test(value)) findings.push({ ruleId: "metadata-control-character", field });
    for (const rule of METADATA_RULES) {
      if (rule.expression.test(value)) findings.push({ ruleId: rule.ruleId, field });
    }
  }
  if (typeof metadata?.authorEmail === "string" && !/^[^\s@]+@[^\s@]+$/.test(metadata.authorEmail)) {
    findings.push({ ruleId: "metadata-invalid-email", field: "authorEmail" });
  }
  if (typeof metadata?.branch === "string" && (/(?:\.\.|[~^:?*[\\])/.test(metadata.branch) || metadata.branch.endsWith(".") || metadata.branch.endsWith("/"))) {
    findings.push({ ruleId: "metadata-invalid-branch", field: "branch" });
  }
  return findings;
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function forbiddenBinaryMagic(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return "pe";
  if (buffer.length >= 4 && buffer[0] === 0x7f && buffer.subarray(1, 4).toString("ascii") === "ELF") return "elf";
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && [0x03, 0x05, 0x07].includes(buffer[2])) return "zip";
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "gzip";
  if (buffer.length >= 6 && buffer.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return "7zip";
  const magic = buffer.length >= 4 ? buffer.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return "mach-o";
  return null;
}

function scanExternalReceipts(
  required,
  receipts,
  candidateId,
  candidateManifestDigest,
  freshness,
  scannerPlan,
  expectedScannerPlanDigest,
) {
  const missingScanners = [];
  const scannerErrors = [];
  let scannerFailureCount = 0;
  const byId = new Map();
  let parsedPlan = null;
  if (scannerPlan) {
    try {
      parsedPlan = parseScannerPlan(scannerPlan);
    } catch (error) {
      scannerErrors.push(`scanner plan is invalid: ${error instanceof Error ? error.message : "invalid plan"}`);
    }
  }
  const effectivePlanDigest = parsedPlan ? (expectedScannerPlanDigest ?? scannerPlanDigest(parsedPlan)) : null;
  for (const receipt of receipts) {
    if (typeof receipt?.gateId !== "string" || !receipt.gateId.startsWith("scanner:")) continue;
    const id = receipt.gateId.slice("scanner:".length);
    if (byId.has(id)) scannerErrors.push(`duplicate scanner receipt: ${id}`);
    else byId.set(id, receipt);
  }
  for (const id of required) {
    const receipt = byId.get(id);
    if (!receipt) {
      missingScanners.push(id);
      continue;
    }
    const planned = parsedPlan?.scanners.find((scanner) => scanner.id === id);
    if (!planned) scannerErrors.push(`${id}: canonical scanner plan is unavailable`);
    const retiredField = ["producer", "signature", "receiptDigest", "trustRegistryDigest"]
      .find((field) => Object.hasOwn(receipt, field));
    if (retiredField) {
      scannerErrors.push(`${id}: retired receipt-signing field is present: ${retiredField}`);
      scannerFailureCount += 1;
    }
    scannerErrors.push(...validateFreshReceipt(receipt, candidateId, freshness).map((error) => `${id}: ${error}`));
    if (receipt.candidateManifestDigest !== candidateManifestDigest) {
      scannerErrors.push(`${id}: candidate manifest digest does not match the exact Git index`);
      scannerFailureCount += 1;
    }
    if (receipt.status !== "pass") scannerErrors.push(`${id}: required scanner status is ${receipt.status}`);
    if (receipt.subject !== "exact-staged-tree") {
      scannerErrors.push(`${id}: scanner subject is not the exact staged tree`);
      scannerFailureCount += 1;
    }
    if (effectivePlanDigest && receipt.scannerPlanDigest !== effectivePlanDigest) {
      scannerErrors.push(`${id}: scanner plan digest does not match`);
      scannerFailureCount += 1;
    }
    if (receipt.runnerResultVerified !== true) scannerErrors.push(`${id}: runner result was not verified before receipt creation`);
    if (planned && (receipt.scanner?.id !== planned.id || receipt.scanner?.scope !== planned.scope
        || receipt.scanner?.parser !== planned.parser || receipt.scanner?.network !== planned.network)) {
      scannerErrors.push(`${id}: scanner scope or parser does not match the canonical plan`);
      scannerFailureCount += 1;
    }
    if (planned && (receipt.tool?.name !== planned.tool || receipt.tool?.version !== planned.version
        || !String(receipt.tool?.observedVersion ?? "").includes(planned.version))) {
      scannerErrors.push(`${id}: scanner tool or version does not match the canonical plan`);
      scannerFailureCount += 1;
    }
    if (planned && (receipt.supportingTools?.length ?? 0) !== planned.supportingTools.length) {
      scannerErrors.push(`${id}: scanner supporting tool set does not match the canonical plan`);
      scannerFailureCount += 1;
    } else if (planned && planned.supportingTools.some((tool, index) => {
      const actual = receipt.supportingTools[index];
      return actual?.name !== tool.tool || actual?.version !== tool.version
        || !String(actual?.observedVersion ?? "").includes(tool.version);
    })) {
      scannerErrors.push(`${id}: scanner supporting tool identity or version does not match the canonical plan`);
      scannerFailureCount += 1;
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.evidenceDigest ?? "")) scannerErrors.push(`${id}: evidence digest is missing`);
    if (!receipt.tool?.name || !receipt.tool?.version) scannerErrors.push(`${id}: tool name/version is missing`);
    if (receipt.evidenceDigest !== receipt.rawEvidenceDigest) {
      scannerErrors.push(`${id}: evidence digest does not match raw evidence digest`);
      scannerFailureCount += 1;
    }
    if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.scannerResultDigest ?? "")) scannerErrors.push(`${id}: scanner runner result digest is missing`);
    if ((receipt.findings?.critical ?? 0) > 0 || (receipt.findings?.high ?? 0) > 0) {
      scannerErrors.push(`${id}: unresolved critical/high findings are present`);
      scannerFailureCount += 1;
    }
    if ((receipt.findings?.deniedLicenses ?? 0) > 0) {
      scannerErrors.push(`${id}: denied production licenses are present`);
      scannerFailureCount += 1;
    }
    if ((receipt.findings?.unknownLicenses ?? 0) > 0 || (receipt.findings?.reviewRequiredLicenses ?? 0) > 0) {
      scannerErrors.push(`${id}: unknown or review-required production licenses are unresolved`);
    }
  }
  return { missingScanners, scannerErrors, scannerFailureCount };
}

export function evaluateSecurityGate({
  root,
  candidate,
  policy,
  metadata,
  scannerReceipts,
  scannerPlan,
  scannerPlanDigest: expectedScannerPlanDigest,
  contractDigests = {},
  now = new Date(),
}) {
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    return {
      schemaVersion: 1, gateId: "security", candidateId: candidate.candidateId, status: "fail",
      observedAt: new Date().toISOString(), subject: "exact-staged-tree-and-proposed-metadata",
      findings: [{ ruleId: "candidate-changed" }], missingScanners: [], scannerErrors: [],
      evidenceDigest: hashObject({ candidate: candidate.candidateId, current: current.candidateId }),
    };
  }
  candidate = current;

  if ((policy.requiredExternalScanners ?? []).length > 0 && !scannerPlan) {
    try {
      const loaded = loadCanonicalContract(root, "scannerPlan", { candidate });
      scannerPlan = loaded.value;
      expectedScannerPlanDigest = loaded.digest;
      contractDigests = { ...contractDigests, scannerPlan: loaded.digest };
    } catch {
      scannerPlan = null;
    }
  }

  const findings = scanCommitMetadata(metadata);
  const blockedFindings = [];
  const forbiddenExtensions = new Set(policy.forbiddenBinaryExtensions ?? []);
  const regularEntries = candidate.entries.filter((entry) => !["120000", "160000"].includes(entry.mode));
  const blobs = readIndexBlobs(root, regularEntries.map((entry) => entry.oid));
  for (const entry of candidate.entries) {
    const classification = classifyPublicPath(entry.path, policy.publicSurface);
    if (classification.classification === "denied") findings.push({ ruleId: "public-surface-denied", path: entry.path });
    if (classification.classification === "review_required") blockedFindings.push({ ruleId: "public-surface-review-required", path: entry.path });
    if (classification.classification === "unclassified") blockedFindings.push({ ruleId: "public-surface-unclassified", path: entry.path });
    for (const pattern of policy.forbiddenPathPatterns ?? []) {
      if (matchGlob(entry.path, pattern) && !isAllowedSecurityPlaceholderPath(entry.path, policy)) {
        findings.push({ ruleId: "forbidden-artifact-path", path: entry.path });
      }
    }
    if (forbiddenExtensions.has(extname(entry.path).toLowerCase())) findings.push({ ruleId: "forbidden-binary-extension", path: entry.path });

    if (entry.mode === "120000") {
      findings.push({ ruleId: "symbolic-link", path: entry.path });
      continue;
    }
    if (entry.mode === "160000") {
      findings.push({ ruleId: "git-submodule", path: entry.path });
      continue;
    }
    const blob = blobs.get(entry.oid);
    if (!blob) {
      blockedFindings.push({ ruleId: "index-blob-unavailable", path: entry.path });
      continue;
    }
    const magic = forbiddenBinaryMagic(blob);
    if (magic) {
      findings.push({ ruleId: "forbidden-binary-magic", path: entry.path, format: magic });
      continue;
    }
    if (blob.length > (policy.maximumTextBlobBytes ?? 2_000_000)) {
      if (isProbablyBinary(blob)) findings.push({ ruleId: "large-binary-blob", path: entry.path });
      else blockedFindings.push({ ruleId: "text-blob-scan-limit", path: entry.path });
      continue;
    }
    if (isProbablyBinary(blob)) {
      if (!(policy.allowedBinaryPaths ?? []).some((pattern) => matchGlob(entry.path, pattern))) {
        findings.push({ ruleId: "binary-blob", path: entry.path });
      }
      continue;
    }
    const text = blob.toString("utf8");
    if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) {
      findings.push({ ruleId: "git-lfs-pointer", path: entry.path });
      continue;
    }
    for (const rule of policy.contentPatterns ?? []) {
      let expression;
      try {
        expression = new RegExp(rule.expression, rule.flags ?? "");
      } catch {
        blockedFindings.push({ ruleId: "invalid-security-pattern", patternId: rule.id });
        continue;
      }
      if (expression.test(text)) findings.push({ ruleId: rule.id, path: entry.path });
    }
  }

  const freshness = { now, maxAgeMs: (policy.maximumScannerAgeSeconds ?? 86_400) * 1000 };
  const { missingScanners, scannerErrors, scannerFailureCount } = scanExternalReceipts(
    policy.requiredExternalScanners ?? [], scannerReceipts ?? [], candidate.candidateId,
    candidate.indexManifestDigest, freshness,
    scannerPlan, expectedScannerPlanDigest,
  );
  const status = findings.length || scannerFailureCount || scannerErrors.some((error) => /status is fail|unresolved critical\/high/i.test(error))
    ? "fail"
    : blockedFindings.length || missingScanners.length || scannerErrors.length
      ? "blocked"
      : "pass";
  return {
    schemaVersion: 1,
    gateId: "security",
    candidateId: candidate.candidateId,
    candidateManifestDigest: candidate.indexManifestDigest,
    contractDigests,
    status,
    observedAt: new Date().toISOString(),
    subject: "exact-staged-tree-and-proposed-metadata",
    metadataDigest: metadata ? hashObject(metadata) : null,
    findingCount: findings.length,
    findings,
    blockedFindings,
    missingScanners,
    scannerErrors,
    evidenceDigest: hashObject({
      candidate: candidate.indexManifestDigest,
      metadata: metadata ? hashObject(metadata) : null,
      findings,
      blockedFindings,
      contractDigests,
      scannerReceipts: (scannerReceipts ?? []).map((receipt) => ({
        gateId: receipt.gateId, status: receipt.status, evidenceDigest: receipt.evidenceDigest,
      })),
    }),
  };
}
