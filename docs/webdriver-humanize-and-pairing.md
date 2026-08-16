# Native WebDriver Humanize and runtime pairing

SlyBrowser's default Python and JavaScript automation path uses the project-built W3C
WebDriver. Humanized pointer and keyboard behavior runs inside that driver rather than
being synthesized by the default SDK clients.

## W3C capability

The SDK sends a vendor capability when creating the session:

```json
{
  "sly:options": {
    "humanize": {
      "enabled": true,
      "preset": "careful",
      "config": {},
      "seed": 42424
    }
  }
}
```

`seed` is only for deterministic tests and should be omitted in normal use. The driver
returns `sly:features.humanize` in the negotiated capabilities. An SDK that requested
Humanize fails closed if that feature is not advertised; it does not silently use a
stock or older driver.

When enabled, the standard element click and element send-keys commands use trusted
browser input with a curved, non-center pointer path, bounded delays, click hold time,
per-character typing, and short thinking pauses. Explicit W3C Actions requests are not
rewritten, so callers retain exact low-level control. Playwright and Puppeteer do not
use WebDriver and therefore retain their framework adapter implementation.

The runtime regression covers Page, Frame and Element behavior at 100%, 125%, 150%
and 200% device scale, Node and Python SDK calls, covered-element recovery and a
three-second command boundary. `getClientRects()` and `getBoundingClientRect()` must
remain in the same CSS coordinate space at every scale; any mismatch blocks release.

## Why copying `chromedriver` alone does not work in production

Production Sly WebDriver uses three independent checks:

1. The requested browser executable must be the approved file name and an exact sibling
   of the running driver.
2. The browser executable SHA-256 must match the value embedded when that driver was
   built. A stock Chrome, modified browser, renamed file, or browser in another directory
   is rejected before a session starts.
3. Driver and browser each consume their own restricted, one-time temporary copy of the
   same short-lived signed lease. Copying the executable does not create an entitlement.

The sibling and hash checks stop a copied driver from being pointed at Chrome or another
browser installation. The signed lease, device binding when enabled, expiry, session ID,
and server-side concurrency/replay policy control copying the complete browser/driver
package. No purely local check can make executable bytes physically uncopyable, so
release security must not rely on obfuscation or a hard-coded secret.

Development builds intentionally default to pairing and license enforcement being off.
They remain testable locally, but they are not distributable commercial artifacts.

## Production build order

The hash must cover the exact browser file that will be packaged. Authenticode signing
changes a PE file, so use this order on Windows:

1. Build `SlyBrowser.exe` with production license enforcement and the production
   public verification key.
2. Authenticode-sign `SlyBrowser.exe`, then verify its signature.
3. Generate the pairing GN arguments from the signed browser:

   ```powershell
   .\scripts\release\Get-WebDriverPairingArgs.ps1 `
     -BrowserExecutable 'F:\chrome\src\out\release_x64\SlyBrowser.exe'
   ```

4. Put the three emitted values into the sanitized production GN configuration and
   rebuild `chromedriver` from the same Chromium checkout.
5. Authenticode-sign `chromedriver.exe`, verify both signatures, and package the exact
   signed browser file hashed in step 3 beside the signed driver.
6. On a clean machine, confirm a valid package launches and that copied, renamed,
   modified, mismatched, expired-lease, and missing-lease cases all fail closed.

Pairing-related GN arguments are:

```gn
sly_webdriver_pairing_enforcement_enabled = true
sly_webdriver_paired_browser_sha256 = "<sha256 of signed browser executable>"
sly_webdriver_paired_browser_name = "SlyBrowser.exe"
```

The private signing key and long-lived customer license key must never enter GN args,
the repository, the driver command line, or release archives.
