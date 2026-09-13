using System.Text;
using System.Text.Json;

namespace SlyBrowser;

public sealed class LaunchPlan : IDisposable, IAsyncDisposable
{
    private bool _disposed;

    public string Executable { get; }
    public IReadOnlyList<string> Arguments { get; }
    public string ConfigFile { get; }
    public string LicenseFile { get; }
    public string? RuntimeFile { get; }
    public string? ReleaseRoot { get; }
    public string? HumanizeConfigFile { get; }
    public string? NativeReadyRequestFile { get; }
    public string? NativeReadyFile { get; }
    public string? NativeReadyNonce { get; }

    internal LaunchPlan(
        string executable,
        IReadOnlyList<string> arguments,
        string configFile,
        string licenseFile,
        string? runtimeFile = null,
        string? releaseRoot = null,
        string? humanizeConfigFile = null,
        string? nativeReadyRequestFile = null,
        string? nativeReadyFile = null,
        string? nativeReadyNonce = null)
    {
        Executable = executable;
        Arguments = arguments;
        ConfigFile = configFile;
        LicenseFile = licenseFile;
        RuntimeFile = runtimeFile;
        ReleaseRoot = releaseRoot;
        HumanizeConfigFile = humanizeConfigFile;
        NativeReadyRequestFile = nativeReadyRequestFile;
        NativeReadyFile = nativeReadyFile;
        NativeReadyNonce = nativeReadyNonce;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (NativeReadyRequestFile is not null) TryDelete(NativeReadyRequestFile);
        if (NativeReadyFile is not null) TryDelete(NativeReadyFile);
        if (HumanizeConfigFile is not null) TryDelete(HumanizeConfigFile);
        if (RuntimeFile is not null) TryDelete(RuntimeFile);
        TryDelete(LicenseFile);
        TryDelete(ConfigFile);
        GC.SuppressFinalize(this);
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (FileNotFoundException) { }
    }

    public async Task WaitForNativeReadyAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (NativeReadyFile is null || NativeReadyNonce is null) return;
        if (timeout <= TimeSpan.Zero)
            throw new ConfigurationException("NativeReadyTimeout must be positive", "config_invalid");
        DateTimeOffset deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (NativeReadyObserved()) return;
            TimeSpan remaining = deadline - DateTimeOffset.UtcNow;
            await Task.Delay(remaining < TimeSpan.FromMilliseconds(50)
                ? remaining
                : TimeSpan.FromMilliseconds(50), cancellationToken);
        }
        throw new ConfigurationException("SlyBrowser did not report native-ready before returning", "native_ready_timeout");
    }

    private bool NativeReadyObserved()
    {
        if (NativeReadyFile is null || NativeReadyNonce is null || !File.Exists(NativeReadyFile)) return false;
        string text = File.ReadAllText(NativeReadyFile);
        if (string.IsNullOrWhiteSpace(text)) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(text);
            JsonElement root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object &&
                root.TryGetProperty("schemaVersion", out JsonElement schema) &&
                schema.GetInt32() == 1 &&
                root.TryGetProperty("kind", out JsonElement kind) &&
                kind.GetString() == "slybrowser.native-ready" &&
                root.TryGetProperty("ready", out JsonElement ready) &&
                ready.ValueKind == JsonValueKind.True &&
                root.TryGetProperty("nonce", out JsonElement nonce) &&
                nonce.GetString() == NativeReadyNonce)
                return true;
        }
        catch (JsonException)
        {
            return false;
        }
        throw new ConfigurationException("Native-ready marker is invalid", "native_ready_invalid");
    }
}

