import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
}

test("release scripts hash both runtimes and produce a verifiable Ed25519 manifest", async (context) => {
  if (process.platform !== "win32") {
    context.skip("PowerShell manifest generation is Windows-specific");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "sly-release-tools-"));
  try {
    const archive = join(root, "browser.zip");
    const browser = join(root, "SlyBrowser.exe");
    const driver = join(root, "chromedriver.exe");
    const unsigned = join(root, "unsigned.json");
    const signed = join(root, "signed.json");
    const privateKeyPath = join(root, "release-private.pem");
    const publicKeyPath = join(root, "release-public.pem");
    const patchRoot = join(root, "patches");
    const evidenceRoot = join(root, "evidence");
    await mkdir(patchRoot);
    await Promise.all([
      writeFile(archive, Buffer.from("test-archive")),
      writeFile(browser, Buffer.from("test-browser")),
      writeFile(driver, Buffer.from("test-driver")),
      writeFile(join(patchRoot, "args.gn"), "is_official_build = true\n"),
      writeFile(join(patchRoot, "0001-sly.patch"), "test patch\n"),
    ]);
    const generated = JSON.parse(execFileSync(process.execPath, [
      resolve("scripts/release/Generate-SupplyChainEvidence.mjs"),
      "--artifact", archive,
      "--browser", browser,
      "--driver", driver,
      "--patch-root", patchRoot,
      "--output-dir", evidenceRoot,
      "--browser-version", "150.0.0.0",
      "--chromium-commit", "abcdef1234567890",
      "--repository", "https://github.com/virtualfanc/slybrowser-chromium",
    ], { encoding: "utf8" }));
    execFileSync("powershell.exe", [
      "-NoProfile", "-File", resolve("scripts/release/New-UnsignedManifest.ps1"),
      "-Artifact", archive,
      "-Platform", "windows",
      "-Arch", "x64",
      "-Url", "https://api.slybrowser.com/v1/releases/artifacts/browser.zip",
      "-BrowserVersion", "150.0.0.0",
      "-SdkCompatibility", ">=0.1.0 <1.0.0",
      "-BrowserExecutable", browser,
      "-DriverExecutable", driver,
      "-Sbom", generated.sbom,
      "-SbomUrl", "https://api.slybrowser.com/v1/releases/evidence/sbom.json",
      "-Provenance", generated.provenance,
      "-ProvenanceUrl", "https://api.slybrowser.com/v1/releases/evidence/provenance.json",
      "-ChromiumPatchInventory", generated.chromiumPatchInventory,
      "-ChromiumPatchInventoryUrl", "https://api.slybrowser.com/v1/releases/evidence/chromium-patches.json",
      "-Output", unsigned,
    ]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
    await writeFile(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));
    execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsigned,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", signed,
    ]);
    const document = JSON.parse(await readFile(signed, "utf8"));
    const { signature, ...payload } = document;
    assert.equal(document.artifacts[0].archiveFormat, "zip");
    assert.match(document.artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(document.artifacts[0].browserSha256, /^[a-f0-9]{64}$/);
    assert.match(document.artifacts[0].driverSha256, /^[a-f0-9]{64}$/);
    assert.equal(document.evidence.sbom.mediaType, "application/vnd.cyclonedx+json");
    assert.equal(document.evidence.sourceBoundary.proprietaryCore, "private");
    assert.equal(signature.keyId, "release-test-v1");
    assert.equal(verify(
      null,
      Buffer.from(JSON.stringify(normalize(payload))),
      publicKey,
      Buffer.from(signature.value, "base64url"),
    ), true);
    const qualification = JSON.parse(execFileSync(process.execPath, [
      resolve("scripts/release/Verify-ReleaseBundle.mjs"),
      "--manifest", signed,
      "--public-key", publicKeyPath,
      "--key-id", "release-test-v1",
      "--artifact", archive,
      "--browser", browser,
      "--driver", driver,
      "--sbom", generated.sbom,
      "--provenance", generated.provenance,
      "--patch-inventory", generated.chromiumPatchInventory,
    ], { encoding: "utf8" }));
    assert.equal(qualification.status, "QUALIFIED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
