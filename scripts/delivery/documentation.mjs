import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { posix, relative, resolve } from "node:path";

import { hashObject, matchGlob, normalizeRepositoryPath, validateFreshReceipt } from "./core.mjs";
import { captureStagedCandidate, readIndexBlob } from "./git-candidate.mjs";

const REQUIRED_LOCAL_SURFACES = [
  "contract", "readme", "api", "configuration", "examples", "changelog", "support", "wiki", "githubFacing",
];

function resolveInside(root, repositoryPath) {
  const normalized = normalizeRepositoryPath(repositoryPath);
  const absolute = resolve(root, normalized);
  const boundary = relative(resolve(root), absolute).replaceAll("\\", "/");
  if (boundary.startsWith("../") || boundary === "..") throw new Error("coverage path escapes repository");
  return absolute;
}

function workingTreeAccess(root) {
  return {
    has(repositoryPath) {
      const absolute = resolveInside(root, repositoryPath);
      return existsSync(absolute) && statSync(absolute).isFile();
    },
    read(repositoryPath) {
      return readFileSync(resolveInside(root, repositoryPath), "utf8");
    },
    list(prefix) {
      const files = [];
      const absolutePrefix = resolveInside(root, prefix);
      function visit(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = resolve(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (entry.isFile()) files.push(relative(root, path).replaceAll("\\", "/"));
        }
      }
      if (existsSync(absolutePrefix)) visit(absolutePrefix);
      return files;
    },
    digest: null,
  };
}

function stagedTreeAccess(root, candidate) {
  const current = captureStagedCandidate(root);
  if (current.candidateId !== candidate.candidateId || current.indexManifestDigest !== candidate.indexManifestDigest) {
    throw new Error("candidate changed before documentation validation");
  }
  const entries = new Map(current.entries.map((entry) => [entry.path, entry]));
  return {
    has(repositoryPath) {
      return entries.has(normalizeRepositoryPath(repositoryPath));
    },
    read(repositoryPath) {
      const entry = entries.get(normalizeRepositoryPath(repositoryPath));
      if (!entry) throw new Error("candidate documentation file is missing");
      return readIndexBlob(root, entry.oid).toString("utf8");
    },
    list(prefix) {
      const normalized = normalizeRepositoryPath(prefix);
      return [...entries.keys()].filter((path) => path.startsWith(`${normalized}/`));
    },
    digest: current.indexManifestDigest,
  };
}

function markdownFiles(access, prefix) {
  return access.list(prefix).filter((path) => path.endsWith(".md"));
}

export function checkWikiLinks(root, wikiRoot = "docs/wiki", access = workingTreeAccess(root)) {
  const normalizedWiki = normalizeRepositoryPath(wikiRoot);
  const errors = [];
  for (const file of markdownFiles(access, normalizedWiki)) {
    const text = access.read(file);
    const links = text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
    for (const match of links) {
      const target = match[1].trim().split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
      const decoded = decodeURIComponent(target).replaceAll("\\", "/");
      const resolved = posix.normalize(posix.join(posix.dirname(file), decoded));
      if (!resolved.startsWith(`${normalizedWiki}/`) || !access.has(resolved)) {
        errors.push(`broken Wiki link in ${file}`);
      }
    }
  }
  return errors;
}

