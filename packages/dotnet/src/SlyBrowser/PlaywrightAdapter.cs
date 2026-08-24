using Microsoft.Playwright;

namespace SlyBrowser;

public sealed class PlaywrightLaunchSettings
{
    public object Profile { get; init; } = new Dictionary<string, object?>();
    public string? TempRoot { get; init; }
    public string? FrameworkVersion { get; init; }
    public bool Humanize { get; init; }
    public string HumanPreset { get; init; } = "default";
    public object? HumanConfig { get; init; }
    public int? HumanSeed { get; init; }
    public object? RuntimeHandoff { get; init; }
    public bool AllowRuntimeActivationTicket { get; init; }
    public string? ReleaseRoot { get; init; }
    public bool NativeReady { get; init; }
    public TimeSpan NativeReadyTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public Action<BrowserTypeLaunchOptions>? Configure { get; init; }
}

public sealed class PlaywrightPersistentLaunchSettings
{
    public object Profile { get; init; } = new Dictionary<string, object?>();
    public string? TempRoot { get; init; }
    public string? FrameworkVersion { get; init; }
    public bool Humanize { get; init; }
    public string HumanPreset { get; init; } = "default";
    public object? HumanConfig { get; init; }
    public int? HumanSeed { get; init; }
    public object? RuntimeHandoff { get; init; }
    public bool AllowRuntimeActivationTicket { get; init; }
    public string? ReleaseRoot { get; init; }
    public bool NativeReady { get; init; }
    public TimeSpan NativeReadyTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public Action<BrowserTypeLaunchPersistentContextOptions>? Configure { get; init; }
}

