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
        await using LicensedPlaywrightBrowser runtime = await LicensedBrowser.LaunchAuthorizedPlaywrightAsync(
            playwright,
            authorization!,
            LicensedSettings(),
            new PlaywrightLaunchSettings
            {
                FrameworkVersion = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_FRAMEWORK_VERSION") ?? "1.61.0",
                Humanize = true,
                HumanPreset = "careful",
                HumanSeed = 52525,
                NativeReady = true,
                NativeReadyTimeout = TimeSpan.FromSeconds(30),
                Configure = options =>
                {
                    options.Headless = !headed;
                    options.Args = ["--window-size=900,700", "--force-device-scale-factor=1.5"];
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
        authorization is not null &&
        Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_CACHE_ROOT") is not null &&
        Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_LICENSE_KEY_ID") is not null &&
        Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX") is not null &&
        Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_RELEASE_KEY_ID") is not null &&
        Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL") is not null;

    private static LicensedLaunchSettings LicensedSettings() =>
        new()
        {
            Trust = new LicenseServiceClientOptions
            {
                LicenseTrustedKeys = new Dictionary<string, byte[]>
                {
                    [Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_LICENSE_KEY_ID")!] =
                        Convert.FromHexString(Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX")!),
                },
                ReleaseTrustedKeys = new Dictionary<string, byte[]>
                {
                    [Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_RELEASE_KEY_ID")!] =
                        Base64UrlDecode(Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL")!),
                },
            },
            Install = new InstallOptions { CacheRoot = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_CACHE_ROOT") },
            Platform = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_PLATFORM") ?? "windows",
            Arch = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_ARCH") ?? "x64",
            UpdateKernel = false,
        };

    private static byte[] Base64UrlDecode(string value)
    {
        string padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }
}
