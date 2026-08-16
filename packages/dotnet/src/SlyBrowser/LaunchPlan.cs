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

    internal LaunchPlan(string executable, IReadOnlyList<string> arguments, string configFile, string licenseFile)
    {
        Executable = executable;
        Arguments = arguments;
        ConfigFile = configFile;
        LicenseFile = licenseFile;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
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
}

public static class SlyBrowserLauncher
{
    public static async Task<LaunchPlan> PrepareAsync(
        string executable,
        object options,
        string licenseEnvelope,
        string? tempRoot = null,
        IEnumerable<string>? extraArguments = null,
        CancellationToken cancellationToken = default)
    {
        string executablePath = Path.GetFullPath(executable);
        if (!File.Exists(executablePath))
            throw new ConfigurationException("Browser executable does not exist", "browser_missing");
        string[] extra = (extraArguments ?? Array.Empty<string>()).ToArray();
        if (extra.Any(argument => argument.Contains("license", StringComparison.OrdinalIgnoreCase) && argument.Contains('=')))
            throw new ConfigurationException(
                "License material must not be passed in extra browser arguments",
                "license_argument_forbidden");

        byte[] config = JsonSerializer.SerializeToUtf8Bytes(options);
        using (JsonDocument configDocument = JsonDocument.Parse(config))
        {
            if (configDocument.RootElement.ValueKind != JsonValueKind.Object)
                throw new ConfigurationException("Launch options must be an object", "config_invalid");
            if (configDocument.RootElement.TryGetProperty("licenseKey", out _))
                throw new ConfigurationException(
                    "A long-lived license key must never be placed in the browser profile handoff",
                    "profile_secret_forbidden");
        }
        byte[] lease = Encoding.UTF8.GetBytes(licenseEnvelope);
        if (config.Length > 1024 * 1024)
            throw new ConfigurationException("Launch configuration is too large", "config_too_large");
        if (lease.Length is 0 or > 64 * 1024)
            throw new ConfigurationException("License lease is missing or too large", "license_invalid_envelope");

        string root = Path.GetFullPath(tempRoot ?? Path.GetTempPath());
        Directory.CreateDirectory(root);
        string configFile = await WritePrivateFileAsync(root, "sly-config-", config, cancellationToken);
        string licenseFile;
        try { licenseFile = await WritePrivateFileAsync(root, "sly-license-", lease, cancellationToken); }
        catch
        {
            File.Delete(configFile);
            throw;
        }
        List<string> arguments =
        [
            $"--sly-config-file={configFile}",
            $"--sly-license-file={licenseFile}",
            .. extra,
        ];
        return new LaunchPlan(executablePath, arguments, configFile, licenseFile);
    }

    private static async Task<string> WritePrivateFileAsync(
        string directory,
        string prefix,
        byte[] payload,
        CancellationToken cancellationToken)
    {
        string path = Path.Combine(directory, $"{prefix}{Guid.NewGuid():N}.json");
        await using FileStream stream = new(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough | FileOptions.Asynchronous);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
        stream.Flush(true);
        return path;
    }
}
