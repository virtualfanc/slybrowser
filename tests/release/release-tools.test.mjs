import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
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
    const archive = join(root, "browser.7z");
    const browser = join(root, "SlyBrowser.exe");
    const driver = join(root, "chromedriver.exe");
    const privateModule = join(root, "sly_private_module.dll");
    const resource = join(root, "resources.pak");
    const binaryLicense = join(root, "BINARY-LICENSE.txt");
    const licenseScope = join(root, "LICENSE-SCOPE.txt");
    const thirdPartyNotices = join(root, "THIRD_PARTY_NOTICES.txt");
    const creditsHtml = join(root, "CREDITS.html");
    const legalManifestArgs = [
      "-BinaryLicense", binaryLicense,
      "-LicenseScope", licenseScope,
      "-ThirdPartyNotices", thirdPartyNotices,
      "-CreditsHtml", creditsHtml,
    ];
    const allResourceFiles = [binaryLicense, licenseScope, thirdPartyNotices, creditsHtml, resource];
    const verificationResourceArgs = allResourceFiles.flatMap((path) => ["--resource", path]);
    const archiveBytes = Buffer.from([
      "test-archive",
      "BINARY-LICENSE.txt",
      "LICENSE-SCOPE.txt",
      "THIRD_PARTY_NOTICES.txt",
      "CREDITS.html",
    ].join("\n"));
    const unsigned = join(root, "unsigned.json");
    const signed = join(root, "signed.json");
    const privateKeyPath = join(root, "release-private.pem");
    const publicKeyPath = join(root, "release-public.pem");
    const patchRoot = join(root, "patches");
    const evidenceRoot = join(root, "evidence");
    await mkdir(patchRoot);
    await Promise.all([
      writeFile(archive, archiveBytes),
      writeFile(browser, Buffer.from("test-browser")),
      writeFile(driver, Buffer.from("test-driver")),
      writeFile(privateModule, Buffer.from("test-private-module")),
      writeFile(resource, Buffer.from("test-resource")),
      writeFile(binaryLicense, "SlyBrowser binary terms\n"),
      writeFile(licenseScope, "SlyBrowser license scope\n"),
      writeFile(thirdPartyNotices, "Chromium and third-party notices\n"),
      writeFile(creditsHtml, "<!doctype html><title>Credits</title>\n"),
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
      "--repository", "https://github.com/example/private-browser-source",
    ], { encoding: "utf8" }));
    execFileSync("powershell.exe", [
      "-NoProfile", "-File", resolve("scripts/release/New-UnsignedManifest.ps1"),
      "-Artifact", archive,
      "-Platform", "windows",
      "-Arch", "x64",
      "-Url", "https://api.slybrowser.com/v1/releases/artifacts/browser.7z",
      "-BrowserVersion", "150.0.0.0",
      "-SdkCompatibility", ">=0.1.0 <1.0.0",
      "-BrowserExecutable", browser,
      "-DriverExecutable", driver,
      "-PrivateModule", privateModule,
      "-PrivateModulePath", "SlyBrowser/sly_private_module.dll",
      "-PrivateModuleAbi", "windows-x64",
      ...legalManifestArgs,
      "-Resource", resource,
      "-ResourcePath", "SlyBrowser/resources.pak",
      "-CodeSignatureScheme", "authenticode",
      "-CodeSignatureSubject", "CN=SlyBrowser Test Publisher",
      "-CodeSignatureCertificateSha256", "3".repeat(64),
      "-CodeSignatureTimestampRequired",
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
    assert.throws(() => execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsigned,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", join(root, "blocked-same-online-key.json"),
    ], {
      encoding: "utf8",
      env: { ...process.env, SLY_LICENSE_SIGNING_KEY_FILE: privateKeyPath },
    }), /separate from online lease signing key/);
    assert.throws(() => execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsigned,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", join(root, "blocked-same-online-key-id.json"),
    ], {
      encoding: "utf8",
      env: { ...process.env, SLY_LICENSE_KEY_ID: "release-test-v1" },
    }), /separate from online lease key ID/);
    execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsigned,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", signed,
    ]);
    const document = JSON.parse(await readFile(signed, "utf8"));
    const { signature, ...payload } = document;
    assert.equal(document.status, "available");
    assert.equal(document.artifacts[0].archiveFormat, "7z");
    assert.match(document.artifacts[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(document.artifacts[0].browserSha256, /^[a-f0-9]{64}$/);
    assert.match(document.artifacts[0].driverSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(document.artifacts[0].privateModules.map((item) => item.path), ["SlyBrowser/sly_private_module.dll"]);
    assert.deepEqual(document.artifacts[0].resources.map((item) => item.path), [
      "BINARY-LICENSE.txt",
      "LICENSE-SCOPE.txt",
      "THIRD_PARTY_NOTICES.txt",
      "CREDITS.html",
      "SlyBrowser/resources.pak",
    ]);
    assert.equal(document.artifacts[0].codeSignature.subject, "CN=SlyBrowser Test Publisher");
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
      "--private-module", privateModule,
      ...verificationResourceArgs,
      "--sbom", generated.sbom,
      "--provenance", generated.provenance,
      "--patch-inventory", generated.chromiumPatchInventory,
    ], { encoding: "utf8" }));
    assert.equal(qualification.status, "QUALIFIED");
    assert.equal(qualification.browserVersion, "150.0.0.0");
    assert.equal(qualification.sdkCompatibility, ">=0.1.0 <1.0.0");
    assert.equal(qualification.platform, "windows");
    assert.equal(qualification.arch, "x64");
    assert.equal(qualification.artifact.url, "https://api.slybrowser.com/v1/releases/artifacts/browser.7z");
    assert.equal(qualification.artifact.sha256, document.artifacts[0].sha256);
    assert.equal(qualification.artifactSha256, document.artifacts[0].sha256);
    assert.equal(qualification.browserSha256, document.artifacts[0].browserSha256);
    assert.equal(qualification.driverSha256, document.artifacts[0].driverSha256);
    assert.match(qualification.manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(qualification.artifact.privateModuleCount, 1);
    assert.equal(qualification.artifact.resourceCount, 5);
    assert.deepEqual(qualification.artifact.requiredLegalResources, [
      "BINARY-LICENSE.txt",
      "LICENSE-SCOPE.txt",
      "THIRD_PARTY_NOTICES.txt",
      "CREDITS.html",
    ]);

    const unsignedWithoutCodeSignature = join(root, "unsigned-no-code-signature.json");
    const signedWithoutCodeSignature = join(root, "signed-no-code-signature.json");
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
      "-PrivateModule", privateModule,
      "-PrivateModulePath", "SlyBrowser/sly_private_module.dll",
      "-PrivateModuleAbi", "windows-x64",
      ...legalManifestArgs,
      "-Resource", resource,
      "-ResourcePath", "SlyBrowser/resources.pak",
      "-Sbom", generated.sbom,
      "-SbomUrl", "https://api.slybrowser.com/v1/releases/evidence/sbom.json",
      "-Provenance", generated.provenance,
      "-ProvenanceUrl", "https://api.slybrowser.com/v1/releases/evidence/provenance.json",
      "-ChromiumPatchInventory", generated.chromiumPatchInventory,
      "-ChromiumPatchInventoryUrl", "https://api.slybrowser.com/v1/releases/evidence/chromium-patches.json",
      "-Output", unsignedWithoutCodeSignature,
    ]);
    execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsignedWithoutCodeSignature,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", signedWithoutCodeSignature,
    ]);
    const noCodeSignatureDocument = JSON.parse(await readFile(signedWithoutCodeSignature, "utf8"));
    assert.equal(Object.hasOwn(noCodeSignatureDocument.artifacts[0], "codeSignature"), false);
    const noCodeSignatureQualification = JSON.parse(execFileSync(process.execPath, [
      resolve("scripts/release/Verify-ReleaseBundle.mjs"),
      "--manifest", signedWithoutCodeSignature,
      "--public-key", publicKeyPath,
      "--key-id", "release-test-v1",
      "--artifact", archive,
      "--browser", browser,
      "--driver", driver,
      "--private-module", privateModule,
      ...verificationResourceArgs,
      "--sbom", generated.sbom,
      "--provenance", generated.provenance,
      "--patch-inventory", generated.chromiumPatchInventory,
    ], { encoding: "utf8" }));
    assert.equal(noCodeSignatureQualification.status, "QUALIFIED");

    const unsignedWithoutEvidence = join(root, "unsigned-no-evidence.json");
    const signedWithoutEvidence = join(root, "signed-no-evidence.json");
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
      "-PrivateModule", privateModule,
      "-PrivateModulePath", "SlyBrowser/sly_private_module.dll",
      "-PrivateModuleAbi", "windows-x64",
      ...legalManifestArgs,
      "-Resource", resource,
      "-ResourcePath", "SlyBrowser/resources.pak",
      "-Output", unsignedWithoutEvidence,
    ]);
    execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsignedWithoutEvidence,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", signedWithoutEvidence,
    ]);
    const noEvidenceDocument = JSON.parse(await readFile(signedWithoutEvidence, "utf8"));
    assert.equal(Object.hasOwn(noEvidenceDocument, "evidence"), false);
    const noEvidenceQualification = JSON.parse(execFileSync(process.execPath, [
      resolve("scripts/release/Verify-ReleaseBundle.mjs"),
      "--manifest", signedWithoutEvidence,
      "--public-key", publicKeyPath,
      "--key-id", "release-test-v1",
      "--artifact", archive,
      "--browser", browser,
      "--driver", driver,
      "--private-module", privateModule,
      ...verificationResourceArgs,
    ], { encoding: "utf8" }));
    assert.equal(noEvidenceQualification.status, "QUALIFIED");
    assert.equal(noEvidenceQualification.supplyChainEvidence, "not-provided");

    const artifactRoot = join(root, "server-artifacts");
    const manifestRoot = join(root, "server-manifests");
    const publishArgs = [
      "-NoProfile", "-File", resolve("scripts/release/Publish-ReleaseBundle.ps1"),
      "-Manifest", signedWithoutEvidence,
      "-Artifact", archive,
      "-BrowserExecutable", browser,
      "-DriverExecutable", driver,
      "-PublicKey", publicKeyPath,
      "-KeyId", "release-test-v1",
      "-ArtifactRoot", artifactRoot,
      "-ManifestRoot", manifestRoot,
      "-PrivateModule", privateModule,
      "-ResourceList", allResourceFiles.join(";"),
    ];
    const published = JSON.parse(execFileSync("powershell.exe", publishArgs, { encoding: "utf8" }));
    assert.equal(published.status, "PUBLISHED");
    assert.equal(published.artifact.status, "published");
    assert.equal(published.manifest.status, "published");
    assert.equal(await readFile(join(artifactRoot, "browser.zip"), "utf8"), archiveBytes.toString("utf8"));
    assert.equal(JSON.parse(await readFile(join(manifestRoot, "150.0.0.0-windows-x64.json"), "utf8")).signature.keyId, "release-test-v1");
    const republished = JSON.parse(execFileSync("powershell.exe", publishArgs, { encoding: "utf8" }));
    assert.equal(republished.artifact.status, "already-present");
    assert.equal(republished.manifest.status, "already-present");

    const revokedUnsigned = join(root, "revoked-unsigned.json");
    const revokedSigned = join(root, "revoked-signed.json");
    const revokedDocument = JSON.parse(JSON.stringify(document));
    delete revokedDocument.signature;
    revokedDocument.status = "revoked";
    await writeFile(revokedUnsigned, JSON.stringify(revokedDocument, null, 2));
    execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", revokedUnsigned,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", revokedSigned,
    ]);
    assert.throws(() => execFileSync(process.execPath, [
      resolve("scripts/release/Verify-ReleaseBundle.mjs"),
      "--manifest", revokedSigned,
      "--public-key", publicKeyPath,
      "--key-id", "release-test-v1",
      "--artifact", archive,
      "--browser", browser,
      "--driver", driver,
      "--private-module", privateModule,
      ...verificationResourceArgs,
      "--sbom", generated.sbom,
      "--provenance", generated.provenance,
      "--patch-inventory", generated.chromiumPatchInventory,
    ], { encoding: "utf8" }), /available release manifest/);

    const unsafeArchive = join(root, "browser-with-pdb.zip");
    const unsafeUnsigned = join(root, "unsafe-unsigned.json");
    const unsafeSigned = join(root, "unsafe-signed.json");
    const unsafeArchiveBytes = Buffer.from("SlyBrowser/chrome.dll.pdb");
    await writeFile(unsafeArchive, unsafeArchiveBytes);
    const unsafeDocument = JSON.parse(JSON.stringify(document));
    delete unsafeDocument.signature;
    unsafeDocument.artifacts[0].size = unsafeArchiveBytes.length;
    unsafeDocument.artifacts[0].sha256 = createHash("sha256")
      .update(unsafeArchiveBytes)
      .digest("hex");
    await writeFile(unsafeUnsigned, JSON.stringify(unsafeDocument, null, 2));
    execFileSync(process.execPath, [
      resolve("scripts/release/Sign-ReleaseManifest.mjs"),
      "--input", unsafeUnsigned,
      "--private-key", privateKeyPath,
      "--key-id", "release-test-v1",
      "--output", unsafeSigned,
    ]);
    assert.throws(() => execFileSync(process.execPath, [
      resolve("scripts/release/Verify-ReleaseBundle.mjs"),
      "--manifest", unsafeSigned,
      "--public-key", publicKeyPath,
      "--key-id", "release-test-v1",
      "--artifact", unsafeArchive,
      "--browser", browser,
      "--driver", driver,
      "--private-module", privateModule,
      ...verificationResourceArgs,
      "--sbom", generated.sbom,
      "--provenance", generated.provenance,
      "--patch-inventory", generated.chromiumPatchInventory,
    ], { encoding: "utf8" }), /raw PDB or symbol files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