public static class SlyBrowserPlaywright
{
    public static async Task<IBrowser> LaunchAsync(
        IPlaywright playwright,
        string executable,
        string licenseEnvelope,
        PlaywrightLaunchSettings? settings = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(playwright);
        settings ??= new PlaywrightLaunchSettings();
        AutomationPolicy.ResolvePlaywrightVersion(settings.FrameworkVersion);
        AutomationPolicy.RequirePlaywrightHumanizeSupport(settings.Humanize);
        ValidateNativeReady(settings.NativeReady, settings.NativeReadyTimeout);

        await using LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
            executable,
            settings.Profile,
            licenseEnvelope,
            settings.TempRoot,
            humanizeControl: NativeHumanizeControl(settings.Humanize, settings.HumanPreset, settings.HumanConfig, settings.HumanSeed),
            runtimeHandoff: settings.RuntimeHandoff,
            nativeReady: settings.NativeReady,
            allowRuntimeActivationTicket: settings.AllowRuntimeActivationTicket,
            releaseRoot: string.IsNullOrWhiteSpace(settings.ReleaseRoot)
                ? SlyBrowserWebDriver.ReleaseRootFromLease(executable, licenseEnvelope)
                : settings.ReleaseRoot,
            cancellationToken: cancellationToken);
        BrowserTypeLaunchOptions options = new();
        settings.Configure?.Invoke(options);
        if (!string.IsNullOrWhiteSpace(options.ExecutablePath))
            throw new ConfigurationException(
                "The browser executable must be passed to the SlyBrowser adapter",
                "executable_option_conflict");
        options.ExecutablePath = plan.Executable;
        options.Args = plan.Arguments.Concat(options.Args ?? Array.Empty<string>()).ToArray();
        IBrowser? browser = null;
        try
        {
            browser = await playwright.Chromium.LaunchAsync(options);
            if (settings.NativeReady)
                await plan.WaitForNativeReadyAsync(settings.NativeReadyTimeout, cancellationToken);
            return browser;
        }
        catch
        {
            if (browser is not null)
            {
                try { await browser.CloseAsync(); }
                catch { /* original failure wins */ }
            }
            throw;
        }
    }

    public static async Task<IBrowserContext> LaunchPersistentContextAsync(
        IPlaywright playwright,
        string userDataDir,
        string executable,
        string licenseEnvelope,
        PlaywrightPersistentLaunchSettings? settings = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(playwright);
        settings ??= new PlaywrightPersistentLaunchSettings();
        AutomationPolicy.ResolvePlaywrightVersion(settings.FrameworkVersion);
        AutomationPolicy.RequirePlaywrightHumanizeSupport(settings.Humanize);
        ValidateNativeReady(settings.NativeReady, settings.NativeReadyTimeout);

        await using LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
            executable,
            settings.Profile,
            licenseEnvelope,
            settings.TempRoot,
            humanizeControl: NativeHumanizeControl(settings.Humanize, settings.HumanPreset, settings.HumanConfig, settings.HumanSeed),
            runtimeHandoff: settings.RuntimeHandoff,
            nativeReady: settings.NativeReady,
            allowRuntimeActivationTicket: settings.AllowRuntimeActivationTicket,
            releaseRoot: string.IsNullOrWhiteSpace(settings.ReleaseRoot)
                ? SlyBrowserWebDriver.ReleaseRootFromLease(executable, licenseEnvelope)
                : settings.ReleaseRoot,
            cancellationToken: cancellationToken);
        BrowserTypeLaunchPersistentContextOptions options = new();
        settings.Configure?.Invoke(options);
        if (!string.IsNullOrWhiteSpace(options.ExecutablePath))
            throw new ConfigurationException(
                "The browser executable must be passed to the SlyBrowser adapter",
                "executable_option_conflict");
        options.ExecutablePath = plan.Executable;
        options.Args = plan.Arguments.Concat(options.Args ?? Array.Empty<string>()).ToArray();
        IBrowserContext? context = null;
        try
        {
            context = await playwright.Chromium.LaunchPersistentContextAsync(
                Path.GetFullPath(userDataDir),
                options);
            if (settings.NativeReady)
                await plan.WaitForNativeReadyAsync(settings.NativeReadyTimeout, cancellationToken);
            return context;
        }
        catch
        {
            if (context is not null)
            {
                try { await context.CloseAsync(); }
                catch { /* original failure wins */ }
            }
            throw;
        }
    }

    private static void ValidateNativeReady(bool nativeReady, TimeSpan timeout)
    {
        if (nativeReady && timeout <= TimeSpan.Zero)
            throw new ConfigurationException("NativeReadyTimeout must be positive", "config_invalid");
    }

    private static object? NativeHumanizeControl(bool enabled, string preset, object? config, int? seed)
    {
        if (!enabled) return null;
        string selectedPreset = string.IsNullOrWhiteSpace(preset) ? "default" : preset;
        if (selectedPreset is not ("default" or "careful"))
            throw new ConfigurationException($"Unknown Humanize preset: {selectedPreset}", "humanize_preset_invalid");
        if (seed is < 0)
            throw new ConfigurationException("Native Humanize seed must be a non-negative integer", "humanize_seed_invalid");
        Dictionary<string, object?> humanize = new()
        {
            ["enabled"] = true,
            ["version"] = 1,
            ["preset"] = selectedPreset,
            ["config"] = config ?? DefaultHumanizeConfig(selectedPreset),
        };
        if (seed is not null) humanize["seed"] = seed.Value;
        return new Dictionary<string, object?>
        {
            ["schemaVersion"] = 1,
            ["kind"] = "slybrowser.native-humanize-control",
            ["backend"] = "playwright",
            ["humanize"] = humanize,
        };
    }

    private static Dictionary<string, int> DefaultHumanizeConfig(string preset)
    {
        bool careful = preset == "careful";
        return new Dictionary<string, int>
        {
            ["mouseStepsMin"] = 10,
            ["mouseStepsMax"] = 16,
            ["mouseStepDelayMin"] = careful ? 8 : 7,
            ["mouseStepDelayMax"] = careful ? 24 : 18,
            ["clickHoldMin"] = careful ? 65 : 45,
            ["clickHoldMax"] = careful ? 145 : 105,
            ["keyDelayMin"] = careful ? 55 : 35,
            ["keyDelayMax"] = careful ? 155 : 115,
            ["thinkDelayMin"] = careful ? 220 : 120,
            ["thinkDelayMax"] = careful ? 620 : 360,
        };
    }
}
