using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SlyBrowser;

public sealed record LicenseAuthorization(string ServiceUrl, string LicenseKey, string Channel = "stable");

public sealed class LicensedSessionGrant
{
    public required string SessionId { get; init; }
    public required string SessionToken { get; init; }
    public required int HeartbeatAfterSeconds { get; set; }
    public required long ExpiresAt { get; set; }
    public required string Plan { get; set; }
    public required IReadOnlyList<string> Features { get; set; }
    public required int ConcurrencyLimit { get; set; }
    public required int ActiveSessions { get; set; }
    public required string BrowserVersion { get; init; }
    public string? RequestedBrowserVersion { get; init; }
    public object? RequestedKernelMajor { get; init; }
    public required string VersionPolicy { get; init; }
    public required string SelectionReason { get; init; }
    public string? SelectionMode { get; init; }
    public required IReadOnlyList<string> AvailableBrowserVersions { get; init; }
    public string? LatestAvailableVersion { get; init; }
    public bool? UpdateAvailable { get; init; }
    public bool? UpdateRequired { get; init; }
    public required IReadOnlyDictionary<string, object?> UpdateRights { get; init; }
    public required string LeaseEnvelope { get; set; }
    public required LicenseClaims Claims { get; set; }
    public required ReleaseManifest Manifest { get; init; }
    public required ReleaseArtifact Artifact { get; init; }
    public required string Platform { get; init; }
    public required string Arch { get; init; }
}

public sealed class LicenseInfo
{
    public required int SchemaVersion { get; init; }
    public required string Channel { get; init; }
    public required string LicenseStatus { get; init; }
    public required string Plan { get; init; }
    public required string EffectivePlan { get; init; }
    public long? PaidThrough { get; init; }
    public required IReadOnlyList<string> Features { get; init; }
    public required int ConcurrencyLimit { get; init; }
    public required int ActiveSessions { get; init; }
    public required int AvailableSessions { get; init; }
    public required IReadOnlyDictionary<string, int> SessionState { get; init; }
    public required string BrowserVersion { get; init; }
    public string? RequestedBrowserVersion { get; init; }
    public object? RequestedKernelMajor { get; init; }
    public required string VersionPolicy { get; init; }
    public required string SelectionReason { get; init; }
    public string? SelectionMode { get; init; }
    public required IReadOnlyList<string> AvailableBrowserVersions { get; init; }
    public string? LatestAvailableVersion { get; init; }
    public bool? UpdateAvailable { get; init; }
    public bool? UpdateRequired { get; init; }
    public required IReadOnlyDictionary<string, object?> UpdateRights { get; init; }
    public string? StableErrorCode { get; init; }
}

public sealed class RuntimeDownloadTicket
{
    public required string Token { get; init; }
    public required long ExpiresAt { get; init; }
    public required string ArtifactSha256 { get; init; }
    public required string ArtifactUrl { get; init; }
}

public sealed class RuntimeSessionGrant
{
    public required int SchemaVersion { get; init; }
    public required string State { get; init; }
    public required string StartupId { get; init; }
    public required string SessionId { get; init; }
    public required string BootstrapToken { get; init; }
    public required string ActivationTicket { get; init; }
    public string? DriverActivationTicket { get; init; }
    public required int HeartbeatAfterSeconds { get; init; }
    public required long ExpiresAt { get; init; }
    public required string Plan { get; init; }
    public required IReadOnlyList<string> Features { get; init; }
    public required int ConcurrencyLimit { get; init; }
    public required int ActiveSessions { get; init; }
    public required string BrowserVersion { get; init; }
    public string? RequestedBrowserVersion { get; init; }
    public object? RequestedKernelMajor { get; init; }
    public required string VersionPolicy { get; init; }
    public required string SelectionReason { get; init; }
    public string? SelectionMode { get; init; }
    public required IReadOnlyList<string> AvailableBrowserVersions { get; init; }
    public string? LatestAvailableVersion { get; init; }
    public bool? UpdateAvailable { get; init; }
    public bool? UpdateRequired { get; init; }
    public required IReadOnlyDictionary<string, object?> UpdateRights { get; init; }
    public required string LeaseEnvelope { get; init; }
    public required LicenseClaims Claims { get; init; }
    public required ReleaseManifest Manifest { get; init; }
    public required ReleaseArtifact Artifact { get; init; }
    public required string Platform { get; init; }
    public required string Arch { get; init; }
    public AutomationBackend? AutomationBackend { get; init; }
    public required RuntimeDownloadTicket DownloadTicket { get; init; }
}

public sealed class RuntimeHeartbeatGrant
{
    public required int SchemaVersion { get; init; }
    public required string State { get; init; }
    public required string StartupId { get; init; }
    public required string SessionId { get; init; }
    public required int HeartbeatAfterSeconds { get; init; }
    public required long ExpiresAt { get; init; }
    public required string Plan { get; init; }
    public required IReadOnlyList<string> Features { get; init; }
    public required int ConcurrencyLimit { get; init; }
    public required int ActiveSessions { get; init; }
    public required string BrowserVersion { get; init; }
    public AutomationBackend? AutomationBackend { get; init; }
    public required string LeaseEnvelope { get; init; }
    public required LicenseClaims Claims { get; init; }
}

public sealed class RuntimeActivationGrant
{
    public required int SchemaVersion { get; init; }
    public required string State { get; init; }
    public required string StartupId { get; init; }
    public required string SessionId { get; init; }
    public required string RuntimeToken { get; init; }
    public required int HeartbeatAfterSeconds { get; init; }
    public required long ExpiresAt { get; init; }
    public required string Plan { get; init; }
    public required IReadOnlyList<string> Features { get; init; }
    public required int ConcurrencyLimit { get; init; }
    public required int ActiveSessions { get; init; }
    public required string BrowserVersion { get; init; }
    public AutomationBackend? AutomationBackend { get; init; }
    public required string LeaseEnvelope { get; init; }
    public required LicenseClaims Claims { get; init; }
}

public sealed class LicenseServiceClientOptions
{
    public required IReadOnlyDictionary<string, byte[]> LicenseTrustedKeys { get; init; }
    public required IReadOnlyDictionary<string, byte[]> ReleaseTrustedKeys { get; init; }
    public IReadOnlyDictionary<string, byte[]> LicenseFileTrustedKeys { get; init; } =
        new Dictionary<string, byte[]>(StringComparer.Ordinal);
    public string? LicenseFilePassphrase { get; init; }
    public IReadOnlySet<string> TrustedServiceUrls { get; init; } =
        new HashSet<string>(["https://api.slybrowser.com"], StringComparer.Ordinal);
    public HttpClient? HttpClient { get; init; }
    public bool AllowInsecureLocalhost { get; init; }
    public string SdkVersion { get; init; } = "0.1.0";
}

public sealed class CreateSessionOptions
{
    public string? Platform { get; init; }
    public string? Arch { get; init; }
    public string? DeviceHash { get; init; }
    public string? KernelMajor { get; init; }
    public bool? UpdateKernel { get; init; }
    public string? BrowserVersion { get; init; }
    public string? VersionPolicy { get; init; }
}

