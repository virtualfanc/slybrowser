# SlyBrowser for Python

The default `launch()` backend is SlyBrowser's project-built W3C WebDriver. Place
`chromedriver.exe` (`chromedriver` on Unix) beside the browser, pass
`driver_executable=...`, or set `SLYBROWSER_WEBDRIVER_PATH`.

```python
from slybrowser import launch

with launch(browser_executable, short_lived_lease, humanize=True) as browser:
    browser.get("https://example.test")
    print(browser.title)
```

The SDK never downloads or selects another driver. Install the optional Playwright
adapter with `pip install slybrowser[playwright]` and call `launch_playwright(...)`
only when that transport is explicitly required. Production packages require the exact
hash-matched browser and driver as sibling files, and each process consumes a separate
temporary copy of the short-lived signed lease. Humanize for the default path executes
natively in Sly WebDriver.

## Playwright adapter

```python
from playwright.sync_api import sync_playwright
from slybrowser import launch_playwright

with sync_playwright() as playwright:
    browser = launch_playwright(
        playwright,
        browser_executable,
        short_lived_lease,
        framework_version="1.62.0",
    )
```

The adapter forces the authorized SlyBrowser executable, rejects Playwright's own
browser path, and validates the binding line. `launch_playwright_async`,
`launch_playwright_persistent` and its async equivalent follow the same contract.
When `humanize=True` is set, the SDK writes a short-lived
`--sly-humanize-config` native control file for the browser process. The Python SDK
does not install a Playwright-side movement substitute; unsupported browser builds
must fail closed at the native capability gate.

## Install and launch the latest authorized release

`launch_latest()` reserves one plan slot, verifies the signed short lease and latest
compatible Stable manifest, downloads the protected ZIP, validates both runtime
executables and maintains a heartbeat until the browser closes.

```python
from playwright.sync_api import sync_playwright
from slybrowser import launch_latest, launch_latest_playwright

with launch_latest(
    "account.authorization.json",
    license_trusted_keys={"license-prod-v1": license_public_key},
    release_trusted_keys={"release-prod-v1": release_public_key},
    humanize=True,
) as browser:
    print(browser.license_runtime)
    browser.get("https://example.test")

with sync_playwright() as playwright:
    browser = launch_latest_playwright(
        playwright,
        "account.authorization.json",
        license_trusted_keys={"license-prod-v1": license_public_key},
        release_trusted_keys={"release-prod-v1": release_public_key},
        framework_version="1.62.0",
    )
    try:
        print(browser.license_runtime["versionAudit"])
    finally:
        browser.close()
```

The authorized Playwright launchers reserve and release the same concurrency slot as
`launch_latest(...)`, expose `license_runtime["versionAudit"]`, and fail closed if
Playwright reports a launched browser version that does not exactly match the signed
selected release. Use `launch_latest_playwright_persistent(...)`,
`launch_latest_playwright_async(...)` or
`launch_latest_playwright_persistent_async(...)` for the matching profile and runtime
style.

For the CLI, provide base64url raw 32-byte Ed25519 keys through
`SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON` and `SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON`, then
run:

```text
slybrowser install --authorization account.authorization.json [--cache DIR] [--kernel-major 150|latest] [--update-kernel]
```

## Import a paid license file on Windows

After checkout, import the encrypted v2 license file once on the Windows machine
that will run SlyBrowser:

```text
set SLYBROWSER_LICENSE_FILE_PUBLIC_KEYS_JSON={"license-file-prod-v1":"BASE64URL_RAW_ED25519_PUBLIC_KEY"}
slybrowser license import --input account.slybrowser-license.json --output account.slybrowser-sealed-license.json --passphrase YOUR_PASSPHRASE
```

The sealed file uses Windows DPAPI current-user protection and can be used anywhere
an authorization file is accepted, including `launch_latest(...)` and the authorized
Playwright helpers. You do not need to pass the license-file passphrase again, but
the sealed file is still a local credential and must not be committed, logged, or
shared.

## Redacted license diagnostics

Use `license info` when a customer needs support without exposing their credential:

```text
slybrowser license info --authorization account.slybrowser-sealed-license.json [--kernel-major 150|latest] [--update-kernel]
```

The command contacts the authorization service through `Authorization: License ...`
and prints only redacted diagnostics: plan, effective plan, paid-through time,
feature set, active/available browser-process concurrency, selected release state,
update availability and `stableErrorCode`. It does not print the license key,
session tokens, download tickets, email, PayNow identifiers, profile paths or service
access URL.

Without `--update-kernel`, the CLI keeps updates closed: it reuses the current
authorized local candidate when one exists and asks the service for an exact grant.
Use `--update-kernel` to actively move to the newest authorized Stable release in
the selected major range.

The authorization file is a credential and must not be committed or logged. See
`docs/authorized-release-service.md` for server deployment and release signing.
