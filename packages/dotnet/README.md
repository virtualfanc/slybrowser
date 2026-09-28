# SlyBrowser for .NET

```sh
dotnet add package SlyBrowser --version 0.2.0
```

`SlyBrowserClient.LaunchAsync()` accepts the authorization file plus optional
`Profile`, `Launch`, and `Humanize` values. No import command is required. The SDK
manages release selection, verification, download, pairing, and temporary state.

```csharp
using SlyBrowser;

SlyBrowserOptions options = new()
{
    Profile = new Dictionary<string, object?> { ["locale"] = "en-US" },
    Launch = new LaunchOptions { Headless = true },
    Humanize = new HumanizeOptions { Enabled = true },
};

await using SlyWebDriverSession browser =
    await SlyBrowserClient.LaunchAsync("account.authorization.json", options);
browser.Driver.Navigate().GoToUrl("https://example.test");
```

The default path uses the matched project WebDriver and never falls back to a system
browser. `SlyBrowserClient.LaunchPlaywrightAsync()` is available when the explicit
Playwright adapter is required.

Unknown or unsupported options, failed authorization, release verification errors,
and browser/driver mismatches stop the launch. Treat the authorization file as a
credential: do not commit, log, or share it.

See the [complete SDK user API](../../docs/user-api.md) for every field and default.
