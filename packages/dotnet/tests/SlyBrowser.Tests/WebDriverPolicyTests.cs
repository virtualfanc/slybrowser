using OpenQA.Selenium;

namespace SlyBrowser.Tests;

public sealed class WebDriverPolicyTests
{
    private static string NativeBrowserName => OperatingSystem.IsWindows() ? "SlyBrowser.exe"
        : OperatingSystem.IsMacOS() ? "SlyBrowser" : "chrome";
    private static string NativeDriverName => OperatingSystem.IsWindows() ? "chromedriver.exe" : "chromedriver";

    [Fact]
    public async Task AcceptsNativeProjectNamesBeforeValidatingSettings()
    {
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-native-names-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string browser = Path.Combine(root, NativeBrowserName);
            string driver = Path.Combine(root, NativeDriverName);
            await File.WriteAllTextAsync(browser, string.Empty, TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(driver, string.Empty, TestContext.Current.CancellationToken);
            WebDriverLaunchSettings settings = new() { DriverStartTimeout = TimeSpan.FromMilliseconds(1) };
            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserWebDriver.LaunchAsync(browser, driver, "{}", settings, TestContext.Current.CancellationToken));
            Assert.Equal("config_invalid", error.Code);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
    [Fact]
    public async Task AppliesNativeCasePolicyToBothExecutables()
    {
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-native-case-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string browser = Path.Combine(root, NativeBrowserName.ToUpperInvariant());
            string driver = Path.Combine(root, NativeDriverName.ToUpperInvariant());
            await File.WriteAllTextAsync(browser, string.Empty, TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(driver, string.Empty, TestContext.Current.CancellationToken);
            WebDriverLaunchSettings settings = new() { DriverStartTimeout = TimeSpan.FromMilliseconds(1) };
            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserWebDriver.LaunchAsync(browser, driver, "{}", settings, TestContext.Current.CancellationToken));
            if (OperatingSystem.IsWindows()) Assert.Equal("config_invalid", error.Code);
            else
            {
                Assert.Equal("browser_executable_invalid", error.Code);
                string nativeBrowser = Path.Combine(root, NativeBrowserName);
                await File.WriteAllTextAsync(nativeBrowser, string.Empty, TestContext.Current.CancellationToken);
                error = await Assert.ThrowsAsync<ConfigurationException>(
                    () => SlyBrowserWebDriver.LaunchAsync(nativeBrowser, driver, "{}", settings, TestContext.Current.CancellationToken));
                Assert.Equal("driver_executable_invalid", error.Code);
            }
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task RejectsNonProjectExecutableNamesBeforeStartingAnything()
    {
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-webdriver-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string browser = Path.Combine(root, "chrome.exe");
            string driver = Path.Combine(root, "system-driver.exe");
            await File.WriteAllTextAsync(browser, string.Empty, TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(driver, string.Empty, TestContext.Current.CancellationToken);
            ConfigurationException browserError = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserWebDriver.LaunchAsync(browser, driver, "{}", TestContext.Current.CancellationToken));
            Assert.Equal("browser_executable_invalid", browserError.Code);

            string slyBrowser = Path.Combine(root, NativeBrowserName);
            await File.WriteAllTextAsync(slyBrowser, string.Empty, TestContext.Current.CancellationToken);
            ConfigurationException driverError = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserWebDriver.LaunchAsync(slyBrowser, driver, "{}", TestContext.Current.CancellationToken));
            Assert.Equal("driver_executable_invalid", driverError.Code);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task BuildsNativeHumanizeCapabilityWithoutFrameworkSubstitution()
    {
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-webdriver-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string browser = Path.Combine(root, "SlyBrowser.exe");
            await File.WriteAllTextAsync(browser, string.Empty, TestContext.Current.CancellationToken);
            await using LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
                browser,
                new { },
                "{}",
                root,
                cancellationToken: TestContext.Current.CancellationToken);
            WebDriverLaunchSettings settings = new()
            {
                Humanize = true,
                HumanPreset = "careful",
                HumanSeed = 42424,
            };
            ICapabilities capabilities = SlyBrowserWebDriver.BuildChromeOptions(plan, settings).ToCapabilities();
            IReadOnlyDictionary<string, object> sly = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object>>(
                capabilities.GetCapability("sly:options"));
            IReadOnlyDictionary<string, object> humanize = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object>>(
                sly["humanize"]);
            Assert.Equal(true, humanize["enabled"]);
            Assert.Equal("careful", humanize["preset"]);
            Assert.Equal(42424, humanize["seed"]);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task RejectsRuntimeHandoffSecretsBeforeStartingProjectWebDriver()
    {
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-webdriver-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string browser = Path.Combine(root, NativeBrowserName);
            string driver = Path.Combine(root, NativeDriverName);
            await File.WriteAllTextAsync(browser, string.Empty, TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(driver, string.Empty, TestContext.Current.CancellationToken);
            WebDriverLaunchSettings settings = new()
            {
                RuntimeHandoff = new { schemaVersion = 2, downloadTicket = "service-only" },
            };

            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserWebDriver.LaunchAsync(
                    browser,
                    driver,
                    "{\"lease\":\"test\"}",
                    settings,
                    TestContext.Current.CancellationToken));
            Assert.Equal("runtime_handoff_secret_forbidden", error.Code);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void DerivesReleaseRootFromSignedArtifactPath()
    {
        string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), $"sly-dotnet-webdriver-{Guid.NewGuid():N}"));
        string browser = Path.Combine(root, "SlyBrowser", "SlyBrowser.exe");
        Assert.Equal(root, SlyBrowserWebDriver.DeriveReleaseRoot(browser, "SlyBrowser/SlyBrowser.exe"));
        Assert.Null(SlyBrowserWebDriver.DeriveReleaseRoot(browser, "OtherBrowser/SlyBrowser.exe"));
    }
}
