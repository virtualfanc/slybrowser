# Release process

No browser artifact is releasable until every gate below passes.

## 1. Source identity

- Record the Chromium tag and commit.
- Record the SlyBrowser patch commit.
- Require a clean checkout, including Skia and V8 submodules.
- Save sanitized GN arguments without API keys, tokens, local paths, or credentials.

## 2. License compliance

- Run `scripts/browser/Check-Licenses.ps1` against the exact Chromium checkout and GN
  output directory.
- Generate `THIRD_PARTY_NOTICES.txt`, `CREDITS.html`, `CHROMIUM_LICENSES.txt`,
  `BINARY-LICENSE.txt`, `LICENSE-SCOPE.txt`, and `release-legal-summary.json`.
- Confirm the SlyBrowser binary license is the owner-approved launch file
  `legal/BINARY-LICENSE.md`, not the archived draft.
- Package required copyright, BSD, Chromium, and third-party notices.
- Confirm Google Chrome branding and trademarked resources are disabled.

## 3. Build and test

- Build the release browser and affected C++ tests.
- Sign and verify the final browser executable before calculating the hash embedded in
  the paired WebDriver.
- Generate the WebDriver pairing GN arguments from that exact signed browser, rebuild
  the driver from the same Chromium checkout, then sign and verify the driver.
- Run C++ unit tests and Chromium browser tests selected by the change map.
- Run SDK unit, contract, download-integrity, and launch tests.
- Run the approved external/local test-page suite with clean profiles.
- Confirm missing/expired leases and copied, renamed, modified, and mismatched runtime
  files fail closed.
- Store structured results, screenshots, browser logs, crash dumps, and environment data.

## 4. Package and sign

- Package deterministic files only; reject unexpected executables and private symbols.
- Keep the exact hash-matched signed browser and signed WebDriver as sibling files; do
  not mutate either executable after pairing validation.
- Calculate archive size and SHA-256.
- Produce a canonical release manifest with SDK compatibility and the four required
  legal resources: `BINARY-LICENSE.txt`, `LICENSE-SCOPE.txt`,
  `THIRD_PARTY_NOTICES.txt`, and `CREDITS.html`.
- Sign through the protected release signing service.
- Verify the published manifest and artifact from a clean machine before announcement.

SDK registry publication additionally requires `sdk-release-authorization.json` as a
GitHub Release asset. Store that file's exact `sha256:<hex>` digest in the protected
registry environment variable `SDK_RELEASE_AUTHORIZATION_SHA256`. The receipt binds the
reviewed candidate ID, `sdk-v<version>` tag, Git source tree, version, and complete SDK
set ID. Registry workflows reject a moved tag, substituted receipt, or different SDK
set before any publishing credential is used.

`scripts/release/New-UnsignedManifest.ps1` records the archive, browser and project-
WebDriver hashes, archive-relative executable paths, and required legal resource
hashes.
`scripts/release/Sign-ReleaseManifest.mjs` signs its canonical JSON payload with an
Ed25519 release key. SDKs reject an archive or cached executable whose recorded hash no
longer matches. Exact commands are in
[Authorized browser delivery](authorized-release-service.md).
`scripts/release/Verify-ReleaseBundle.mjs` emits a sanitized qualification summary
with the signed manifest hash, artifact URL, archive/browser/WebDriver hashes, platform,
architecture, SDK compatibility, saved browser version, and required legal resources.
It fails closed when any required legal file is missing from the signed manifest or
archive. Feed that summary plus the kernel-update score gate into
`Build-QualificationReport.mjs`; the report blocks if the verified manifest hashes
disagree with the release inputs.

## 5. Rollback

Keep the previous supported artifact and manifest available. A bad release is revoked in
the update service, documented in the changelog, and replaced with a new immutable
version; published archives and manifests are never silently overwritten.
