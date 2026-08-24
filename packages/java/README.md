# SlyBrowser for Java

The Java SDK keeps the project WebDriver as the product default and provides an
optional Playwright adapter for the validated Java binding line.

```java
try (SlyWebDriverSession session = SlyBrowser.launch(
    Path.of("C:/path/to/SlyBrowser.exe"),
    Path.of("C:/path/to/chromedriver.exe"),
    licenseEnvelope)) {
  session.getDriver().get("https://example.test");
}
```

The Java SDK uses Selenium's W3C client objects but starts only the exact driver path
supplied above, passes a separate one-time driver lease, and rejects any executable not
named `SlyBrowser.exe`/`chromedriver.exe`. It never invokes Selenium Manager or a
driver from `PATH`, and it rejects a session unless the full reported browser and
driver versions match. Native Humanize is carried in `sly:options` to the project
driver.

For commercial runtime delivery, use the authorized latest-release entry point. It
reads the local authorization file, reserves one concurrency slot, verifies the signed
release manifest and archive, installs the matched browser/WebDriver pair, exposes
`requested → selected → downloaded → launched` version audit metadata, and releases
the slot when the session is closed.

```java
LicensedLaunchSettings settings = new LicensedLaunchSettings();
settings.trust = new LicenseServiceClientOptions();
settings.trust.licenseTrustedKeys = licenseKeys;
settings.trust.releaseTrustedKeys = releaseKeys;

try (SlyWebDriverSession session = SlyBrowser.launchLatest(
    Path.of("C:/path/to/account.authorization.json"),
    settings)) {
  System.out.println(session.getLicenseRuntime().versionAudit.launched);
}
```

For support diagnostics without reserving a browser process, call the read-only
license info endpoint:

```java
LicenseServiceClient client = new LicenseServiceClient(
    LicenseServiceClient.readAuthorization(Path.of("account.authorization.json"), false),
    settings.trust);
LicenseInfo info = client.licenseInfo(new CreateSessionOptions());
System.out.println(info.effectivePlan + " " + info.activeSessions + "/" + info.concurrencyLimit);
```

`LicenseInfo` contains redacted plan, paid-through, feature, concurrency, selected
release, update and stable error-code fields. It does not contain the license key,
runtime tokens, download tickets, email, PayNow identifiers, profile paths or service
access URL.

Playwright is explicit:

```java
try (Playwright playwright = Playwright.create()) {
  PlaywrightLaunchSettings settings = new PlaywrightLaunchSettings();
  settings.frameworkVersion = "1.61.0";
  try (Browser browser = SlyBrowserPlaywright.launch(
      playwright,
      Path.of("C:/path/to/SlyBrowser.exe"),
      licenseEnvelope,
      settings)) {
    // Use the normal Playwright Java Browser API.
  }
}
```

The adapter always sets the authorized SlyBrowser executable and rejects an
executable supplied through Playwright options. It does not call Playwright's
browser installer and does not fall back to a system browser.
