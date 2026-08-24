import { basename, resolve } from "node:path";

import { ServiceError } from "./errors.js";

export interface CatalogArtifact {
  platform: "windows" | "linux" | "macos";
  arch: "x64" | "arm64";
  url: string;
  sha256: string;
  size: number;
  archiveFormat: "zip";
  browserExecutable: string;
  driverExecutable: string;
  browserSha256: string;
  driverSha256: string;
  privateModules: CatalogPrivateModule[];
  resources: CatalogResourceFile[];
  codeSignature?: CatalogCodeSignature;
}

export interface CatalogPrivateModule {
  path: string;
  sha256: string;
  size: number;
  abi: string;
}

export interface CatalogResourceFile {
  path: string;
  sha256: string;
  size: number;
}

export interface CatalogCodeSignature {
  scheme: "authenticode" | "apple-developer-id" | "x509-code-signing";
  subject: string;
  certificateSha256: string;
  timestampRequired: boolean;
}

export interface CatalogManifest {
  schemaVersion: 1;
  browserVersion: string;
  sdkCompatibility: string;
  status?: "available" | "revoked";
  publishedAt?: string;
  artifacts: CatalogArtifact[];
  signature: { algorithm: "ed25519"; keyId: string; value: string };
  [name: string]: unknown;
}

export interface CatalogSelection {
  manifest: CatalogManifest;
  artifact: CatalogArtifact;
  versionPolicy: VersionPolicy;
  requestedBrowserVersion?: string;
  requestedKernelMajor: KernelMajor;
  updateKernel: boolean;
  selectionReason: "latest" | "exact" | "rollback";
  selectionMode: "latest" | "latest-in-major" | "cached-approved" | "exact" | "rollback";
  availableBrowserVersions: string[];
  latestAvailableVersion: string;
  updateAvailable: boolean;
  updateRequired: boolean;
}

export type VersionPolicy = "latest" | "exact" | "at-or-before";
export type KernelMajor = number | "latest";

function versionParts(value: string): number[] {
  if (!/^\d+(\.\d+){0,7}$/.test(value)) throw new TypeError(`Invalid browser version: ${value}`);
  return value.split(".").map(Number);
}

function compareVersion(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function browserMajor(value: string): number {
  return versionParts(value)[0]!;
}

function normalizeKernelMajor(value: KernelMajor | undefined): KernelMajor {
  if (value === undefined || value === "latest") return "latest";
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ServiceError("version_policy_invalid", "Kernel major must be a positive integer or latest", 400);
  }
  return value;
}

function matchesKernelMajor(browserVersion: string, kernelMajor: KernelMajor): boolean {
  return kernelMajor === "latest" || browserMajor(browserVersion) === kernelMajor;
}

function matchesCompatibility(range: string, version: string): boolean {
  versionParts(version);
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new TypeError("Release SDK compatibility range is invalid");
  return tokens.every((token) => {
    if (token.startsWith("^")) return matchesCaretCompatibility(token.slice(1), version);
    const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,7})$/.exec(token);
    if (!match) throw new TypeError("Release SDK compatibility range is invalid");
    const comparison = compareVersion(version, match[2]!);
    switch (match[1] ?? "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      default: return comparison === 0;
    }
  });
}

function matchesCaretCompatibility(base: string, version: string): boolean {
  const parts = versionParts(base);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  const upper = major > 0
    ? `${major + 1}.0.0`
    : minor > 0
      ? `0.${minor + 1}.0`
      : `0.0.${patch + 1}`;
  return compareVersion(version, base) >= 0 && compareVersion(version, upper) < 0;
}

