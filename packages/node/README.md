# SlyBrowser for JavaScript

`launch()` starts the project-built W3C WebDriver shipped beside SlyBrowser. It never
uses Selenium Manager, downloads a driver, or searches for a system Chrome.

```ts
import { launch } from "slybrowser";

await using browser = await launch(browserExecutable, shortLivedLease, {
  humanize: true,
});
await browser.get("https://example.test");
console.log(await browser.title());
```

Set `driverExecutable` or `SLYBROWSER_WEBDRIVER_PATH` only when the driver is not
beside the browser during development. Production packages require the exact
hash-matched browser and driver as sibling files. Browser and driver major versions
must match, and each process consumes a separate temporary copy of the short-lived
signed lease. Humanize for this default path executes natively in Sly WebDriver;
Playwright and Puppeteer remain optional through their explicitly named launch adapters.

## Playwright and Puppeteer adapters

Both adapters force the supplied SlyBrowser executable and validate the installed
framework binding line. They never use a framework-downloaded browser or a system
Chrome fallback.

```ts
import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";
import { launchPlaywright, launchPuppeteer } from "slybrowser";

const browser = await launchPlaywright(
  { chromium }, browserExecutable, shortLivedLease,
  { frameworkVersion: "1.62.1" },
);

const puppeteerBrowser = await launchPuppeteer(
  puppeteer, browserExecutable, shortLivedLease,
  { frameworkVersion: "25.8.0" },
);
```

Use `launchPlaywrightPersistent` or `launchPuppeteerPersistent` for persistent
profiles. When `humanize: true` is set, the SDK writes a short-lived
`--sly-humanize-config` native control file for the browser process. The SDK does not
install a Playwright/Puppeteer-side movement substitute; unsupported browser builds
must fail closed at the native capability gate.

## Install and launch the latest authorized release

The license service returns a signed short lease and the signed newest compatible
Stable manifest. The SDK then downloads the protected ZIP, verifies the archive plus
the exact browser/WebDriver hashes, safely caches it and enforces the plan's one-session-
per-browser-process limit.

```ts
import { chromium } from "playwright-core";
import puppeteer from "puppeteer-core";
import { launchLatest, launchLatestPlaywright, launchLatestPuppeteer } from "slybrowser";

await using browser = await launchLatest("account.authorization.json", {
  trust: {
    licenseTrustedKeys: { "license-prod-v1": licensePublicKey },
    releaseTrustedKeys: { "release-prod-v1": releasePublicKey },
  },
  humanize: true,
});

console.log(browser.licenseRuntime); // plan, limit, version and session ID
await browser.get("https://example.test");

const playwrightBrowser = await launchLatestPlaywright(
  { chromium }, "account.authorization.json", {
    trust: {
      licenseTrustedKeys: { "license-prod-v1": licensePublicKey },
      releaseTrustedKeys: { "release-prod-v1": releasePublicKey },
    },
    frameworkVersion: "1.62.1",
  },
);

const puppeteerBrowser = await launchLatestPuppeteer(
  puppeteer, "account.authorization.json", {
    trust: {
      licenseTrustedKeys: { "license-prod-v1": licensePublicKey },
      releaseTrustedKeys: { "release-prod-v1": releasePublicKey },
    },
    frameworkVersion: "25.8.0",
  },
);
```

The authorized framework launchers reserve and release the same concurrency slot as
`launchLatest(...)`, expose `licenseRuntime.versionAudit`, and fail closed if the
framework reports a launched browser version that does not exactly match the signed
selected release. Persistent profile variants are available as
`launchLatestPlaywrightPersistent` and `launchLatestPuppeteerPersistent`.

The public keys are raw 32-byte Ed25519 keys. The CLI accepts them as base64url JSON in
`SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON` and `SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON`:

```text
slybrowser install --authorization account.authorization.json [--cache DIR] [--kernel-major 150|latest] [--update-kernel]
```

## Import a paid license file on Windows

After checkout, the billing email delivers an encrypted v2 license file. Import it
once on the Windows machine that will run SlyBrowser:

```text
set SLYBROWSER_LICENSE_FILE_PUBLIC_KEYS_JSON={"license-file-prod-v1":"BASE64URL_RAW_ED25519_PUBLIC_KEY"}
slybrowser license import --input account.slybrowser-license.json --output account.slybrowser-sealed-license.json --passphrase YOUR_PASSPHRASE
```

The sealed output uses Windows DPAPI current-user protection. It can be passed to
the same `--authorization` option and to `launchLatest(...)`/Playwright/Puppeteer
authorized launchers without providing the license-file passphrase again. The sealed
file still grants access on that Windows account, so do not commit, log, or share it.

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

Do not commit or log the authorization file. See
`docs/authorized-release-service.md` for the server and release workflow.
