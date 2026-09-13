import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import * as yauzl from "yauzl";

import { ArtifactError } from "./errors.js";
import { verifyArtifact } from "./manifest.js";
import type { LicenseServiceClient, LicensedSessionGrant, RuntimeSessionGrant } from "./service.js";

const execFileAsync = promisify(execFile);
const MAXIMUM_7Z_ENTRIES = 100_000;
const INSPECTION_TIMEOUT_MS = 30_000;
const EXTRACTION_TIMEOUT_MS = 5 * 60_000;

export interface BrowserInstallation {
  version: string;
  platform: string;
  arch: string;
  root: string;
  browserExecutable: string;
  driverExecutable: string;
  artifactSha256: string;
}

export interface BrowserInstallationReference {
  installation: BrowserInstallation;
  referenceFile: string;
  release(): Promise<void>;
}

export interface InstallOptions {
  cacheRoot?: string;
  lockTimeoutMs?: number;
  extractor?: (archive: string, destination: string) => Promise<void>;
}

export interface CurrentBrowserLookupOptions {
  cacheRoot?: string;
  platform?: "windows" | "linux" | "macos";
  arch?: "x64" | "arm64";
  kernelMajor?: number | "latest";
}

export interface BrowserPruneResult {
  removed: string[];
  skippedInUse: string[];
  kept: string[];
}

type InstallGrant = LicensedSessionGrant | RuntimeSessionGrant;

function isRuntimeGrant(grant: InstallGrant): grant is RuntimeSessionGrant {
  return "downloadTicket" in grant;
}

function defaultCacheRoot(): string {
  if (process.platform === "win32") {
    return resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SlyBrowser", "cache");
  }
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Caches", "SlyBrowser");
  return resolve(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "slybrowser");
}

function currentPlatform(): "windows" | "linux" | "macos" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  throw new ArtifactError("Unsupported platform", "platform_unsupported");
}

function currentArch(): "x64" | "arm64" {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  throw new ArtifactError("Unsupported architecture", "platform_unsupported");
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function matchesKernelMajor(version: string, kernelMajor: number | "latest"): boolean {
  return kernelMajor === "latest" || Number(version.split(".")[0]) === kernelMajor;
}

function maximumExpandedBytes(archiveSize: number): number {
  return Math.min(Math.max(archiveSize * 20, 2 * 1024 * 1024 * 1024), 16 * 1024 * 1024 * 1024);
}

function enforceDownloadSizeLimit(maximumBytes: number): Transform {
  let downloaded = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      if (downloaded > maximumBytes) {
        callback(new ArtifactError("Browser artifact download exceeds its signed size", "artifact_size_mismatch"));
        return;
      }
      callback(null, chunk);
    },
  });
}

function assertContentLength(response: Response, expectedSize: number): void {
  const value = response.headers.get("content-length");
  if (value === null) return;
  if (!/^\d+$/.test(value) || Number(value) > expectedSize) {
    throw new ArtifactError("Browser artifact download exceeds its signed size", "artifact_size_mismatch");
  }
}

async function safeExtractZip(archive: string, destination: string, limit: number): Promise<void> {
  const root = resolve(destination);
  let expanded = 0;
  await mkdir(root, { recursive: true });
  const zipFile = await openZipFile(archive);
  await new Promise<void>((accept, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (error) reject(error);
      else accept();
    };
    zipFile.once("error", finish);
    zipFile.once("end", () => finish());
    zipFile.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        const normalized = safeZipEntryName(entry);
        expanded += entry.uncompressedSize;
        if (expanded > limit) {
          throw new ArtifactError("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
        }
        const output = resolve(root, normalized);
        if (!isSubpath(root, output)) {
          throw new ArtifactError("Browser archive contains an unsafe path", "artifact_layout_invalid");
        }
        if (normalized.endsWith("/")) {
          await mkdir(output, { recursive: true, mode: 0o700 });
        } else {
          await mkdir(dirname(output), { recursive: true });
          const stream = await openZipEntryStream(zipFile, entry);
          await pipeline(stream, createWriteStream(output, { mode: safeZipEntryMode(entry) }));
        }
        zipFile.readEntry();
      })().catch(finish);
    });
    zipFile.readEntry();
  });
}

