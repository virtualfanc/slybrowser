using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;
using OpenQA.Selenium.Remote;

namespace SlyBrowser;

public static class SlyBrowserWebDriver
{
    private const int MaxLicenseBytes = 64 * 1024;
    private const int MaxRuntimeBytes = 64 * 1024;

    public static Task<SlyWebDriverSession> LaunchAsync(
        string browserExecutable,
        string driverExecutable,
        string licenseEnvelope,
        CancellationToken cancellationToken = default) =>
        LaunchAsync(browserExecutable, driverExecutable, licenseEnvelope, new WebDriverLaunchSettings(), cancellationToken);

    public static async Task<SlyWebDriverSession> LaunchAsync(
        string browserExecutable,
        string driverExecutable,
        string licenseEnvelope,
        WebDriverLaunchSettings settings,
        CancellationToken cancellationToken = default)
    {
        string browser = RequireExecutable(browserExecutable, "SlyBrowser.exe", "browser");
        string driverPath = RequireExecutable(driverExecutable, "chromedriver.exe", "driver");
        ValidateSettings(settings);
        string root = Path.GetFullPath(settings.TempRoot ?? Path.GetTempPath());
        Directory.CreateDirectory(root);
        string? releaseRoot = string.IsNullOrWhiteSpace(settings.ReleaseRoot)
            ? ReleaseRootFromLease(browser, licenseEnvelope)
            : Path.GetFullPath(settings.ReleaseRoot);
        string driverLicense = await WriteDriverLicenseAsync(root, licenseEnvelope, cancellationToken);
        string? driverRuntime = null;
        LaunchPlan? plan = null;
        Process? process = null;
        RemoteWebDriver? driver = null;
        Uri? serviceUrl = null;
        try
        {
            plan = await SlyBrowserLauncher.PrepareAsync(
                browser,
                settings.Profile,
                licenseEnvelope,
                settings.TempRoot,
                extraArguments: BuildBrowserArguments(settings),
                runtimeHandoff: settings.RuntimeHandoff,
                nativeReady: settings.NativeReady,
                allowRuntimeActivationTicket: settings.AllowRuntimeActivationTicket,
                releaseRoot: releaseRoot,
                cancellationToken: cancellationToken);
            driverRuntime = await WriteDriverRuntimeAsync(
                root,
                settings.DriverRuntimeHandoff ?? settings.RuntimeHandoff,
                settings.AllowRuntimeActivationTicket,
                cancellationToken);
            int port = FreeLoopbackPort();
            process = StartDriver(driverPath, port, driverLicense, driverRuntime, releaseRoot);
            serviceUrl = new($"http://127.0.0.1:{port}/");
            await WaitForDriverAsync(serviceUrl, process, settings.DriverStartTimeout, cancellationToken);
            ChromeOptions options = BuildChromeOptions(plan, settings);
            driver = new RemoteWebDriver(serviceUrl, options.ToCapabilities(), settings.CommandTimeout);
            (string browserVersion, string driverVersion) = RequireExactPair(driver.Capabilities);
            driver.Manage().Timeouts().PageLoad = settings.CommandTimeout;
            driver.Manage().Timeouts().AsynchronousJavaScript = settings.CommandTimeout;
            driver.Manage().Timeouts().ImplicitWait = TimeSpan.Zero;
            if (settings.NativeReady)
                await plan.WaitForNativeReadyAsync(settings.NativeReadyTimeout, cancellationToken);
            return new SlyWebDriverSession(driver, process, serviceUrl, plan, driverLicense, driverRuntime, browserVersion, driverVersion);
        }
        catch
        {
            try { driver?.Quit(); } catch (WebDriverException) { }
            driver?.Dispose();
            if (serviceUrl is not null) SlyWebDriverSession.RequestShutdown(serviceUrl);
            SlyWebDriverSession.StopProcess(process);
            process?.Dispose();
            if (plan is not null) await plan.DisposeAsync();
            SlyWebDriverSession.TryDelete(driverRuntime);
            SlyWebDriverSession.TryDelete(driverLicense);
            throw;
        }
    }

    internal static ChromeOptions BuildChromeOptions(LaunchPlan plan, WebDriverLaunchSettings settings)
    {
        ChromeOptions options = new()
        {
            BinaryLocation = plan.Executable,
            AcceptInsecureCertificates = false,
        };
        options.AddArguments(plan.Arguments);
        options.AddExcludedArguments(settings.ExcludedSwitches);
        Dictionary<string, object> humanize = new()
        {
            ["enabled"] = settings.Humanize,
            ["preset"] = settings.HumanPreset,
        };
        if (settings.HumanConfig is not null) humanize["config"] = settings.HumanConfig;
        if (settings.HumanSeed is not null) humanize["seed"] = settings.HumanSeed.Value;
        options.AddAdditionalOption("sly:options", new Dictionary<string, object> { ["humanize"] = humanize });
        return options;
    }