export function validateFeatureCoverage(root, manifest, context = {}) {
  const errors = [];
  let access;
  try {
    access = context.candidate ? stagedTreeAccess(root, context.candidate) : workingTreeAccess(root);
  } catch (error) {
    return {
      schemaVersion: 1, gateId: "documentation", candidateId: context.candidateId ?? context.candidate?.candidateId ?? null,
      status: "fail", localStatus: "fail", observedAt: new Date().toISOString(), activeFeatureCount: 0,
      errors: [error.message], missingExternalSurfaces: [], externalErrors: [], remotePublication: "not_evaluated",
      evidenceDigest: hashObject({ error: error.message }),
    };
  }
  const seen = new Set();
  const active = (manifest.features ?? []).filter((feature) => feature.status === "active");
  for (const feature of active) {
    if (!feature.id || seen.has(feature.id)) errors.push("active feature IDs must be present and unique");
    seen.add(feature.id);
    for (const surface of REQUIRED_LOCAL_SURFACES) {
      const paths = feature.local?.[surface];
      if (!Array.isArray(paths) || paths.length === 0) {
        errors.push(`${feature.id}: missing local ${surface} coverage`);
        continue;
      }
      for (const path of paths) {
        try {
          normalizeRepositoryPath(path);
          if (!access.has(path)) errors.push(`${feature.id}: missing coverage file for ${surface}`);
        } catch {
          errors.push(`${feature.id}: invalid coverage path for ${surface}`);
        }
      }
    }
  }
  errors.push(...checkWikiLinks(root, "docs/wiki", access));

  const inferredAffected = new Set();
  if (context.candidate) {
    for (const stagedPath of context.candidate.stagedPaths ?? []) {
      for (const feature of active) {
        const coveredPaths = Object.values(feature.local ?? {}).flat();
        if (coveredPaths.includes(stagedPath)) inferredAffected.add(feature.id);
      }
      for (const rule of manifest.featurePathRules ?? []) {
        if ((rule.patterns ?? []).some((pattern) => matchGlob(stagedPath, pattern))) {
          for (const featureId of rule.featureIds ?? []) inferredAffected.add(featureId);
        }
      }
    }
  }

  const requiredWikiSections = ["Installation", "Configuration", "API", "Errors", "Limitations", "Platforms"];
  const wikiHome = access.has("docs/wiki/Home.md") ? access.read("docs/wiki/Home.md") : "";
  for (const feature of active) {
    for (const page of feature.local?.wiki ?? []) {
      if (!access.has(page)) continue;
      const text = access.read(page);
      for (const section of requiredWikiSections) {
        if (!new RegExp(`^## .*${section}`, "im").test(text)) errors.push(`${feature.id}: Wiki page is missing the ${section} section`);
      }
      const pageName = posix.basename(page);
      if (!wikiHome.includes(`(${pageName})`)) errors.push(`${feature.id}: Wiki page is not linked from Home.md`);
    }
  }

  const wikiLeakRules = [
    /(?:[A-Za-z]:\\|\/(?:Users|home)\/)/i,
    /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/i,
    /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]/i,
  ];
  for (const file of markdownFiles(access, "docs/wiki")) {
    const text = access.read(file);
    if (wikiLeakRules.some((rule) => rule.test(text))) errors.push(`Wiki disclosure scan failed for ${file}`);
  }

  const affected = new Set(context.affectedFeatureIds ?? []);
  for (const featureId of affected) {
    if (!seen.has(featureId)) errors.push(`change context names unknown feature: ${featureId}`);
  }
  for (const featureId of inferredAffected) {
    if (!affected.has(featureId)) errors.push(`change context omits staged affected feature: ${featureId}`);
  }
  const externalReceipts = context.externalReceipts ?? [];
  const externalCommitRequired = Array.isArray(manifest.externalCommitRequired)
    ? new Set(manifest.externalCommitRequired)
    : null;
  if (externalCommitRequired) {
    for (const feature of active) {
      for (const surface of externalCommitRequired) {
        if (feature.external?.[surface] !== "receipt-required") errors.push(`${feature.id}: missing required external surface ${surface}`);
      }
    }
  }
  const missingExternalSurfaces = [];
  const externalErrors = [];
  for (const feature of active.filter((item) => affected.has(item.id))) {
    for (const [surface, policy] of Object.entries(feature.external ?? {})) {
      if (policy !== "receipt-required") continue;
      if (externalCommitRequired && !externalCommitRequired.has(surface)) continue;
      const gateId = `docs-external:${feature.id}:${surface}`;
      const receipt = externalReceipts.find((item) => item.gateId === gateId);
      if (!receipt) {
        missingExternalSurfaces.push(surface);
        continue;
      }
      if (context.candidateId) {
        externalErrors.push(...validateFreshReceipt(receipt, context.candidateId, {
          now: context.now ?? new Date(), maxAgeMs: context.maxAgeMs ?? 86_400_000,
        }).map((error) => `${gateId}: ${error}`));
      }
      if (context.candidate?.indexManifestDigest && receipt.candidateManifestDigest !== context.candidate.indexManifestDigest) {
        externalErrors.push(`${gateId}: candidate manifest digest does not match the exact Git index`);
      }
      if (receipt.status !== "pass") externalErrors.push(`${gateId}: status is ${receipt.status}`);
      if (!/^sha256:[0-9a-f]{64}$/i.test(receipt.evidenceDigest ?? "")) externalErrors.push(`${gateId}: evidence digest is missing`);
      const retiredField = ["producer", "signature", "receiptDigest", "trustRegistryDigest"]
        .find((field) => Object.hasOwn(receipt, field));
      if (retiredField) externalErrors.push(`${gateId}: retired receipt-signing field is present: ${retiredField}`);
    }
  }
  const localStatus = errors.length ? "fail" : "pass";
  const status = errors.length || externalErrors.some((error) => /status is fail/i.test(error))
    ? "fail"
    : missingExternalSurfaces.length || externalErrors.length
      ? "blocked"
      : "pass";
  return {
    schemaVersion: 1,
    gateId: "documentation",
    candidateId: context.candidateId ?? null,
    candidateManifestDigest: context.candidate?.indexManifestDigest ?? null,
    contractDigests: context.contractDigests ?? {},
    status,
    localStatus,
    observedAt: new Date().toISOString(),
    activeFeatureCount: active.length,
    inferredAffectedFeatureIds: [...inferredAffected].sort(),
    errors,
    missingExternalSurfaces: [...new Set(missingExternalSurfaces)].sort(),
    externalErrors,
    remotePublication: affected.size ? "not_evaluated_unless_receipted" : "not_applicable_no_affected_public_feature",
    evidenceDigest: hashObject({ manifest, candidateDigest: access.digest, contractDigests: context.contractDigests ?? {}, errors, missingExternalSurfaces, externalErrors }),
  };
}