function parseManifest(value: unknown): CatalogManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Release manifest must be an object");
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== 1 || typeof document.browserVersion !== "string" || !document.browserVersion) {
    throw new TypeError("Release manifest identity is invalid");
  }
  versionParts(document.browserVersion);
  if (typeof document.sdkCompatibility !== "string" || !document.sdkCompatibility) {
    throw new TypeError("Release manifest SDK compatibility is invalid");
  }
  if (document.status !== undefined && document.status !== "available" && document.status !== "revoked") {
    throw new TypeError("Release manifest status is invalid");
  }
  if (!Array.isArray(document.artifacts) || !document.artifacts.length) throw new TypeError("Release manifest artifacts are invalid");
  if (document.evidence !== undefined && !parseEvidence(document.evidence)) {
    throw new TypeError("Release manifest supply-chain evidence is invalid");
  }
  const artifacts = document.artifacts.map((item): CatalogArtifact => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Release artifact is invalid");
    const artifact = item as Record<string, unknown>;
    if (!new Set(["windows", "linux", "macos"]).has(String(artifact.platform)) ||
        !new Set(["x64", "arm64"]).has(String(artifact.arch)) ||
        typeof artifact.url !== "string" || !artifact.url.startsWith("https://") ||
        typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.size) || Number(artifact.size) <= 0 ||
        artifact.archiveFormat !== "zip" ||
        typeof artifact.browserExecutable !== "string" || !safeRelativePath(artifact.browserExecutable) ||
        typeof artifact.driverExecutable !== "string" || !safeRelativePath(artifact.driverExecutable) ||
        typeof artifact.browserSha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.browserSha256) ||
        typeof artifact.driverSha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.driverSha256) ||
        !parsePrivateModules(artifact.privateModules) ||
        !parseResources(artifact.resources) ||
        (Object.hasOwn(artifact, "codeSignature") && !parseCodeSignature(artifact.codeSignature))) {
      throw new TypeError("Release artifact fields are invalid");
    }
    return artifact as unknown as CatalogArtifact;
  });
  const signature = document.signature as Record<string, unknown> | undefined;
  if (!signature || signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string") {
    throw new TypeError("Release manifest signature block is invalid");
  }
  return { ...document, artifacts } as unknown as CatalogManifest;
}

function parseEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(",") !== "chromiumPatchInventory,provenance,sbom,sourceBoundary") return false;
  const sourceBoundary = evidence.sourceBoundary as Record<string, unknown> | undefined;
  return parseEvidenceArtifact(evidence.sbom, "application/vnd.cyclonedx+json") &&
    parseEvidenceArtifact(evidence.provenance, "application/vnd.in-toto+json") &&
    parseEvidenceArtifact(evidence.chromiumPatchInventory, "application/vnd.slybrowser.chromium-patch-inventory+json") &&
    !!sourceBoundary && typeof sourceBoundary === "object" && !Array.isArray(sourceBoundary) &&
    Object.keys(sourceBoundary).sort().join(",") === "chromiumPatches,proprietaryCore,sdk" &&
    sourceBoundary.sdk === "open-source" &&
    sourceBoundary.chromiumPatches === "inventory-and-approved-patches" &&
    sourceBoundary.proprietaryCore === "private";
}

function parseEvidenceArtifact(value: unknown, mediaType: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  return Object.keys(artifact).sort().join(",") === "mediaType,sha256,size,url" &&
    typeof artifact.url === "string" && artifact.url.startsWith("https://") &&
    typeof artifact.sha256 === "string" && /^[a-f0-9]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.size) && Number(artifact.size) > 0 &&
    artifact.mediaType === mediaType;
}

function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) && !value.replaceAll("\\", "/").split("/").includes("..");
}

function parsePrivateModules(value: unknown): value is CatalogPrivateModule[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const module = item as Record<string, unknown>;
    return Object.keys(module).sort().join(",") === "abi,path,sha256,size" &&
      typeof module.path === "string" && safeRelativePath(module.path) &&
      typeof module.sha256 === "string" && /^[a-f0-9]{64}$/.test(module.sha256) &&
      Number.isSafeInteger(module.size) && Number(module.size) > 0 &&
      typeof module.abi === "string" && module.abi.length > 0 && module.abi.length <= 128;
  });
}