    private static IEnumerable<string> BuildBrowserArguments(WebDriverLaunchSettings settings)
    {
        List<string> arguments = ["--no-first-run", "--no-default-browser-check", .. settings.BrowserArguments];
        if (settings.Headless && !arguments.Any(value => value.StartsWith("--headless", StringComparison.Ordinal)))
            arguments.Add("--headless=new");
        if (!arguments.Any(value => value.StartsWith("--window-size", StringComparison.Ordinal)))
            arguments.Add($"--window-size={settings.ViewportWidth},{settings.ViewportHeight}");
        if (settings.ProfileDirectory is not null &&
            !arguments.Any(value => value.StartsWith("--user-data-dir", StringComparison.Ordinal)))
            arguments.Add($"--user-data-dir={Path.GetFullPath(settings.ProfileDirectory)}");
        return arguments;
    }

    private static void ValidateSettings(WebDriverLaunchSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        if (settings.DriverStartTimeout < TimeSpan.FromSeconds(1) || settings.CommandTimeout < TimeSpan.FromSeconds(1))
            throw new ConfigurationException("WebDriver timeouts must be at least 1000 milliseconds", "config_invalid");
        if (settings.NativeReady && settings.NativeReadyTimeout <= TimeSpan.Zero)
            throw new ConfigurationException("NativeReadyTimeout must be positive", "config_invalid");
        if (settings.ViewportWidth < 320 || settings.ViewportHeight < 240)
            throw new ConfigurationException("WebDriver viewport is invalid", "config_invalid");
        string mode = settings.ProfileMode ?? (settings.ProfileDirectory is null ? "ephemeral" : "persistent");
        if (mode == "persistent" && settings.ProfileDirectory is null)
            throw new ConfigurationException("Persistent profile mode requires ProfileDirectory", "persistent_profile_dir_required");
        if (mode == "ephemeral" && settings.ProfileDirectory is not null)
            throw new ConfigurationException("Ephemeral profile mode cannot use ProfileDirectory", "ephemeral_profile_dir_forbidden");
        if (mode is not ("ephemeral" or "persistent"))
            throw new ConfigurationException($"Unsupported profile mode: {mode}", "config_invalid");
    }

