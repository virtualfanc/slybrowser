# Automation scripts

All PowerShell entry points support `-Verbose` and stop on the first failed external
command. Paths are resolved before use; no script recursively deletes a caller-provided
directory.

| Script | Purpose |
| --- | --- |
| `Test-Repository.ps1` | Run repository, Python, Node.js, and optional .NET checks |
| `browser/Build-Chromium.ps1` | Build explicit Chromium targets with autoninja |
| `browser/Test-Cpp.ps1` | Build and run selected C++ tests with JSON summaries |
| `browser/Test-NativeProfileHandoff.ps1` | Verify one-time native config across window and Worker contexts |
| `browser/Test-DetectionPages.ps1` | Run 30+ local/live detection pages and produce scores |
| `browser/Test-DetectionPagesWebDriver.ps1` | Run the same suite through the project's explicit self-built WebDriver |
| `browser/Test-SlyVsCloakWebDriver.ps1` | Run sequential Sly/Cloak WebDriver comparisons with recorded Cloak stealth flags |
| `browser/Test-SlyVsCloakBest.ps1` | Compare Sly's project WebDriver with Cloak's official wrapper in real Humanize best mode |
| `browser/Test-NativeRuntimeWatchdogMatrix.ps1` | Run the production-like native license watchdog matrix against the project-built browser and WebDriver |
| `browser/Test-SignedPrivateBrowserLicenseOnly.ps1` | Run the signed private-browser startup gate with a real localhost authorization service and native runtime handoff |
| `browser/Compare-DetectionResults.ps1` | Compare saved Stock/Cloak/Sly results |
| `browser/Rescore-DetectionResults.ps1` | Recalculate saved run summaries after methodology changes |
| `browser/Check-Licenses.ps1` | Scan the built Chromium dependency graph and generate release legal artifacts: binary terms, license scope, third-party NOTICE, Chromium licenses, credits HTML and hash summary |
| `license/New-SignedTestLease.mjs` | Generate a short-lived Ed25519 test lease and matching public-key metadata |
| `release/Build-WindowsReleaseCandidate.ps1` | Build a Windows x64 ZIP candidate from the current Chromium output using a previous archive as the layout template, add legal files, and optionally emit an unsigned manifest |
| `release/New-ReleaseSigningKey.mjs` | Generate a local/offline Ed25519 release-manifest signing key pair outside Git |
| `release/New-UnsignedManifest.ps1` | Hash an archive and create an unsigned canonical manifest input |
| `release/Publish-ReleaseBundle.ps1` | Verify and copy a signed release ZIP/manifest into the self-hosted API artifact roots without overwriting changed bytes |
| `release/Publish-ReleaseBundleToServer.ps1` | Verify locally, upload the ZIP to the API server first, then upload the signed manifest last over SSH/SCP |
| `release/Set-SdkPackageVersion.ps1` | Keep workspace, npm, PyPI, Maven and NuGet package versions synchronized with `contracts/sdk-packages.json` |
| `release/Publish-SdkPackages.ps1` | Build, dry-run or publish the four public SDK packages to npm, PyPI, Maven Central and NuGet |

Run the lightweight repository guard before staging or opening a PR:

```powershell
.\scripts\Test-Repository.ps1 -RepositoryGuardOnly
```

It checks `git diff --check`, scans for obvious private keys and blocks tracked
AI-agent scratch material, local instruction files, build outputs, coverage,
dependency folders, browser binaries, symbol files and release archives. The full
script without `-RepositoryGuardOnly` continues into SDK, service, release and
detection test checks.

The focused C++ license and native-profile suites are the default because they produce
small, attributable results:

```powershell
.\scripts\browser\Test-Cpp.ps1 -ChromiumSrc E:\multilogin\chrome\src -OutDir out\release_x64
```

The native profile handoff test requires a development build with license enforcement
disabled (or a separately authorized production launch) and writes measured runtime
evidence under `artifacts/`:

```powershell
.\scripts\browser\Test-NativeProfileHandoff.ps1 `
  -BrowserExecutable E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe
```

The WebDriver benchmark uses the browser and `chromedriver.exe` from the same explicit
Chromium output directory. It never downloads a replacement driver:

```powershell
$env:SLYBROWSER_CHROMIUM_SRC = 'E:\multilogin\chrome\src'
.\scripts\browser\Test-DetectionPagesWebDriver.ps1 -OutDir out\release_x64
```

For a production build, add `-LicenseFile` with a fresh short-lived lease. License keys,
lease contents, browser binaries, and driver binaries are not part of this repository.
Windows license handoff files are ACL-restricted before they are passed to the browser
or driver; if ACL hardening fails, the scripts fail closed.

Before producing a release manifest, generate the legal artifacts from the exact
Chromium checkout and build output that produced the browser binary:

```powershell
.\scripts\browser\Check-Licenses.ps1 `
  -ChromiumSrc E:\multilogin\chrome\src `
  -OutDir out\release_x64 `
  -GnTarget //chrome:chrome
```

