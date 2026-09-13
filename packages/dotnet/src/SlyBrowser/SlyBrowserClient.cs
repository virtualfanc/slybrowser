namespace SlyBrowser;

using Microsoft.Playwright;

/// <summary>Default .NET entry point. Explicit framework backends use SlyBrowserPlaywright.</summary>
public static class SlyBrowserClient
{
    public static Task<AuthorizedInstallation> PrepareLatestAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.PrepareLatestAuthorizedBrowserAsync(authorizationFile, settings, cancellationToken);

    public static Task<AuthorizedInstallation> PrepareAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.PrepareAuthorizedBrowserAsync(authorizationFile, settings, cancellationToken);

    public static Task<BrowserInstallation> InstallLatestAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.InstallLatestAsync(authorizationFile, settings, cancellationToken);

    public static Task<BrowserInstallation> InstallAuthorizedAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.InstallAuthorizedAsync(authorizationFile, settings, cancellationToken);

    public static Task<SlyWebDriverSession> LaunchLatestAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchLatestAsync(authorizationFile, settings, cancellationToken);

    public static Task<SlyWebDriverSession> LaunchAuthorizedAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LicensedBrowser.LaunchAuthorizedAsync(authorizationFile, settings, cancellationToken);

    public static Task<LicensedPlaywrightBrowser> LaunchLatestPlaywrightAsync(
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

    public static Task<LicensedPlaywrightBrowser> LaunchAuthorizedPlaywrightAsync(
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

    public static Task<LicensedPlaywrightContext> LaunchLatestPlaywrightPersistentAsync(
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

    public static Task<LicensedPlaywrightContext> LaunchAuthorizedPlaywrightPersistentAsync(
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

    public static Task<SlyWebDriverSession> LaunchAsync(
        string browserExecutable,
        string driverExecutable,
        string licenseEnvelope,
        CancellationToken cancellationToken = default) =>
        SlyBrowserWebDriver.LaunchAsync(
            browserExecutable,
            driverExecutable,
            licenseEnvelope,
            cancellationToken);

    public static Task<SlyWebDriverSession> LaunchAsync(
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