    internal static string? DeriveReleaseRoot(string browserExecutable, string? artifactBrowserExecutable)
    {
        if (string.IsNullOrWhiteSpace(artifactBrowserExecutable)) return null;
        string[] expectedParts = artifactBrowserExecutable
            .Replace('\\', '/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (expectedParts.Length == 0) return null;

        string? current = Path.GetFullPath(browserExecutable);
        for (int index = expectedParts.Length - 1; index >= 0; index--)
        {
            if (string.IsNullOrWhiteSpace(current)) return null;
            string currentName = Path.GetFileName(current.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (!string.Equals(currentName, expectedParts[index], StringComparison.OrdinalIgnoreCase))
                return null;
            current = Path.GetDirectoryName(current);
        }
        return string.IsNullOrWhiteSpace(current) ? null : Path.GetFullPath(current);
    }

    internal static string? ReleaseRootFromLease(string browserExecutable, string licenseEnvelope)
    {
        try
        {
            using JsonDocument envelope = JsonDocument.Parse(licenseEnvelope);
            JsonElement root = envelope.RootElement;
            if (!root.TryGetProperty("payload", out JsonElement payloadElement) ||
                payloadElement.ValueKind != JsonValueKind.String)
                return null;
            string? payload = payloadElement.GetString();
            if (string.IsNullOrWhiteSpace(payload)) return null;

            using JsonDocument claims = JsonDocument.Parse(CanonicalJson.DecodeBase64Url(payload, MaxLicenseBytes));
            if (!claims.RootElement.TryGetProperty("artifact", out JsonElement artifact) ||
                artifact.ValueKind != JsonValueKind.Object ||
                !artifact.TryGetProperty("browserExecutable", out JsonElement executableElement) ||
                executableElement.ValueKind != JsonValueKind.String)
                return null;
            return DeriveReleaseRoot(browserExecutable, executableElement.GetString());
        }
        catch (Exception exception) when (exception is ArgumentException or FormatException or JsonException)
        {
            return null;
        }
    }

    private static string RequireExecutable(string value, string expectedName, string kind)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ConfigurationException($"{kind} executable is required", $"{kind}_missing");
        string path = Path.GetFullPath(value);
        if (!File.Exists(path))
            throw new ConfigurationException($"{kind} executable does not exist", $"{kind}_missing");
        if (!string.Equals(Path.GetFileName(path), expectedName, StringComparison.OrdinalIgnoreCase))
            throw new ConfigurationException(
                $"Expected the project {kind} executable named {expectedName}",
                $"{kind}_executable_invalid");
        return path;
    }

    private static async Task<string> WriteDriverLicenseAsync(
        string root,
        string envelope,
        CancellationToken cancellationToken)
    {
        byte[] payload = Encoding.UTF8.GetBytes(envelope ?? string.Empty);
        if (payload.Length is 0 or > MaxLicenseBytes)
            throw new ConfigurationException("License lease is missing or too large", "license_invalid_envelope");
        string path = Path.Combine(root, $"sly-driver-license-{Guid.NewGuid():N}.json");
        await using (FileStream stream = new(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough | FileOptions.Asynchronous))
        {
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await stream.WriteAsync(payload, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            stream.Flush(true);
        }
        SecureHandoffFiles.RestrictWindowsAcl(path);
        return path;
    }

    private static async Task<string?> WriteDriverRuntimeAsync(
        string root,
        object? runtimeHandoff,
        bool allowRuntimeActivationTicket,
        CancellationToken cancellationToken)
    {
        if (runtimeHandoff is null) return null;
        byte[] payload = SlyBrowserLauncher.SerializeRuntimeHandoff(runtimeHandoff, allowRuntimeActivationTicket);
        if (payload.Length is 0 or > MaxRuntimeBytes)
            throw new ConfigurationException("Runtime handoff file is missing or too large", "runtime_handoff_invalid");
        string path = Path.Combine(root, $"sly-driver-runtime-{Guid.NewGuid():N}.json");
        await using (FileStream stream = new(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough | FileOptions.Asynchronous))
        {
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await stream.WriteAsync(payload, cancellationToken);
            await stream.FlushAsync(cancellationToken);
            stream.Flush(true);
        }
        SecureHandoffFiles.RestrictWindowsAcl(path);
        return path;
    }

    private static int FreeLoopbackPort()
    {
        TcpListener listener = new(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static Process StartDriver(string executable, int port, string licenseFile, string? runtimeFile, string? releaseRoot)
    {
        ProcessStartInfo start = new()
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add($"--port={port}");
        start.ArgumentList.Add("--allowed-ips=");
        start.ArgumentList.Add($"--sly-license-file={licenseFile}");
        if (runtimeFile is not null) start.ArgumentList.Add($"--sly-runtime-file={runtimeFile}");
        if (releaseRoot is not null) start.ArgumentList.Add($"--sly-release-root={Path.GetFullPath(releaseRoot)}");
        Process process = new() { StartInfo = start, EnableRaisingEvents = true };
        if (!process.Start())
            throw new ConfigurationException("Unable to start project WebDriver", "webdriver_start_failed");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static async Task WaitForDriverAsync(
        Uri serviceUrl,
        Process process,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using HttpClient client = new() { Timeout = TimeSpan.FromSeconds(1) };
        DateTimeOffset deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (process.HasExited)
                throw new ConfigurationException("Project WebDriver exited before becoming ready", "webdriver_start_failed");
            try
            {
                using HttpResponseMessage response = await client.GetAsync(new Uri(serviceUrl, "status"), cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    using JsonDocument document = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(cancellationToken));
                    JsonElement root = document.RootElement;
                    if (root.TryGetProperty("value", out JsonElement value)) root = value;
                    if (root.TryGetProperty("ready", out JsonElement ready) && ready.ValueKind == JsonValueKind.True) return;
                }
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { }
            await Task.Delay(100, cancellationToken);
        }
        throw new ConfigurationException("Project WebDriver did not become ready", "webdriver_start_timeout");
    }

    private static (string BrowserVersion, string DriverVersion) RequireExactPair(ICapabilities capabilities)
    {
        string browserVersion = capabilities.GetCapability("browserVersion")?.ToString() ?? string.Empty;
        string driverVersion = ChromeDriverVersion(capabilities.GetCapability("chrome"));
        if (browserVersion.Length == 0 || driverVersion.Length == 0)
            throw new ConfigurationException("Project WebDriver did not report exact versions", "webdriver_version_missing");
        if (!string.Equals(browserVersion, driverVersion, StringComparison.Ordinal))
            throw new ConfigurationException(
                "SlyBrowser and project WebDriver versions do not match",
                "webdriver_version_mismatch");
        return (browserVersion, driverVersion);
    }

    private static string ChromeDriverVersion(object? chrome)
    {
        object? value = chrome switch
        {
            IReadOnlyDictionary<string, object> dictionary when dictionary.TryGetValue("chromedriverVersion", out object? item) => item,
            IDictionary<string, object> dictionary when dictionary.TryGetValue("chromedriverVersion", out object? item) => item,
            JsonElement element when element.ValueKind == JsonValueKind.Object && element.TryGetProperty("chromedriverVersion", out JsonElement item) => item.ToString(),
            _ => null,
        };
        return value?.ToString()?.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? string.Empty;
    }
}
