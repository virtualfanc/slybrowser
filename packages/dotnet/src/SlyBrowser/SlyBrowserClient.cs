namespace SlyBrowser;

using Microsoft.Playwright;

/// <summary>Default .NET entry point. Explicit framework backends use SlyBrowserPlaywright.</summary>
public static class SlyBrowserClient
{
    public static Task<SlyWebDriverSession> LaunchAsync(
        string authorizationFile,
        SlyBrowserOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new SlyBrowserOptions();
        return LicensedBrowser.LaunchLatestAsync(
            authorizationFile,
            LicensedSettings(options),
            cancellationToken);
    }

    public static Task<LicensedPlaywrightBrowser> LaunchPlaywrightAsync(
        IPlaywright playwright,
        string authorizationFile,
        SlyBrowserOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new SlyBrowserOptions();
        return LicensedBrowser.LaunchLatestPlaywrightAsync(
            playwright,
            authorizationFile,
            LicensedSettings(options),
            PlaywrightSettings(options),
            cancellationToken);
    }

    public static Task<LicensedPlaywrightContext> LaunchPlaywrightPersistentAsync(
        IPlaywright playwright,
        string userDataDirectory,
        string authorizationFile,
        SlyBrowserOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new SlyBrowserOptions();
        return LicensedBrowser.LaunchLatestPlaywrightPersistentAsync(
            playwright,
            userDataDirectory,
            authorizationFile,
            LicensedSettings(options),
            PlaywrightPersistentSettings(options),
            cancellationToken);
    }

    private static LicensedLaunchSettings LicensedSettings(SlyBrowserOptions options)
    {
        Validate(options);
        return new()
        {
        UpdateKernel = options.Launch.UpdateKernel,
        WebDriver = new WebDriverLaunchSettings
        {
            Profile = options.Profile,
            Headless = options.Launch.Headless,
            ProfileMode = options.Launch.ProfileMode,
            ProfileDirectory = options.Launch.ProfileDirectory,
            Humanize = options.Humanize.Enabled,
            HumanPreset = options.Humanize.Preset,
            HumanSeed = options.Humanize.Seed,
            HumanConfig = options.Humanize.Config,
        },
        };
    }

    private static PlaywrightLaunchSettings PlaywrightSettings(SlyBrowserOptions options)
    {
        Validate(options);
        return new()
        {
        Profile = options.Profile,
        Humanize = options.Humanize.Enabled,
        HumanPreset = options.Humanize.Preset,
        HumanSeed = options.Humanize.Seed,
        HumanConfig = options.Humanize.Config,
        Configure = value => value.Headless = options.Launch.Headless,
        };
    }

    private static PlaywrightPersistentLaunchSettings PlaywrightPersistentSettings(SlyBrowserOptions options)
    {
        Validate(options);
        return new()
        {
        Profile = options.Profile,
        Humanize = options.Humanize.Enabled,
        HumanPreset = options.Humanize.Preset,
        HumanSeed = options.Humanize.Seed,
        HumanConfig = options.Humanize.Config,
        Configure = value => value.Headless = options.Launch.Headless,
        };
    }

    private static void Validate(SlyBrowserOptions options)
    {
        if (options.Profile is null || options.Launch is null || options.Humanize is null)
            throw new ConfigurationException("Profile, Launch and Humanize must be objects", "launch_options_invalid");
        if (options.Launch.ProfileMode is not ("ephemeral" or "persistent"))
            throw new ConfigurationException("Launch.ProfileMode must be ephemeral or persistent", "launch_options_invalid");
        if (options.Humanize.Preset is not ("default" or "careful"))
            throw new ConfigurationException("Humanize.Preset must be default or careful", "humanize_preset_invalid");
    }

    internal static Task<AuthorizedInstallation> PrepareLatestAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.PrepareLatestAuthorizedBrowserAsync(authorizationFile, settings, cancellationToken);

    internal static Task<AuthorizedInstallation> PrepareAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.PrepareAuthorizedBrowserAsync(authorizationFile, settings, cancellationToken);

    internal static Task<BrowserInstallation> InstallLatestAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.InstallLatestAsync(authorizationFile, settings, cancellationToken);

    internal static Task<BrowserInstallation> InstallAuthorizedAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.InstallAuthorizedAsync(authorizationFile, settings, cancellationToken);

    internal static Task<SlyWebDriverSession> LaunchLatestAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchLatestAsync(authorizationFile, settings, cancellationToken);

    internal static Task<SlyWebDriverSession> LaunchAuthorizedAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchAuthorizedAsync(authorizationFile, settings, cancellationToken);

    internal static Task<LicensedPlaywrightBrowser> LaunchLatestPlaywrightAsync(
        IPlaywright playwright,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchLatestPlaywrightAsync(
            playwright,
            authorizationFile,
            settings,
            playwrightSettings,
            cancellationToken);

    internal static Task<LicensedPlaywrightBrowser> LaunchAuthorizedPlaywrightAsync(
        IPlaywright playwright,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchAuthorizedPlaywrightAsync(
            playwright,
            authorizationFile,
            settings,
            playwrightSettings,
            cancellationToken);

    internal static Task<LicensedPlaywrightContext> LaunchLatestPlaywrightPersistentAsync(
        IPlaywright playwright,
        string userDataDir,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightPersistentLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchLatestPlaywrightPersistentAsync(
            playwright,
            userDataDir,
            authorizationFile,
            settings,
            playwrightSettings,
            cancellationToken);

    internal static Task<LicensedPlaywrightContext> LaunchAuthorizedPlaywrightPersistentAsync(
        IPlaywright playwright,
        string userDataDir,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightPersistentLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchAuthorizedPlaywrightPersistentAsync(
            playwright,
            userDataDir,
            authorizationFile,
            settings,
            playwrightSettings,
            cancellationToken);

    internal static Task<SlyWebDriverSession> LaunchAsync(
        string browserExecutable,
        string driverExecutable,
        string licenseEnvelope,
        CancellationToken cancellationToken = default) =>
        SlyBrowserWebDriver.LaunchAsync(
            browserExecutable,
            driverExecutable,
            licenseEnvelope,
            cancellationToken);

    internal static Task<SlyWebDriverSession> LaunchAsync(
        string browserExecutable,
        string driverExecutable,
        string licenseEnvelope,
        WebDriverLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        SlyBrowserWebDriver.LaunchAsync(
            browserExecutable,
            driverExecutable,
            licenseEnvelope,
            settings,
            cancellationToken);
}