function parseResources(value: unknown): value is CatalogResourceFile[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const resource = item as Record<string, unknown>;
    return Object.keys(resource).sort().join(",") === "path,sha256,size" &&
      typeof resource.path === "string" && safeRelativePath(resource.path) &&
      typeof resource.sha256 === "string" && /^[a-f0-9]{64}$/.test(resource.sha256) &&
      Number.isSafeInteger(resource.size) && Number(resource.size) > 0;
  });
}

function parseCodeSignature(value: unknown): value is CatalogCodeSignature {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const signature = value as Record<string, unknown>;
  return Object.keys(signature).sort().join(",") === "certificateSha256,scheme,subject,timestampRequired" &&
    new Set(["authenticode", "apple-developer-id", "x509-code-signing"]).has(signature.scheme as string) &&
    typeof signature.subject === "string" && signature.subject.length > 0 && signature.subject.length <= 512 &&
    typeof signature.certificateSha256 === "string" && /^[a-f0-9]{64}$/.test(signature.certificateSha256) &&
    typeof signature.timestampRequired === "boolean";
}

export class ReleaseCatalog {
  readonly #manifests: CatalogManifest[];

  constructor(manifests: readonly unknown[]) {
    this.#manifests = manifests.map(parseManifest);
    if (!this.#manifests.length) throw new TypeError("At least one signed release manifest is required");
    const paths = new Set<string>();
    for (const artifact of this.#manifests.flatMap((manifest) => manifest.artifacts)) {
      const pathname = new URL(artifact.url).pathname;
      if (paths.has(pathname)) throw new TypeError(`Release artifact URL path is not immutable: ${pathname}`);
      paths.add(pathname);
    }
  }

  availableVersions(platform: string, arch: string, sdkVersion: string, kernelMajor: KernelMajor = "latest"): string[] {
    const selectedKernelMajor = normalizeKernelMajor(kernelMajor);
    return [...new Set(this.#manifests
      .filter((manifest) => manifestStatus(manifest) === "available")
      .filter((manifest) => matchesCompatibility(manifest.sdkCompatibility, sdkVersion))
      .filter((manifest) => matchesKernelMajor(manifest.browserVersion, selectedKernelMajor))
      .filter((manifest) => manifest.artifacts.some((artifact) => artifact.platform === platform && artifact.arch === arch))
      .map((manifest) => manifest.browserVersion))]
      .sort((left, right) => compareVersion(right, left));
  }

  select(
    platform: string,
    arch: string,
    sdkVersion: string,
    options: { versionPolicy?: VersionPolicy; browserVersion?: string; kernelMajor?: KernelMajor; updateKernel?: boolean } = {},
  ): CatalogSelection {
    const versionPolicy = options.versionPolicy ?? "latest";
    const kernelMajor = normalizeKernelMajor(options.kernelMajor);
    const updateKernel = options.updateKernel ?? false;
    if (typeof updateKernel !== "boolean") {
      throw new ServiceError("version_policy_invalid", "updateKernel must be a boolean", 400);
    }
    if (!new Set<VersionPolicy>(["latest", "exact", "at-or-before"]).has(versionPolicy)) {
      throw new ServiceError("version_policy_invalid", `Unsupported browser version policy: ${versionPolicy}`, 400);
    }
    if (versionPolicy === "latest" && options.browserVersion !== undefined) {
      throw new ServiceError("version_policy_invalid", "Latest selection cannot include a requested browser version", 400);
    }
    if (versionPolicy !== "latest" && options.browserVersion === undefined) {
      throw new ServiceError("version_policy_invalid", `${versionPolicy} selection requires a browser version`, 400);
    }
    if (options.browserVersion !== undefined) versionParts(options.browserVersion);
    if (options.browserVersion !== undefined && !matchesKernelMajor(options.browserVersion, kernelMajor)) {
      throw new ServiceError("version_policy_invalid", "Requested browser version does not match kernelMajor", 400);
    }
    const availableBrowserVersions = this.availableVersions(platform, arch, sdkVersion, kernelMajor);
    const candidates = this.#manifests.flatMap((manifest) =>
      (manifestStatus(manifest) === "available" && matchesCompatibility(manifest.sdkCompatibility, sdkVersion) ? manifest.artifacts : [])
        .filter((artifact) => artifact.platform === platform && artifact.arch === arch)
        .map((artifact) => ({ manifest, artifact })),
    ).filter(({ manifest }) => {
      if (!matchesKernelMajor(manifest.browserVersion, kernelMajor)) return false;
      if (versionPolicy === "latest") return true;
      const comparison = compareVersion(manifest.browserVersion, options.browserVersion!);
      return versionPolicy === "exact" ? comparison === 0 : comparison <= 0;
    }).sort((left, right) => compareVersion(right.manifest.browserVersion, left.manifest.browserVersion));
    const selection = candidates[0];
    if (!selection) {
      const requested = options.browserVersion === undefined ? "latest" : options.browserVersion;
      throw new ServiceError(
        "release_version_unavailable",
        `No Stable browser satisfies ${versionPolicy} ${requested} for SDK ${sdkVersion} on ${platform}/${arch}`,
        404,
      );
    }
    return {
      ...selection,
      versionPolicy,
      ...(options.browserVersion === undefined ? {} : { requestedBrowserVersion: options.browserVersion }),
      requestedKernelMajor: kernelMajor,
      updateKernel,
      selectionReason: versionPolicy === "at-or-before"
        ? selection.manifest.browserVersion === options.browserVersion ? "exact" : "rollback"
        : versionPolicy,
      selectionMode: versionPolicy === "latest"
        ? kernelMajor === "latest" ? "latest" : "latest-in-major"
        : !updateKernel && versionPolicy === "exact" ? "cached-approved"
          : versionPolicy === "at-or-before" && selection.manifest.browserVersion !== options.browserVersion ? "rollback" : "exact",
      availableBrowserVersions,
      latestAvailableVersion: availableBrowserVersions[0]!,
      updateAvailable: availableBrowserVersions[0] !== selection.manifest.browserVersion,
      updateRequired: false,
    };
  }