async function safeExtract7z(archive: string, destination: string, limit: number): Promise<void> {
  let executable: string | undefined;
  let listing: string | undefined;
  const configured = process.env.SLYBROWSER_7Z_PATH;
  for (const candidate of [configured, ...(process.platform === "win32" ? ["7z.exe", "7z"] : ["7zz", "7z"])].filter((value): value is string => Boolean(value))) {
    try {
      const inspected = await execFileAsync(candidate, ["l", "-slt", archive], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: INSPECTION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      executable = candidate;
      listing = inspected.stdout;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ArtifactError("Unable to inspect browser archive", "artifact_extract_failed");
      }
    }
  }
  if (!executable) throw new ArtifactError("7z or 7zz is required to extract browser archives", "artifact_extractor_missing");
  inspect7zListingForExtraction(listing ?? "", limit);
  try {
    await execFileAsync(executable, ["x", archive, `-o${destination}`, "-y", "-bd", "-bb0"], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: EXTRACTION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
      throw new ArtifactError("Browser archive extraction timed out", "artifact_extract_timeout");
    }
    throw new ArtifactError("Unable to extract browser artifact", "artifact_extract_failed");
  }
  let expanded = 0;
  for (const relativeName of await readdir(destination, { recursive: true })) {
    const output = resolve(destination, relativeName);
    const info = await lstat(output);
    if (info.isSymbolicLink()) throw new ArtifactError("Browser archive contains a symbolic link", "artifact_layout_invalid");
    if (info.isFile()) {
      expanded += info.size;
      if (expanded > limit) throw new ArtifactError("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
    }
  }
}

export function inspect7zListingForExtraction(listing: string, limit: number): void {
  const separator = /^----------\s*$/m.exec(listing);
  if (!separator) throw new ArtifactError("Unable to inspect browser archive", "artifact_extract_failed");
  const records = listing.slice(separator.index + separator[0].length).split(/\r?\n\s*\r?\n/);
  const seen = new Set<string>();
  let expanded = 0;
  let entries = 0;
  for (const record of records) {
    const fields = new Map<string, string>();
    for (const line of record.split(/\r?\n/)) {
      const marker = line.indexOf(" = ");
      if (marker > 0) fields.set(line.slice(0, marker), line.slice(marker + 3));
    }
    const rawName = fields.get("Path");
    if (!rawName) continue;
    entries += 1;
    if (entries > MAXIMUM_7Z_ENTRIES) {
      throw new ArtifactError("Browser archive contains too many entries", "artifact_layout_invalid");
    }
    const normalized = rawName.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.includes("..") || normalized.includes("\0")) {
      throw new ArtifactError("Browser archive contains an unsafe path", "artifact_layout_invalid");
    }
    const identity = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(identity)) throw new ArtifactError("Browser archive contains duplicate paths", "artifact_layout_invalid");
    seen.add(identity);
    const attributes = fields.get("Attributes") ?? "";
    if (fields.has("Symbolic Link") || /^l/i.test(attributes) || attributes.includes(" reparse ")) {
      throw new ArtifactError("Browser archive contains a symbolic link", "artifact_layout_invalid");
    }
    const sizeText = fields.get("Size") ?? "0";
    if (!/^\d+$/.test(sizeText)) throw new ArtifactError("Browser archive has an invalid entry size", "artifact_extract_failed");
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) throw new ArtifactError("Browser archive has an invalid entry size", "artifact_extract_failed");
    expanded += size;
    if (expanded > limit) throw new ArtifactError("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
  }
  if (entries === 0) throw new ArtifactError("Browser archive contains no entries", "artifact_layout_invalid");
}

async function safeExtractArchive(archive: string, destination: string, format: "7z" | "zip", limit: number): Promise<void> {
  if (format === "7z") return safeExtract7z(archive, destination, limit);
  return safeExtractZip(archive, destination, limit);
}