public static class SlyBrowserLauncher
{
    private static void ValidateFingerprintProfile(JsonElement root)
    {
        JsonElement profile = root.TryGetProperty("profile", out JsonElement nested) && nested.ValueKind == JsonValueKind.Object ? nested : root;
        bool hasMode = profile.TryGetProperty("fingerprintMode", out JsonElement modeValue);
        bool hasSeed = profile.TryGetProperty("fingerprintSeed", out JsonElement seedValue);
        bool hasSchema = profile.TryGetProperty("fingerprintSchemaVersion", out JsonElement schemaValue);
        if (!hasMode && !hasSeed && !hasSchema) return;
        string mode = hasMode && modeValue.ValueKind == JsonValueKind.String ? modeValue.GetString()! : hasMode ? "" : "seeded";
        if (mode is not ("explicit" or "seeded"))
            throw new ConfigurationException("profile.fingerprintMode is invalid", "profile_invalid");
        if (hasSeed && (seedValue.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(seedValue.GetString()) || seedValue.GetString()!.Length > 128))
            throw new ConfigurationException("profile.fingerprintSeed is invalid", "profile_invalid");
        if (hasSchema && (schemaValue.ValueKind != JsonValueKind.Number || !schemaValue.TryGetInt32(out int schema) || schema != 1))
            throw new ConfigurationException("profile.fingerprintSchemaVersion is unsupported", "profile_invalid");
        if (mode == "explicit" && (hasSeed || hasSchema))
            throw new ConfigurationException("profile.fingerprintSeed requires seeded fingerprint mode", "profile_invalid");
        if (mode == "seeded" && (!hasSeed || !hasSchema))
            throw new ConfigurationException("Seeded fingerprint mode requires seed and schema version", "profile_invalid");
    }
    public static Task<LaunchPlan> PrepareAsync(
        string executable,
        object options,
        string licenseEnvelope,
        string? tempRoot,
        IEnumerable<string>? extraArguments,
        object? humanizeControl,
        CancellationToken cancellationToken) =>
        PrepareAsync(
            executable,
            options,
            licenseEnvelope,
            tempRoot,
            extraArguments,
            humanizeControl,
            runtimeHandoff: null,
            nativeReady: false,
            cancellationToken: cancellationToken);

