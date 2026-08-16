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
| `browser/Compare-DetectionResults.ps1` | Compare saved Stock/Cloak/Sly results |
| `browser/Rescore-DetectionResults.ps1` | Recalculate saved run summaries after methodology changes |
| `browser/Check-Licenses.ps1` | Scan the built Chromium dependency graph and generate credits HTML |
| `release/New-UnsignedManifest.ps1` | Hash an archive and create an unsigned canonical manifest input |

The focused C++ license and native-profile suites are the default because they produce
small, attributable results:

```powershell
.\scripts\browser\Test-Cpp.ps1 -ChromiumSrc F:\chrome\src -OutDir out\release_x64
```

The native profile handoff test requires a development build with license enforcement
disabled (or a separately authorized production launch) and writes measured runtime
evidence under `artifacts/`:

```powershell
.\scripts\browser\Test-NativeProfileHandoff.ps1 `
  -BrowserExecutable F:\chrome\src\out\release_x64\SlyBrowser.exe
```

The WebDriver benchmark uses the browser and `chromedriver.exe` from the same explicit
Chromium output directory. It never downloads a replacement driver:

```powershell
$env:SLYBROWSER_CHROMIUM_SRC = 'F:\chrome\src'
.\scripts\browser\Test-DetectionPagesWebDriver.ps1 -OutDir out\release_x64
```

For a production build, add `-LicenseFile` with a fresh short-lived lease. License keys,
lease contents, browser binaries, and driver binaries are not part of this repository.

Run a full WebDriver-to-WebDriver comparison with explicit binaries:

```powershell
.\scripts\browser\Test-SlyVsCloakWebDriver.ps1 `
  -SlyBrowserExecutable 'F:\chrome\src\out\release_x64\SlyBrowser.exe' `
  -SlyDriverExecutable 'F:\chrome\src\out\release_x64\chromedriver.exe' `
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
  -SlyBrowserExecutable 'F:\chrome\src\out\release_x64\SlyBrowser.exe' `
  -SlyDriverExecutable 'F:\chrome\src\out\release_x64\chromedriver.exe' `
  -CloakBrowserExecutable 'C:\Users\me\.cloakbrowser\chromium-VERSION\chrome.exe' `
  -CloakWrapperModule 'E:\dev\CloakBrowser\js\dist\index.js'
```

The resulting comparison labels the different automation providers. Humanize cannot
be enabled by a Chromium command-line switch or through raw ChromeDriver alone.

Use `-Full` to additionally build and run Chromium's `components_unittests` and
`browser_tests`. A full run is a release gate and can take substantially longer:

```powershell
.\scripts\browser\Test-Cpp.ps1 -ChromiumSrc F:\chrome\src -OutDir out\release_x64 -Full
```

Signing is deliberately not implemented with a local private-key argument. Production
signatures must come from a protected signing service or an explicitly approved offline
process.