function openZipFile(archive: string): Promise<yauzl.ZipFile> {
  return new Promise((accept, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zipFile) => {
      if (error) {
        reject(new ArtifactError("Unable to open browser archive", "artifact_extract_failed"));
        return;
      }
      if (!zipFile) {
        reject(new ArtifactError("Unable to open browser archive", "artifact_extract_failed"));
        return;
      }
      accept(zipFile);
    });
  });
}

function openZipEntryStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((accept, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(new ArtifactError("Unable to extract browser artifact", "artifact_extract_failed"));
        return;
      }
      if (!stream) {
        reject(new ArtifactError("Unable to extract browser artifact", "artifact_extract_failed"));
        return;
      }
      accept(stream);
    });
  });
}

function safeZipEntryName(entry: yauzl.Entry): string {
  const normalized = entry.fileName.replaceAll("\\", "/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new ArtifactError("Browser archive contains an unsafe path", "artifact_layout_invalid");
  }
  const mode = (entry.externalFileAttributes >> 16) & 0xffff;
  if ((mode & 0xf000) === 0xa000) {
    throw new ArtifactError("Browser archive contains a symbolic link", "artifact_layout_invalid");
  }
  return normalized;
}

function safeZipEntryMode(entry: yauzl.Entry): number {
  const mode = (entry.externalFileAttributes >> 16) & 0xffff;
  return (mode & 0o111) !== 0 ? 0o700 : 0o600;
}

function isSubpath(root: string, value: string): boolean {
  const child = resolve(value);
  const relation = relative(root, child);
  return relation === "" || (relation !== "" && !relation.startsWith("..") && !isAbsolute(relation));
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function quarantinePath(path: string): Promise<void> {
  if (!await pathExists(path)) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const target = `${path}.bad-${process.pid}-${Date.now()}-${attempt}`;
    try {
      await rename(path, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (code === "EEXIST") continue;
      throw new ArtifactError("Unable to quarantine invalid browser cache", "artifact_cache_failed");
    }
  }
  throw new ArtifactError("Unable to quarantine invalid browser cache", "artifact_cache_failed");
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

async function verifyRuntime(root: string, grant: InstallGrant): Promise<{ browser: string; driver: string }> {
  const browser = resolve(root, grant.artifact.browserExecutable);
  const driver = resolve(root, grant.artifact.driverExecutable);
  if (!browser.startsWith(`${resolve(root)}\\`) && !browser.startsWith(`${resolve(root)}/`) ||
      !driver.startsWith(`${resolve(root)}\\`) && !driver.startsWith(`${resolve(root)}/`) ||
      dirname(browser) !== dirname(driver) || !await exists(browser) || !await exists(driver)) {
    throw new ArtifactError("Installed browser and project WebDriver layout is invalid", "artifact_layout_invalid");
  }
  if (await sha256(browser) !== grant.artifact.browserSha256 || await sha256(driver) !== grant.artifact.driverSha256) {
    throw new ArtifactError("Installed browser or project WebDriver hash does not match the signed manifest", "artifact_runtime_hash_mismatch");
  }
  return { browser, driver };
}

async function acquireLock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new ArtifactError("Timed out waiting for the browser installation lock", "install_lock_timeout");
      await new Promise((accept) => setTimeout(accept, 100));
    }
  }
}

async function readInstallation(path: string, grant: InstallGrant): Promise<BrowserInstallation | null> {
  try {
    const document = JSON.parse(await readFile(join(path, ".sly-install.json"), "utf8")) as BrowserInstallation;
    if (document.version !== grant.browserVersion || document.artifactSha256 !== grant.artifact.sha256) return null;
    const expectedBrowser = resolve(path, grant.artifact.browserExecutable);
    const expectedDriver = resolve(path, grant.artifact.driverExecutable);
    if (resolve(document.root) !== resolve(path) || resolve(document.browserExecutable) !== expectedBrowser ||
        resolve(document.driverExecutable) !== expectedDriver) return null;
    await verifyRuntime(path, grant);
    return document;
  } catch {
    return null;
  }
}