  selectLatest(platform: string, arch: string, sdkVersion: string): CatalogSelection {
    return this.select(platform, arch, sdkVersion);
  }

  findArtifactByPath(pathname: string): CatalogArtifact | undefined {
    return this.#manifests
      .filter((manifest) => manifestStatus(manifest) === "available")
      .flatMap((manifest) => manifest.artifacts)
      .find((artifact) => new URL(artifact.url).pathname === pathname);
  }

  assertArtifactAvailable(browserVersion: string, artifactSha256: string): CatalogArtifact {
    const artifact = this.#manifests
      .filter((manifest) => manifestStatus(manifest) === "available")
      .filter((manifest) => manifest.browserVersion === browserVersion)
      .flatMap((manifest) => manifest.artifacts)
      .find((candidate) => candidate.sha256 === artifactSha256);
    if (!artifact) {
      throw new ServiceError(
        "kernel_update_required",
        "The authorized browser release was withdrawn; update is required before continuing",
        409,
      );
    }
    return artifact;
  }

  artifactPath(artifactRoot: string, artifact: CatalogArtifact): string {
    const root = resolve(artifactRoot);
    const result = resolve(root, basename(new URL(artifact.url).pathname));
    if (result === root || !result.startsWith(`${root}\\`) && !result.startsWith(`${root}/`)) {
      throw new ServiceError("artifact_path_invalid", "Release artifact path is invalid", 500);
    }
    return result;
  }
}

function manifestStatus(manifest: CatalogManifest): "available" | "revoked" {
  return manifest.status ?? "available";
}
