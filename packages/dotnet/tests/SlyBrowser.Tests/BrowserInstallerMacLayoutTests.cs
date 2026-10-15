using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace SlyBrowser.Tests;

public sealed class BrowserInstallerMacLayoutTests
{
    private const string Browser = "SlyBrowser/SlyBrowser.app/Contents/MacOS/SlyBrowser";
    private const string Driver = "SlyBrowser/chromedriver";

    [Fact]
    public async Task InstallsDiscoversAndRepairsExactMacBundle()
    {
        var fixture = CreateFixture("macos", Browser, Driver, "browser");
        try
        {
            BrowserInstallation installed = await BrowserInstaller.InstallGrantedBrowserAsync(null!, fixture.Grant, fixture.Options, TestContext.Current.CancellationToken);
            Assert.Equal("browser", await File.ReadAllTextAsync(installed.BrowserExecutable, TestContext.Current.CancellationToken));
            BrowserInstallation? found = await BrowserInstaller.FindCurrentBrowserInstallationAsync(fixture.Options, "macos", "arm64", "latest", TestContext.Current.CancellationToken);
            Assert.Equal(installed, found);
            Assert.Equal(installed, await BrowserInstaller.InstallGrantedBrowserAsync(null!, fixture.Grant, fixture.Options, TestContext.Current.CancellationToken));
            await File.WriteAllTextAsync(installed.DriverExecutable, "tampered", TestContext.Current.CancellationToken);
            BrowserInstallation repaired = await BrowserInstaller.InstallGrantedBrowserAsync(null!, fixture.Grant, fixture.Options, TestContext.Current.CancellationToken);
            Assert.Equal("driver", await File.ReadAllTextAsync(repaired.DriverExecutable, TestContext.Current.CancellationToken));
        }
        finally { Directory.Delete(fixture.Options.CacheRoot!, recursive: true); }
    }

    [Theory]
    [InlineData("linux", Browser, Driver)]
    [InlineData("macos", "SlyBrowser/Other.app/Contents/MacOS/SlyBrowser", Driver)]
    [InlineData("macos", Browser, "SlyBrowser/otherdriver")]
    public async Task RejectsOtherSeparatedLayouts(string platform, string browser, string driver)
    {
        var fixture = CreateFixture(platform, browser, driver, "browser");
        try
        {
            ArtifactException error = await Assert.ThrowsAsync<ArtifactException>(() => BrowserInstaller.InstallGrantedBrowserAsync(null!, fixture.Grant, fixture.Options, TestContext.Current.CancellationToken));
            Assert.Equal("artifact_layout_invalid", error.Code);
        }
        finally { Directory.Delete(fixture.Options.CacheRoot!, recursive: true); }
    }

    [Fact]
    public async Task RetainsSignedExecutableHashCheckForMacBundle()
    {
        var fixture = CreateFixture("macos", Browser, Driver, "tampered");
        try
        {
            ArtifactException error = await Assert.ThrowsAsync<ArtifactException>(() => BrowserInstaller.InstallGrantedBrowserAsync(null!, fixture.Grant, fixture.Options, TestContext.Current.CancellationToken));
            Assert.Equal("artifact_runtime_hash_mismatch", error.Code);
        }
        finally { Directory.Delete(fixture.Options.CacheRoot!, recursive: true); }
    }

    private static (LicensedSessionGrant Grant, InstallOptions Options) CreateFixture(string platform, string browser, string driver, string browserBytes)
    {
        using MemoryStream bytes = new();
        using (ZipArchive zip = new(bytes, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var pair in new[] { (browser, browserBytes), (driver, "driver") })
            {
                using Stream entry = zip.CreateEntry(pair.Item1).Open();
                entry.Write(Encoding.UTF8.GetBytes(pair.Item2));
            }
        }
        byte[] archive = bytes.ToArray();
        string Sha(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
        ReleaseArtifact artifact = new(platform, "arm64", "https://api.slybrowser.test/artifact.zip", Sha(archive), archive.Length, "zip", browser, driver, Sha(Encoding.UTF8.GetBytes("browser")), Sha(Encoding.UTF8.GetBytes("driver")), [], [], null);
        LicensedSessionGrant grant = new()
        {
            SessionId = "modeled-session", SessionToken = "modeled-token", HeartbeatAfterSeconds = 60,
            ExpiresAt = long.MaxValue, Plan = "free", Features = [], ConcurrencyLimit = 1, ActiveSessions = 0,
            BrowserVersion = "148.0.7778.179", VersionPolicy = "exact", SelectionReason = "test",
            AvailableBrowserVersions = [], UpdateRights = new Dictionary<string, object?>(), LeaseEnvelope = "",
            Claims = null!, Manifest = null!, Artifact = artifact, Platform = platform, Arch = "arm64"
        };
        InstallOptions options = new() { CacheRoot = Path.Combine(Path.GetTempPath(), $"sly-mac-layout-{Guid.NewGuid():N}") };
        string downloads = Path.Combine(options.CacheRoot, "downloads");
        Directory.CreateDirectory(downloads);
        File.WriteAllBytes(Path.Combine(downloads, artifact.Sha256 + ".zip"), archive);
        return (grant, options);
    }
}