async function readLooseInstallation(path: string, options: Required<Omit<CurrentBrowserLookupOptions, "cacheRoot">>): Promise<BrowserInstallation | null> {
  try {
    const document = JSON.parse(await readFile(join(path, ".sly-install.json"), "utf8")) as BrowserInstallation;
    if (document.platform !== options.platform || document.arch !== options.arch) return null;
    if (!/^\d+(\.\d+){0,7}$/.test(document.version) || !matchesKernelMajor(document.version, options.kernelMajor)) return null;
    if (typeof document.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.artifactSha256)) return null;
    const root = resolve(document.root);
    if (root !== resolve(path)) return null;
    const browser = resolve(document.browserExecutable);
    const driver = resolve(document.driverExecutable);
    if (!browser.startsWith(`${root}\\`) && !browser.startsWith(`${root}/`) ||
        !driver.startsWith(`${root}\\`) && !driver.startsWith(`${root}/`) ||
        dirname(browser) !== dirname(driver) || !await exists(browser) || !await exists(driver)) {
      return null;
    }
    return { ...document, root, browserExecutable: browser, driverExecutable: driver };
  } catch {
    return null;
  }
}

async function writeCurrentPointers(cacheRoot: string, installation: BrowserInstallation): Promise<void> {
  const current = join(cacheRoot, "stable", "current");
  await mkdir(current, { recursive: true });
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    version: installation.version,
    platform: installation.platform,
    arch: installation.arch,
    artifactSha256: installation.artifactSha256,
    root: installation.root,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  const major = installation.version.split(".")[0]!;
  await writeFile(join(current, `${installation.platform}-${installation.arch}-latest.json`), payload, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(current, `${installation.platform}-${installation.arch}-${major}.json`), payload, { encoding: "utf8", mode: 0o600 });
}

