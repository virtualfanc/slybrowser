using System.ComponentModel;
using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SlyBrowser;

public sealed record BrowserInstallation(
    string Version,
    string Platform,
    string Arch,
    string Root,
    string BrowserExecutable,
    string DriverExecutable,
    string ArtifactSha256);

public sealed record BrowserPruneResult(
    IReadOnlyList<string> Removed,
    IReadOnlyList<string> SkippedInUse,
    IReadOnlyList<string> Kept);

public sealed class BrowserInstallationReference : IAsyncDisposable, IDisposable
{
    private bool _released;

    internal BrowserInstallationReference(BrowserInstallation installation, string referenceFile)
    {
        Installation = installation;
        ReferenceFile = referenceFile;
    }

    public BrowserInstallation Installation { get; }
    public string ReferenceFile { get; }

    public void Release()
    {
        if (_released) return;
        _released = true;
        if (File.Exists(ReferenceFile)) File.Delete(ReferenceFile);
    }

    public void Dispose() => Release();

    public ValueTask DisposeAsync()
    {
        Release();
        return ValueTask.CompletedTask;
    }
}

public sealed class InstallOptions
{
    public string? CacheRoot { get; init; }
    public TimeSpan LockTimeout { get; init; } = TimeSpan.FromSeconds(60);
    public Func<string, string, CancellationToken, Task>? Extractor { get; init; }
}

public static class BrowserInstaller
{
    private const int Maximum7zEntries = 100_000;
    private static readonly TimeSpan InspectionTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ExtractionTimeout = TimeSpan.FromMinutes(5);

    public static async Task<BrowserInstallation> InstallGrantedBrowserAsync(
        LicenseServiceClient client,
        LicensedSessionGrant grant,
        InstallOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return await InstallGrantedBrowserAsync(
            InstallGrantView.From(grant),
            async (destination, token) => await client.DownloadArtifactAsync(grant, destination, token),
            options,
            cancellationToken);
    }

    public static async Task<BrowserInstallation> InstallGrantedBrowserAsync(
        LicenseServiceClient client,
        RuntimeSessionGrant grant,
        InstallOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        return await InstallGrantedBrowserAsync(
            InstallGrantView.From(grant),
            async (destination, token) => await client.DownloadRuntimeArtifactAsync(grant, destination, token),
            options,
            cancellationToken);
    }