The output directory defaults to `artifacts/licenses/` and is intentionally ignored by
Git. Copy `BINARY-LICENSE.txt`, `LICENSE-SCOPE.txt`, `THIRD_PARTY_NOTICES.txt` and
`CREDITS.html` into the release ZIP. Pass those same files to
`New-UnsignedManifest.ps1`; release verification fails if the manifest or archive is
missing any of them.

To refresh a Windows ZIP candidate after rebuilding the private browser/WebDriver,
reuse the previous archive as a layout template so only known release files are copied:

```powershell
.\scripts\release\Build-WindowsReleaseCandidate.ps1 `
  -ChromiumOutDir E:\multilogin\chrome\src\out\release_x64 `
  -TemplateArchive E:\multilogin\slybrowser-chromium\chromium\148.0.7778.179\slybrowser-148.0.7778.179-win-x64.zip `
  -BrowserVersion 148.0.7778.179 `
  -LegalDirectory .\artifacts\licenses `
  -OutputDirectory E:\multilogin\artifacts\release-candidates\148.0.7778.179 `
  -ArtifactUrl https://api.slybrowser.com/v1/releases/artifacts/slybrowser-148.0.7778.179-win-x64.zip `
  -ManifestOutput E:\multilogin\artifacts\release-candidates\148.0.7778.179\stable.win-x64.unsigned.json
```

The script writes a `.zip.md5` sidecar and refuses unsafe template paths. The output is
ignored by Git; copy it to the private Chromium archive or server only after verifying
hashes and release scope.

Generate a local release-manifest signing key outside the repository when preparing a
launch-candidate signed manifest. Keep the private key out of Git and separate from the
online lease-signing and license-file-signing keys:

```powershell
node .\scripts\release\New-ReleaseSigningKey.mjs `
  --output .\artifacts\keys\release-launch-candidate-20260824 `
  --key-id release-launch-candidate-20260824
```

For a local signed test build, keep the Ed25519 test private key outside the repository,
compile the private browser with the `gnArgs` public-key metadata emitted by the helper,
then let the strongest comparison script create an expiring lease on demand:

```powershell
node .\scripts\license\New-SignedTestLease.mjs `
  --lease "$env:TEMP\sly-test-lease.json" `
  --metadata "$env:TEMP\sly-test-lease-metadata.json" `
  --private-key-file C:\secure\sly-test-lease-private.pem

$env:SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE = 'C:\secure\sly-test-lease-private.pem'
.\scripts\browser\Test-SlyVsChromiumStrongest.ps1
```

Run the native runtime watchdog release gate against the exact browser/WebDriver pair
compiled with the matching public key and key ID:

```powershell
.\scripts\browser\Test-NativeRuntimeWatchdogMatrix.ps1 `
  -BrowserExecutable E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe `
  -DriverExecutable E:\multilogin\chrome\src\out\release_x64\chromedriver.exe `
  -PrivateKeyFile C:\secure\sly-test-lease-private.pem `
  -KeyId launch-candidate-20260824 `
  -IncludeRevocationExit `
  -IncludeTransientExpiry
```

This matrix verifies native activate, heartbeat, release, terminal HTTP refusal,
signature/hash tampering, expired leases, browser/WebDriver same-session pairing,
revocation exit, and transient 5xx retry-until-expiry behavior. It writes ignored
evidence under `artifacts/test-results/native-watchdog/`; signing private keys and
compiled binaries stay outside Git.

Run the signed private-browser startup gate when you need a shorter release check for
lease-only rejection, browser/WebDriver pairing and one valid native runtime handoff:

```powershell
node .\scripts\license\New-SignedTestLease.mjs `
  --lease "$env:TEMP\sly-test-lease.json" `
  --metadata "$env:TEMP\sly-test-lease-metadata.json" `
  --private-key-file C:\secure\sly-test-lease-private.pem `
  --key-id launch-candidate-20260824 `
  --feature browser `
  --feature webdriver `
  --feature humanize

.\scripts\browser\Test-SignedPrivateBrowserLicenseOnly.ps1 `
  -BrowserExecutable E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe `
  -DriverExecutable E:\multilogin\chrome\src\out\release_x64\chromedriver.exe `
  -LicenseFile "$env:TEMP\sly-test-lease.json" `
  -PrivateKeyFile C:\secure\sly-test-lease-private.pem `
  -KeyId launch-candidate-20260824
```

