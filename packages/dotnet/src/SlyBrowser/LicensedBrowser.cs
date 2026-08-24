using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace SlyBrowser;

public sealed record BrowserVersionAudit(
    string? Requested,
    string Selected,
    string Downloaded,
    string Launched,
    string Policy,
    string SelectionReason);

public sealed record LicenseRuntimeMetadata(
    string SessionId,
    string Plan,
    int ConcurrencyLimit,
    string BrowserVersion,
    string VersionPolicy,
    string SelectionReason,
    BrowserVersionAudit VersionAudit);

public sealed class LicensedLaunchSettings
{
    public required LicenseServiceClientOptions Trust { get; init; }
    public InstallOptions Install { get; init; } = new();
    public string? Platform { get; init; }
    public string? Arch { get; init; }
    public string? DeviceHash { get; init; }
    public string? KernelMajor { get; init; }
    public bool? UpdateKernel { get; init; }
    public string? BrowserVersion { get; init; }
    public string? VersionPolicy { get; init; }
    public WebDriverLaunchSettings WebDriver { get; init; } = new();
}

public sealed class LicensedPlaywrightBrowser : IAsyncDisposable
{
    private readonly IBrowser _browser;
    private readonly Func<ValueTask> _release;
    private bool _released;

    internal LicensedPlaywrightBrowser(
        IBrowser browser,
        LicenseRuntimeMetadata licenseRuntime,
        Func<ValueTask> release)
    {
        _browser = browser;
        LicenseRuntime = licenseRuntime;
        _release = release;
    }

    public IBrowser Browser => _browser;
    public LicenseRuntimeMetadata LicenseRuntime { get; }

    public async ValueTask DisposeAsync()
    {
        Exception? failure = null;
        try
        {
            await _browser.CloseAsync();
        }
        catch (Exception exception)
        {
            failure = exception;
        }
        if (!_released)
        {
            _released = true;
            try
            {
                await _release();
            }
            catch (Exception exception)
            {
                if (failure is null) failure = exception;
                else failure = new AggregateException(failure, exception);
            }
        }
        if (failure is not null) throw failure;
    }
}

public sealed class LicensedPlaywrightContext : IAsyncDisposable
{
    private readonly IBrowserContext _context;
    private readonly Func<ValueTask> _release;
    private bool _released;

    internal LicensedPlaywrightContext(
        IBrowserContext context,
        LicenseRuntimeMetadata licenseRuntime,
        Func<ValueTask> release)
    {
        _context = context;
        LicenseRuntime = licenseRuntime;
        _release = release;
    }

    public IBrowserContext Context => _context;
    public LicenseRuntimeMetadata LicenseRuntime { get; }

    public async ValueTask DisposeAsync()
    {
        Exception? failure = null;
        try
        {
            await _context.CloseAsync();
        }
        catch (Exception exception)
        {
            failure = exception;
        }
        if (!_released)
        {
            _released = true;
            try
            {
                await _release();
            }
            catch (Exception exception)
            {
                if (failure is null) failure = exception;
                else failure = new AggregateException(failure, exception);
            }
        }
        if (failure is not null) throw failure;
    }
}

public sealed class AuthorizedInstallation : IAsyncDisposable
{
    private bool _released;

    internal AuthorizedInstallation(
        LicenseServiceClient client,
        RuntimeSessionGrant grant,
        BrowserInstallation installation)
    {
        Client = client;
        Grant = grant;
        Installation = installation;
    }

    public LicenseServiceClient Client { get; }
    public RuntimeSessionGrant Grant { get; }
    public BrowserInstallation Installation { get; }

    public async ValueTask ReleaseAsync(CancellationToken cancellationToken = default)
    {
        if (_released) return;
        _released = true;
        await Client.ReleaseRuntimeSessionAsync(Grant, cancellationToken);
    }

    public async ValueTask DisposeAsync() => await ReleaseAsync();
}

