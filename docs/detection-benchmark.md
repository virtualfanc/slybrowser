# Detection benchmark

The benchmark compares browsers under one controlled environment. It is a regression
and product-comparison tool, not a guarantee that any unrelated website will allow a
particular session.

## What is measured

The default configuration contains more than 30 checks across:

- direct automation signals (`navigator.webdriver`, headless UA, plugins,
  `window.chrome`, and common CDP globals);
- window, iframe, and worker consistency;
- public bot-detection demos including Sannysoft, Incolumitas, BrowserScan,
  Device & Browser Info, and Fingerprint's web-scraping demo;
- reCAPTCHA v3's public score demo;
- authorized Turnstile and ShieldSquare endpoints when configured;
- canvas, WebGL, audio, fonts, WebRTC, client hints, TLS, HTTP/2, headers, proxy,
  and IP evidence pages.

The official CreepJS deployment is `abrahamjuliot.github.io/creepjs`; similarly named
mirrors are intentionally excluded. Turnstile's built-in test keys are used only as
functional E2E checks and are never counted as anti-detection passes because Cloudflare
documents that they return predetermined outcomes.

## Framework runner (Playwright and Puppeteer)

Copy `tests/detection/browsers.example.json` to the ignored file
`tests/detection/browsers.local.json`, then set the referenced environment variables.
Do not place license values or proxy passwords in the JSON file.

```powershell
$env:STOCK_CHROME_EXE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:CLOAKBROWSER_BINARY_PATH = 'C:\path\to\cloakbrowser.exe'
$env:SLYBROWSER_BINARY_PATH = '<chromium-output>\SlyBrowser.exe'
$env:SLYBROWSER_TEST_LICENSE_FILE = 'C:\secure\short-lived-test-lease.json'

./scripts/browser/Test-DetectionPages.ps1 `
  -BrowserConfig ./tests/detection/browsers.local.json
```

Each browser entry may set `provider` to `playwright-core` or `puppeteer-core`;
omitting it preserves the Playwright default. This path is useful for comparing
framework launch behavior across browser targets. It is distinct from the project's
W3C WebDriver path below. Puppeteer is a Node.js/TypeScript-only integration and is
not exposed by the Python, Java or .NET packages.

The controlled strongest-mode script runs the project WebDriver result plus a
four-way framework matrix: SlyBrowser and stock Chromium through both Playwright and
Puppeteer. It creates a fresh one-time license/profile handoff for every SlyBrowser
process, records the installed framework binding version, and runs the Node.js,
Python, Java and .NET Native Humanize score parity gate before publishing the public
comparison:

```powershell
.\scripts\browser\Test-SlyVsChromiumStrongest.ps1 `
  -LicenseFile 'C:\secure\short-lived-test-lease.json' `
  -ProfileConfigFile '.\tests\detection\profiles\strongest-benchmark.json'
```

Framework results deliberately record Native Humanize as unavailable instead of
substituting framework mouse/keyboard helpers. Use `-SkipFrameworkBackends` only when
running the legacy WebDriver-versus-stock-Playwright subset.

First-release SlyBrowser benchmark profiles must use direct networking. Proxy
routing, proxy alignment, GEO/geolocation, and WebRTC proxy/replace settings are
future features and are rejected by the public SDK launch helpers.

## Project WebDriver runner

`Test-DetectionPagesWebDriver.ps1` launches the explicitly selected project build of
`chromedriver.exe`, which in turn launches the explicitly selected SlyBrowser binary.
It does not use Selenium Manager, a system driver, or a downloaded fallback. Browser
and driver SHA-256 values and reported versions are stored in the JSON result, and the
run stops before collection if their major versions differ.

This is the same transport used by the default JavaScript, Python, Java and .NET SDK
launch functions. The benchmark requires explicit binary paths for reproducibility;
normal SDK use resolves the sibling project driver automatically.

When both binaries are in the same Chromium output directory:

```powershell
$env:SLYBROWSER_CHROMIUM_SRC = '<chromium-source-root>'

