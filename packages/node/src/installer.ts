import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import extractZip from "extract-zip";

import { ArtifactError } from "./errors.js";
import { verifyArtifact } from "./manifest.js";
import type { LicenseServiceClient, LicensedSessionGrant } from "./service.js";

export interface BrowserInstallation {
  version: string;
  platform: string;
  arch: string;
  root: string;
  browserExecutable: string;
  driverExecutable: string;
  artifactSha256: string;
}

export interface InstallOptions {
  cacheRoot?: string;
  lockTimeoutMs?: number;
  extractor?: (archive: string, destination: string) => Promise<void>;
}

function defaultCacheRoot(): string {
  if (process.platform === "win32") {
    return resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SlyBrowser", "cache");
  }
  if (process.platform === "darwin") return resolve(homedir(), "Library", "Caches", "SlyBrowser");
  return resolve(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "slybrowser");
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  await pipeline(createReadStream(path), digest);
  return digest.digest("hex");
}

async function verifyRuntime(root: string, grant: LicensedSessionGrant): Promise<{ browser: string; driver: string }> {
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

async function readInstallation(path: string, grant: LicensedSessionGrant): Promise<BrowserInstallation | null> {
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

export async function installGrantedBrowser(
  client: LicenseServiceClient,
  grant: LicensedSessionGrant,
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
    const archive = join(downloads, `${grant.artifact.sha256}.zip`);
    let archiveValid = false;
    try {
      await verifyArtifact(archive, grant.artifact);
      archiveValid = true;
    } catch {
      archiveValid = false;
    }
    if (!archiveValid) {
      const temporaryArchive = `${archive}.${process.pid}.${Date.now()}.download`;
      try {
        const response = await client.downloadArtifact(grant);
        await pipeline(Readable.fromWeb(response.body! as never), createWriteStream(temporaryArchive, { flags: "wx", mode: 0o600 }));
        await verifyArtifact(temporaryArchive, grant.artifact);
        await rm(archive, { force: true });
        await rename(temporaryArchive, archive);
      } catch (error) {
        await rm(temporaryArchive, { force: true });
        throw error;
      }
    }
    await verifyArtifact(archive, grant.artifact);
    temporaryDirectory = join(dirname(installRoot), `.extract-${process.pid}-${Date.now()}`);
    await mkdir(temporaryDirectory, { recursive: false });
    await (options.extractor ?? (async (source, destination) => extractZip(source, { dir: destination })))(archive, temporaryDirectory);
    const pair = await verifyRuntime(temporaryDirectory, grant);
    await rm(installRoot, { recursive: true, force: true });
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
    return installation;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    await releaseLock();
  }
}
