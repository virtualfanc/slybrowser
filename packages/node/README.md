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

## Install and launch the latest authorized release

The license service returns a signed short lease and the signed newest compatible
Stable manifest. The SDK then downloads the protected ZIP, verifies the archive plus
the exact browser/WebDriver hashes, safely caches it and enforces the plan's one-session-
per-browser-process limit.

```ts
import { launchLatest } from "slybrowser";

await using browser = await launchLatest("account.authorization.json", {
  trust: {
    licenseTrustedKeys: { "license-prod-v1": licensePublicKey },
    releaseTrustedKeys: { "release-prod-v1": releasePublicKey },
  },
  humanize: true,
});

console.log(browser.licenseRuntime); // plan, limit, version and session ID
await browser.get("https://example.test");
```

The public keys are raw 32-byte Ed25519 keys. The CLI accepts them as base64url JSON in
`SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON` and `SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON`:

```text
slybrowser install --authorization account.authorization.json [--cache DIR]
```

Do not commit or log the authorization file. See
`docs/authorized-release-service.md` for the server and release workflow.