The success path starts an in-memory license service and uses a real activation ticket;
plain signed leases without native runtime handoff are expected to fail closed.

Run a full WebDriver-to-WebDriver comparison with explicit binaries:

```powershell
.\scripts\browser\Test-SlyVsCloakWebDriver.ps1 `
  -SlyBrowserExecutable 'E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe' `
  -SlyDriverExecutable 'E:\multilogin\chrome\src\out\release_x64\chromedriver.exe' `
  -CloakBrowserExecutable 'C:\path\to\cloakbrowser\chrome.exe' `
  -CloakDriverExecutable 'C:\path\to\cloakbrowser\chromedriver.exe'
```

The comparison script enables all seed-derived fingerprint features available in the
selected Cloak binary and records its arguments. It does not obtain a Cloak license or
turn an older keyless binary into the current licensed build.

For a product-best comparison that actually enables Cloak's wrapper-level Humanize
layer, build the open CloakBrowser JavaScript wrapper and pass its generated
`dist/index.js`. The default is headed mode, `humanize=true`, the `careful` preset,
GeoIP/WebRTC alignment, default stealth arguments, and a reproducible fingerprint
seed. SlyBrowser continues to use its explicitly selected project `chromedriver.exe`:

```powershell
.\scripts\browser\Test-SlyVsCloakBest.ps1 `
  -SlyBrowserExecutable 'E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe' `
  -SlyDriverExecutable 'E:\multilogin\chrome\src\out\release_x64\chromedriver.exe' `
  -CloakBrowserExecutable 'C:\Users\me\.cloakbrowser\chromium-VERSION\chrome.exe' `
  -CloakWrapperModule 'E:\dev\CloakBrowser\js\dist\index.js'
```

The resulting comparison labels the different automation providers. Humanize cannot
be enabled by a Chromium command-line switch or through raw ChromeDriver alone.

Use `-Full` to additionally build and run Chromium's `components_unittests` and
`browser_tests`. A full run is a release gate and can take substantially longer:

```powershell
.\scripts\browser\Test-Cpp.ps1 -ChromiumSrc E:\multilogin\chrome\src -OutDir out\release_x64 -Full
```

Release signing is deliberately not implemented with a local private-key argument.
Production signatures must come from a protected signing service or an explicitly
approved offline process.

For the first self-hosted download origin, publish release files to the Linux API
server after the manifest is signed:

```powershell
.\scripts\release\Publish-ReleaseBundleToServer.ps1 `
  -Manifest .\release\stable.json `
  -Artifact .\release\slybrowser-win-x64.zip `
  -BrowserExecutable .\release\SlyBrowser.exe `
  -DriverExecutable .\release\slywebdriver.exe `
  -ResourceList ".\release\BINARY-LICENSE.txt;.\release\LICENSE-SCOPE.txt;.\release\THIRD_PARTY_NOTICES.txt;.\release\CREDITS.html" `
  -PublicKey .\release\release-public.pem `
  -KeyId release-prod-v1 `
  -RemoteHost api.slybrowser.com `
  -RemoteUser slyrelease
```

The remote script only writes under `/srv/slybrowser/releases/artifacts` and
`/srv/slybrowser/releases/manifests` by default. It refuses to overwrite a same-name
file with different bytes and publishes the manifest after the ZIP, so clients do not
see a manifest before its artifact is present.

## Public SDK package publishing

The four public SDK packages share one version source:

```powershell
.\scripts\release\Set-SdkPackageVersion.ps1 -Version 0.1.0
.\scripts\release\Set-SdkPackageVersion.ps1 -Check
```

Dry-run all package builds before any registry upload:

```powershell
.\scripts\release\Publish-SdkPackages.ps1 -Package all -DryRun
```

The production upload command is intentionally separate:

```powershell
.\scripts\release\Publish-SdkPackages.ps1 -Package all -Publish
```

Registry targets are pinned in `contracts/sdk-packages.json`:

- Node.js: npm `slybrowser`
- Python: PyPI `slybrowser`
- Java: Maven Central `com.slybrowser:slybrowser`
- .NET: NuGet `SlyBrowser`

Publishing requires authenticated provider-side controls: npm login or trusted
publishing, PyPI/twine token or trusted publishing, Maven Central `central`
credentials plus GPG signing, and `NUGET_API_KEY` for NuGet. Keep these secrets in
the provider or CI environment, never in the repository.
