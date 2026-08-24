using System.Globalization;
using System.Text;
using System.Text.Json;
using OpenQA.Selenium;
using OpenQA.Selenium.Interactions;

namespace SlyBrowser.Tests;

public sealed class NativeHumanizeRuntimeTests
{
    [Fact]
    public async Task ScoresNativeHumanizeRuntimeWhenConfigured()
    {
        string? browser = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_BROWSER");
        string? driver = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_DRIVER");
        string? license = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_LICENSE");
        string? authorization = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE");
        string? output = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_OUTPUT");
        if (output is null || (!AuthorizationConfigured(authorization) && (browser is null || driver is null || license is null))) return;

        DateTimeOffset started = DateTimeOffset.UtcNow;
        WebDriverLaunchSettings settings = new()
        {
            Headless = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_HEADED") != "1",
            ViewportWidth = 800,
            ViewportHeight = 600,
            BrowserArguments = ["--force-device-scale-factor=2"],
            Humanize = true,
            HumanPreset = "careful",
            HumanSeed = 42424,
            CommandTimeout = TimeSpan.FromSeconds(30),
        };

        await using SlyWebDriverSession session = authorization is not null
            ? await LicensedBrowser.LaunchAuthorizedAsync(
                authorization,
                LicensedSettings(settings),
                TestContext.Current.CancellationToken)
            : await SlyBrowserWebDriver.LaunchAsync(
                browser!,
                driver!,
                await File.ReadAllTextAsync(license!, TestContext.Current.CancellationToken),
                settings,
                TestContext.Current.CancellationToken);
        IWebDriver webDriver = session.Driver;
        IJavaScriptExecutor js = (IJavaScriptExecutor)webDriver;
        webDriver.Navigate().GoToUrl(DataUrl("""
          <input id="name" style="position:absolute;left:40px;top:40px;width:240px;height:40px" onclick="window.inputClicks=(window.inputClicks||0)+1">
          <button id="target" style="position:absolute;left:420px;top:260px;width:220px;height:90px" onclick="window.clicked=(window.clicked||0)+1">Target</button>
          <iframe id="test-frame" style="position:absolute;left:80px;top:380px;width:500px;height:180px"
            srcdoc="<button id='frame-target' style='position:absolute;left:120px;top:40px;width:180px;height:70px' onclick='window.clicked=(window.clicked||0)+1'>Frame target</button>"></iframe>
        """));

        webDriver.FindElement(By.CssSelector("#name")).SendKeys("dotnet-humanize");
        webDriver.FindElement(By.CssSelector("#target")).Click();
        IReadOnlyDictionary<string, object?> geometry = AsMap(js.ExecuteScript("""
          const target = document.querySelector('#target');
          const bounding = target.getBoundingClientRect();
          const client = target.getClientRects()[0];
          return {
            dpr: devicePixelRatio,
            bounding: {x: bounding.x, y: bounding.y, width: bounding.width, height: bounding.height},
            client: {x: client.x, y: client.y, width: client.width, height: client.height},
            clicked: window.clicked || 0,
            inputClicks: window.inputClicks || 0,
            typed: document.querySelector('#name').value,
          };
        """));

        IWebElement frame = webDriver.FindElement(By.CssSelector("#test-frame"));
        webDriver.SwitchTo().Frame(frame);
        webDriver.FindElement(By.CssSelector("#frame-target")).Click();
        object? frameClicked = js.ExecuteScript("return window.clicked || 0");
        webDriver.SwitchTo().ParentFrame();
        new Actions(webDriver)
            .MoveByOffset(40, 40)
            .Pause(TimeSpan.FromMilliseconds(20))
            .MoveByOffset(140, 80)
            .Perform();

        IReadOnlyDictionary<string, bool> checks = Checks(geometry, frameClicked, "dotnet-humanize", 2);
        double score = checks.Values.Count(passed => passed) * 100.0 / checks.Count;
        Assert.Equal(100.0, score, precision: 3);

        object report = new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            status = "PASS",
            score,
            checks,
            runtime = new
            {
                dotnet = Environment.Version.ToString(),
                platform = Environment.OSVersion.Platform.ToString(),
                arch = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
            },
            matrix = new
            {
                sdk = "dotnet",
                headed = Environment.GetEnvironmentVariable("SLYBROWSER_INTEGRATION_HEADED") == "1",
                page = true,
                frame = true,
                elementClick = true,
                elementType = true,
                dpi = 2,
                commandTimeoutMs = 30_000,
            },
            geometry,
            frameClicked,
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

    private static LicensedLaunchSettings LicensedSettings(WebDriverLaunchSettings webdriver) =>
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
            Platform = "windows",
            Arch = "x64",
            UpdateKernel = false,
            WebDriver = webdriver,
        };

    private static byte[] Base64UrlDecode(string value)
    {
        string padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }

    private static IReadOnlyDictionary<string, bool> Checks(
        IReadOnlyDictionary<string, object?> geometry,
        object? frameClicked,
        string typed,
        double dpr)
    {
        IReadOnlyDictionary<string, object?> bounding = AsMap(geometry["bounding"]);
        IReadOnlyDictionary<string, object?> client = AsMap(geometry["client"]);
        bool consistent = new[] { "x", "y", "width", "height" }
            .All(name => Math.Abs(Number(bounding[name]) - Number(client[name])) <= 0.01);
        return new Dictionary<string, bool>
        {
            ["page"] = true,
            ["frame"] = Number(frameClicked) == 1,
            ["elementClick"] = Number(geometry["clicked"]) == 1,
            ["elementType"] = string.Equals(geometry["typed"]?.ToString(), typed, StringComparison.Ordinal),
            ["noPreparatoryClickForTyping"] = Number(geometry["inputClicks"]) == 0,
            ["dpi"] = Math.Abs(Number(geometry["dpr"]) - dpr) <= 0.001,
            ["geometry"] = consistent,
        };
    }

    private static IReadOnlyDictionary<string, object?> AsMap(object? value) =>
        value switch
        {
            IReadOnlyDictionary<string, object?> direct => direct,
            _ => throw new InvalidOperationException($"Expected JavaScript object map but got {value?.GetType().FullName ?? "null"}."),
        };

    private static double Number(object? value) =>
        Convert.ToDouble(value, CultureInfo.InvariantCulture);
}