public sealed class CreateRuntimeSessionOptions
{
    public string? StartupId { get; init; }
    public AutomationBackend? AutomationBackend { get; init; }
    public string? Platform { get; init; }
    public string? Arch { get; init; }
    public string? DeviceHash { get; init; }
    public string? KernelMajor { get; init; }
    public bool? UpdateKernel { get; init; }
    public string? BrowserVersion { get; init; }
    public string? VersionPolicy { get; init; }
}

public sealed class LicenseServiceClient : IDisposable
{
    private static readonly HashSet<string> Plans = new(StringComparer.Ordinal)
        { "free", "basic", "pro", "max", "ultra" };
    private static readonly HashSet<string> SafeErrorDetailFields = new(StringComparer.Ordinal)
        { "state", "concurrencyLimit", "activeSessions", "availableSessions", "retryAfterSeconds", "action", "dimension" };
    private readonly HttpClient _http;
    private readonly bool _ownsHttpClient;
    private readonly LicenseVerifier _licenseVerifier;
    private readonly IReadOnlyDictionary<string, byte[]> _releaseTrustedKeys;
    private readonly string _sdkVersion;

    public LicenseServiceClient(LicenseAuthorization authorization, LicenseServiceClientOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        Authorization = ParseAuthorization(
            new Dictionary<string, object?>
            {
                ["schemaVersion"] = 1,
                ["serviceUrl"] = authorization.ServiceUrl,
                ["licenseKey"] = authorization.LicenseKey,
                ["channel"] = authorization.Channel,
            },
            options.AllowInsecureLocalhost);
        _http = options.HttpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false });
        _ownsHttpClient = options.HttpClient is null;
        _licenseVerifier = new LicenseVerifier(options.LicenseTrustedKeys);
        _releaseTrustedKeys = options.ReleaseTrustedKeys;
        _sdkVersion = options.SdkVersion;
    }

    public LicenseAuthorization Authorization { get; }

    public static async Task<LicenseAuthorization> ReadAuthorizationAsync(
        string path,
        bool allowInsecureLocalhost = false,
        CancellationToken cancellationToken = default)
    {
        return await ReadAuthorizationAsync(
            path,
            new LicenseFileReadOptions { AllowInsecureLocalhost = allowInsecureLocalhost },
            cancellationToken);
    }

    public static async Task<LicenseAuthorization> ReadAuthorizationAsync(
        string path,
        LicenseFileReadOptions? options,
        CancellationToken cancellationToken = default)
    {
        byte[] raw = await File.ReadAllBytesAsync(Path.GetFullPath(path), cancellationToken);
        if (raw.Length > 64 * 1024)
            throw Fail("authorization_invalid", "Authorization file is too large");
        try
        {
            using JsonDocument document = JsonDocument.Parse(raw);
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty("schemaVersion", out JsonElement schema) &&
                schema.TryGetInt32(out int schemaVersion) &&
                schemaVersion == 2)
                return LicenseFileReader.Read(document.RootElement, options);
            return ParseAuthorization(document.RootElement, options?.AllowInsecureLocalhost ?? false);
        }
        catch (JsonException exception)
        {
            throw Fail("authorization_invalid", "Authorization file is not valid JSON", 0, exception);
        }
    }

    public async Task<LicenseInfo> LicenseInfoAsync(
        CreateSessionOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new CreateSessionOptions();
        string platform = options.Platform ?? CurrentPlatform();
        string arch = options.Arch ?? CurrentArch();
        string versionPolicy = options.VersionPolicy ?? (options.BrowserVersion is null ? "latest" : "exact");
        if (versionPolicy is not ("latest" or "exact" or "at-or-before"))
            throw Fail("version_policy_invalid", $"Unsupported browser version policy: {versionPolicy}");
        if (versionPolicy == "latest" && options.BrowserVersion is not null)
            throw Fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
        if (versionPolicy != "latest" && options.BrowserVersion is null)
            throw Fail("version_policy_invalid", $"{versionPolicy} selection requires a browser version");
        if (options.BrowserVersion is not null) _ = ReleaseManifestVerifier.CompareVersion(options.BrowserVersion, options.BrowserVersion);
        object kernelMajor = NormalizeKernelMajor(options.KernelMajor);
        bool updateKernel = options.UpdateKernel ?? false;
        if (options.BrowserVersion is not null && kernelMajor is int major && BrowserMajor(options.BrowserVersion) != major)
            throw Fail("version_policy_invalid", "BrowserVersion does not match KernelMajor");

        Dictionary<string, object?> body = new()
        {
            ["platform"] = platform,
            ["arch"] = arch,
            ["channel"] = Authorization.Channel,
            ["sdkVersion"] = _sdkVersion,
            ["kernelMajor"] = kernelMajor,
            ["updateKernel"] = updateKernel,
            ["versionPolicy"] = versionPolicy,
        };
        if (options.DeviceHash is not null) body["deviceHash"] = options.DeviceHash;
        if (options.BrowserVersion is not null) body["browserVersion"] = options.BrowserVersion;

        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            "/v2/licenses/info",
            $"License {Authorization.LicenseKey}",
            body,
            cancellationToken);
        JsonElement root = response.RootElement;
        string channel = RequiredString(root, "channel", "license_service_invalid_response");
        string status = RequiredString(root, "licenseStatus", "license_service_invalid_response");
        string plan = RequiredString(root, "plan", "license_service_invalid_response");
        string effectivePlan = RequiredString(root, "effectivePlan", "license_service_invalid_response");
        string browserVersion = RequiredString(root, "browserVersion", "license_service_invalid_response");
        string returnedPolicy = RequiredString(root, "versionPolicy", "license_service_invalid_response");
        string selectionReason = RequiredString(root, "selectionReason", "license_service_invalid_response");
        string? requestedBrowserVersion = root.TryGetProperty("requestedBrowserVersion", out JsonElement requested) &&
            requested.ValueKind != JsonValueKind.Null ? requested.GetString() : null;
        if (RequiredInteger(root, "schemaVersion", "license_service_invalid_response") != 1 ||
            channel != "stable" ||
            !new HashSet<string>(["active", "hold", "revoked"], StringComparer.Ordinal).Contains(status) ||
            !Plans.Contains(plan) ||
            !Plans.Contains(effectivePlan) ||
            returnedPolicy != versionPolicy ||
            selectionReason is not ("latest" or "exact" or "rollback") ||
            requestedBrowserVersion != options.BrowserVersion ||
            (root.TryGetProperty("stableErrorCode", out JsonElement stableErrorCode) && stableErrorCode.ValueKind != JsonValueKind.Null))
            throw Fail("license_service_invalid_response", "License service info response is invalid");

        int concurrency = checked((int)RequiredInteger(root, "concurrencyLimit", "license_service_invalid_response"));
        int active = checked((int)RequiredInteger(root, "activeSessions", "license_service_invalid_response"));
        int available = checked((int)RequiredInteger(root, "availableSessions", "license_service_invalid_response"));
        if (!root.TryGetProperty("sessionState", out JsonElement state) || state.ValueKind != JsonValueKind.Object ||
            RequiredInteger(state, "activeBrowserProcesses", "license_service_invalid_response") != active ||
            RequiredInteger(state, "limit", "license_service_invalid_response") != concurrency ||
            RequiredInteger(state, "available", "license_service_invalid_response") != available)
            throw Fail("license_service_invalid_response", "License service session-state response is invalid");
        IReadOnlyList<string> features = ReadStringArray(root, "features");
        if (features.Count == 0 || features.Count != features.Distinct(StringComparer.Ordinal).Count())
            throw Fail("license_service_invalid_response", "License service feature response is invalid");
        long? paidThrough = root.TryGetProperty("paidThrough", out JsonElement paid) && paid.ValueKind != JsonValueKind.Null
            ? paid.GetInt64()
            : null;
        return new LicenseInfo
        {
            SchemaVersion = 1,
            Channel = "stable",
            LicenseStatus = status,
            Plan = plan,
            EffectivePlan = effectivePlan,
            PaidThrough = paidThrough,
            Features = features,
            ConcurrencyLimit = concurrency,
            ActiveSessions = active,
            AvailableSessions = available,
            SessionState = new Dictionary<string, int>
            {
                ["activeBrowserProcesses"] = active,
                ["limit"] = concurrency,
                ["available"] = available,
            },
            BrowserVersion = browserVersion,
            RequestedBrowserVersion = requestedBrowserVersion,
            RequestedKernelMajor = OptionalKernelMajor(root),
            VersionPolicy = versionPolicy,
            SelectionReason = selectionReason,
            SelectionMode = OptionalSelectionMode(root),
            AvailableBrowserVersions = ReadStringArray(root, "availableBrowserVersions"),
            LatestAvailableVersion = OptionalVersion(root, "latestAvailableVersion"),
            UpdateAvailable = OptionalBoolean(root, "updateAvailable"),
            UpdateRequired = OptionalBoolean(root, "updateRequired"),
            UpdateRights = ReadUpdateRights(root),
            StableErrorCode = null,
        };
    }

    public async Task<LicensedSessionGrant> CreateSessionAsync(
        CreateSessionOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new CreateSessionOptions();
        string platform = options.Platform ?? CurrentPlatform();
        string arch = options.Arch ?? CurrentArch();
        string versionPolicy = options.VersionPolicy ?? (options.BrowserVersion is null ? "latest" : "exact");
        if (versionPolicy is not ("latest" or "exact" or "at-or-before"))
            throw Fail("version_policy_invalid", $"Unsupported browser version policy: {versionPolicy}");
        if (versionPolicy == "latest" && options.BrowserVersion is not null)
            throw Fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
        if (versionPolicy != "latest" && options.BrowserVersion is null)
            throw Fail("version_policy_invalid", $"{versionPolicy} selection requires a browser version");
        if (options.BrowserVersion is not null) _ = ReleaseManifestVerifier.CompareVersion(options.BrowserVersion, options.BrowserVersion);
        object kernelMajor = NormalizeKernelMajor(options.KernelMajor);
        bool updateKernel = options.UpdateKernel ?? false;
        if (options.BrowserVersion is not null && kernelMajor is int major && BrowserMajor(options.BrowserVersion) != major)
            throw Fail("version_policy_invalid", "BrowserVersion does not match KernelMajor");

        Dictionary<string, object?> body = new()
        {
            ["platform"] = platform,
            ["arch"] = arch,
            ["channel"] = Authorization.Channel,
            ["sdkVersion"] = _sdkVersion,
            ["kernelMajor"] = kernelMajor,
            ["updateKernel"] = updateKernel,
            ["versionPolicy"] = versionPolicy,
        };
        if (options.DeviceHash is not null) body["deviceHash"] = options.DeviceHash;
        if (options.BrowserVersion is not null) body["browserVersion"] = options.BrowserVersion;

        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            "/v1/licenses/sessions",
            $"License {Authorization.LicenseKey}",
            body,
            cancellationToken);
        JsonElement root = response.RootElement.Clone();
        string sessionId = RequiredString(root, "sessionId", "license_service_invalid_response");
        string sessionToken = RequiredString(root, "sessionToken", "license_service_invalid_response");
        string browserVersion = RequiredString(root, "browserVersion", "license_service_invalid_response");
        long expiresAt = RequiredInteger(root, "expiresAt", "license_service_invalid_response");
        int heartbeat = checked((int)RequiredInteger(root, "heartbeatAfterSeconds", "license_service_invalid_response"));
        string returnedPolicy = RequiredString(root, "versionPolicy", "license_service_invalid_response");
        string selectionReason = RequiredString(root, "selectionReason", "license_service_invalid_response");
        string? requestedBrowserVersion = root.TryGetProperty("requestedBrowserVersion", out JsonElement requested)
            ? requested.GetString()
            : null;
        if (returnedPolicy != versionPolicy ||
            selectionReason is not ("latest" or "exact" or "rollback") ||
            requestedBrowserVersion != options.BrowserVersion)
            throw Fail("license_service_invalid_response", "License service version-selection response is invalid");
        if (versionPolicy == "exact" && browserVersion != options.BrowserVersion)
            throw Fail("release_version_mismatch", $"Requested browser {options.BrowserVersion} but service selected {browserVersion}");
        if (versionPolicy == "at-or-before" && ReleaseManifestVerifier.CompareVersion(browserVersion, options.BrowserVersion!) > 0)
            throw Fail("release_version_mismatch", "Rollback selection is newer than the requested browser version");
        IReadOnlyList<string> versions = ReadStringArray(root, "availableBrowserVersions");
        Dictionary<string, object?> updateRights = ReadUpdateRights(root);
        object? requestedKernelMajor = OptionalKernelMajor(root);
        string? selectionMode = OptionalSelectionMode(root);
        string? latestAvailableVersion = OptionalVersion(root, "latestAvailableVersion");
        bool? updateAvailable = OptionalBoolean(root, "updateAvailable");
        bool? updateRequired = OptionalBoolean(root, "updateRequired");
        string leaseEnvelope = RawJson(root, "lease");
        LicenseClaims claims = _licenseVerifier.Verify(
            leaseEnvelope,
            browserVersion,
            requiredFeatures: RequiredLeaseFeatures(null),
            deviceHash: options.DeviceHash);
        if (claims.SessionId != sessionId || claims.ExpiresAt != expiresAt)
            throw Fail("license_service_invalid_response", "Signed lease does not match the allocated session");
        ReleaseManifest manifest = ReleaseManifestVerifier.Verify(root.GetProperty("manifest"), _releaseTrustedKeys);
        if (manifest.BrowserVersion != browserVersion)
            throw Fail("license_service_invalid_response", "Release manifest does not match the signed lease");
        if (!ReleaseManifestVerifier.IsSdkCompatible(manifest.SdkCompatibility, _sdkVersion))
            throw Fail("sdk_version_unsupported", $"Browser {browserVersion} does not support SDK {_sdkVersion}");
        ReleaseArtifact artifact = manifest.Select(platform, arch);
        if (new Uri(artifact.Url).GetLeftPart(UriPartial.Authority) != new Uri(Authorization.ServiceUrl).GetLeftPart(UriPartial.Authority))
            throw Fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
        string plan = RequiredString(root, "plan", "license_service_invalid_response");
        int concurrency = checked((int)RequiredInteger(root, "concurrencyLimit", "license_service_invalid_response"));
        int active = checked((int)RequiredInteger(root, "activeSessions", "license_service_invalid_response"));
        if (!Plans.Contains(plan))
            throw Fail("license_service_invalid_response", "License service plan response is invalid");
        IReadOnlyList<string> features = ResponseFeatures(root, claims);
        AssertClaimsMatchPlan(claims, plan, concurrency, features);

        return new LicensedSessionGrant
        {
            SessionId = sessionId,
            SessionToken = sessionToken,
            HeartbeatAfterSeconds = heartbeat,
            ExpiresAt = expiresAt,
            Plan = plan,
            Features = features,
            ConcurrencyLimit = concurrency,
            ActiveSessions = active,
            BrowserVersion = browserVersion,
            RequestedBrowserVersion = requestedBrowserVersion,
            RequestedKernelMajor = requestedKernelMajor,
            VersionPolicy = versionPolicy,
            SelectionReason = selectionReason,
            SelectionMode = selectionMode,
            AvailableBrowserVersions = versions,
            LatestAvailableVersion = latestAvailableVersion,
            UpdateAvailable = updateAvailable,
            UpdateRequired = updateRequired,
            UpdateRights = updateRights,
            LeaseEnvelope = leaseEnvelope,
            Claims = claims,
            Manifest = manifest,
            Artifact = artifact,
            Platform = platform,
            Arch = arch,
        };
    }

    public async Task<RuntimeSessionGrant> CreateRuntimeSessionAsync(
        CreateRuntimeSessionOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new CreateRuntimeSessionOptions();
        string platform = options.Platform ?? CurrentPlatform();
        string arch = options.Arch ?? CurrentArch();
        string startupId = options.StartupId ?? NewStartupId();
        if (!Regex.IsMatch(startupId, @"^st_[A-Za-z0-9_-]{16,120}$"))
            throw Fail("startup_id_invalid", "Runtime startup ID is invalid");
        string versionPolicy = options.VersionPolicy ?? (options.BrowserVersion is null ? "latest" : "exact");
        if (versionPolicy is not ("latest" or "exact" or "at-or-before"))
            throw Fail("version_policy_invalid", $"Unsupported browser version policy: {versionPolicy}");
        if (versionPolicy == "latest" && options.BrowserVersion is not null)
            throw Fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
        if (versionPolicy != "latest" && options.BrowserVersion is null)
            throw Fail("version_policy_invalid", $"{versionPolicy} selection requires a browser version");
        if (options.BrowserVersion is not null) _ = ReleaseManifestVerifier.CompareVersion(options.BrowserVersion, options.BrowserVersion);
        object kernelMajor = NormalizeKernelMajor(options.KernelMajor);
        bool updateKernel = options.UpdateKernel ?? false;
        if (options.BrowserVersion is not null && kernelMajor is int major && BrowserMajor(options.BrowserVersion) != major)
            throw Fail("version_policy_invalid", "BrowserVersion does not match KernelMajor");

        Dictionary<string, object?> body = new()
        {
            ["startupId"] = startupId,
            ["platform"] = platform,
            ["arch"] = arch,
            ["channel"] = Authorization.Channel,
            ["sdkVersion"] = _sdkVersion,
            ["kernelMajor"] = kernelMajor,
            ["updateKernel"] = updateKernel,
            ["versionPolicy"] = versionPolicy,
        };
        if (options.AutomationBackend is not null) body["automationBackend"] = AutomationBackendValue(options.AutomationBackend.Value);
        if (options.DeviceHash is not null) body["deviceHash"] = options.DeviceHash;
        if (options.BrowserVersion is not null) body["browserVersion"] = options.BrowserVersion;

        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            "/v2/runtime/sessions",
            $"License {Authorization.LicenseKey}",
            body,
            cancellationToken);
        JsonElement root = response.RootElement.Clone();
        if (RequiredInteger(root, "schemaVersion", "license_service_invalid_response") != 2)
            throw Fail("license_service_invalid_response", "Runtime session response is invalid");
        string state = RequiredString(root, "state", "license_service_invalid_response");
        if (state is not ("reserved" or "active" or "closing") ||
            RequiredString(root, "startupId", "license_service_invalid_response") != startupId)
            throw Fail("license_service_invalid_response", "Runtime session response is invalid");
        string sessionId = RequiredString(root, "sessionId", "license_service_invalid_response");
        string bootstrapToken = RequiredString(root, "bootstrapToken", "license_service_invalid_response");
        string activationTicket = RequiredString(root, "activationTicket", "license_service_invalid_response");
        string? driverActivationTicket = OptionalString(root, "driverActivationTicket", "license_service_invalid_response");
        if (options.AutomationBackend == AutomationBackend.ProjectWebDriver && driverActivationTicket is null)
            throw Fail("license_service_invalid_response", "Project WebDriver runtime session is missing a driver activation ticket");
        string browserVersion = RequiredString(root, "browserVersion", "license_service_invalid_response");
        long expiresAt = RequiredInteger(root, "expiresAt", "license_service_invalid_response");
        int heartbeat = checked((int)RequiredInteger(root, "heartbeatAfterSeconds", "license_service_invalid_response"));
        string returnedPolicy = RequiredString(root, "versionPolicy", "license_service_invalid_response");
        string selectionReason = RequiredString(root, "selectionReason", "license_service_invalid_response");
        string? requestedBrowserVersion = root.TryGetProperty("requestedBrowserVersion", out JsonElement requested)
            ? requested.GetString()
            : null;
        if (returnedPolicy != versionPolicy ||
            selectionReason is not ("latest" or "exact" or "rollback") ||
            requestedBrowserVersion != options.BrowserVersion)
            throw Fail("license_service_invalid_response", "Runtime version-selection response is invalid");
        if (versionPolicy == "exact" && browserVersion != options.BrowserVersion)
            throw Fail("release_version_mismatch", $"Requested browser {options.BrowserVersion} but service selected {browserVersion}");
        if (versionPolicy == "at-or-before" && ReleaseManifestVerifier.CompareVersion(browserVersion, options.BrowserVersion!) > 0)
            throw Fail("release_version_mismatch", "Rollback selection is newer than the requested browser version");
        IReadOnlyList<string> versions = ReadStringArray(root, "availableBrowserVersions");
        Dictionary<string, object?> updateRights = ReadUpdateRights(root);
        object? requestedKernelMajor = OptionalKernelMajor(root);
        string? selectionMode = OptionalSelectionMode(root);
        string? latestAvailableVersion = OptionalVersion(root, "latestAvailableVersion");
        bool? updateAvailable = OptionalBoolean(root, "updateAvailable");
        bool? updateRequired = OptionalBoolean(root, "updateRequired");
        string leaseEnvelope = RawJson(root, "lease");
        LicenseClaims claims = _licenseVerifier.Verify(
            leaseEnvelope,
            browserVersion,
            requiredFeatures: RequiredLeaseFeatures(options.AutomationBackend),
            deviceHash: options.DeviceHash);
        if (claims.SessionId != sessionId || claims.ExpiresAt != expiresAt)
            throw Fail("license_service_invalid_response", "Runtime lease does not match the allocated session");
        ReleaseManifest manifest = ReleaseManifestVerifier.Verify(root.GetProperty("manifest"), _releaseTrustedKeys);
        if (manifest.BrowserVersion != browserVersion)
            throw Fail("license_service_invalid_response", "Release manifest does not match the runtime lease");
        if (!ReleaseManifestVerifier.IsSdkCompatible(manifest.SdkCompatibility, _sdkVersion))
            throw Fail("sdk_version_unsupported", $"Browser {browserVersion} does not support SDK {_sdkVersion}");
        ReleaseArtifact artifact = manifest.Select(platform, arch);
        if (Origin(artifact.Url) != Origin(Authorization.ServiceUrl))
            throw Fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
        if (!root.TryGetProperty("downloadTicket", out JsonElement ticket) || ticket.ValueKind != JsonValueKind.Object)
            throw Fail("license_service_invalid_response", "Runtime download ticket response is invalid");
        string ticketToken = RequiredString(ticket, "token", "license_service_invalid_response");
        long ticketExpiresAt = RequiredInteger(ticket, "expiresAt", "license_service_invalid_response");
        string artifactSha256 = RequiredString(ticket, "artifactSha256", "license_service_invalid_response");
        string artifactUrl = RequiredString(ticket, "artifactUrl", "license_service_invalid_response");
        if (ticketExpiresAt != expiresAt ||
            artifactSha256 != artifact.Sha256 ||
            Origin(artifactUrl) != Origin(Authorization.ServiceUrl))
            throw Fail("license_service_invalid_response", "Runtime download ticket response is invalid");
        string plan = RequiredString(root, "plan", "license_service_invalid_response");
        int concurrency = checked((int)RequiredInteger(root, "concurrencyLimit", "license_service_invalid_response"));
        int active = checked((int)RequiredInteger(root, "activeSessions", "license_service_invalid_response"));
        if (!Plans.Contains(plan))
            throw Fail("license_service_invalid_response", "Runtime plan response is invalid");
        IReadOnlyList<string> features = ResponseFeatures(root, claims);
        AssertClaimsMatchPlan(claims, plan, concurrency, features);

        return new RuntimeSessionGrant
        {
            SchemaVersion = 2,
            State = state,
            StartupId = startupId,
            SessionId = sessionId,
            BootstrapToken = bootstrapToken,
            ActivationTicket = activationTicket,
            DriverActivationTicket = driverActivationTicket,
            HeartbeatAfterSeconds = heartbeat,
            ExpiresAt = expiresAt,
            Plan = plan,
            Features = features,
            ConcurrencyLimit = concurrency,
            ActiveSessions = active,
            BrowserVersion = browserVersion,
            RequestedBrowserVersion = requestedBrowserVersion,
            RequestedKernelMajor = requestedKernelMajor,
            VersionPolicy = versionPolicy,
            SelectionReason = selectionReason,
            SelectionMode = selectionMode,
            AvailableBrowserVersions = versions,
            LatestAvailableVersion = latestAvailableVersion,
            UpdateAvailable = updateAvailable,
            UpdateRequired = updateRequired,
            UpdateRights = updateRights,
            LeaseEnvelope = leaseEnvelope,
            Claims = claims,
            Manifest = manifest,
            Artifact = artifact,
            Platform = platform,
            Arch = arch,
            AutomationBackend = options.AutomationBackend,
            DownloadTicket = new RuntimeDownloadTicket
            {
                Token = ticketToken,
                ExpiresAt = ticketExpiresAt,
                ArtifactSha256 = artifactSha256,
                ArtifactUrl = artifactUrl,
            },
        };
    }

    public async Task HeartbeatAsync(LicensedSessionGrant grant, CancellationToken cancellationToken = default)
    {
        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            $"/v1/licenses/sessions/{Uri.EscapeDataString(grant.SessionId)}/heartbeat",
            $"Session {grant.SessionToken}",
            new Dictionary<string, object?>(),
            cancellationToken);
        JsonElement root = response.RootElement.Clone();
        string lease = RawJson(root, "lease");
        long expiresAt = RequiredInteger(root, "expiresAt", "license_service_invalid_response");
        LicenseClaims claims = _licenseVerifier.Verify(
            lease,
            grant.BrowserVersion,
            requiredFeatures: RequiredLeaseFeatures(null),
            deviceHash: grant.Claims.DeviceHash);
        if (claims.SessionId != grant.SessionId || claims.ExpiresAt != expiresAt)
            throw Fail("license_service_invalid_response", "Heartbeat lease does not match the active session");
        string plan = RequiredString(root, "plan", "license_service_invalid_response");
        int concurrency = checked((int)RequiredInteger(root, "concurrencyLimit", "license_service_invalid_response"));
        int active = checked((int)RequiredInteger(root, "activeSessions", "license_service_invalid_response"));
        if (!Plans.Contains(plan))
            throw Fail("license_service_invalid_response", "Heartbeat plan response is invalid");
        IReadOnlyList<string> features = ResponseFeatures(root, claims);
        AssertClaimsMatchPlan(claims, plan, concurrency, features);
        grant.LeaseEnvelope = lease;
        grant.Claims = claims;
        grant.ExpiresAt = expiresAt;
        grant.Plan = plan;
        grant.Features = features;
        grant.ConcurrencyLimit = concurrency;
        grant.ActiveSessions = active;
    }

    public async Task<RuntimeHeartbeatGrant> BootstrapHeartbeatAsync(
        RuntimeSessionGrant grant,
        CancellationToken cancellationToken = default)
    {
        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            $"/v2/runtime/sessions/{Uri.EscapeDataString(grant.SessionId)}/bootstrap-heartbeat",
            $"Bootstrap {grant.BootstrapToken}",
            null,
            cancellationToken);
        return RuntimeHeartbeatGrantFrom(
            response.RootElement.Clone(),
            grant.StartupId,
            grant.SessionId,
            grant.BrowserVersion,
            grant.Claims.DeviceHash,
            grant.AutomationBackend);
    }

    public async Task<RuntimeActivationGrant> ActivateRuntimeSessionAsync(
        RuntimeSessionGrant grant,
        CancellationToken cancellationToken = default)
    {
        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            $"/v2/runtime/sessions/{Uri.EscapeDataString(grant.SessionId)}/activate",
            $"Activation {grant.ActivationTicket}",
            null,
            cancellationToken);
        JsonElement root = response.RootElement.Clone();
        RuntimeHeartbeatGrant heartbeat = RuntimeHeartbeatGrantFrom(
            root,
            grant.StartupId,
            grant.SessionId,
            grant.BrowserVersion,
            grant.Claims.DeviceHash,
            grant.AutomationBackend);
        string runtimeToken = RequiredString(root, "runtimeToken", "license_service_invalid_response");
        if (heartbeat.State != "active")
            throw Fail("license_service_invalid_response", "Runtime activation response is invalid");
        return new RuntimeActivationGrant
        {
            SchemaVersion = heartbeat.SchemaVersion,
            State = "active",
            StartupId = heartbeat.StartupId,
            SessionId = heartbeat.SessionId,
            RuntimeToken = runtimeToken,
            HeartbeatAfterSeconds = heartbeat.HeartbeatAfterSeconds,
            ExpiresAt = heartbeat.ExpiresAt,
            Plan = heartbeat.Plan,
            Features = heartbeat.Features,
            ConcurrencyLimit = heartbeat.ConcurrencyLimit,
            ActiveSessions = heartbeat.ActiveSessions,
            BrowserVersion = heartbeat.BrowserVersion,
            AutomationBackend = heartbeat.AutomationBackend,
            LeaseEnvelope = heartbeat.LeaseEnvelope,
            Claims = heartbeat.Claims,
        };
    }

    public async Task<RuntimeHeartbeatGrant> RuntimeHeartbeatAsync(
        RuntimeActivationGrant grant,
        CancellationToken cancellationToken = default)
    {
        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            $"/v2/runtime/sessions/{Uri.EscapeDataString(grant.SessionId)}/heartbeat",
            $"Runtime {grant.RuntimeToken}",
            null,
            cancellationToken);
        return RuntimeHeartbeatGrantFrom(
            response.RootElement.Clone(),
            grant.StartupId,
            grant.SessionId,
            grant.BrowserVersion,
            grant.Claims.DeviceHash,
            grant.AutomationBackend);
    }

    public async Task<RuntimeHeartbeatGrant> CloseRuntimeSessionAsync(
        RuntimeActivationGrant grant,
        CancellationToken cancellationToken = default)
    {
        using JsonDocument response = await RequestJsonAsync(
            HttpMethod.Post,
            $"/v2/runtime/sessions/{Uri.EscapeDataString(grant.SessionId)}/close",
            $"Runtime {grant.RuntimeToken}",
            null,
            cancellationToken);
        return RuntimeHeartbeatGrantFrom(
            response.RootElement.Clone(),
            grant.StartupId,
            grant.SessionId,
            grant.BrowserVersion,
            grant.Claims.DeviceHash,
            grant.AutomationBackend);
    }

    public async Task ReleaseAsync(LicensedSessionGrant grant, CancellationToken cancellationToken = default)
    {
        await RequestAsync(
            HttpMethod.Delete,
            $"/v1/licenses/sessions/{Uri.EscapeDataString(grant.SessionId)}",
            $"Session {grant.SessionToken}",
            null,
            cancellationToken);
    }

    public async Task ReleaseRuntimeSessionAsync(RuntimeSessionGrant grant, CancellationToken cancellationToken = default)
    {
        await RequestAsync(
            HttpMethod.Delete,
            $"/v2/runtime/sessions/{Uri.EscapeDataString(grant.SessionId)}",
            $"Bootstrap {grant.BootstrapToken}",
            null,
            cancellationToken);
    }

    public async Task ReleaseRuntimeSessionAsync(RuntimeActivationGrant grant, CancellationToken cancellationToken = default)
    {
        await RequestAsync(
            HttpMethod.Delete,
            $"/v2/runtime/sessions/{Uri.EscapeDataString(grant.SessionId)}",
            $"Runtime {grant.RuntimeToken}",
            null,
            cancellationToken);
    }

    public async Task DownloadArtifactAsync(
        LicensedSessionGrant grant,
        string destination,
        CancellationToken cancellationToken = default)
    {
        using HttpRequestMessage request = new(HttpMethod.Get, grant.Artifact.Url);
        request.Headers.Authorization = AuthenticationHeaderValue.Parse($"Session {grant.SessionToken}");
        using HttpResponseMessage response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) await ThrowResponseAsync(response, cancellationToken);
        await using Stream input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using FileStream output = new(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
        await input.CopyToAsync(output, cancellationToken);
    }

    public async Task DownloadRuntimeArtifactAsync(
        RuntimeSessionGrant grant,
        string destination,
        CancellationToken cancellationToken = default)
    {
        using HttpRequestMessage request = new(HttpMethod.Get, RuntimeArtifactUri(grant));
        request.Headers.Authorization = AuthenticationHeaderValue.Parse($"Download {grant.DownloadTicket.Token}");
        using HttpResponseMessage response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode) await ThrowResponseAsync(response, cancellationToken);
        await using Stream input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using FileStream output = new(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
        await input.CopyToAsync(output, cancellationToken);
    }

    private RuntimeHeartbeatGrant RuntimeHeartbeatGrantFrom(
        JsonElement root,
        string startupId,
        string sessionId,
        string browserVersion,
        string? deviceHash,
        AutomationBackend? automationBackend)
    {
        if (RequiredInteger(root, "schemaVersion", "license_service_invalid_response") != 2 ||
            RequiredString(root, "startupId", "license_service_invalid_response") != startupId ||
            RequiredString(root, "sessionId", "license_service_invalid_response") != sessionId)
            throw Fail("license_service_invalid_response", "Runtime heartbeat response is invalid");
        string state = RequiredString(root, "state", "license_service_invalid_response");
        if (state is not ("reserved" or "active" or "closing"))
            throw Fail("license_service_invalid_response", "Runtime session state is invalid");
        long expiresAt = RequiredInteger(root, "expiresAt", "license_service_invalid_response");
        int heartbeat = checked((int)RequiredInteger(root, "heartbeatAfterSeconds", "license_service_invalid_response"));
        string leaseEnvelope = RawJson(root, "lease");
        LicenseClaims claims = _licenseVerifier.Verify(
            leaseEnvelope,
            browserVersion,
            requiredFeatures: RequiredLeaseFeatures(automationBackend),
            deviceHash: deviceHash);
        if (claims.SessionId != sessionId || claims.ExpiresAt != expiresAt)
            throw Fail("license_service_invalid_response", "Runtime heartbeat lease does not match the active session");
        string plan = RequiredString(root, "plan", "license_service_invalid_response");
        int concurrency = checked((int)RequiredInteger(root, "concurrencyLimit", "license_service_invalid_response"));
        int active = checked((int)RequiredInteger(root, "activeSessions", "license_service_invalid_response"));
        if (!Plans.Contains(plan))
            throw Fail("license_service_invalid_response", "Runtime heartbeat plan response is invalid");
        IReadOnlyList<string> features = ResponseFeatures(root, claims);
        AssertClaimsMatchPlan(claims, plan, concurrency, features);
        return new RuntimeHeartbeatGrant
        {
            SchemaVersion = 2,
            State = state,
            StartupId = startupId,
            SessionId = sessionId,
            HeartbeatAfterSeconds = heartbeat,
            ExpiresAt = expiresAt,
            Plan = plan,
            Features = features,
            ConcurrencyLimit = concurrency,
            ActiveSessions = active,
            BrowserVersion = browserVersion,
            AutomationBackend = automationBackend,
            LeaseEnvelope = leaseEnvelope,
            Claims = claims,
        };
    }

    private async Task<JsonDocument> RequestJsonAsync(
        HttpMethod method,
        string path,
        string authorization,
        object? body,
        CancellationToken cancellationToken)
    {
        HttpResponseMessage response = await RequestAsync(method, path, authorization, body, cancellationToken);
        try
        {
            await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        }
        catch (JsonException exception)
        {
            throw Fail("license_service_invalid_response", "License service returned invalid JSON", (int)response.StatusCode, exception);
        }
    }

    private async Task<HttpResponseMessage> RequestAsync(
        HttpMethod method,
        string path,
        string authorization,
        object? body,
        CancellationToken cancellationToken)
    {
        Uri endpoint = new($"{Authorization.ServiceUrl}{path}");
        using HttpRequestMessage request = new(method, endpoint);
        request.Headers.Authorization = AuthenticationHeaderValue.Parse(authorization);
        if (body is not null)
        {
            request.Content = new StringContent(
                JsonSerializer.Serialize(body, new JsonSerializerOptions { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull }),
                Encoding.UTF8,
                "application/json");
        }
        HttpResponseMessage response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NoContent) return response;
        if (!response.IsSuccessStatusCode) await ThrowResponseAsync(response, cancellationToken);
        return response;
    }

    private static async Task ThrowResponseAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        string code = "license_service_error";
        Dictionary<string, object?> details = new(StringComparer.Ordinal);
        try
        {
            await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using JsonDocument document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
            if (document.RootElement.TryGetProperty("error", out JsonElement error))
            {
                if (error.TryGetProperty("code", out JsonElement remoteCode) && remoteCode.ValueKind == JsonValueKind.String)
                    code = SafeRemoteErrorCode(remoteCode.GetString());
                if (error.ValueKind == JsonValueKind.Object)
                    details = SafeErrorDetails(error);
            }
        }
        catch (JsonException) { }
        string message = RemoteErrorMessage((int)response.StatusCode, code);
        throw Fail(code, message, (int)response.StatusCode, details: details);
    }

    private static string SafeRemoteErrorCode(string? code) =>
        code is not null && Regex.IsMatch(code, "^[a-z0-9_]{2,96}$")
            ? code
            : "license_service_error";

    private static string RemoteErrorMessage(int status, string code) =>
        code == "license_plan_expired"
            ? "The SlyBrowser paid plan has expired. Renew the plan before starting SlyBrowser."
            : $"License service request failed with HTTP {status} ({code})";

    private static Dictionary<string, object?> SafeErrorDetails(JsonElement error)
    {
        Dictionary<string, object?> details = new(StringComparer.Ordinal);
        foreach (JsonProperty property in error.EnumerateObject())
        {
            if (SafeErrorDetailFields.Contains(property.Name))
            {
                object? safeValue = SafeErrorDetailValue(property.Name, property.Value);
                if (safeValue is not null) details[property.Name] = safeValue;
            }
            else if (property.Name == "actions" && property.Value.ValueKind == JsonValueKind.Array)
            {
                List<object?> actions = SafeErrorActions(property.Value);
                if (actions.Count > 0) details["actions"] = actions;
            }
        }
        return details;
    }

    private static object? SafeErrorDetailValue(string key, JsonElement value)
    {
        if (key is "concurrencyLimit" or "activeSessions" or "availableSessions" or "retryAfterSeconds")
            return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long numeric) ? numeric : null;
        if (value.ValueKind != JsonValueKind.String) return null;
        string? text = value.GetString();
        return text is not null && Regex.IsMatch(text, "^[a-z0-9_:-]{1,96}$") ? text : null;
    }

    private static List<object?> SafeErrorActions(JsonElement value)
    {
        List<object?> actions = [];
        foreach (JsonElement action in value.EnumerateArray())
        {
            if (action.ValueKind != JsonValueKind.Object) continue;
            Dictionary<string, object?> sanitized = new(StringComparer.Ordinal);
            if (action.TryGetProperty("type", out JsonElement type) &&
                type.ValueKind == JsonValueKind.String &&
                type.GetString() is string typeText &&
                Regex.IsMatch(typeText, "^[a-z0-9_:-]{1,96}$"))
                sanitized["type"] = typeText;
            if (action.TryGetProperty("url", out JsonElement url) &&
                url.ValueKind == JsonValueKind.String &&
                url.GetString() is string urlText &&
                urlText.StartsWith("https://slybrowser.com/", StringComparison.Ordinal))
                sanitized["url"] = urlText;
            if (sanitized.Count > 0) actions.Add(sanitized);
        }
        return actions;
    }

    private static LicenseAuthorization ParseAuthorization(object value, bool allowInsecureLocalhost)
    {
        if (value is JsonElement element)
        {
            if (element.ValueKind != JsonValueKind.Object ||
                !PropertySet(element).SetEquals(["channel", "licenseKey", "schemaVersion", "serviceUrl"]) ||
                RequiredInteger(element, "schemaVersion", "authorization_invalid") != 1 ||
                RequiredString(element, "channel", "authorization_invalid") != "stable")
                throw Fail("authorization_invalid", "Authorization file fields are invalid");
            return ValidateAuthorization(
                RequiredString(element, "serviceUrl", "authorization_invalid"),
                RequiredString(element, "licenseKey", "authorization_invalid"),
                allowInsecureLocalhost);
        }
        IReadOnlyDictionary<string, object?> dictionary = (IReadOnlyDictionary<string, object?>)value;
        return ValidateAuthorization(
            Convert.ToString(dictionary["serviceUrl"]) ?? "",
            Convert.ToString(dictionary["licenseKey"]) ?? "",
            allowInsecureLocalhost);
    }

    private static LicenseAuthorization ValidateAuthorization(string serviceUrl, string licenseKey, bool allowInsecureLocalhost)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(licenseKey, @"^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$"))
            throw Fail("authorization_invalid", "Authorization key format is invalid");
        if (!Uri.TryCreate(serviceUrl, UriKind.Absolute, out Uri? url))
            throw Fail("authorization_invalid", "Authorization service URL is invalid");
        bool local = url.Host is "127.0.0.1" or "localhost" or "::1";
        if (url.Scheme != Uri.UriSchemeHttps && !(allowInsecureLocalhost && local && url.Scheme == Uri.UriSchemeHttp))
            throw Fail("authorization_invalid", "Authorization service URL must use HTTPS");
        return new LicenseAuthorization(url.ToString().TrimEnd('/'), licenseKey);
    }

    private static string AutomationBackendValue(AutomationBackend value) => value switch
    {
        AutomationBackend.ProjectWebDriver => "project-webdriver",
        AutomationBackend.Playwright => "playwright",
        _ => throw Fail("automation_backend_unsupported", "Automation backend is unsupported"),
    };

    private static string NewStartupId() => $"st_{Guid.NewGuid():N}";

    private static object NormalizeKernelMajor(string? value)
    {
        if (string.IsNullOrEmpty(value) || value == "latest") return "latest";
        if (int.TryParse(value, out int major) && major > 0) return major;
        throw Fail("version_policy_invalid", "KernelMajor must be a positive integer or latest");
    }

    private static int BrowserMajor(string browserVersion) => int.Parse(browserVersion.Split('.')[0]);

    private static object? OptionalKernelMajor(JsonElement root)
    {
        if (!root.TryGetProperty("requestedKernelMajor", out JsonElement value)) return null;
        if (value.ValueKind == JsonValueKind.String && value.GetString() == "latest") return "latest";
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out int major) && major > 0) return major;
        throw Fail("license_service_invalid_response", "License service requested-kernel response is invalid");
    }

    private static string? OptionalSelectionMode(JsonElement root)
    {
        if (!root.TryGetProperty("selectionMode", out JsonElement value)) return null;
        if (value.ValueKind != JsonValueKind.String)
            throw Fail("license_service_invalid_response", "License service selection-mode response is invalid");
        string mode = value.GetString() ?? "";
        if (mode is "latest" or "latest-in-major" or "cached-approved" or "exact" or "rollback") return mode;
        throw Fail("license_service_invalid_response", "License service selection-mode response is invalid");
    }

    private static string? OptionalVersion(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value)) return null;
        if (value.ValueKind == JsonValueKind.String)
        {
            string version = value.GetString() ?? "";
            if (Regex.IsMatch(version, @"^\d+(?:\.\d+){0,7}$")) return version;
        }
        throw Fail("license_service_invalid_response", $"License service {name} response is invalid");
    }

    private static bool? OptionalBoolean(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value)) return null;
        if (value.ValueKind == JsonValueKind.True) return true;
        if (value.ValueKind == JsonValueKind.False) return false;
        throw Fail("license_service_invalid_response", $"License service {name} response is invalid");
    }

    private static Uri RuntimeArtifactUri(RuntimeSessionGrant grant)
    {
        UriBuilder builder = new(grant.DownloadTicket.ArtifactUrl);
        if (builder.Path.StartsWith("/v1/releases/artifacts/", StringComparison.Ordinal))
            builder.Path = builder.Path.Replace("/v1/releases/artifacts/", "/v2/runtime/artifacts/", StringComparison.Ordinal);
        if (!builder.Path.StartsWith("/v2/runtime/artifacts/", StringComparison.Ordinal))
            throw Fail("license_service_invalid_response", "Runtime artifact URL is invalid");
        return builder.Uri;
    }

    private static string Origin(string url) => new Uri(url).GetLeftPart(UriPartial.Authority);

    private static IReadOnlyList<string> RequiredLeaseFeatures(AutomationBackend? backend)
    {
        List<string> features = ["browser", "release-download", "webdriver"];
        if (backend == AutomationBackend.Playwright)
            features.Add("playwright");
        return features;
    }

    private static IReadOnlyList<string> ResponseFeatures(JsonElement root, LicenseClaims claims)
    {
        IReadOnlyList<string> features =
            root.TryGetProperty("features", out JsonElement element) && element.ValueKind != JsonValueKind.Null
                ? ReadStringArray(element)
                : claims.Features;
        if (features.Count == 0 || features.Count != features.Distinct(StringComparer.Ordinal).Count())
            throw Fail("license_service_invalid_response", "License service feature response is invalid");
        return features;
    }

    private static void AssertClaimsMatchPlan(
        LicenseClaims claims,
        string plan,
        int concurrencyLimit,
        IReadOnlyList<string> features)
    {
        if (claims.PlanId is not null && !StringComparer.Ordinal.Equals(claims.PlanId, plan))
            throw Fail("license_service_invalid_response", "Signed lease plan does not match the service response");
        if (claims.ConcurrencyLimit is not null && claims.ConcurrencyLimit.Value != concurrencyLimit)
            throw Fail("license_service_invalid_response", "Signed lease concurrency limit does not match the service response");
        if (!SameStringSet(claims.Features, features))
            throw Fail("license_service_invalid_response", "Signed lease features do not match the service response");
    }

    private static bool SameStringSet(IReadOnlyList<string> left, IReadOnlyList<string> right) =>
        left.Count == right.Count && left.ToHashSet(StringComparer.Ordinal).SetEquals(right);

    private static string CurrentPlatform()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsLinux()) return "linux";
        if (OperatingSystem.IsMacOS()) return "macos";
        throw Fail("platform_unsupported", "Unsupported platform");
    }

    private static string CurrentArch()
    {
        if (System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.X64) return "x64";
        if (System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.Arm64) return "arm64";
        throw Fail("platform_unsupported", "Unsupported architecture");
    }

    private static string RawJson(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || element.ValueKind != JsonValueKind.Object)
            throw Fail("license_service_invalid_response", "License service response field is invalid");
        return element.GetRawText();
    }

    private static IReadOnlyList<string> ReadStringArray(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || element.ValueKind != JsonValueKind.Array)
            throw Fail("license_service_invalid_response", "License service array response is invalid");
        return ReadStringArray(element);
    }

    private static IReadOnlyList<string> ReadStringArray(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Array)
            throw Fail("license_service_invalid_response", "License service array response is invalid");
        List<string> values = [];
        foreach (JsonElement item in element.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(item.GetString()))
                throw Fail("license_service_invalid_response", "License service array response is invalid");
            values.Add(item.GetString()!);
        }
        return values;
    }

    private static Dictionary<string, object?> ReadUpdateRights(JsonElement root)
    {
        if (!root.TryGetProperty("updateRights", out JsonElement rights) || rights.ValueKind != JsonValueKind.Object ||
            RequiredString(rights, "status", "license_service_invalid_response") != "active" ||
            RequiredString(rights, "channel", "license_service_invalid_response") != "stable" ||
            !rights.TryGetProperty("exactVersion", out JsonElement exact) || exact.ValueKind != JsonValueKind.True ||
            !rights.TryGetProperty("rollback", out JsonElement rollback) || rollback.ValueKind != JsonValueKind.True)
            throw Fail("license_service_invalid_response", "License service update-rights response is invalid");
        object? updatesThrough = rights.TryGetProperty("updatesThrough", out JsonElement updates)
            ? updates.ValueKind == JsonValueKind.Null ? null : updates.GetInt64()
            : throw Fail("license_service_invalid_response", "License service update-rights response is invalid");
        return new Dictionary<string, object?> { ["status"] = "active", ["channel"] = "stable", ["updatesThrough"] = updatesThrough, ["exactVersion"] = true, ["rollback"] = true };
    }

    private static string RequiredString(JsonElement root, string name, string code)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || element.ValueKind != JsonValueKind.String)
            throw Fail(code, "License service response field is invalid");
        string? value = element.GetString();
        if (string.IsNullOrEmpty(value)) throw Fail(code, "License service response field is invalid");
        return value;
    }

    private static string? OptionalString(JsonElement root, string name, string code)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || element.ValueKind == JsonValueKind.Null)
            return null;
        if (element.ValueKind != JsonValueKind.String) throw Fail(code, "License service response field is invalid");
        string? value = element.GetString();
        if (string.IsNullOrEmpty(value)) throw Fail(code, "License service response field is invalid");
        return value;
    }

    private static long RequiredInteger(JsonElement root, string name, string code)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || !element.TryGetInt64(out long value))
            throw Fail(code, "License service response field is invalid");
        return value;
    }

    private static HashSet<string> PropertySet(JsonElement value) =>
        value.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);

    private static object? JsonValue(JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.Object:
                Dictionary<string, object?> map = new(StringComparer.Ordinal);
                foreach (JsonProperty property in value.EnumerateObject())
                    map[property.Name] = JsonValue(property.Value);
                return map;
            case JsonValueKind.Array:
                List<object?> list = [];
                foreach (JsonElement item in value.EnumerateArray())
                    list.Add(JsonValue(item));
                return list;
            case JsonValueKind.String:
                return value.GetString();
            case JsonValueKind.Number:
                return value.TryGetInt64(out long integer) ? integer : value.GetDouble();
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Null:
                return null;
            default:
                return value.GetRawText();
        }
    }

    private static LicenseServiceException Fail(
        string code,
        string message,
        int status = 0,
        Exception? exception = null,
        IReadOnlyDictionary<string, object?>? details = null) =>
        new(message, code, status, exception, details);

    public void Dispose()
    {
        if (_ownsHttpClient) _http.Dispose();
        GC.SuppressFinalize(this);
    }

    ~LicenseServiceClient()
    {
        if (_ownsHttpClient) _http.Dispose();
    }
}
