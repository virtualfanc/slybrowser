# SlyBrowser for .NET

Project WebDriver remains the default automation backend. The optional
`Microsoft.Playwright` adapter launches only the SlyBrowser executable supplied
to it; it never invokes Playwright's browser installer or falls back to a system
browser.

```csharp
using SlyBrowser;

await using SlyWebDriverSession session = await SlyBrowserClient.LaunchAsync(
    @"C:\path\to\SlyBrowser.exe",
    @"C:\path\to\chromedriver.exe",
    licenseEnvelope);
session.Driver.Navigate().GoToUrl("https://example.test");
```

The .NET SDK uses Selenium's W3C client objects but starts the exact driver process
itself, with a separate one-time lease. Selenium Manager and `PATH` lookup are never
called. Executable names and full reported browser/driver versions must match, and
Native Humanize is sent through `sly:options` to the project driver.

Current release archives use 7z, so install `7z` (or `7zz` on Unix-like systems), or set `SLYBROWSER_7Z_PATH` to the executable before using the automatic installer.

For commercial runtime delivery, use the authorized latest-release entry point. It
reads the local authorization file, reserves one concurrency slot, verifies the signed
release manifest and archive, installs the matched browser/WebDriver pair, exposes
`requested → selected → downloaded → launched` version audit metadata, and releases
the slot when the session is disposed.

```csharp
LicensedLaunchSettings settings = new()
{
    Trust = new LicenseServiceClientOptions
    {
        LicenseTrustedKeys = licenseKeys,
        ReleaseTrustedKeys = releaseKeys,
    },
};

await using SlyWebDriverSession session =
    await SlyBrowserClient.LaunchLatestAsync(
        @"C:\path\to\account.authorization.json",
        settings);

Console.WriteLine(session.LicenseRuntime?.VersionAudit.Launched);
```

For support diagnostics without reserving a browser process, call the read-only
license info endpoint:

```csharp
LicenseAuthorization authorization =
    await LicenseServiceClient.ReadAuthorizationAsync(@"C:\path\to\account.authorization.json");
using LicenseServiceClient client = new(authorization, settings.Trust);
LicenseInfo info = await client.LicenseInfoAsync();
Console.WriteLine($"{info.EffectivePlan} {info.ActiveSessions}/{info.ConcurrencyLimit}");
```

`LicenseInfo` contains redacted plan, paid-through, feature, concurrency, selected
release, update and stable error-code fields. It does not contain the license key,
runtime tokens, download tickets, email, PayNow identifiers, profile paths or service
access URL.

Playwright is explicit:

```csharp
using Microsoft.Playwright;
using SlyBrowser;

using IPlaywright playwright = await Playwright.CreateAsync();
await using IBrowser browser = await SlyBrowserPlaywright.LaunchAsync(
    playwright,
    @"C:\path\to\SlyBrowser.exe",
    licenseEnvelope,
    new() { FrameworkVersion = "1.61.0" });
```

Persistent contexts use `SlyBrowserPlaywright.LaunchPersistentContextAsync`.
Supplying an executable through Playwright options, using an unvalidated binding
version, or requesting native Humanize before the browser advertises it produces
a fail-closed configuration error.