    public static async Task<LaunchPlan> PrepareAsync(
        string executable,
        object options,
        string licenseEnvelope,
        string? tempRoot = null,
        IEnumerable<string>? extraArguments = null,
        object? humanizeControl = null,
        object? runtimeHandoff = null,
        bool nativeReady = false,
        bool allowRuntimeActivationTicket = false,
        string? releaseRoot = null,
        CancellationToken cancellationToken = default)
    {
        string executablePath = Path.GetFullPath(executable);
        if (!File.Exists(executablePath))
            throw new ConfigurationException("Browser executable does not exist", "browser_missing");
        string[] extra = (extraArguments ?? Array.Empty<string>()).ToArray();
        if (extra.Any(IsForbiddenSecretArgument))
            throw new ConfigurationException(
                "License and runtime material must not be passed in extra browser arguments",
                "license_argument_forbidden");

        byte[] config = JsonSerializer.SerializeToUtf8Bytes(options);
        using (JsonDocument configDocument = JsonDocument.Parse(config))
        {
            if (configDocument.RootElement.ValueKind != JsonValueKind.Object)
                throw new ConfigurationException("Launch options must be an object", "config_invalid");
            if (configDocument.RootElement.TryGetProperty("licenseKey", out _) ||
                configDocument.RootElement.TryGetProperty("runtimeToken", out _) ||
                configDocument.RootElement.TryGetProperty("bootstrapToken", out _) ||
                configDocument.RootElement.TryGetProperty("activationTicket", out _) ||
                configDocument.RootElement.TryGetProperty("downloadTicket", out _))
                throw new ConfigurationException(
                    "License and runtime secrets must never be placed in the browser profile handoff",
                    "profile_secret_forbidden");
            ValidateFingerprintProfile(configDocument.RootElement);
        }
        byte[] lease = Encoding.UTF8.GetBytes(licenseEnvelope);
        if (config.Length > 1024 * 1024)
            throw new ConfigurationException("Launch configuration is too large", "config_too_large");
        if (lease.Length is 0 or > 64 * 1024)
            throw new ConfigurationException("License lease is missing or too large", "license_invalid_envelope");

        string root = Path.GetFullPath(tempRoot ?? Path.GetTempPath());
        string? releaseRootPath = string.IsNullOrWhiteSpace(releaseRoot) ? null : Path.GetFullPath(releaseRoot);
        Directory.CreateDirectory(root);
        string configFile = await WritePrivateFileAsync(root, "sly-config-", config, cancellationToken);
        string? licenseFile = null;
        string? runtimeFile = null;
        string? humanizeConfigFile = null;
        string? nativeReadyRequestFile = null;
        string? nativeReadyFile = null;
        string? nativeReadyNonce = null;
        try
        {
            licenseFile = await WritePrivateFileAsync(root, "sly-license-", lease, cancellationToken);
            if (runtimeHandoff is not null)
            {
                byte[] runtime = SerializeRuntimeHandoff(runtimeHandoff, allowRuntimeActivationTicket);
                if (runtime.Length is 0 or > 64 * 1024)
                    throw new ConfigurationException("Runtime handoff file is missing or too large", "runtime_handoff_invalid");
                runtimeFile = await WritePrivateFileAsync(root, "sly-runtime-", runtime, cancellationToken);
            }
            if (humanizeControl is not null)
            {
                byte[] humanize = JsonSerializer.SerializeToUtf8Bytes(humanizeControl);
                if (humanize.Length > 64 * 1024)
                    throw new ConfigurationException("Native Humanize control file is too large", "humanize_config_too_large");
                humanizeConfigFile = await WritePrivateFileAsync(root, "sly-humanize-", humanize, cancellationToken);
            }
            if (nativeReady)
            {
                nativeReadyNonce = Guid.NewGuid().ToString("N");
                nativeReadyFile = await WritePrivateFileAsync(root, "sly-native-ready-", [], cancellationToken);
                byte[] request = JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object?>
                {
                    ["schemaVersion"] = 1,
                    ["kind"] = "slybrowser.native-ready-request",
                    ["readyFile"] = nativeReadyFile,
                    ["nonce"] = nativeReadyNonce,
                });
                nativeReadyRequestFile = await WritePrivateFileAsync(root, "sly-native-ready-request-", request, cancellationToken);
            }
        }
        catch
        {
            if (nativeReadyRequestFile is not null) File.Delete(nativeReadyRequestFile);
            if (nativeReadyFile is not null) File.Delete(nativeReadyFile);
            if (humanizeConfigFile is not null) File.Delete(humanizeConfigFile);
            if (runtimeFile is not null) File.Delete(runtimeFile);
            if (licenseFile is not null) File.Delete(licenseFile);
            File.Delete(configFile);
            throw;
        }
        List<string> arguments =
        [
            $"--sly-config-file={configFile}",
            $"--sly-license-file={licenseFile}",
            .. (runtimeFile is null ? Array.Empty<string>() : [$"--sly-runtime-file={runtimeFile}"]),
            .. (releaseRootPath is null ? Array.Empty<string>() : [$"--sly-release-root={releaseRootPath}"]),
            .. (humanizeConfigFile is null ? Array.Empty<string>() : [$"--sly-humanize-config={humanizeConfigFile}"]),
            .. (nativeReadyRequestFile is null ? Array.Empty<string>() : [$"--sly-native-ready-request-file={nativeReadyRequestFile}"]),
            .. extra,
        ];
        return new LaunchPlan(
            executablePath,
            arguments,
            configFile,
            licenseFile!,
            runtimeFile,
            releaseRootPath,
            humanizeConfigFile,
            nativeReadyRequestFile,
            nativeReadyFile,
            nativeReadyNonce);
    }

    private static bool IsForbiddenSecretArgument(string argument)
    {
        int equalsIndex = argument.IndexOf('=');
        if (equalsIndex < 0) return false;
        string switchName = argument[..equalsIndex];
        return switchName.Contains("license", StringComparison.OrdinalIgnoreCase) ||
               switchName.Contains("runtime", StringComparison.OrdinalIgnoreCase);
    }

    internal static byte[] SerializeRuntimeHandoff(object runtimeHandoff, bool allowRuntimeActivationTicket = false)
    {
        byte[] runtime = JsonSerializer.SerializeToUtf8Bytes(runtimeHandoff);
        using JsonDocument runtimeDocument = JsonDocument.Parse(runtime);
        JsonElement root = runtimeDocument.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            root.TryGetProperty("licenseKey", out _) ||
            root.TryGetProperty("runtimeToken", out _) ||
            (!allowRuntimeActivationTicket && root.TryGetProperty("activationTicket", out _)) ||
            root.TryGetProperty("downloadTicket", out _))
            throw new ConfigurationException(
                "Runtime handoff must not contain long-lived keys, runtime tokens or download tickets",
                "runtime_handoff_secret_forbidden");
        return runtime;
    }

    private static async Task<string> WritePrivateFileAsync(
        string directory,
        string prefix,
        byte[] payload,
        CancellationToken cancellationToken)
    {
        string path = Path.Combine(directory, $"{prefix}{Guid.NewGuid():N}.json");
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
}