.\scripts\browser\Test-DetectionPagesWebDriver.ps1 `
  -OutDir 'out\release_x64'
```

Explicit paths are also supported:

```powershell
.\scripts\browser\Test-DetectionPagesWebDriver.ps1 `
  -BrowserExecutable '<chromium-output>\SlyBrowser.exe' `
  -DriverExecutable '<chromium-output>\chromedriver.exe' `
  -Only local-core-signals,local-context-consistency,device-browser-info
```

Enable native Sly WebDriver Humanize for behavior-sensitive runs. The runner negotiates
`sly:options.humanize`; standard element click and send-keys commands are then executed
inside the driver with trusted non-center curved pointer input and per-character
keyboard timing. Explicit W3C Actions remain deterministic caller-controlled benchmark
steps and are not rewritten. No DOM events are dispatched with JavaScript:

```powershell
.\scripts\browser\Test-DetectionPagesWebDriver.ps1 `
  -BrowserExecutable '<chromium-output>\SlyBrowser.exe' `
  -DriverExecutable '<chromium-output>\chromedriver.exe' `
  -Headed `
  -Humanize `
  -HumanPreset careful `
  -HumanSeed 42424
```

The seed is recorded in the report for reproducibility. Omit `-HumanSeed` from an
uncontrolled production run if deterministic paths are undesirable. Every WebDriver
HTTP request has a bounded host-side timeout so a stalled driver command becomes an
evidenced `ERROR` rather than hanging the entire benchmark.

Product-recommended Chrome switch exclusions can be passed explicitly. They are
recorded in the JSON result so a comparison cannot silently change its launch policy:

```powershell
.\scripts\browser\Test-DetectionPagesWebDriver.ps1 `
  -BrowserExecutable 'C:\path\to\cloakbrowser\chrome.exe' `
  -DriverExecutable 'C:\path\to\cloakbrowser\chromedriver.exe' `
  -BrowserArgument '--fingerprint=42424','--fingerprint-platform=windows' `
  -ExcludeSwitch 'enable-automation','enable-unsafe-swiftshader'
```

For an authorized production build, pass only a short-lived signed lease file; never
pass a long-lived license key:

```powershell
.\scripts\browser\Test-DetectionPagesWebDriver.ps1 `
  -ChromiumSrc '<chromium-source-root>' `
  -LicenseFile 'C:\secure\short-lived-test-lease.json' `
  -ProfileConfigFile 'C:\secure\one-time-profile.json'
```

The script preserves the supplied lease source and creates two separate temporary
one-time copies: one is consumed by Sly WebDriver and one by SlyBrowser. It deletes any
copy that a process did not already consume.

The paths for license, profile, proxy, token, password, and secret arguments are
redacted from report launch arguments. The browser may consume and delete the
one-time license/profile files according to its native policy, so use fresh test
fixtures for each run. Browser console logging is disabled by default because enabling
it changes ChromeDriver's DevTools command traffic; `-CaptureBrowserLogs` is available
only when those diagnostics are intentionally required.

This runner controls ChromeDriver through the W3C WebDriver HTTP protocol. ChromeDriver
can use Chromium DevTools internally, so the result must be described as a WebDriver
run, not as a claim that no CDP traffic exists.

For a sequential SlyBrowser/CloakBrowser WebDriver comparison, use
`Test-SlyVsCloakWebDriver.ps1`. It applies CloakBrowser's documented seed/platform
fingerprint configuration, locale/timezone binary flags, GPU allowance, and default
automation-switch exclusions. Seed-derived canvas, WebGL, audio, font, hardware, and
screen features are enabled by the selected Cloak binary itself. The script cannot
enable features absent from that binary or obtain a current licensed binary without
the user's own Cloak entitlement.

For the best available cross-transport comparison, use
`Test-SlyVsCloakBest.ps1`. It enables `careful` Humanize for both SlyBrowser and
CloakBrowser and records each product's transport, preset, executable, version, and
hash; a Playwright-versus-WebDriver result remains engineering evidence rather than a
same-transport parity claim.

