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

## Install and launch the latest authorized release

`launch_latest()` reserves one plan slot, verifies the signed short lease and latest
compatible Stable manifest, downloads the protected ZIP, validates both runtime
executables and maintains a heartbeat until the browser closes.

```python
from slybrowser import launch_latest

with launch_latest(
    "account.authorization.json",
    license_trusted_keys={"license-prod-v1": license_public_key},
    release_trusted_keys={"release-prod-v1": release_public_key},
    humanize=True,
) as browser:
    print(browser.license_runtime)
    browser.get("https://example.test")
```

For the CLI, provide base64url raw 32-byte Ed25519 keys through
`SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON` and `SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON`, then
run:

```text
slybrowser install --authorization account.authorization.json [--cache DIR]
```

The authorization file is a credential and must not be committed or logged. See
`docs/authorized-release-service.md` for server deployment and release signing.