public static class LicensedBrowser
{
    public static BrowserVersionAudit VerifyBrowserVersionAudit(BrowserVersionAudit audit)
    {
        if (audit.Downloaded != audit.Selected || audit.Launched != audit.Selected)
            throw new ArtifactException(
                $"Browser version chain mismatch: selected={audit.Selected}, downloaded={audit.Downloaded}, launched={audit.Launched}",
                "browser_version_chain_mismatch");
        if (audit.Policy == "latest" && audit.Requested is not null ||
            audit.Policy == "exact" && audit.Requested != audit.Selected ||
            audit.Policy == "at-or-before" && (audit.Requested is null ||
                ReleaseManifestVerifier.CompareVersion(audit.Selected, audit.Requested) > 0))
            throw new ArtifactException("Requested and selected browser versions violate the declared policy", "browser_version_policy_mismatch");
        return audit;
    }

    public static async Task<AuthorizedInstallation> PrepareLatestAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        await PrepareLatestAuthorizedBrowserAsync(
            authorizationFile,
            settings,
            AutomationBackend.ProjectWebDriver,
            cancellationToken);

    private static async Task<AuthorizedInstallation> PrepareLatestAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        AutomationBackend automationBackend,
        CancellationToken cancellationToken = default)
    {
        LicenseAuthorization authorization = await LicenseServiceClient.ReadAuthorizationAsync(
            authorizationFile,
            new LicenseFileReadOptions
            {
                AllowInsecureLocalhost = settings.Trust.AllowInsecureLocalhost,
                LicenseFilePassphrase = settings.Trust.LicenseFilePassphrase,
                LicenseFileTrustedKeys = settings.Trust.LicenseFileTrustedKeys,
                TrustedServiceUrls = settings.Trust.TrustedServiceUrls,
            },
            cancellationToken);
        LicenseServiceClient client = new(authorization, settings.Trust);
        bool updateKernel = settings.UpdateKernel ?? true;
        BrowserInstallation? current = !updateKernel && settings.BrowserVersion is null && settings.VersionPolicy is null
            ? await BrowserInstaller.FindCurrentBrowserInstallationAsync(
                settings.Install,
                settings.Platform,
                settings.Arch,
                settings.KernelMajor,
                cancellationToken)
            : null;
        RuntimeSessionGrant grant;
        try
        {
            grant = await client.CreateRuntimeSessionAsync(
                new CreateRuntimeSessionOptions
                {
                    Platform = settings.Platform,
                    Arch = settings.Arch,
                    AutomationBackend = automationBackend,
                    DeviceHash = settings.DeviceHash,
                    KernelMajor = settings.KernelMajor,
                    UpdateKernel = updateKernel,
                    BrowserVersion = current?.Version ?? settings.BrowserVersion,
                    VersionPolicy = current is null ? settings.VersionPolicy : "exact",
                },
                cancellationToken);
        }
        catch (LicenseServiceException exception) when (current is not null && exception.Code == "release_version_unavailable")
        {
            throw new LicenseServiceException(
                "The current local browser release was withdrawn; update is required before continuing",
                "kernel_update_required",
                409,
                exception);
        }
        try
        {
            await using BootstrapHeartbeatController heartbeat = new(client, grant);
            heartbeat.Start();
            BrowserInstallation installation = await BrowserInstaller.InstallGrantedBrowserAsync(
                client,
                grant,
                settings.Install,
                cancellationToken);
            if (heartbeat.Failure is not null &&
                grant.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30)
                throw heartbeat.Failure;
            return new AuthorizedInstallation(client, grant, installation);
        }
        catch
        {
            try { await client.ReleaseRuntimeSessionAsync(grant, cancellationToken); }
            catch { /* original failure wins */ }
            throw;
        }
    }

    public static Task<AuthorizedInstallation> PrepareAuthorizedBrowserAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        PrepareLatestAuthorizedBrowserAsync(
            authorizationFile,
            WithDefaultUpdateKernel(settings, false),
            cancellationToken);

    public static async Task<BrowserInstallation> InstallLatestAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default)
    {
        await using AuthorizedInstallation authorized = await PrepareLatestAuthorizedBrowserAsync(
            authorizationFile,
            settings,
            cancellationToken);
        return authorized.Installation;
    }

    public static Task<BrowserInstallation> InstallAuthorizedAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        InstallLatestAsync(authorizationFile, WithDefaultUpdateKernel(settings, false), cancellationToken);

    public static async Task<SlyWebDriverSession> LaunchLatestAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default)
    {
        AuthorizedInstallation authorized = await PrepareLatestAuthorizedBrowserAsync(
            authorizationFile,
            settings,
            cancellationToken);
        BrowserInstallationReference? reference = null;
        SlyWebDriverSession? session = null;
        await using BootstrapHeartbeatController heartbeat = new(authorized.Client, authorized.Grant);
        try
        {
            heartbeat.Start();
            reference = await BrowserInstaller.AcquireBrowserInstallationReferenceAsync(authorized.Installation, cancellationToken);
            session = await SlyBrowserWebDriver.LaunchAsync(
                authorized.Installation.BrowserExecutable,
                authorized.Installation.DriverExecutable,
                authorized.Grant.LeaseEnvelope,
                WithRuntimeHandoff(
                    settings.WebDriver,
                    RuntimeBootstrapHandoff(authorized.Client, authorized.Grant, settings.WebDriver.RuntimeHandoff),
                    DriverRuntimeBootstrapHandoff(authorized.Client, authorized.Grant, settings.WebDriver.DriverRuntimeHandoff)),
                cancellationToken);
            BrowserVersionAudit audit = VerifyBrowserVersionAudit(new BrowserVersionAudit(
                authorized.Grant.RequestedBrowserVersion,
                authorized.Grant.BrowserVersion,
                authorized.Installation.Version,
                session.BrowserVersion,
                authorized.Grant.VersionPolicy,
                authorized.Grant.SelectionReason));
            session.LicenseRuntime = new LicenseRuntimeMetadata(
                authorized.Grant.SessionId,
                authorized.Grant.Plan,
                authorized.Grant.ConcurrencyLimit,
                authorized.Grant.BrowserVersion,
                authorized.Grant.VersionPolicy,
                authorized.Grant.SelectionReason,
                audit);
            session.AddCloseCallback(async () =>
            {
                try { await authorized.ReleaseAsync(cancellationToken); }
                finally { reference!.Release(); }
            });
            return session;
        }
        catch
        {
            if (session is not null)
            {
                try { await session.DisposeAsync(); }
                catch { /* original failure wins */ }
            }
            try { reference?.Release(); }
            catch { /* original failure wins */ }
            try { await authorized.ReleaseAsync(cancellationToken); }
            catch { /* original failure wins */ }
            await authorized.DisposeAsync();
            throw;
        }
    }

    public static Task<SlyWebDriverSession> LaunchAuthorizedAsync(
        string authorizationFile,
        LicensedLaunchSettings settings,
        CancellationToken cancellationToken = default) =>
        LaunchLatestAsync(authorizationFile, WithDefaultUpdateKernel(settings, false), cancellationToken);

    public static Task<LicensedPlaywrightBrowser> LaunchLatestPlaywrightAsync(
        IPlaywright playwright,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LaunchPlaywrightWithAuthorizedDefaultsAsync(
            playwright,
            authorizationFile,
            settings,
            playwrightSettings,
            updateKernelDefault: true,
            cancellationToken);

    public static Task<LicensedPlaywrightBrowser> LaunchAuthorizedPlaywrightAsync(
        IPlaywright playwright,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LaunchPlaywrightWithAuthorizedDefaultsAsync(
            playwright,
            authorizationFile,
            settings,
            playwrightSettings,
            updateKernelDefault: false,
            cancellationToken);

    public static Task<LicensedPlaywrightContext> LaunchLatestPlaywrightPersistentAsync(
        IPlaywright playwright,
        string userDataDir,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightPersistentLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LaunchPlaywrightPersistentWithAuthorizedDefaultsAsync(
            playwright,
            userDataDir,
            authorizationFile,
            settings,
            playwrightSettings,
            updateKernelDefault: true,
            cancellationToken);

    public static Task<LicensedPlaywrightContext> LaunchAuthorizedPlaywrightPersistentAsync(
        IPlaywright playwright,
        string userDataDir,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightPersistentLaunchSettings? playwrightSettings = null,
        CancellationToken cancellationToken = default) =>
        LaunchPlaywrightPersistentWithAuthorizedDefaultsAsync(
            playwright,
            userDataDir,
            authorizationFile,
            settings,
            playwrightSettings,
            updateKernelDefault: false,
            cancellationToken);

    private static async Task<LicensedPlaywrightBrowser> LaunchPlaywrightWithAuthorizedDefaultsAsync(
        IPlaywright playwright,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightLaunchSettings? suppliedPlaywrightSettings,
        bool updateKernelDefault,
        CancellationToken cancellationToken)
    {
        AuthorizedInstallation authorized = await PrepareLatestAuthorizedBrowserAsync(
            authorizationFile,
            WithDefaultUpdateKernel(settings, updateKernelDefault),
            AutomationBackend.Playwright,
            cancellationToken);
        BrowserInstallationReference? reference = null;
        IBrowser? browser = null;
        await using BootstrapHeartbeatController heartbeat = new(authorized.Client, authorized.Grant);
        try
        {
            heartbeat.Start();
            reference = await BrowserInstaller.AcquireBrowserInstallationReferenceAsync(
                authorized.Installation,
                cancellationToken);
            PlaywrightLaunchSettings launchSettings = WithRuntimeHandoff(
                suppliedPlaywrightSettings ?? new PlaywrightLaunchSettings(),
                RuntimeBootstrapHandoff(
                    authorized.Client,
                    authorized.Grant,
                    suppliedPlaywrightSettings?.RuntimeHandoff));
            browser = await SlyBrowserPlaywright.LaunchAsync(
                playwright,
                authorized.Installation.BrowserExecutable,
                authorized.Grant.LeaseEnvelope,
                launchSettings,
                cancellationToken);
            BrowserVersionAudit audit = VerifyBrowserVersionAudit(new BrowserVersionAudit(
                authorized.Grant.RequestedBrowserVersion,
                authorized.Grant.BrowserVersion,
                authorized.Installation.Version,
                NormalizeFrameworkBrowserVersion(browser.Version),
                authorized.Grant.VersionPolicy,
                authorized.Grant.SelectionReason));
            LicenseRuntimeMetadata runtime = new(
                authorized.Grant.SessionId,
                authorized.Grant.Plan,
                authorized.Grant.ConcurrencyLimit,
                authorized.Grant.BrowserVersion,
                authorized.Grant.VersionPolicy,
                authorized.Grant.SelectionReason,
                audit);
            return new LicensedPlaywrightBrowser(browser, runtime, async () =>
            {
                try { await ReleaseFrameworkAuthorizationAsync(authorized, cancellationToken); }
                finally { reference!.Release(); }
            });
        }
        catch
        {
            if (browser is not null)
            {
                try { await browser.CloseAsync(); }
                catch { /* original failure wins */ }
            }
            try { reference?.Release(); }
            catch { /* original failure wins */ }
            try { await authorized.ReleaseAsync(cancellationToken); }
            catch { /* original failure wins */ }
            await authorized.DisposeAsync();
            throw;
        }
    }

    private static async Task<LicensedPlaywrightContext> LaunchPlaywrightPersistentWithAuthorizedDefaultsAsync(
        IPlaywright playwright,
        string userDataDir,
        string authorizationFile,
        LicensedLaunchSettings settings,
        PlaywrightPersistentLaunchSettings? suppliedPlaywrightSettings,
        bool updateKernelDefault,
        CancellationToken cancellationToken)
    {
        AuthorizedInstallation authorized = await PrepareLatestAuthorizedBrowserAsync(
            authorizationFile,
            WithDefaultUpdateKernel(settings, updateKernelDefault),
            AutomationBackend.Playwright,
            cancellationToken);
        BrowserInstallationReference? reference = null;
        IBrowserContext? context = null;
        await using BootstrapHeartbeatController heartbeat = new(authorized.Client, authorized.Grant);
        try
        {
            heartbeat.Start();
            reference = await BrowserInstaller.AcquireBrowserInstallationReferenceAsync(
                authorized.Installation,
                cancellationToken);
            PlaywrightPersistentLaunchSettings launchSettings = WithRuntimeHandoff(
                suppliedPlaywrightSettings ?? new PlaywrightPersistentLaunchSettings(),
                RuntimeBootstrapHandoff(
                    authorized.Client,
                    authorized.Grant,
                    suppliedPlaywrightSettings?.RuntimeHandoff));
            context = await SlyBrowserPlaywright.LaunchPersistentContextAsync(
                playwright,
                userDataDir,
                authorized.Installation.BrowserExecutable,
                authorized.Grant.LeaseEnvelope,
                launchSettings,
                cancellationToken);
            if (context.Browser is null)
                throw new ArtifactException("Framework context did not expose a browser for version audit", "browser_version_missing");
            BrowserVersionAudit audit = VerifyBrowserVersionAudit(new BrowserVersionAudit(
                authorized.Grant.RequestedBrowserVersion,
                authorized.Grant.BrowserVersion,
                authorized.Installation.Version,
                NormalizeFrameworkBrowserVersion(context.Browser.Version),
                authorized.Grant.VersionPolicy,
                authorized.Grant.SelectionReason));
            LicenseRuntimeMetadata runtime = new(
                authorized.Grant.SessionId,
                authorized.Grant.Plan,
                authorized.Grant.ConcurrencyLimit,
                authorized.Grant.BrowserVersion,
                authorized.Grant.VersionPolicy,
                authorized.Grant.SelectionReason,
                audit);
            return new LicensedPlaywrightContext(context, runtime, async () =>
            {
                try { await ReleaseFrameworkAuthorizationAsync(authorized, cancellationToken); }
                finally { reference!.Release(); }
            });
        }
        catch
        {
            if (context is not null)
            {
                try { await context.CloseAsync(); }
                catch { /* original failure wins */ }
            }
            try { reference?.Release(); }
            catch { /* original failure wins */ }
            try { await authorized.ReleaseAsync(cancellationToken); }
            catch { /* original failure wins */ }
            await authorized.DisposeAsync();
            throw;
        }
    }

    private static LicensedLaunchSettings WithDefaultUpdateKernel(
        LicensedLaunchSettings settings,
        bool updateKernel)
    {
        if (settings.UpdateKernel is not null) return settings;
        return new LicensedLaunchSettings
        {
            Trust = settings.Trust,
            Install = settings.Install,
            Platform = settings.Platform,
            Arch = settings.Arch,
            DeviceHash = settings.DeviceHash,
            KernelMajor = settings.KernelMajor,
            UpdateKernel = updateKernel,
            BrowserVersion = settings.BrowserVersion,
            VersionPolicy = settings.VersionPolicy,
            WebDriver = settings.WebDriver,
        };
    }

    private static async Task ReleaseFrameworkAuthorizationAsync(
        AuthorizedInstallation authorized,
        CancellationToken cancellationToken)
    {
        try
        {
            await authorized.ReleaseAsync(cancellationToken);
        }
        catch (LicenseServiceException exception) when (
            exception.Status == 401 && exception.Code == "session_invalid" ||
            exception.Status == 429 && exception.Code == "request_rate_limited")
        {
            // The native browser watchdog may have already closed and released the same
            // runtime session while the framework wrapper is disposing. A release-side
            // rate limit is also fail-closed because it can only leave the session
            // counted until expiry; it cannot grant extra concurrency.
        }
    }

    private static PlaywrightLaunchSettings WithRuntimeHandoff(
        PlaywrightLaunchSettings settings,
        object runtimeHandoff) =>
        new()
        {
            Profile = settings.Profile,
            TempRoot = settings.TempRoot,
            FrameworkVersion = settings.FrameworkVersion,
            Humanize = settings.Humanize,
            HumanPreset = settings.HumanPreset,
            HumanConfig = settings.HumanConfig,
            HumanSeed = settings.HumanSeed,
            RuntimeHandoff = runtimeHandoff,
            AllowRuntimeActivationTicket = true,
            ReleaseRoot = settings.ReleaseRoot,
            NativeReady = settings.NativeReady,
            NativeReadyTimeout = settings.NativeReadyTimeout,
            Configure = settings.Configure,
        };

    private static PlaywrightPersistentLaunchSettings WithRuntimeHandoff(
        PlaywrightPersistentLaunchSettings settings,
        object runtimeHandoff) =>
        new()
        {
            Profile = settings.Profile,
            TempRoot = settings.TempRoot,
            FrameworkVersion = settings.FrameworkVersion,
            Humanize = settings.Humanize,
            HumanPreset = settings.HumanPreset,
            HumanConfig = settings.HumanConfig,
            HumanSeed = settings.HumanSeed,
            RuntimeHandoff = runtimeHandoff,
            AllowRuntimeActivationTicket = true,
            ReleaseRoot = settings.ReleaseRoot,
            NativeReady = settings.NativeReady,
            NativeReadyTimeout = settings.NativeReadyTimeout,
            Configure = settings.Configure,
        };

    private static string NormalizeFrameworkBrowserVersion(string value)
    {
        Match match = Regex.Match(value, @"(\d+\.\d+\.\d+\.\d+)");
        if (!match.Success)
            throw new ArtifactException(
                $"Framework browser returned an unsupported version string: {value}",
                "browser_version_invalid");
        return match.Groups[1].Value;
    }

    private static IReadOnlyDictionary<string, object?> RuntimeBootstrapHandoff(
        LicenseServiceClient client,
        RuntimeSessionGrant grant,
        object? existing) =>
        RuntimeBootstrapHandoff(client, grant, existing, grant.ActivationTicket);

    private static IReadOnlyDictionary<string, object?> DriverRuntimeBootstrapHandoff(
        LicenseServiceClient client,
        RuntimeSessionGrant grant,
        object? existing)
    {
        if (string.IsNullOrEmpty(grant.DriverActivationTicket))
            throw new ConfigurationException(
                "Project WebDriver runtime session is missing a driver activation ticket",
                "license_service_invalid_response");
        return RuntimeBootstrapHandoff(client, grant, existing, grant.DriverActivationTicket);
    }

    private static IReadOnlyDictionary<string, object?> RuntimeBootstrapHandoff(
        LicenseServiceClient client,
        RuntimeSessionGrant grant,
        object? existing,
        string activationTicket)
    {
        Dictionary<string, object?> result = new(StringComparer.Ordinal);
        if (existing is IReadOnlyDictionary<string, object?> readOnly)
        {
            foreach ((string key, object? value) in readOnly) result[key] = value;
        }
        else if (existing is IDictionary<string, object?> dictionary)
        {
            foreach ((string key, object? value) in dictionary) result[key] = value;
        }
        else if (existing is not null)
        {
            result["userRuntimeHandoff"] = existing;
        }
        result["schemaVersion"] = 2;
        result["serviceUrl"] = client.Authorization.ServiceUrl;
        result["state"] = grant.State;
        result["startupId"] = grant.StartupId;
        result["sessionId"] = grant.SessionId;
        result["bootstrapToken"] = grant.BootstrapToken;
        result["activationTicket"] = activationTicket;
        result["heartbeatAfterSeconds"] = grant.HeartbeatAfterSeconds;
        result["expiresAt"] = grant.ExpiresAt;
        result["plan"] = grant.Plan;
        result["features"] = grant.Features;
        result["concurrencyLimit"] = grant.ConcurrencyLimit;
        result["activeSessions"] = grant.ActiveSessions;
        result["browserVersion"] = grant.BrowserVersion;
        if (grant.AutomationBackend is not null) result["automationBackend"] = AutomationBackendValue(grant.AutomationBackend.Value);
        return result;
    }

    private static WebDriverLaunchSettings WithRuntimeHandoff(
        WebDriverLaunchSettings settings,
        object runtimeHandoff,
        object driverRuntimeHandoff) =>
        new()
        {
            Profile = settings.Profile,
            RuntimeHandoff = runtimeHandoff,
            DriverRuntimeHandoff = driverRuntimeHandoff,
            AllowRuntimeActivationTicket = true,
            NativeReady = settings.NativeReady,
            NativeReadyTimeout = settings.NativeReadyTimeout,
            TempRoot = settings.TempRoot,
            ProfileDirectory = settings.ProfileDirectory,
            ProfileMode = settings.ProfileMode,
            BrowserArguments = settings.BrowserArguments,
            ExcludedSwitches = settings.ExcludedSwitches,
            Headless = settings.Headless,
            ViewportWidth = settings.ViewportWidth,
            ViewportHeight = settings.ViewportHeight,
            Humanize = settings.Humanize,
            HumanPreset = settings.HumanPreset,
            HumanConfig = settings.HumanConfig,
            HumanSeed = settings.HumanSeed,
            DriverStartTimeout = settings.DriverStartTimeout,
            CommandTimeout = settings.CommandTimeout,
        };

    private sealed class BootstrapHeartbeatController : IAsyncDisposable
    {
        private readonly LicenseServiceClient _client;
        private readonly RuntimeSessionGrant _grant;
        private readonly CancellationTokenSource _stop = new();
        private Task? _task;

        internal BootstrapHeartbeatController(LicenseServiceClient client, RuntimeSessionGrant grant)
        {
            _client = client;
            _grant = grant;
        }

        internal Exception? Failure { get; private set; }

        internal void Start()
        {
            _task ??= Task.Run(LoopAsync);
        }

        private async Task LoopAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(HeartbeatDelay(_grant.HeartbeatAfterSeconds), _stop.Token);
                    await _client.BootstrapHeartbeatAsync(_grant, _stop.Token);
                    Failure = null;
                }
                catch (OperationCanceledException) when (_stop.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception exception)
                {
                    Failure = exception;
                }
            }
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            if (_task is not null)
            {
                try { await _task; }
                catch (OperationCanceledException) { }
            }
            _stop.Dispose();
        }
    }

    internal static TimeSpan HeartbeatDelay(int heartbeatAfterSeconds)
    {
        int baseSeconds = Math.Max(1, heartbeatAfterSeconds);
        int jitterWindow = Math.Min(15, Math.Max(0, baseSeconds - 1));
        return TimeSpan.FromSeconds(Math.Max(1, baseSeconds - jitterWindow));
    }

    private static string AutomationBackendValue(AutomationBackend backend) =>
        backend switch
        {
            AutomationBackend.ProjectWebDriver => "project-webdriver",
            AutomationBackend.Playwright => "playwright",
            _ => throw new ConfigurationException("Unsupported automation backend", "automation_backend_unsupported"),
        };
}
