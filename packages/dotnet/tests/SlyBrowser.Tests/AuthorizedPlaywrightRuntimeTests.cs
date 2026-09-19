using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Playwright;

namespace SlyBrowser.Tests;

public sealed class AuthorizedPlaywrightRuntimeTests
{
    [Fact]
    public async Task LaunchesAuthorizedPlaywrightWhenConfigured()
    {
        string? authorization = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE");
        string? output = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_OUTPUT");
        if (!AuthorizationConfigured(authorization) || output is null) return;
        if (Environment.GetEnvironmentVariable("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD") != "1") return;

        DateTimeOffset started = DateTimeOffset.UtcNow;
        bool headed = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_HEADED") == "1";
        using IPlaywright playwright = await Playwright.CreateAsync();
        await using LicensedPlaywrightBrowser runtime = await SlyBrowserClient.LaunchPlaywrightAsync(
            playwright,
            authorization!,
            new SlyBrowserOptions
            {
                Launch = new LaunchOptions { Headless = !headed },
                Humanize = new HumanizeOptions
                {
                    Enabled = true,
                    Preset = "careful",
                    Seed = 52525,
                },
            },
            TestContext.Current.CancellationToken);

        IPage page = await runtime.Browser.NewPageAsync();
        await page.GotoAsync(DataUrl("<title>sly-dotnet-playwright-ok</title><button id='target'>Target</button>"));
        Assert.Equal("sly-dotnet-playwright-ok", await page.TitleAsync());
        JsonElement signals = await page.EvaluateAsync<JsonElement>("""
        () => ({
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
          chromeType: typeof window.chrome,
          dpr: devicePixelRatio,
        })
        """);
        Assert.False(signals.TryGetProperty("webdriver", out JsonElement webdriver) && webdriver.ValueKind == JsonValueKind.True);
        Assert.Equal("object", signals.GetProperty("chromeType").GetString());

        object report = new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            status = "PASS",
            language = "dotnet",
            backend = "playwright",
            headed,
            browserVersion = runtime.LicenseRuntime.BrowserVersion,
            versionAudit = runtime.LicenseRuntime.VersionAudit,
            signals,
            durationMs = (long)(DateTimeOffset.UtcNow - started).TotalMilliseconds,
        };
        string outputPath = Path.GetFullPath(output);
        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        await File.WriteAllTextAsync(
            outputPath,
            JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }) + "\n",
            TestContext.Current.CancellationToken);
    }

    private static string DataUrl(string markup) =>
        "data:text/html;charset=utf-8;base64," + Convert.ToBase64String(Encoding.UTF8.GetBytes(markup));

    private static bool AuthorizationConfigured(string? authorization) =>
        authorization is not null;
}