export async function acquireBrowserInstallationReference(
  installation: BrowserInstallation,
): Promise<BrowserInstallationReference> {
  const root = resolve(installation.root);
  const refs = join(root, ".sly-refs");
  await mkdir(refs, { recursive: true });
  const referenceFile = join(refs, `${process.pid}-${Date.now()}-${randomUUID()}.json`);
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    processId: process.pid,
    acquiredAt: new Date().toISOString(),
    version: installation.version,
    platform: installation.platform,
    arch: installation.arch,
    artifactSha256: installation.artifactSha256,
    root,
    browserExecutable: resolve(installation.browserExecutable),
    driverExecutable: resolve(installation.driverExecutable),
  }, null, 2)}\n`;
  await writeFile(referenceFile, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let released = false;
  return {
    installation,
    referenceFile,
    async release() {
      if (released) return;
      released = true;
      await rm(referenceFile, { force: true });
    },
  };
}

export async function activeBrowserInstallationReferences(
  installation: BrowserInstallation,
): Promise<string[]> {
  const refs = join(resolve(installation.root), ".sly-refs");
  const entries = await readdir(refs, { withFileTypes: true }).catch(() => []);
  const active: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const referenceFile = join(refs, entry.name);
    try {
      const document = JSON.parse(await readFile(referenceFile, "utf8")) as {
        processId?: unknown;
        root?: unknown;
        artifactSha256?: unknown;
      };
      if (resolve(String(document.root ?? "")) !== resolve(installation.root) ||
          document.artifactSha256 !== installation.artifactSha256) {
        continue;
      }
      const pid = Number(document.processId);
      if (processIsAlive(pid)) {
        active.push(referenceFile);
      } else {
        await rm(referenceFile, { force: true });
      }
    } catch {
      await rm(referenceFile, { force: true });
    }
  }
  return active;
}

export async function isBrowserInstallationInUse(installation: BrowserInstallation): Promise<boolean> {
  return (await activeBrowserInstallationReferences(installation)).length > 0;
}

async function currentInstallationRoots(cacheRoot: string): Promise<Set<string>> {
  const roots = new Set<string>();
  const current = join(cacheRoot, "stable", "current");
  const pointers = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const pointer of pointers) {
    if (!pointer.isFile() || !pointer.name.endsWith(".json")) continue;
    try {
      const document = JSON.parse(await readFile(join(current, pointer.name), "utf8")) as { root?: unknown };
      if (typeof document.root === "string") roots.add(resolve(document.root));
    } catch {
      // Ignore corrupt current pointers; installation metadata is rechecked before deletion.
    }
  }
  return roots;
}

export async function pruneBrowserInstallations(
  options: CurrentBrowserLookupOptions & { dryRun?: boolean } = {},
): Promise<BrowserPruneResult> {
  const cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot());
  const stable = join(cacheRoot, "stable");
  const lookup = {
    platform: options.platform ?? currentPlatform(),
    arch: options.arch ?? currentArch(),
    kernelMajor: options.kernelMajor ?? "latest",
  } satisfies Required<Omit<CurrentBrowserLookupOptions, "cacheRoot">>;
  if (lookup.kernelMajor !== "latest" && (!Number.isSafeInteger(lookup.kernelMajor) || lookup.kernelMajor < 1)) {
    throw new ArtifactError("kernelMajor must be a positive integer or latest", "version_policy_invalid");
  }
  const currentRoots = await currentInstallationRoots(cacheRoot);
  const result: BrowserPruneResult = { removed: [], skippedInUse: [], kept: [] };
  const versions = await readdir(stable, { withFileTypes: true }).catch(() => []);
  for (const version of versions) {
    if (!version.isDirectory() || version.name === "current" || !/^\d+(\.\d+){0,7}$/.test(version.name) ||
        !matchesKernelMajor(version.name, lookup.kernelMajor)) continue;
    const versionRoot = join(stable, version.name);
    const identities = await readdir(versionRoot, { withFileTypes: true }).catch(() => []);
    for (const identity of identities) {
      if (!identity.isDirectory()) continue;
      const root = resolve(versionRoot, identity.name);
      const installation = await readLooseInstallation(root, lookup);
      if (!installation) continue;
      if (currentRoots.has(resolve(installation.root))) {
        result.kept.push(installation.root);
        continue;
      }
      if (await isBrowserInstallationInUse(installation)) {
        result.skippedInUse.push(installation.root);
        continue;
      }
      result.removed.push(installation.root);
      if (options.dryRun !== true) {
        await rm(installation.root, { recursive: true, force: true });
        const remaining = await readdir(versionRoot).catch(() => []);
        if (remaining.length === 0) await rm(versionRoot, { recursive: true, force: true });
      }
    }
  }
  result.removed.sort();
  result.skippedInUse.sort();
  result.kept.sort();
  return result;
}

export async function findCurrentBrowserInstallation(options: CurrentBrowserLookupOptions = {}): Promise<BrowserInstallation | null> {
  const cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot());
  const lookup = {
    platform: options.platform ?? currentPlatform(),
    arch: options.arch ?? currentArch(),
    kernelMajor: options.kernelMajor ?? "latest",
  } satisfies Required<Omit<CurrentBrowserLookupOptions, "cacheRoot">>;
  if (lookup.kernelMajor !== "latest" && (!Number.isSafeInteger(lookup.kernelMajor) || lookup.kernelMajor < 1)) {
    throw new ArtifactError("kernelMajor must be a positive integer or latest", "version_policy_invalid");
  }
  const currentKey = `${lookup.platform}-${lookup.arch}-${lookup.kernelMajor}.json`;
  try {
    const pointer = JSON.parse(await readFile(join(cacheRoot, "stable", "current", currentKey), "utf8")) as { root?: string };
    if (typeof pointer.root === "string") {
      const current = await readLooseInstallation(pointer.root, lookup);
      if (current) return current;
    }
  } catch {
    // Fall back to scanning older caches that predate the current pointer.
  }
  try {
    const stable = join(cacheRoot, "stable");
    const versions = await readdir(stable, { withFileTypes: true });
    const candidates: BrowserInstallation[] = [];
    for (const version of versions) {
      if (!version.isDirectory() || version.name === "current" || !/^\d+(\.\d+){0,7}$/.test(version.name) ||
          !matchesKernelMajor(version.name, lookup.kernelMajor)) continue;
      const identities = await readdir(join(stable, version.name), { withFileTypes: true }).catch(() => []);
      for (const identity of identities) {
        if (!identity.isDirectory()) continue;
        const installation = await readLooseInstallation(join(stable, version.name, identity.name), lookup);
        if (installation) candidates.push(installation);
      }
    }
    candidates.sort((left, right) => compareVersion(right.version, left.version));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

export async function installGrantedBrowser(
  client: LicenseServiceClient,
  grant: InstallGrant,
  options: InstallOptions = {},
): Promise<BrowserInstallation> {
  const cacheRoot = resolve(options.cacheRoot ?? defaultCacheRoot());
  const identity = `${grant.platform}-${grant.arch}-${grant.artifact.sha256.slice(0, 16)}`;
  const installRoot = join(cacheRoot, "stable", grant.browserVersion, identity);
  const existing = await readInstallation(installRoot, grant);
  if (existing) return existing;
  await mkdir(dirname(installRoot), { recursive: true });
  const lockPath = `${installRoot}.lock`;
  const releaseLock = await acquireLock(lockPath, options.lockTimeoutMs ?? 60_000);
  let temporaryDirectory: string | undefined;
  try {
    const raced = await readInstallation(installRoot, grant);
    if (raced) return raced;
    const downloads = join(cacheRoot, "downloads");
    await mkdir(downloads, { recursive: true });
    const archive = join(downloads, `${grant.artifact.sha256}.${grant.artifact.archiveFormat}`);
    let archiveValid = false;
    try {
      await verifyArtifact(archive, grant.artifact);
      archiveValid = true;
    } catch {
      archiveValid = false;
    }
    if (!archiveValid) {
      await quarantinePath(archive);
      const temporaryArchive = `${archive}.${process.pid}.${Date.now()}.${randomUUID()}.part`;
      try {
        const response = isRuntimeGrant(grant)
          ? await client.downloadRuntimeArtifact(grant)
          : await client.downloadArtifact(grant);
        assertContentLength(response, grant.artifact.size);
        await pipeline(
          Readable.fromWeb(response.body! as never),
          enforceDownloadSizeLimit(grant.artifact.size),
          createWriteStream(temporaryArchive, { flags: "wx", mode: 0o600 }),
        );
        await verifyArtifact(temporaryArchive, grant.artifact);
        await rename(temporaryArchive, archive);
      } catch (error) {
        await rm(temporaryArchive, { force: true });
        throw error;
      }
    }
    await verifyArtifact(archive, grant.artifact);
    temporaryDirectory = join(dirname(installRoot), `.extract-${process.pid}-${Date.now()}-${randomUUID()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    await (options.extractor ?? (async (source, destination) => safeExtractArchive(source, destination, grant.artifact.archiveFormat, maximumExpandedBytes(grant.artifact.size))))(
      archive,
      temporaryDirectory,
    );
    const pair = await verifyRuntime(temporaryDirectory, grant);
    await quarantinePath(installRoot);
    await rename(temporaryDirectory, installRoot);
    temporaryDirectory = undefined;
    const installation: BrowserInstallation = {
      version: grant.browserVersion,
      platform: grant.platform,
      arch: grant.arch,
      root: installRoot,
      browserExecutable: resolve(installRoot, grant.artifact.browserExecutable),
      driverExecutable: resolve(installRoot, grant.artifact.driverExecutable),
      artifactSha256: grant.artifact.sha256,
    };
    await writeFile(join(installRoot, ".sly-install.json"), `${JSON.stringify(installation, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeCurrentPointers(cacheRoot, installation);
    return installation;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await releaseLock();
  }
}