    private static async Task<BrowserInstallation> InstallGrantedBrowserAsync(
        InstallGrantView grant,
        Func<string, CancellationToken, Task> downloader,
        InstallOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new InstallOptions();
        string cacheRoot = Path.GetFullPath(options.CacheRoot ?? DefaultCacheRoot());
        string identity = $"{grant.Platform}-{grant.Arch}-{grant.Artifact.Sha256[..16]}";
        string installRoot = Path.Combine(cacheRoot, "stable", grant.BrowserVersion, identity);
        BrowserInstallation? existing = await ReadInstallationAsync(installRoot, grant, cancellationToken);
        if (existing is not null) return existing;
        Directory.CreateDirectory(Path.GetDirectoryName(installRoot)!);
        string lockPath = $"{installRoot}.lock";
        await using IAsyncDisposable lockHandle = await AcquireLockAsync(lockPath, options.LockTimeout, cancellationToken);
        BrowserInstallation? raced = await ReadInstallationAsync(installRoot, grant, cancellationToken);
        if (raced is not null) return raced;

        string downloads = Path.Combine(cacheRoot, "downloads");
        Directory.CreateDirectory(downloads);
        string archive = Path.Combine(downloads, $"{grant.Artifact.Sha256}.{grant.Artifact.ArchiveFormat}");
        bool archiveValid = false;
        try
        {
            await ReleaseManifestVerifier.VerifyArtifactAsync(archive, grant.Artifact, cancellationToken);
            archiveValid = true;
        }
        catch (ArtifactException) { archiveValid = false; }
        if (!archiveValid)
        {
            QuarantinePath(archive);
            string temporaryArchive = $"{archive}.{Environment.ProcessId}.{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}.{Guid.NewGuid():N}.part";
            try
            {
                await downloader(temporaryArchive, cancellationToken);
                AssertDownloadedSize(temporaryArchive, grant.Artifact.Size);
                await ReleaseManifestVerifier.VerifyArtifactAsync(temporaryArchive, grant.Artifact, cancellationToken);
                File.Move(temporaryArchive, archive);
            }
            catch
            {
                if (File.Exists(temporaryArchive)) File.Delete(temporaryArchive);
                throw;
            }
        }
        await ReleaseManifestVerifier.VerifyArtifactAsync(archive, grant.Artifact, cancellationToken);
        string temporaryDirectory = Path.Combine(Path.GetDirectoryName(installRoot)!, $".extract-{Environment.ProcessId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(temporaryDirectory);
        try
        {
            if (options.Extractor is not null) await options.Extractor(archive, temporaryDirectory, cancellationToken);
            else await SafeExtractArchiveAsync(archive, temporaryDirectory, grant.Artifact.ArchiveFormat, MaximumExpandedBytes(grant.Artifact.Size), cancellationToken);
            (string browser, string driver) = await VerifyRuntimeAsync(temporaryDirectory, grant, cancellationToken);
            QuarantinePath(installRoot);
            Directory.Move(temporaryDirectory, installRoot);
            temporaryDirectory = "";
            BrowserInstallation installation = new(
                grant.BrowserVersion,
                grant.Platform,
                grant.Arch,
                installRoot,
                Path.Combine(installRoot, grant.Artifact.BrowserExecutable),
                Path.Combine(installRoot, grant.Artifact.DriverExecutable),
                grant.Artifact.Sha256);
            await File.WriteAllTextAsync(
                Path.Combine(installRoot, ".sly-install.json"),
                JsonSerializer.Serialize(installation, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine,
                cancellationToken);
            await WriteCurrentPointersAsync(cacheRoot, installation, cancellationToken);
            _ = browser;
            _ = driver;
            return installation;
        }
        finally
        {
            if (temporaryDirectory.Length > 0 && Directory.Exists(temporaryDirectory))
                Directory.Delete(temporaryDirectory, recursive: true);
        }
    }

    public static async Task<BrowserInstallation?> FindCurrentBrowserInstallationAsync(
        InstallOptions? options = null,
        string? platform = null,
        string? arch = null,
        string? kernelMajor = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new InstallOptions();
        string cacheRoot = Path.GetFullPath(options.CacheRoot ?? DefaultCacheRoot());
        string selectedPlatform = platform ?? CurrentPlatform();
        string selectedArch = arch ?? CurrentArch();
        string selectedKernel = string.IsNullOrEmpty(kernelMajor) ? "latest" : kernelMajor;
        if (selectedKernel != "latest" && (!int.TryParse(selectedKernel, out int major) || major <= 0))
            throw new ArtifactException("KernelMajor must be a positive integer or latest", "version_policy_invalid");
        string pointer = Path.Combine(cacheRoot, "stable", "current", $"{selectedPlatform}-{selectedArch}-{selectedKernel}.json");
        try
        {
            if (!File.Exists(pointer)) return null;
            using JsonDocument document = JsonDocument.Parse(await File.ReadAllTextAsync(pointer, cancellationToken));
            if (!document.RootElement.TryGetProperty("Root", out JsonElement root) &&
                !document.RootElement.TryGetProperty("root", out root))
                return null;
            string? rootPath = root.GetString();
            if (string.IsNullOrEmpty(rootPath)) return null;
            return await ReadLooseInstallationAsync(rootPath, selectedPlatform, selectedArch, selectedKernel, cancellationToken);
        }
        catch (IOException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static async Task<BrowserInstallationReference> AcquireBrowserInstallationReferenceAsync(
        BrowserInstallation installation,
        CancellationToken cancellationToken = default)
    {
        string root = Path.GetFullPath(installation.Root);
        string refs = Path.Combine(root, ".sly-refs");
        Directory.CreateDirectory(refs);
        string referenceFile = Path.Combine(refs, $"{Environment.ProcessId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{Guid.NewGuid():N}.json");
        string payload = JsonSerializer.Serialize(new
        {
            SchemaVersion = 1,
            ProcessId = Environment.ProcessId,
            AcquiredAt = DateTimeOffset.UtcNow,
            installation.Version,
            installation.Platform,
            installation.Arch,
            installation.ArtifactSha256,
            Root = root,
            BrowserExecutable = Path.GetFullPath(installation.BrowserExecutable),
            DriverExecutable = Path.GetFullPath(installation.DriverExecutable),
        }, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
        await File.WriteAllTextAsync(referenceFile, payload, cancellationToken);
        return new BrowserInstallationReference(installation, referenceFile);
    }

    public static async Task<IReadOnlyList<string>> ActiveBrowserInstallationReferencesAsync(
        BrowserInstallation installation,
        CancellationToken cancellationToken = default)
    {
        string root = Path.GetFullPath(installation.Root);
        string refs = Path.Combine(root, ".sly-refs");
        List<string> active = [];
        if (!Directory.Exists(refs)) return active;
        foreach (string referenceFile in Directory.EnumerateFiles(refs, "*.json"))
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(await File.ReadAllTextAsync(referenceFile, cancellationToken));
                JsonElement element = document.RootElement;
                string? referencedRoot = ReadString(element, "Root", "root");
                string? artifactSha256 = ReadString(element, "ArtifactSha256", "artifactSha256");
                if (referencedRoot is null ||
                    Path.GetFullPath(referencedRoot) != root ||
                    artifactSha256 != installation.ArtifactSha256)
                    continue;
                int processId = ReadInt(element, "ProcessId", "processId");
                if (ProcessIsAlive(processId)) active.Add(referenceFile);
                else DeleteReference(referenceFile);
            }
            catch
            {
                DeleteReference(referenceFile);
            }
        }
        return active;
    }

    public static async Task<bool> IsBrowserInstallationInUseAsync(
        BrowserInstallation installation,
        CancellationToken cancellationToken = default) =>
        (await ActiveBrowserInstallationReferencesAsync(installation, cancellationToken)).Count > 0;

    public static async Task<BrowserPruneResult> PruneBrowserInstallationsAsync(
        InstallOptions? options = null,
        string? platform = null,
        string? arch = null,
        string? kernelMajor = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new InstallOptions();
        string cacheRoot = Path.GetFullPath(options.CacheRoot ?? DefaultCacheRoot());
        string selectedPlatform = platform ?? CurrentPlatform();
        string selectedArch = arch ?? CurrentArch();
        string selectedKernel = string.IsNullOrEmpty(kernelMajor) ? "latest" : kernelMajor;
        if (selectedKernel != "latest" && (!int.TryParse(selectedKernel, out int major) || major <= 0))
            throw new ArtifactException("KernelMajor must be a positive integer or latest", "version_policy_invalid");
        string stable = Path.Combine(cacheRoot, "stable");
        HashSet<string> currentRoots = await CurrentInstallationRootsAsync(cacheRoot, cancellationToken);
        List<string> removed = [];
        List<string> skippedInUse = [];
        List<string> kept = [];
        if (!Directory.Exists(stable)) return new BrowserPruneResult(removed, skippedInUse, kept);
        foreach (string versionRoot in Directory.EnumerateDirectories(stable))
        {
            string version = Path.GetFileName(versionRoot);
            if (version == "current" ||
                !System.Text.RegularExpressions.Regex.IsMatch(version, @"^\d+(?:\.\d+){0,7}$") ||
                !MatchesKernelMajor(version, selectedKernel))
                continue;
            foreach (string root in Directory.EnumerateDirectories(versionRoot))
            {
                BrowserInstallation? installation = await ReadLooseInstallationAsync(
                    root,
                    selectedPlatform,
                    selectedArch,
                    selectedKernel,
                    cancellationToken);
                if (installation is null) continue;
                string normalizedRoot = Path.GetFullPath(installation.Root);
                if (currentRoots.Contains(normalizedRoot))
                {
                    kept.Add(normalizedRoot);
                    continue;
                }
                if (await IsBrowserInstallationInUseAsync(installation, cancellationToken))
                {
                    skippedInUse.Add(normalizedRoot);
                    continue;
                }
                Directory.Delete(normalizedRoot, recursive: true);
                removed.Add(normalizedRoot);
            }
            if (!Directory.EnumerateFileSystemEntries(versionRoot).Any())
                Directory.Delete(versionRoot);
        }
        removed.Sort(StringComparer.OrdinalIgnoreCase);
        skippedInUse.Sort(StringComparer.OrdinalIgnoreCase);
        kept.Sort(StringComparer.OrdinalIgnoreCase);
        return new BrowserPruneResult(removed, skippedInUse, kept);
    }

    private static async Task<HashSet<string>> CurrentInstallationRootsAsync(
        string cacheRoot,
        CancellationToken cancellationToken)
    {
        HashSet<string> roots = new(OperatingSystem.IsWindows()
            ? StringComparer.OrdinalIgnoreCase
            : StringComparer.Ordinal);
        string current = Path.Combine(cacheRoot, "stable", "current");
        if (!Directory.Exists(current)) return roots;
        foreach (string pointer in Directory.EnumerateFiles(current, "*.json"))
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(await File.ReadAllTextAsync(pointer, cancellationToken));
                string? root = ReadString(document.RootElement, "Root", "root");
                if (!string.IsNullOrEmpty(root)) roots.Add(Path.GetFullPath(root));
            }
            catch { }
        }
        return roots;
    }

    private static bool ProcessIsAlive(int processId)
    {
        if (processId <= 0) return false;
        try
        {
            using System.Diagnostics.Process process = System.Diagnostics.Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static string? ReadString(JsonElement element, string pascal, string camel)
    {
        if (element.TryGetProperty(pascal, out JsonElement value) ||
            element.TryGetProperty(camel, out value))
            return value.GetString();
        return null;
    }

    private static int ReadInt(JsonElement element, string pascal, string camel)
    {
        if (element.TryGetProperty(pascal, out JsonElement value) ||
            element.TryGetProperty(camel, out value))
            return value.TryGetInt32(out int result) ? result : -1;
        return -1;
    }

    private static void DeleteReference(string referenceFile)
    {
        try
        {
            if (File.Exists(referenceFile)) File.Delete(referenceFile);
        }
        catch { }
    }

    private static string DefaultCacheRoot()
    {
        if (OperatingSystem.IsWindows())
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SlyBrowser", "cache");
        if (OperatingSystem.IsMacOS())
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Caches", "SlyBrowser");
        return Path.Combine(Environment.GetEnvironmentVariable("XDG_CACHE_HOME") ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache"), "slybrowser");
    }

    private static async Task<BrowserInstallation?> ReadInstallationAsync(
        string path,
        InstallGrantView grant,
        CancellationToken cancellationToken)
    {
        try
        {
            string manifestPath = Path.Combine(path, ".sly-install.json");
            if (!File.Exists(manifestPath)) return null;
            BrowserInstallation? document = JsonSerializer.Deserialize<BrowserInstallation>(
                await File.ReadAllTextAsync(manifestPath, cancellationToken));
            if (document is null ||
                document.Version != grant.BrowserVersion ||
                document.ArtifactSha256 != grant.Artifact.Sha256 ||
                Path.GetFullPath(document.Root) != Path.GetFullPath(path) ||
                Path.GetFullPath(document.BrowserExecutable) != Path.GetFullPath(Path.Combine(path, grant.Artifact.BrowserExecutable)) ||
                Path.GetFullPath(document.DriverExecutable) != Path.GetFullPath(Path.Combine(path, grant.Artifact.DriverExecutable)))
                return null;
            await VerifyRuntimeAsync(path, grant, cancellationToken);
            return document;
        }
        catch
        {
            return null;
        }
    }

    private static async Task<BrowserInstallation?> ReadLooseInstallationAsync(
        string path,
        string platform,
        string arch,
        string kernelMajor,
        CancellationToken cancellationToken)
    {
        try
        {
            string manifestPath = Path.Combine(path, ".sly-install.json");
            if (!File.Exists(manifestPath)) return null;
            BrowserInstallation? document = JsonSerializer.Deserialize<BrowserInstallation>(
                await File.ReadAllTextAsync(manifestPath, cancellationToken));
            if (document is null ||
                document.Platform != platform ||
                document.Arch != arch ||
                !MatchesKernelMajor(document.Version, kernelMajor) ||
                Path.GetFullPath(document.Root) != Path.GetFullPath(path))
                return null;
            string browser = Path.GetFullPath(document.BrowserExecutable);
            string driver = Path.GetFullPath(document.DriverExecutable);
            string root = Path.GetFullPath(path);
            if (!browser.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                !driver.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                Path.GetDirectoryName(browser) != Path.GetDirectoryName(driver) ||
                !File.Exists(browser) ||
                !File.Exists(driver))
                return null;
            return document;
        }
        catch
        {
            return null;
        }
    }

    private static async Task WriteCurrentPointersAsync(
        string cacheRoot,
        BrowserInstallation installation,
        CancellationToken cancellationToken)
    {
        string current = Path.Combine(cacheRoot, "stable", "current");
        Directory.CreateDirectory(current);
        string payload = JsonSerializer.Serialize(new
        {
            SchemaVersion = 1,
            installation.Version,
            installation.Platform,
            installation.Arch,
            installation.ArtifactSha256,
            installation.Root,
            UpdatedAt = DateTimeOffset.UtcNow,
        }, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine;
        string major = installation.Version.Split('.')[0];
        await File.WriteAllTextAsync(Path.Combine(current, $"{installation.Platform}-{installation.Arch}-latest.json"), payload, cancellationToken);
        await File.WriteAllTextAsync(Path.Combine(current, $"{installation.Platform}-{installation.Arch}-{major}.json"), payload, cancellationToken);
    }

    private static long MaximumExpandedBytes(long archiveSize) =>
        Math.Min(Math.Max(archiveSize * 20, 2L * 1024 * 1024 * 1024), 16L * 1024 * 1024 * 1024);

    private static Task SafeExtractArchiveAsync(
        string archive,
        string destination,
        string archiveFormat,
        long maximumExpandedBytes,
        CancellationToken cancellationToken) =>
        archiveFormat == "7z"
            ? SafeExtract7zAsync(archive, destination, maximumExpandedBytes, cancellationToken)
            : SafeExtractAsync(archive, destination, maximumExpandedBytes, cancellationToken);

    private static async Task SafeExtract7zAsync(
        string archive,
        string destination,
        long maximumExpandedBytes,
        CancellationToken cancellationToken)
    {
        Win32Exception? missing = null;
        string? configured = Environment.GetEnvironmentVariable("SLYBROWSER_7Z_PATH");
        IEnumerable<string> executables = (configured is null ? Array.Empty<string>() : new[] { configured })
            .Concat(OperatingSystem.IsWindows() ? new[] { "7z.exe", "7z" } : new[] { "7zz", "7z" });
        foreach (string executable in executables)
        {
            try
            {
                string listing = await Run7zAsync(
                    executable,
                    new[] { "l", "-slt", archive },
                    InspectionTimeout,
                    cancellationToken);
                Inspect7zListing(listing, maximumExpandedBytes);
                await Run7zAsync(
                    executable,
                    new[] { "x", archive, $"-o{destination}", "-y", "-bd", "-bb0" },
                    ExtractionTimeout,
                    cancellationToken);

                long expanded = 0;
                foreach (string output in Directory.EnumerateFileSystemEntries(destination, "*", SearchOption.AllDirectories))
                {
                    FileAttributes attributes = File.GetAttributes(output);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                        throw new ArtifactException("Browser archive contains a symbolic link or reparse point", "artifact_layout_invalid");
                    if ((attributes & FileAttributes.Directory) == 0)
                    {
                        expanded += new FileInfo(output).Length;
                        if (expanded > maximumExpandedBytes)
                            throw new ArtifactException("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
                    }
                }
                return;
            }
            catch (Win32Exception error)
            {
                missing = error;
            }
        }
        throw new ArtifactException("7z or 7zz is required to extract browser archives", "artifact_extractor_missing", missing);
    }

    private static async Task<string> Run7zAsync(
        string executable,
        IEnumerable<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ProcessStartInfo start = new(executable)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (string argument in arguments)
            start.ArgumentList.Add(argument);
        using Process process = Process.Start(start)
            ?? throw new ArtifactException("Unable to start 7z browser archive extraction", "artifact_extract_failed");
        using CancellationTokenSource timeoutSource = new(timeout);
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutSource.Token);
        Task<string> stdout = process.StandardOutput.ReadToEndAsync(linked.Token);
        Task<string> stderr = process.StandardError.ReadToEndAsync(linked.Token);
        try
        {
            await process.WaitForExitAsync(linked.Token);
            await Task.WhenAll(stdout, stderr);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new ArtifactException("Browser archive extraction timed out", "artifact_extract_timeout");
        }
        if (process.ExitCode != 0)
            throw new ArtifactException("Unable to inspect or extract browser artifact", "artifact_extract_failed");
        return await stdout;
    }

    internal static void Inspect7zListing(string listing, long maximumExpandedBytes)
    {
        Match separator = Regex.Match(listing, "^----------\\s*$", RegexOptions.Multiline);
        if (!separator.Success)
            throw new ArtifactException("Unable to inspect browser archive", "artifact_extract_failed");
        HashSet<string> seen = new(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        long expanded = 0;
        int entries = 0;
        foreach (string record in Regex.Split(listing[(separator.Index + separator.Length)..], "\\r?\\n\\s*\\r?\\n"))
        {
            Dictionary<string, string> fields = new(StringComparer.Ordinal);
            using StringReader reader = new(record);
            while (reader.ReadLine() is { } line)
            {
                int marker = line.IndexOf(" = ", StringComparison.Ordinal);
                if (marker > 0) fields[line[..marker]] = line[(marker + 3)..];
            }
            if (!fields.TryGetValue("Path", out string? rawName) || rawName.Length == 0) continue;
            entries += 1;
            if (entries > Maximum7zEntries)
                throw new ArtifactException("Browser archive contains too many entries", "artifact_layout_invalid");
            string normalized = rawName.Replace('\\', '/');
            if (normalized.StartsWith("/", StringComparison.Ordinal) ||
                (normalized.Length >= 2 && normalized[1] == ':') ||
                normalized.Split('/').Contains("..") || normalized.Contains('\0'))
                throw new ArtifactException("Browser archive contains an unsafe path", "artifact_layout_invalid");
            if (!seen.Add(normalized))
                throw new ArtifactException("Browser archive contains duplicate paths", "artifact_layout_invalid");
            fields.TryGetValue("Attributes", out string? attributes);
            attributes ??= "";
            if (fields.ContainsKey("Symbolic Link") || attributes.StartsWith('l') || attributes.Contains(" reparse ", StringComparison.OrdinalIgnoreCase))
                throw new ArtifactException("Browser archive contains a symbolic link", "artifact_layout_invalid");
            string sizeText = fields.GetValueOrDefault("Size", "0");
            if (!long.TryParse(sizeText, out long size) || size < 0)
                throw new ArtifactException("Browser archive has an invalid entry size", "artifact_extract_failed");
            try
            {
                expanded = checked(expanded + size);
            }
            catch (OverflowException error)
            {
                throw new ArtifactException("Browser archive has an invalid entry size", "artifact_extract_failed", error);
            }
            if (expanded > maximumExpandedBytes)
                throw new ArtifactException("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
        }
        if (entries == 0)
            throw new ArtifactException("Browser archive contains no entries", "artifact_layout_invalid");
    }

    private static async Task SafeExtractAsync(
        string archive,
        string destination,
        long maximumExpandedBytes,
        CancellationToken cancellationToken)
    {
        long expanded = 0;
        string root = Path.GetFullPath(destination);
        using ZipArchive package = ZipFile.OpenRead(archive);
        foreach (ZipArchiveEntry entry in package.Entries)
        {
            string normalized = entry.FullName.Replace('\\', '/');
            if (Path.IsPathRooted(normalized) ||
                normalized.StartsWith("/", StringComparison.Ordinal) ||
                normalized.Split('/').Contains("..") ||
                (normalized.Length >= 2 && normalized[1] == ':'))
                throw new ArtifactException("Browser archive contains an unsafe path", "artifact_layout_invalid");
            int mode = (entry.ExternalAttributes >> 16) & 0xF000;
            if (mode == 0xA000)
                throw new ArtifactException("Browser archive contains a symbolic link", "artifact_layout_invalid");
            expanded += entry.Length;
            if (expanded > maximumExpandedBytes)
                throw new ArtifactException("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
            string output = Path.GetFullPath(Path.Combine(destination, entry.FullName));
            if (!output.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new ArtifactException("Browser archive contains an unsafe path", "artifact_layout_invalid");
            if (entry.FullName.EndsWith("/", StringComparison.Ordinal) ||
                entry.FullName.EndsWith("\\", StringComparison.Ordinal))
            {
                Directory.CreateDirectory(output);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            await using Stream input = entry.Open();
            await using FileStream file = new(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, true);
            await input.CopyToAsync(file, cancellationToken);
        }
    }

    private static void AssertDownloadedSize(string path, long expectedSize)
    {
        FileInfo info = new(path);
        if (!info.Exists)
            throw new ArtifactException("Browser artifact download is missing", "artifact_missing");
        if (info.Length > expectedSize)
            throw new ArtifactException("Browser artifact download exceeds its signed size", "artifact_size_mismatch");
    }

    private static void QuarantinePath(string path)
    {
        if (!File.Exists(path) && !Directory.Exists(path)) return;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            string target = $"{path}.bad-{Environment.ProcessId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}-{attempt}";
            try
            {
                if (File.Exists(path)) File.Move(path, target);
                else Directory.Move(path, target);
                return;
            }
            catch (FileNotFoundException)
            {
                return;
            }
            catch (DirectoryNotFoundException)
            {
                return;
            }
            catch (IOException) when (File.Exists(target) || Directory.Exists(target))
            {
                continue;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw new ArtifactException("Unable to quarantine invalid browser cache", "artifact_cache_failed", error);
            }
        }
        throw new ArtifactException("Unable to quarantine invalid browser cache", "artifact_cache_failed");
    }

    private static async Task<(string Browser, string Driver)> VerifyRuntimeAsync(
        string root,
        InstallGrantView grant,
        CancellationToken cancellationToken)
    {
        string resolvedRoot = Path.GetFullPath(root);
        string browser = Path.GetFullPath(Path.Combine(root, grant.Artifact.BrowserExecutable));
        string driver = Path.GetFullPath(Path.Combine(root, grant.Artifact.DriverExecutable));
        if (!browser.StartsWith(resolvedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            !driver.StartsWith(resolvedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            Path.GetDirectoryName(browser) != Path.GetDirectoryName(driver) ||
            !File.Exists(browser) ||
            !File.Exists(driver))
            throw new ArtifactException("Installed browser and project WebDriver layout is invalid", "artifact_layout_invalid");
        if (await Sha256Async(browser, cancellationToken) != grant.Artifact.BrowserSha256 ||
            await Sha256Async(driver, cancellationToken) != grant.Artifact.DriverSha256)
            throw new ArtifactException("Installed browser or project WebDriver hash does not match the signed manifest", "artifact_runtime_hash_mismatch");
        return (browser, driver);
    }

    private static string CurrentPlatform()
    {
        if (OperatingSystem.IsWindows()) return "windows";
        if (OperatingSystem.IsLinux()) return "linux";
        if (OperatingSystem.IsMacOS()) return "macos";
        throw new ArtifactException("Unsupported platform", "platform_unsupported");
    }

    private static string CurrentArch()
    {
        return System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
        {
            System.Runtime.InteropServices.Architecture.X64 => "x64",
            System.Runtime.InteropServices.Architecture.Arm64 => "arm64",
            _ => throw new ArtifactException("Unsupported architecture", "platform_unsupported"),
        };
    }

    private static bool MatchesKernelMajor(string version, string kernelMajor) =>
        kernelMajor == "latest" || version.Split('.')[0] == kernelMajor;

    private static async Task<string> Sha256Async(string path, CancellationToken cancellationToken)
    {
        await using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }

    private static async Task<IAsyncDisposable> AcquireLockAsync(
        string path,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow + timeout;
        while (true)
        {
            try
            {
                FileStream stream = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                await using StreamWriter writer = new(stream);
                await writer.WriteAsync(Environment.ProcessId.ToString());
                return new AsyncAction(async () =>
                {
                    await stream.DisposeAsync();
                    if (File.Exists(path)) File.Delete(path);
                });
            }
            catch (IOException)
            {
                if (DateTimeOffset.UtcNow >= deadline)
                    throw new ArtifactException("Timed out waiting for the browser installation lock", "install_lock_timeout");
                await Task.Delay(100, cancellationToken);
            }
        }
    }

    private sealed class AsyncAction : IAsyncDisposable
    {
        private readonly Func<ValueTask> _action;

        public AsyncAction(Func<Task> action)
        {
            _action = async () => await action();
        }

        public ValueTask DisposeAsync() => _action();
    }

    private sealed record InstallGrantView(
        string BrowserVersion,
        string Platform,
        string Arch,
        ReleaseArtifact Artifact)
    {
        public static InstallGrantView From(LicensedSessionGrant grant) =>
            new(grant.BrowserVersion, grant.Platform, grant.Arch, grant.Artifact);

        public static InstallGrantView From(RuntimeSessionGrant grant) =>
            new(grant.BrowserVersion, grant.Platform, grant.Arch, grant.Artifact);
    }
}
