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
}

export interface CatalogManifest {
  schemaVersion: 1;
  browserVersion: string;
  sdkCompatibility: string;
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
  selectionReason: "latest" | "exact" | "rollback";
  availableBrowserVersions: string[];
}

export type VersionPolicy = "latest" | "exact" | "at-or-before";

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

function matchesCompatibility(range: string, version: string): boolean {
  versionParts(version);
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new TypeError("Release SDK compatibility range is invalid");
  return tokens.every((token) => {
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
  if (!Array.isArray(document.artifacts) || !document.artifacts.length) throw new TypeError("Release manifest artifacts are invalid");
  const evidence = document.evidence as Record<string, unknown> | undefined;
  if (!evidence || !evidence.sbom || !evidence.provenance || !evidence.chromiumPatchInventory || !evidence.sourceBoundary) {
    throw new TypeError("Release manifest supply-chain evidence is required");
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
        typeof artifact.driverSha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.driverSha256)) {
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

function safeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.startsWith("/") && !value.startsWith("\\") &&
    !/^[A-Za-z]:/.test(value) && !value.replaceAll("\\", "/").split("/").includes("..");
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

  availableVersions(platform: string, arch: string, sdkVersion: string): string[] {
    return [...new Set(this.#manifests
      .filter((manifest) => matchesCompatibility(manifest.sdkCompatibility, sdkVersion))
      .filter((manifest) => manifest.artifacts.some((artifact) => artifact.platform === platform && artifact.arch === arch))
      .map((manifest) => manifest.browserVersion))]
      .sort((left, right) => compareVersion(right, left));
  }

  select(
    platform: string,
    arch: string,
    sdkVersion: string,
    options: { versionPolicy?: VersionPolicy; browserVersion?: string } = {},
  ): CatalogSelection {
    const versionPolicy = options.versionPolicy ?? "latest";
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
    const availableBrowserVersions = this.availableVersions(platform, arch, sdkVersion);
    const candidates = this.#manifests.flatMap((manifest) =>
      (matchesCompatibility(manifest.sdkCompatibility, sdkVersion) ? manifest.artifacts : [])
        .filter((artifact) => artifact.platform === platform && artifact.arch === arch)
        .map((artifact) => ({ manifest, artifact })),
    ).filter(({ manifest }) => {
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
      selectionReason: versionPolicy === "at-or-before"
        ? selection.manifest.browserVersion === options.browserVersion ? "exact" : "rollback"
        : versionPolicy,
      availableBrowserVersions,
    };
  }

  selectLatest(platform: string, arch: string, sdkVersion: string): CatalogSelection {
    return this.select(platform, arch, sdkVersion);
  }

  findArtifactByPath(pathname: string): CatalogArtifact | undefined {
    return this.#manifests.flatMap((manifest) => manifest.artifacts)
      .find((artifact) => new URL(artifact.url).pathname === pathname);
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