For authorized commercial-service tests, optionally set:

- `SLY_TEST_TURNSTILE_NONINTERACTIVE_URL`
- `SLY_TEST_TURNSTILE_MANAGED_URL`
- `SLY_TEST_SHIELDSQUARE_URL`

Those URLs must be controlled by or explicitly authorized for the tester. A production
site chosen merely because it uses a protection vendor is not an acceptable target.

## Scoring

Only checks with a stable, machine-readable verdict receive weights. Informational
pages produce `EVIDENCE` and remain visible in the report without an invented score.
`PASS` and `FAIL` are the only completed graded outcomes. Navigation or extraction
errors reduce coverage instead of inventing a zero score. Missing required checks also
reduce coverage; below 80% coverage the overall result is marked `provisional`.

The report shows:

- raw weighted score among completed graded checks;
- required coverage;
- coverage-adjusted score;
- category scores;
- PASS, FAIL, ERROR, EVIDENCE, and SKIP counts;
- TLS parity against the stock baseline only when browser major versions match.

## Fair comparison rules

Stock Chrome, CloakBrowser, and SlyBrowser runs should use the same host, network,
proxy policy, locale, timezone, viewport, time window, automation transport, and
browser major. Playwright-to-Playwright and Puppeteer-to-Puppeteer comparisons should
also pin their respective binding lines.
The runner records its transport, executable hashes, and versions. When browser majors
or automation transports differ, treat the result as engineering evidence rather than
a controlled parity claim.
The public comparison and kernel-update gate preserve cross-major evidence but suppress
numeric differences so a saved report cannot be mistaken for a same-major win/loss
claim.

Each run stores page text, common signals, screenshots, and structured verdicts under
ignored `artifacts/test-results`. The framework runner also captures console output
and request failures. WebDriver browser logs are opt-in. These files may expose the
test machine's IP address and fingerprint and should be handled as sensitive evidence.

Saved evidence can be recalculated after a documented methodology correction without
revisiting live pages:

```powershell
.\scripts\browser\Rescore-DetectionResults.ps1 `
  -ResultsDirectory .\artifacts\test-results\detection\live-20260815
```

Playwright and WebDriver JSON results use the same schema and can be compared, as can
an authorized CloakBrowser result captured with the same definitions:

```powershell
.\scripts\browser\Compare-DetectionResults.ps1 `
  -Results @(
    '.\artifacts\test-results\detection\playwright\slybrowser.json',
    '.\artifacts\test-results\detection\webdriver\slybrowser-webdriver.json'
  ) `
  -Output '.\artifacts\test-results\detection\transport-comparison.md'
```

The rescorer preserves captured evidence. It also migrates the two legacy semantic
mistakes supported by the saved data: runner errors with numeric zeroes become
scoreless `ERROR` results, and reCAPTCHA results whose saved score is explicitly
`null` become scoreless `EVIDENCE` rather than `FAIL`.

## Service-specific interpretation

- Google documents reCAPTCHA v3 as a server-verified score from 0.0 to 1.0; the default
  benchmark records the public demo score with a 0.7 threshold. A product release gate
  should use an owner-controlled backend and verify the expected action.
- Cloudflare requires server-side Turnstile token validation. Official dummy keys are
  suitable for functional tests but unsuitable for comparing stealth performance.
- Incolumitas publishes a behavioral score over time; the runner waits and records both
  named OK/FAIL checks and any score it can extract.
- TLS values from Peet are evidence. “Identical to Chrome” is awarded only by comparison
  with a same-major stock-browser baseline, never by hard-coding a historical JA3/JA4.

Public references: [Cloudflare Turnstile testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
[Google reCAPTCHA v3](https://developers.google.com/recaptcha/docs/v3),
[Incolumitas bot tests](https://bot.incolumitas.com/),
[Fingerprint scraping demo](https://demo.fingerprint.com/web-scraping), and
[CreepJS official repository](https://github.com/abrahamjuliot/creepjs).
