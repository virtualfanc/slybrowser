using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

namespace SlyBrowser.Tests;

public sealed class LicensedReleaseTests
{
    [Fact]
    public void ExposesStableAuthorizedAliases()
    {
        Assert.Equal(
            typeof(SlyBrowserClient).GetMethod(nameof(SlyBrowserClient.LaunchLatestAsync))!.ReturnType,
            typeof(SlyBrowserClient).GetMethod(nameof(SlyBrowserClient.LaunchAuthorizedAsync))!.ReturnType);
        Assert.Equal(
            typeof(SlyBrowserClient).GetMethod(nameof(SlyBrowserClient.InstallLatestAsync))!.ReturnType,
            typeof(SlyBrowserClient).GetMethod(nameof(SlyBrowserClient.InstallAuthorizedAsync))!.ReturnType);
        Assert.Equal(
            typeof(SlyBrowserClient).GetMethod(nameof(SlyBrowserClient.PrepareLatestAuthorizedBrowserAsync))!.ReturnType,
            typeof(SlyBrowserClient).GetMethod(nameof(SlyBrowserClient.PrepareAuthorizedBrowserAsync))!.ReturnType);
    }

    [Fact]
    public async Task ReadsV2LicenseFileAndFailsClosedOnTampering()
    {
        Ed25519PrivateKeyParameters signingKey = NewPrivateKey();
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-v2-license-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string licenseFile = Path.Combine(root, "account.slybrowser-license.json");
            Dictionary<string, object?> document = LicenseDocument(signingKey);
            await File.WriteAllTextAsync(licenseFile, JsonSerializer.Serialize(document), TestContext.Current.CancellationToken);
            LicenseFileReadOptions options = new()
            {
                LicenseFilePassphrase = "test-passphrase-only",
                LicenseFileTrustedKeys = new Dictionary<string, byte[]> { ["license-file-test-v1"] = signingKey.GeneratePublicKey().GetEncoded() },
                TrustedServiceUrls = new HashSet<string>(["https://api.slybrowser.test"], StringComparer.Ordinal),
            };
            LicenseAuthorization authorization = await LicenseServiceClient.ReadAuthorizationAsync(
                licenseFile,
                options,
                TestContext.Current.CancellationToken);
            Assert.Equal("https://api.slybrowser.test", authorization.ServiceUrl);
            Assert.Equal($"sly_live_{document["licenseId"]}.{new string('x', 43)}", authorization.LicenseKey);
            Assert.DoesNotContain("sly_live_", await File.ReadAllTextAsync(licenseFile, TestContext.Current.CancellationToken));

            Dictionary<string, object?> portableDocument = LicenseDocument(
                signingKey,
                fileId: "lf_portable_dotnet_reader",
                passphrase: "portable-passphrase-only",
                kdfName: "sly-portable-scrypt-v1",
                kdfPurpose: "portable-passphrase",
                scope: "portable-passphrase");
            await File.WriteAllTextAsync(licenseFile, JsonSerializer.Serialize(portableDocument), TestContext.Current.CancellationToken);
            LicenseFileReadOptions portableOptions = new()
            {
                LicenseFilePassphrase = "portable-passphrase-only",
                LicenseFileTrustedKeys = options.LicenseFileTrustedKeys,
                TrustedServiceUrls = options.TrustedServiceUrls,
            };
            LicenseAuthorization portableAuthorization = await LicenseServiceClient.ReadAuthorizationAsync(
                licenseFile,
                portableOptions,
                TestContext.Current.CancellationToken);
            Assert.Equal("https://api.slybrowser.test", portableAuthorization.ServiceUrl);
            Assert.Equal($"sly_live_{portableDocument["licenseId"]}.{new string('x', 43)}", portableAuthorization.LicenseKey);

            Dictionary<string, object?> tamperedOrigin = new(document) { ["serviceUrl"] = "https://evil.example" };
            await File.WriteAllTextAsync(licenseFile, JsonSerializer.Serialize(tamperedOrigin), TestContext.Current.CancellationToken);
            LicenseServiceException originError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, options, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_untrusted_origin", originError.Code);

            Dictionary<string, object?> tamperedCiphertext = new(document) { ["ciphertext"] = CorruptBase64Url((string)document["ciphertext"]!) };
            await File.WriteAllTextAsync(licenseFile, JsonSerializer.Serialize(tamperedCiphertext), TestContext.Current.CancellationToken);
            LicenseServiceException ciphertextError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, options, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_signature_invalid", ciphertextError.Code);

            Dictionary<string, object?> signature = new((Dictionary<string, object?>)document["signature"]!);
            signature["signature"] = CorruptBase64Url((string)signature["signature"]!);
            Dictionary<string, object?> tamperedSignature = new(document) { ["signature"] = signature };
            await File.WriteAllTextAsync(licenseFile, JsonSerializer.Serialize(tamperedSignature), TestContext.Current.CancellationToken);
            LicenseServiceException signatureError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, options, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_signature_invalid", signatureError.Code);

            await File.WriteAllTextAsync(licenseFile, JsonSerializer.Serialize(document), TestContext.Current.CancellationToken);
            LicenseFileReadOptions wrongPassphrase = new()
            {
                LicenseFilePassphrase = "wrong-passphrase",
                LicenseFileTrustedKeys = options.LicenseFileTrustedKeys,
                TrustedServiceUrls = options.TrustedServiceUrls,
            };
            LicenseServiceException lockedError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, wrongPassphrase, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_locked", lockedError.Code);

            LicenseFileReadOptions unknownKey = new()
            {
                LicenseFilePassphrase = options.LicenseFilePassphrase,
                TrustedServiceUrls = options.TrustedServiceUrls,
            };
            LicenseServiceException keyError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, unknownKey, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_key_unknown", keyError.Code);

            await File.WriteAllTextAsync(
                licenseFile,
                JsonSerializer.Serialize(LicenseDocument(signingKey, audience: "other-product", fileId: "lf_test_dotnet_wrong_audience")),
                TestContext.Current.CancellationToken);
            LicenseServiceException audienceError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, options, TestContext.Current.CancellationToken));
            Assert.Equal("authorization_invalid", audienceError.Code);

            await File.WriteAllTextAsync(
                licenseFile,
                JsonSerializer.Serialize(LicenseDocument(
                    signingKey,
                    issuedAt: "2020-01-01T00:00:00.000Z",
                    expiresAt: "2020-01-02T00:00:00.000Z",
                    fileId: "lf_test_dotnet_expired")),
                TestContext.Current.CancellationToken);
            LicenseServiceException expiredError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, options, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_expired", expiredError.Code);

            await File.WriteAllTextAsync(
                licenseFile,
                JsonSerializer.Serialize(LicenseDocument(
                    signingKey,
                    fileId: "lf_test_dotnet_plan_claim",
                    secretOverrides: new Dictionary<string, object?> { ["plan"] = "grid" })),
                TestContext.Current.CancellationToken);
            LicenseServiceException planError = await Assert.ThrowsAsync<LicenseServiceException>(
                () => LicenseServiceClient.ReadAuthorizationAsync(licenseFile, options, TestContext.Current.CancellationToken));
            Assert.Equal("license_file_payload_invalid", planError.Code);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task VerifiesDownloadsExtractsReusesCacheAndReleases()
    {
        Fixture fixture = new();
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-licensed-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string authorization = await fixture.WriteAuthorizationAsync(root);
            LicensedLaunchSettings settings = fixture.Settings(root);
            BrowserInstallation first = await SlyBrowserClient.InstallLatestAsync(
                authorization,
                settings,
                TestContext.Current.CancellationToken);
            BrowserInstallation second = await SlyBrowserClient.InstallLatestAsync(
                authorization,
                settings,
                TestContext.Current.CancellationToken);
            Assert.Equal("150.0.8000.1", first.Version);
            Assert.Equal(first, second);
            Assert.EndsWith("SlyBrowser.exe", first.BrowserExecutable);
            Assert.EndsWith("chromedriver.exe", first.DriverExecutable);
            Assert.Equal("browser", await File.ReadAllTextAsync(first.BrowserExecutable, TestContext.Current.CancellationToken));
            Assert.Equal(1, fixture.Downloads);
            Assert.Equal(2, fixture.Releases);
            await using BrowserInstallationReference reference =
                await BrowserInstaller.AcquireBrowserInstallationReferenceAsync(first, TestContext.Current.CancellationToken);
            Assert.True(await BrowserInstaller.IsBrowserInstallationInUseAsync(first, TestContext.Current.CancellationToken));
            Assert.Single(await BrowserInstaller.ActiveBrowserInstallationReferencesAsync(first, TestContext.Current.CancellationToken));
            reference.Release();
            Assert.False(await BrowserInstaller.IsBrowserInstallationInUseAsync(first, TestContext.Current.CancellationToken));

            await File.WriteAllTextAsync(first.DriverExecutable, "tampered", TestContext.Current.CancellationToken);
            BrowserInstallation repaired = await SlyBrowserClient.InstallLatestAsync(
                authorization,
                settings,
                TestContext.Current.CancellationToken);
            Assert.Equal("driver", await File.ReadAllTextAsync(repaired.DriverExecutable, TestContext.Current.CancellationToken));
            Assert.Equal(1, fixture.Downloads);
            Assert.Equal(3, fixture.Releases);

            await File.WriteAllTextAsync(repaired.BrowserExecutable, "tampered-again", TestContext.Current.CancellationToken);
            await File.WriteAllTextAsync(Path.Combine(root, "downloads", $"{fixture.ArtifactSha256}.zip"), "corrupt-archive", TestContext.Current.CancellationToken);
            BrowserInstallation repairedAfterArchiveDamage = await SlyBrowserClient.InstallLatestAsync(
                authorization,
                settings,
                TestContext.Current.CancellationToken);
            Assert.Equal("browser", await File.ReadAllTextAsync(repairedAfterArchiveDamage.BrowserExecutable, TestContext.Current.CancellationToken));
            Assert.Equal(2, fixture.Downloads);
            Assert.Equal(4, fixture.Releases);
            BrowserInstallation unused = await FakeInstallationAsync(root, "149.0.0.1", "windows-x64-aaaaaaaaaaaaaaaa", "a");
            BrowserInstallation inUse = await FakeInstallationAsync(root, "149.0.0.2", "windows-x64-bbbbbbbbbbbbbbbb", "b");
            await using BrowserInstallationReference pruneReference =
                await BrowserInstaller.AcquireBrowserInstallationReferenceAsync(inUse, TestContext.Current.CancellationToken);
            BrowserPruneResult pruned = await BrowserInstaller.PruneBrowserInstallationsAsync(
                settings.Install,
                "windows",
                "x64",
                "latest",
                TestContext.Current.CancellationToken);
            Assert.Equal([unused.Root], pruned.Removed);
            Assert.Equal([inUse.Root], pruned.SkippedInUse);
            Assert.Contains(repairedAfterArchiveDamage.Root, pruned.Kept);
            Assert.False(Directory.Exists(unused.Root));
            Assert.True(Directory.Exists(inUse.Root));
            pruneReference.Release();
            BrowserPruneResult secondPrune = await BrowserInstaller.PruneBrowserInstallationsAsync(
                settings.Install,
                "windows",
                "x64",
                "latest",
                TestContext.Current.CancellationToken);
            Assert.Equal([inUse.Root], secondPrune.Removed);
            Assert.Contains(Directory.EnumerateFileSystemEntries(Path.Combine(root, "downloads")), path => Path.GetFileName(path).Contains(".bad-", StringComparison.Ordinal));
            Assert.Contains(Directory.EnumerateFileSystemEntries(Path.Combine(root, "stable", "150.0.8000.1")), path => Path.GetFileName(path).Contains(".bad-", StringComparison.Ordinal));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static async Task<BrowserInstallation> FakeInstallationAsync(
        string cacheRoot,
        string version,
        string identity,
        string prefix)
    {
        string root = Path.Combine(cacheRoot, "stable", version, identity);
        Directory.CreateDirectory(root);
        string browser = Path.Combine(root, "SlyBrowser.exe");
        string driver = Path.Combine(root, "chromedriver.exe");
        await File.WriteAllTextAsync(browser, "old-browser", TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(driver, "old-driver", TestContext.Current.CancellationToken);
        BrowserInstallation installation = new(
            version,
            "windows",
            "x64",
            root,
            browser,
            driver,
            new string(prefix[0], 64));
        await File.WriteAllTextAsync(
            Path.Combine(root, ".sly-install.json"),
            JsonSerializer.Serialize(installation, new JsonSerializerOptions { WriteIndented = true }) + Environment.NewLine,
            TestContext.Current.CancellationToken);
        return installation;
    }

    [Fact]
    public async Task AuthorizedDefaultsKeepUpdatesClosedWhileLatestUpdates()
    {
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-kernel-policy-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            Fixture authorizedFixture = new();
            string authorizedFile = await authorizedFixture.WriteAuthorizationAsync(root);
            BrowserInstallation authorized = await SlyBrowserClient.InstallAuthorizedAsync(
                authorizedFile,
                authorizedFixture.Settings(Path.Combine(root, "authorized-cache"), kernelMajor: "150"),
                TestContext.Current.CancellationToken);
            Assert.Equal("150.0.8000.1", authorized.Version);
            Assert.Empty(authorizedFixture.SessionRequests);
            Assert.Equal("project-webdriver", authorizedFixture.RuntimeSessionRequests[0].GetProperty("automationBackend").GetString());
            Assert.Equal(150, authorizedFixture.RuntimeSessionRequests[0].GetProperty("kernelMajor").GetInt32());
            Assert.False(authorizedFixture.RuntimeSessionRequests[0].GetProperty("updateKernel").GetBoolean());
            BrowserInstallation cached = await SlyBrowserClient.InstallAuthorizedAsync(
                authorizedFile,
                authorizedFixture.Settings(Path.Combine(root, "authorized-cache"), kernelMajor: "150"),
                TestContext.Current.CancellationToken);
            Assert.Equal("150.0.8000.1", cached.Version);
            Assert.Equal("project-webdriver", authorizedFixture.RuntimeSessionRequests[1].GetProperty("automationBackend").GetString());
            Assert.Equal(150, authorizedFixture.RuntimeSessionRequests[1].GetProperty("kernelMajor").GetInt32());
            Assert.False(authorizedFixture.RuntimeSessionRequests[1].GetProperty("updateKernel").GetBoolean());
            Assert.Equal("150.0.8000.1", authorizedFixture.RuntimeSessionRequests[1].GetProperty("browserVersion").GetString());
            Assert.Equal("exact", authorizedFixture.RuntimeSessionRequests[1].GetProperty("versionPolicy").GetString());
            Fixture withdrawnFixture = new(
                sessionError: true,
                sessionErrorCode: "release_version_unavailable",
                sessionErrorStatus: HttpStatusCode.NotFound);
            LicenseServiceException withdrawn = await Assert.ThrowsAsync<LicenseServiceException>(
                () => SlyBrowserClient.InstallAuthorizedAsync(
                    authorizedFile,
                    withdrawnFixture.Settings(Path.Combine(root, "authorized-cache"), kernelMajor: "150"),
                    TestContext.Current.CancellationToken));
            Assert.Equal("kernel_update_required", withdrawn.Code);
            Assert.Equal(409, withdrawn.Status);

            Fixture latestFixture = new();
            string latestFile = await latestFixture.WriteAuthorizationAsync(root);
            BrowserInstallation latest = await SlyBrowserClient.InstallLatestAsync(
                latestFile,
                latestFixture.Settings(Path.Combine(root, "latest-cache"), kernelMajor: "150"),
                TestContext.Current.CancellationToken);
            Assert.Equal("150.0.8000.1", latest.Version);
            Assert.Empty(latestFixture.SessionRequests);
            Assert.Equal("project-webdriver", latestFixture.RuntimeSessionRequests[0].GetProperty("automationBackend").GetString());
            Assert.Equal(150, latestFixture.RuntimeSessionRequests[0].GetProperty("kernelMajor").GetInt32());
            Assert.True(latestFixture.RuntimeSessionRequests[0].GetProperty("updateKernel").GetBoolean());
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task UsesV2RuntimeCredentialsForActivationDownloadAndRelease()
    {
        Fixture fixture = new();
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-runtime-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            LicenseServiceClient client = new(
                new LicenseAuthorization(
                    "https://api.slybrowser.test",
                    $"sly_live_00000000-0000-4000-8000-000000000002.{"x".PadLeft(43, 'x')}"),
                fixture.Settings(root).Trust);
            RuntimeSessionGrant grant = await client.CreateRuntimeSessionAsync(
                new CreateRuntimeSessionOptions
                {
                    Platform = "windows",
                    Arch = "x64",
                    AutomationBackend = AutomationBackend.Playwright,
                    StartupId = "st_dotnetv2runtime001",
                },
                TestContext.Current.CancellationToken);
            Assert.Equal(2, grant.SchemaVersion);
            Assert.Equal("reserved", grant.State);
            Assert.Equal("bootstrap-token", grant.BootstrapToken);
            Assert.Equal("activation-ticket", grant.ActivationTicket);
            Assert.Null(grant.DriverActivationTicket);
            Assert.Equal("download-token", grant.DownloadTicket.Token);
            Assert.Equal("150.0.8000.1", grant.BrowserVersion);
            Assert.Equal(AutomationBackend.Playwright, grant.AutomationBackend);

            RuntimeHeartbeatGrant bootstrap = await client.BootstrapHeartbeatAsync(grant, TestContext.Current.CancellationToken);
            Assert.Equal("reserved", bootstrap.State);
            BrowserInstallation installation = await BrowserInstaller.InstallGrantedBrowserAsync(
                client,
                grant,
                new InstallOptions { CacheRoot = Path.Combine(root, "runtime-cache") },
                TestContext.Current.CancellationToken);
            Assert.Equal("150.0.8000.1", installation.Version);
            Assert.Equal("browser", await File.ReadAllTextAsync(installation.BrowserExecutable, TestContext.Current.CancellationToken));
            Assert.Equal("driver", await File.ReadAllTextAsync(installation.DriverExecutable, TestContext.Current.CancellationToken));
            RuntimeActivationGrant active = await client.ActivateRuntimeSessionAsync(grant, TestContext.Current.CancellationToken);
            Assert.Equal("active", active.State);
            Assert.Equal("runtime-token", active.RuntimeToken);
            RuntimeHeartbeatGrant heartbeat = await client.RuntimeHeartbeatAsync(active, TestContext.Current.CancellationToken);
            Assert.Equal("active", heartbeat.State);
            RuntimeHeartbeatGrant closing = await client.CloseRuntimeSessionAsync(active, TestContext.Current.CancellationToken);
            Assert.Equal("closing", closing.State);
            await client.ReleaseRuntimeSessionAsync(active, TestContext.Current.CancellationToken);
            Assert.Equal(1, fixture.Downloads);
            Assert.Equal(1, fixture.Releases);

            Fixture reservedFixture = new();
            LicenseServiceClient reservedClient = new(
                new LicenseAuthorization(
                    "https://api.slybrowser.test",
                    $"sly_live_00000000-0000-4000-8000-000000000002.{"x".PadLeft(43, 'x')}"),
                reservedFixture.Settings(root).Trust);
            RuntimeSessionGrant reserved = await reservedClient.CreateRuntimeSessionAsync(
                new CreateRuntimeSessionOptions
                {
                    Platform = "windows",
                    Arch = "x64",
                    StartupId = "st_dotnetv2runtime001",
                },
                TestContext.Current.CancellationToken);
            await reservedClient.ReleaseRuntimeSessionAsync(reserved, TestContext.Current.CancellationToken);
            Assert.Equal(1, reservedFixture.Releases);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task ReadsRedactedOnlineLicenseInfoWithoutCreatingSession()
    {
        Fixture fixture = new();
        LicenseServiceClient client = new(
            new LicenseAuthorization(
                "https://api.slybrowser.test",
                $"sly_live_00000000-0000-4000-8000-000000000002.{"x".PadLeft(43, 'x')}"),
            fixture.Settings(Path.GetTempPath()).Trust);
        LicenseInfo info = await client.LicenseInfoAsync(
            new CreateSessionOptions
            {
                Platform = "windows",
                Arch = "x64",
                KernelMajor = "150",
                UpdateKernel = false,
            },
            TestContext.Current.CancellationToken);
        Assert.Equal(1, info.SchemaVersion);
        Assert.Equal("stable", info.Channel);
        Assert.Equal("active", info.LicenseStatus);
        Assert.Equal("launch", info.Plan);
        Assert.Equal("launch", info.EffectivePlan);
        Assert.Equal(5, info.ConcurrencyLimit);
        Assert.Equal(0, info.ActiveSessions);
        Assert.Equal(5, info.AvailableSessions);
        Assert.Equal(150, Assert.IsType<int>(info.RequestedKernelMajor));
        Assert.Equal("latest-in-major", info.SelectionMode);
        Assert.Null(info.StableErrorCode);
        Assert.Contains("playwright", info.Features);
        Assert.Empty(fixture.SessionRequests);
        Assert.Empty(fixture.RuntimeSessionRequests);
        string serialized = JsonSerializer.Serialize(info);
        Assert.DoesNotContain("sly_live_", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("session-token", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("download-token", serialized, StringComparison.Ordinal);
        Assert.DoesNotContain("bootstrap-token", serialized, StringComparison.Ordinal);
    }

    [Fact]
    public void DotNetBootstrapHeartbeatUsesNegativeJitterWindow()
    {
        Assert.Equal(TimeSpan.FromSeconds(285), LicensedBrowser.HeartbeatDelay(300));
        Assert.Equal(TimeSpan.FromSeconds(1), LicensedBrowser.HeartbeatDelay(5));
        Assert.Equal(TimeSpan.FromSeconds(1), LicensedBrowser.HeartbeatDelay(0));
    }

    [Fact]
    public async Task RejectsManifestChangedAfterSigning()
    {
        Fixture fixture = new(tamperManifest: true);
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-licensed-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string authorization = await fixture.WriteAuthorizationAsync(root);
            ManifestException error = await Assert.ThrowsAsync<ManifestException>(
                () => SlyBrowserClient.InstallLatestAsync(
                    authorization,
                    fixture.Settings(root),
                    TestContext.Current.CancellationToken));
            Assert.Equal("manifest_invalid_signature", error.Code);
            Assert.Equal(0, fixture.Downloads);
            Assert.Equal(0, fixture.Releases);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task PreservesSessionLimitErrors()
    {
        Fixture fixture = new(sessionError: true);
        string root = Path.Combine(Path.GetTempPath(), $"sly-dotnet-licensed-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            string authorization = await fixture.WriteAuthorizationAsync(root);
            LicenseServiceException error = await Assert.ThrowsAsync<LicenseServiceException>(
                () => SlyBrowserClient.InstallLatestAsync(
                    authorization,
                    fixture.Settings(root),
                    TestContext.Current.CancellationToken));
            Assert.Equal("session_limit", error.Code);
            Assert.Equal(409, error.Status);
            Assert.Equal(5L, Convert.ToInt64(error.Details["concurrencyLimit"]));
            Assert.Equal(5L, Convert.ToInt64(error.Details["activeSessions"]));
            Assert.Equal(0L, Convert.ToInt64(error.Details["availableSessions"]));
            List<object?> actions = Assert.IsType<List<object?>>(error.Details["actions"]);
            HashSet<string> actionTypes = actions
                .Select(action => Assert.IsType<Dictionary<string, object?>>(action)["type"] as string)
                .Where(type => type is not null)
                .ToHashSet(StringComparer.Ordinal)!;
            Assert.Equal(new HashSet<string>(["close_session", "upgrade_plan"], StringComparer.Ordinal), actionTypes);
            Dictionary<string, object?> closeAction = Assert.IsType<Dictionary<string, object?>>(actions[0]);
            Assert.False(closeAction.ContainsKey("api"));
            Assert.False(closeAction.ContainsKey("authorization"));
            string rendered = $"{error.Message} {string.Join(" ", error.Details.Select(pair => $"{pair.Key}={pair.Value}"))}";
            Assert.DoesNotContain("runtime-token", rendered, StringComparison.Ordinal);
            Assert.DoesNotContain("download-token", rendered, StringComparison.Ordinal);
            Assert.DoesNotContain("buyer@example.com", rendered, StringComparison.Ordinal);
            Assert.DoesNotContain("paynow-secret", rendered, StringComparison.Ordinal);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void VerifiesRequestedSelectedDownloadedLaunchedVersionAudit()
    {
        BrowserVersionAudit audit = LicensedBrowser.VerifyBrowserVersionAudit(new BrowserVersionAudit(
            "151.0.0.0",
            "150.0.8000.1",
            "150.0.8000.1",
            "150.0.8000.1",
            "at-or-before",
            "rollback"));
        Assert.Equal("150.0.8000.1", audit.Launched);

        ArtifactException error = Assert.Throws<ArtifactException>(() =>
            LicensedBrowser.VerifyBrowserVersionAudit(new BrowserVersionAudit(
                "150.0.8000.1",
                "150.0.8000.1",
                "150.0.8000.1",
                "151.0.0.0",
                "exact",
                "exact")));
        Assert.Equal("browser_version_chain_mismatch", error.Code);
    }

    private static Dictionary<string, object?> LicenseDocument(
        Ed25519PrivateKeyParameters signingKey,
        string audience = "slybrowser-license-file",
        string issuedAt = "2033-05-18T03:33:20.000Z",
        string expiresAt = "2034-05-18T03:33:20.000Z",
        string fileId = "lf_test_dotnet_reader",
        string passphrase = "test-passphrase-only",
        string kdfName = "sly-test-scrypt-v1",
        string kdfPurpose = "test-private-preview",
        string scope = "test-private-preview",
        Dictionary<string, object?>? secretOverrides = null)
    {
        byte[] salt = DeterministicBytes("dotnet-license-file-salt", 16);
        byte[] nonce = DeterministicBytes("dotnet-license-file-nonce", 12);
        Dictionary<string, object?> kdf = new()
        {
            ["name"] = kdfName,
            ["purpose"] = kdfPurpose,
            ["salt"] = CanonicalJson.EncodeBase64Url(salt),
            ["cost"] = 16_384,
            ["blockSize"] = 8,
            ["parallelization"] = 1,
            ["keyLength"] = 32,
        };
        Dictionary<string, object?> encryption = new()
        {
            ["algorithm"] = "AES-256-GCM",
            ["kdf"] = kdf,
            ["nonce"] = CanonicalJson.EncodeBase64Url(nonce),
            ["aad"] = "slybrowser-license-v2-public-header",
        };
        Dictionary<string, object?> document = new()
        {
            ["schemaVersion"] = 2,
            ["type"] = "slybrowser-license",
            ["audience"] = audience,
            ["serviceUrl"] = "https://api.slybrowser.test",
            ["licenseId"] = "00000000-0000-4000-8000-000000000002",
            ["channel"] = "stable",
            ["issuedAt"] = issuedAt,
            ["expiresAt"] = expiresAt,
            ["fileId"] = fileId,
            ["encryption"] = encryption,
            ["ciphertext"] = "",
            ["tag"] = "",
            ["signature"] = new Dictionary<string, object?>
            {
                ["algorithm"] = "Ed25519",
                ["keyId"] = "license-file-test-v1",
                ["signature"] = "",
            },
        };
        Dictionary<string, object?> secret = new()
        {
            ["schemaVersion"] = 2,
            ["type"] = "slybrowser-license-secret",
            ["audience"] = document["audience"],
            ["licenseId"] = document["licenseId"],
            ["fileId"] = document["fileId"],
            ["serviceUrl"] = document["serviceUrl"],
            ["channel"] = "stable",
            ["licenseKey"] = $"sly_live_{document["licenseId"]}.{new string('x', 43)}",
            ["secretVersion"] = 1,
            ["createdAt"] = document["issuedAt"],
            ["expiresAt"] = document["expiresAt"],
            ["nonce"] = "dotnet-payload-nonce",
            ["scope"] = scope,
        };
        if (secretOverrides is not null)
        {
            foreach ((string claimName, object? value) in secretOverrides) secret[claimName] = value;
        }
        byte[] key = SCrypt.Generate(Encoding.UTF8.GetBytes(passphrase), salt, 16_384, 8, 1, 32);
        byte[] plaintext = Canonical(JsonSerializer.SerializeToElement(secret));
        byte[] ciphertext = new byte[plaintext.Length];
        byte[] tag = new byte[16];
        using (AesGcm aes = new(key, 16))
        {
            aes.Encrypt(nonce, plaintext, ciphertext, tag, Canonical(JsonSerializer.SerializeToElement(PublicHeader(document))));
        }
        document["ciphertext"] = CanonicalJson.EncodeBase64Url(ciphertext);
        document["tag"] = CanonicalJson.EncodeBase64Url(tag);
        ((Dictionary<string, object?>)document["signature"]!)["signature"] =
            CanonicalJson.EncodeBase64Url(Sign(signingKey, Canonical(JsonSerializer.SerializeToElement(SignedBody(document)))));
        return document;
    }

    private static Dictionary<string, object?> PublicHeader(Dictionary<string, object?> document) => new()
    {
        ["schemaVersion"] = document["schemaVersion"],
        ["type"] = document["type"],
        ["audience"] = document["audience"],
        ["serviceUrl"] = document["serviceUrl"],
        ["licenseId"] = document["licenseId"],
        ["channel"] = document["channel"],
        ["issuedAt"] = document["issuedAt"],
        ["expiresAt"] = document["expiresAt"],
        ["fileId"] = document["fileId"],
        ["encryption"] = document["encryption"],
    };

    private static Dictionary<string, object?> SignedBody(Dictionary<string, object?> document)
    {
        Dictionary<string, object?> result = PublicHeader(document);
        result["ciphertext"] = document["ciphertext"];
        result["tag"] = document["tag"];
        return result;
    }

    private static byte[] Canonical(JsonElement element) => CanonicalJson.Serialize(element);

    private static byte[] DeterministicBytes(string label, int length)
    {
        using MemoryStream stream = new();
        for (int index = 0; stream.Length < length; index++)
            stream.Write(SHA256.HashData(Encoding.UTF8.GetBytes($"{label}:{index}")));
        return stream.ToArray()[..length];
    }

    private static string CorruptBase64Url(string value) =>
        $"{(value.StartsWith('A') ? 'B' : 'A')}{value[1..]}";

    private static Ed25519PrivateKeyParameters NewPrivateKey()
    {
        Ed25519KeyPairGenerator generator = new();
        generator.Init(new Org.BouncyCastle.Crypto.KeyGenerationParameters(new SecureRandom(), 256));
        return (Ed25519PrivateKeyParameters)generator.GenerateKeyPair().Private;
    }

    private static byte[] Sign(Ed25519PrivateKeyParameters key, byte[] payload)
    {
        Ed25519Signer signer = new();
        signer.Init(true, key);
        signer.BlockUpdate(payload, 0, payload.Length);
        return signer.GenerateSignature();
    }

    private sealed class Fixture
    {
        private readonly Ed25519PrivateKeyParameters _leasePrivate;
        private readonly Ed25519PrivateKeyParameters _releasePrivate;
        private readonly byte[] _archive;
        private readonly string _artifactSha256;
        private readonly bool _tamperManifest;
        private readonly bool _sessionError;
        private readonly string _sessionErrorCode;
        private readonly HttpStatusCode _sessionErrorStatus;
        private readonly long _now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        private readonly string _sessionToken = "session-token";
        private readonly string _bootstrapToken = "bootstrap-token";
        private readonly string _activationTicket = "activation-ticket";
        private readonly string _driverActivationTicket = "driver-activation-ticket";
        private readonly string _runtimeToken = "runtime-token";
        private readonly string _downloadTicketToken = "download-token";
        public int Downloads { get; private set; }
        public int Releases { get; private set; }
        public string ArtifactSha256 => _artifactSha256;
        public List<JsonElement> SessionRequests { get; } = [];
        public List<JsonElement> RuntimeSessionRequests { get; } = [];

        public Fixture(
            bool tamperManifest = false,
            bool sessionError = false,
            string sessionErrorCode = "session_limit",
            HttpStatusCode sessionErrorStatus = HttpStatusCode.Conflict)
        {
            _leasePrivate = NewPrivateKey();
            _releasePrivate = NewPrivateKey();
            _archive = BuildArchive();
            _artifactSha256 = Sha256(_archive);
            _tamperManifest = tamperManifest;
            _sessionError = sessionError;
            _sessionErrorCode = sessionErrorCode;
            _sessionErrorStatus = sessionErrorStatus;
        }

        public async Task<string> WriteAuthorizationAsync(string directory)
        {
            string path = Path.Combine(directory, "account.authorization.json");
            await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                serviceUrl = "https://api.slybrowser.test",
                licenseKey = $"sly_live_00000000-0000-4000-8000-000000000002.{"x".PadLeft(43, 'x')}",
                channel = "stable",
            }), TestContext.Current.CancellationToken);
            return path;
        }

        public LicensedLaunchSettings Settings(string cacheRoot, string? kernelMajor = null, bool? updateKernel = null) => new()
        {
            Trust = new LicenseServiceClientOptions
            {
                LicenseTrustedKeys = new Dictionary<string, byte[]> { ["lease-test"] = _leasePrivate.GeneratePublicKey().GetEncoded() },
                ReleaseTrustedKeys = new Dictionary<string, byte[]> { ["release-test"] = _releasePrivate.GeneratePublicKey().GetEncoded() },
                HttpClient = new HttpClient(new Handler(this)),
            },
            Install = new InstallOptions { CacheRoot = cacheRoot },
            Platform = "windows",
            Arch = "x64",
            KernelMajor = kernelMajor,
            UpdateKernel = updateKernel,
        };

        private HttpResponseMessage Handle(HttpRequestMessage request)
        {
            string url = request.RequestUri?.ToString() ?? "";
            if (url.EndsWith("/v2/licenses/info", StringComparison.Ordinal) && request.Method == HttpMethod.Post)
            {
                using JsonDocument requestDocument = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
                JsonElement infoRequest = requestDocument.RootElement.Clone();
                string policy = infoRequest.TryGetProperty("versionPolicy", out JsonElement policyElement)
                    ? policyElement.GetString() ?? "latest"
                    : "latest";
                string? requested = infoRequest.TryGetProperty("browserVersion", out JsonElement versionElement)
                    ? versionElement.GetString()
                    : null;
                object requestedKernelMajor = KernelMajorValue(infoRequest);
                string browserVersion = "150.0.8000.1";
                return Json(new Dictionary<string, object?>
                {
                    ["schemaVersion"] = 1,
                    ["channel"] = "stable",
                    ["licenseStatus"] = "active",
                    ["plan"] = "launch",
                    ["effectivePlan"] = "launch",
                    ["paidThrough"] = _now + 86_400,
                    ["features"] = new[] { "browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright", "puppeteer" },
                    ["concurrencyLimit"] = 5,
                    ["activeSessions"] = 0,
                    ["availableSessions"] = 5,
                    ["sessionState"] = new { activeBrowserProcesses = 0, limit = 5, available = 5 },
                    ["browserVersion"] = browserVersion,
                    ["requestedBrowserVersion"] = requested,
                    ["requestedKernelMajor"] = requestedKernelMajor,
                    ["versionPolicy"] = policy,
                    ["selectionReason"] = policy == "at-or-before" && requested != browserVersion ? "rollback" : policy == "at-or-before" ? "exact" : policy,
                    ["selectionMode"] = "latest-in-major",
                    ["availableBrowserVersions"] = new[] { browserVersion },
                    ["latestAvailableVersion"] = browserVersion,
                    ["updateAvailable"] = false,
                    ["updateRequired"] = false,
                    ["updateRights"] = new { status = "active", channel = "stable", updatesThrough = _now + 86_400, exactVersion = true, rollback = true },
                    ["stableErrorCode"] = null,
                }, HttpStatusCode.OK);
            }
            if (url.EndsWith("/v1/licenses/sessions", StringComparison.Ordinal) && request.Method == HttpMethod.Post)
            {
                if (_sessionError)
                {
                    return Json(new { error = SessionLimitError() }, _sessionErrorStatus);
                }
                using JsonDocument requestDocument = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
                JsonElement sessionRequest = requestDocument.RootElement.Clone();
                SessionRequests.Add(sessionRequest);
                string policy = sessionRequest.TryGetProperty("versionPolicy", out JsonElement policyElement)
                    ? policyElement.GetString() ?? "latest"
                    : "latest";
                string? requested = sessionRequest.TryGetProperty("browserVersion", out JsonElement versionElement)
                    ? versionElement.GetString()
                    : null;
                object requestedKernelMajor = KernelMajorValue(sessionRequest);
                string browserVersion = "150.0.8000.1";
                return Json(new Dictionary<string, object?>
                {
                    ["schemaVersion"] = 1,
                    ["sessionId"] = "00000000-0000-4000-8000-000000000001",
                    ["sessionToken"] = _sessionToken,
                    ["heartbeatAfterSeconds"] = 60,
                    ["expiresAt"] = _now + 600,
                    ["plan"] = "launch",
                    ["concurrencyLimit"] = 5,
                    ["activeSessions"] = 1,
                    ["browserVersion"] = browserVersion,
                    ["requestedBrowserVersion"] = requested,
                    ["requestedKernelMajor"] = requestedKernelMajor,
                    ["versionPolicy"] = policy,
                    ["selectionReason"] = policy == "at-or-before" && requested != browserVersion ? "rollback" : policy == "at-or-before" ? "exact" : policy,
                    ["selectionMode"] = policy == "latest" && requestedKernelMajor is int ? "latest-in-major" : policy,
                    ["availableBrowserVersions"] = new[] { browserVersion },
                    ["latestAvailableVersion"] = browserVersion,
                    ["updateAvailable"] = false,
                    ["updateRequired"] = false,
                    ["updateRights"] = new { status = "active", channel = "stable", updatesThrough = _now + 86_400, exactVersion = true, rollback = true },
                    ["lease"] = Lease(browserVersion),
                    ["manifest"] = Manifest(),
                }, HttpStatusCode.Created);
            }
            if (url.EndsWith("/v2/runtime/sessions", StringComparison.Ordinal) && request.Method == HttpMethod.Post)
            {
                if (_sessionError)
                {
                    return Json(new { error = SessionLimitError() }, _sessionErrorStatus);
                }
                using JsonDocument requestDocument = JsonDocument.Parse(request.Content!.ReadAsStringAsync().Result);
                JsonElement runtimeRequest = requestDocument.RootElement.Clone();
                RuntimeSessionRequests.Add(runtimeRequest);
                string policy = runtimeRequest.TryGetProperty("versionPolicy", out JsonElement policyElement)
                    ? policyElement.GetString() ?? "latest"
                    : "latest";
                string? requested = runtimeRequest.TryGetProperty("browserVersion", out JsonElement versionElement)
                    ? versionElement.GetString()
                    : null;
                string startupId = runtimeRequest.TryGetProperty("startupId", out JsonElement startupElement)
                    ? startupElement.GetString() ?? ""
                    : "";
                string? automationBackend = null;
                if (runtimeRequest.TryGetProperty("automationBackend", out JsonElement backendElement))
                {
                    automationBackend = backendElement.GetString();
                    Assert.Contains(backendElement.GetString(), new[] { "project-webdriver", "playwright" });
                }
                object requestedKernelMajor = KernelMajorValue(runtimeRequest);
                string browserVersion = "150.0.8000.1";
                Dictionary<string, object?> ticket = new()
                {
                    ["token"] = _downloadTicketToken,
                    ["expiresAt"] = _now + 600,
                    ["artifactSha256"] = _artifactSha256,
                    ["artifactUrl"] = $"https://api.slybrowser.test/v1/releases/artifacts/{_artifactSha256}.zip",
                };
                return Json(new Dictionary<string, object?>
                {
                    ["schemaVersion"] = 2,
                    ["state"] = "reserved",
                    ["startupId"] = startupId,
                    ["sessionId"] = "00000000-0000-4000-8000-000000000001",
                    ["bootstrapToken"] = _bootstrapToken,
                    ["activationTicket"] = _activationTicket,
                    ["driverActivationTicket"] = automationBackend == "project-webdriver" ? _driverActivationTicket : null,
                    ["heartbeatAfterSeconds"] = 60,
                    ["expiresAt"] = _now + 600,
                    ["plan"] = "launch",
                    ["concurrencyLimit"] = 5,
                    ["activeSessions"] = 1,
                    ["browserVersion"] = browserVersion,
                    ["requestedBrowserVersion"] = requested,
                    ["requestedKernelMajor"] = requestedKernelMajor,
                    ["versionPolicy"] = policy,
                    ["selectionReason"] = policy == "at-or-before" && requested != browserVersion ? "rollback" : policy == "at-or-before" ? "exact" : policy,
                    ["selectionMode"] = policy == "latest" && requestedKernelMajor is int ? "latest-in-major" : policy,
                    ["availableBrowserVersions"] = new[] { browserVersion },
                    ["latestAvailableVersion"] = browserVersion,
                    ["updateAvailable"] = false,
                    ["updateRequired"] = false,
                    ["updateRights"] = new { status = "active", channel = "stable", updatesThrough = _now + 86_400, exactVersion = true, rollback = true },
                    ["lease"] = Lease(browserVersion),
                    ["manifest"] = Manifest(),
                    ["downloadTicket"] = ticket,
                }, HttpStatusCode.Created);
            }
            if (url.EndsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/bootstrap-heartbeat", StringComparison.Ordinal) &&
                request.Method == HttpMethod.Post)
            {
                Assert.Equal($"Bootstrap {_bootstrapToken}", request.Headers.Authorization?.ToString());
                return RuntimeJson("reserved", includeRuntimeToken: false);
            }
            if (url.EndsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/activate", StringComparison.Ordinal) &&
                request.Method == HttpMethod.Post)
            {
                Assert.Equal($"Activation {_activationTicket}", request.Headers.Authorization?.ToString());
                return RuntimeJson("active", includeRuntimeToken: true);
            }
            if (url.EndsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/heartbeat", StringComparison.Ordinal) &&
                request.Method == HttpMethod.Post)
            {
                Assert.Equal($"Runtime {_runtimeToken}", request.Headers.Authorization?.ToString());
                return RuntimeJson("active", includeRuntimeToken: false);
            }
            if (url.EndsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/close", StringComparison.Ordinal) &&
                request.Method == HttpMethod.Post)
            {
                Assert.Equal($"Runtime {_runtimeToken}", request.Headers.Authorization?.ToString());
                return RuntimeJson("closing", includeRuntimeToken: false);
            }
            if (url.Contains("/v1/releases/artifacts/", StringComparison.Ordinal))
            {
                Assert.Equal($"Session {_sessionToken}", request.Headers.Authorization?.ToString());
                Downloads++;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(_archive) };
            }
            if (url.Contains("/v2/runtime/artifacts/", StringComparison.Ordinal))
            {
                Assert.Equal($"Download {_downloadTicketToken}", request.Headers.Authorization?.ToString());
                Downloads++;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(_archive) };
            }
            if (request.Method == HttpMethod.Delete)
            {
                if (url.Contains("/v2/runtime/sessions/", StringComparison.Ordinal))
                {
                    string? authorization = request.Headers.Authorization?.ToString();
                    Assert.True(
                        authorization == $"Runtime {_runtimeToken}" || authorization == $"Bootstrap {_bootstrapToken}",
                        $"Unexpected v2 runtime release authorization: {authorization}");
                }
                Releases++;
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }
            throw new InvalidOperationException($"Unexpected request: {request.Method} {url}");
        }

        private Dictionary<string, object?> SessionLimitError() => new()
        {
            ["code"] = _sessionErrorCode,
            ["message"] = "Limit reached for runtime-token buyer@example.com paynow-secret",
            ["concurrencyLimit"] = 5,
            ["activeSessions"] = 5,
            ["availableSessions"] = 0,
            ["runtimeToken"] = _runtimeToken,
            ["downloadTicket"] = _downloadTicketToken,
            ["email"] = "buyer@example.com",
            ["payNowId"] = "paynow-secret",
            ["actions"] = new object[]
            {
                new Dictionary<string, object?>
                {
                    ["type"] = "close_session",
                    ["api"] = "DELETE /v2/runtime/sessions/{sessionId}",
                    ["authorization"] = $"Runtime {_runtimeToken}",
                },
                new Dictionary<string, object?> { ["type"] = "upgrade_plan", ["url"] = "https://slybrowser.com/#pricing" },
            },
        };

        private static object KernelMajorValue(JsonElement request)
        {
            if (!request.TryGetProperty("kernelMajor", out JsonElement kernelMajor)) return "latest";
            return kernelMajor.ValueKind == JsonValueKind.Number
                ? kernelMajor.GetInt32()
                : kernelMajor.GetString() ?? "latest";
        }

        private HttpResponseMessage RuntimeJson(string state, bool includeRuntimeToken)
        {
            Dictionary<string, object?> response = new()
            {
                ["schemaVersion"] = 2,
                ["state"] = state,
                ["startupId"] = "st_dotnetv2runtime001",
                ["sessionId"] = "00000000-0000-4000-8000-000000000001",
                ["heartbeatAfterSeconds"] = 60,
                ["expiresAt"] = _now + 600,
                ["plan"] = "launch",
                ["concurrencyLimit"] = 5,
                ["activeSessions"] = 1,
                ["lease"] = Lease("150.0.8000.1"),
            };
            if (includeRuntimeToken) response["runtimeToken"] = _runtimeToken;
            return Json(response, HttpStatusCode.OK);
        }

        private Dictionary<string, object?> Lease(string browserVersion)
        {
            string browserSha256 = Sha256(Encoding.UTF8.GetBytes("browser"));
            string driverSha256 = Sha256(Encoding.UTF8.GetBytes("driver"));
            Dictionary<string, object?> artifact = new()
            {
                ["sha256"] = _artifactSha256,
                ["platform"] = "windows",
                ["arch"] = "x64",
                ["archiveFormat"] = "zip",
                ["browserExecutable"] = "SlyBrowser.exe",
                ["driverExecutable"] = "chromedriver.exe",
                ["browserSha256"] = browserSha256,
                ["driverSha256"] = driverSha256,
                ["privateModules"] = new object[]
                {
                    new Dictionary<string, object?>
                    {
                        ["path"] = "SlyBrowser/sly_private_module.dll",
                        ["sha256"] = Sha256(Encoding.UTF8.GetBytes("private-module")),
                        ["size"] = Encoding.UTF8.GetByteCount("private-module"),
                        ["abi"] = "windows-x64",
                    },
                },
                ["resources"] = new object[]
                {
                    new Dictionary<string, object?>
                    {
                        ["path"] = "SlyBrowser/resources.pak",
                        ["sha256"] = Sha256(Encoding.UTF8.GetBytes("resources")),
                        ["size"] = Encoding.UTF8.GetByteCount("resources"),
                    },
                },
                ["codeSignature"] = new Dictionary<string, object?>
                {
                    ["scheme"] = "authenticode",
                    ["subject"] = "CN=SlyBrowser Test Publisher",
                    ["certificateSha256"] = new string('3', 64),
                    ["timestampRequired"] = true,
                },
            };
            Dictionary<string, object?> claims = new()
            {
                ["schemaVersion"] = 2,
                ["licenseId"] = "00000000-0000-4000-8000-000000000002",
                ["audience"] = "slybrowser",
                ["issuedAt"] = _now,
                ["notBefore"] = _now,
                ["expiresAt"] = _now + 600,
                ["browserVersion"] = browserVersion,
                ["browserMin"] = browserVersion,
                ["browserMax"] = browserVersion,
                ["planId"] = "launch",
                ["concurrencyLimit"] = 5,
                ["licenseStatus"] = "active",
                ["artifactSha256"] = _artifactSha256,
                ["browserSha256"] = browserSha256,
                ["driverSha256"] = driverSha256,
                ["artifact"] = artifact,
                ["leaseGeneration"] = _now + 600,
                ["features"] = new[] { "browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright" },
                ["sessionId"] = "00000000-0000-4000-8000-000000000001",
                ["nonce"] = "test-nonce",
            };
            byte[] payload = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(claims));
            return new Dictionary<string, object?>
            {
                ["algorithm"] = "Ed25519",
                ["keyId"] = "lease-test",
                ["payload"] = CanonicalJson.EncodeBase64Url(payload),
                ["signature"] = CanonicalJson.EncodeBase64Url(Sign(_leasePrivate, payload)),
            };
        }

        private Dictionary<string, object?> Manifest()
        {
            Dictionary<string, object?> unsigned = new()
            {
                ["schemaVersion"] = 1,
                ["browserVersion"] = "150.0.8000.1",
                ["sdkCompatibility"] = ">=0.1.0 <1.0.0",
                ["status"] = "available",
                ["publishedAt"] = DateTimeOffset.FromUnixTimeSeconds(_now).ToString("O"),
                ["artifacts"] = new[]
                {
                    new Dictionary<string, object?>
                    {
                        ["platform"] = "windows",
                        ["arch"] = "x64",
                        ["url"] = $"https://api.slybrowser.test/v1/releases/artifacts/{_artifactSha256}.zip",
                        ["sha256"] = _artifactSha256,
                        ["size"] = _archive.Length,
                        ["archiveFormat"] = "zip",
                        ["browserExecutable"] = "SlyBrowser.exe",
                        ["driverExecutable"] = "chromedriver.exe",
                        ["browserSha256"] = Sha256(Encoding.UTF8.GetBytes("browser")),
                        ["driverSha256"] = Sha256(Encoding.UTF8.GetBytes("driver")),
                        ["privateModules"] = new object[]
                        {
                            new Dictionary<string, object?>
                            {
                                ["path"] = "SlyBrowser/sly_private_module.dll",
                                ["sha256"] = Sha256(Encoding.UTF8.GetBytes("private-module")),
                                ["size"] = Encoding.UTF8.GetByteCount("private-module"),
                                ["abi"] = "windows-x64",
                            },
                        },
                        ["resources"] = new object[]
                        {
                            new Dictionary<string, object?>
                            {
                                ["path"] = "SlyBrowser/resources.pak",
                                ["sha256"] = Sha256(Encoding.UTF8.GetBytes("resources")),
                                ["size"] = Encoding.UTF8.GetByteCount("resources"),
                            },
                        },
                        ["codeSignature"] = new Dictionary<string, object?>
                        {
                            ["scheme"] = "authenticode",
                            ["subject"] = "CN=SlyBrowser Test Publisher",
                            ["certificateSha256"] = new string('3', 64),
                            ["timestampRequired"] = true,
                        },
                    },
                },
                ["evidence"] = new
                {
                    sbom = new { url = "https://api.slybrowser.test/evidence/sbom.json", sha256 = new string('0', 64), size = 1, mediaType = "application/vnd.cyclonedx+json" },
                    provenance = new { url = "https://api.slybrowser.test/evidence/provenance.json", sha256 = new string('1', 64), size = 1, mediaType = "application/vnd.in-toto+json" },
                    chromiumPatchInventory = new { url = "https://api.slybrowser.test/evidence/patches.json", sha256 = new string('2', 64), size = 1, mediaType = "application/vnd.slybrowser.chromium-patch-inventory+json" },
                    sourceBoundary = new { sdk = "open-source", chromiumPatches = "inventory-and-approved-patches", proprietaryCore = "private" },
                },
            };
            using JsonDocument unsignedDocument = JsonDocument.Parse(JsonSerializer.Serialize(unsigned));
            byte[] payload = CanonicalJson.Serialize(unsignedDocument.RootElement);
            Dictionary<string, object?> manifest = new(unsigned)
            {
                ["signature"] = new Dictionary<string, object?>
                {
                    ["algorithm"] = "ed25519",
                    ["keyId"] = "release-test",
                    ["value"] = CanonicalJson.EncodeBase64Url(Sign(_releasePrivate, payload)),
                },
            };
            if (_tamperManifest) manifest["browserVersion"] = "151.0.0.0";
            return manifest;
        }

        private static HttpResponseMessage Json(object value, HttpStatusCode status)
        {
            return new HttpResponseMessage(status)
            {
                Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json"),
            };
        }

        private static byte[] BuildArchive()
        {
            using MemoryStream stream = new();
            using (System.IO.Compression.ZipArchive archive = new(stream, System.IO.Compression.ZipArchiveMode.Create, leaveOpen: true))
            {
                WriteEntry(archive, "SlyBrowser.exe", "browser");
                WriteEntry(archive, "chromedriver.exe", "driver");
            }
            return stream.ToArray();
        }

        private static void WriteEntry(System.IO.Compression.ZipArchive archive, string name, string value)
        {
            System.IO.Compression.ZipArchiveEntry entry = archive.CreateEntry(name);
            using StreamWriter writer = new(entry.Open());
            writer.Write(value);
        }

        private static Ed25519PrivateKeyParameters NewPrivateKey()
        {
            Ed25519KeyPairGenerator generator = new();
            generator.Init(new Org.BouncyCastle.Crypto.KeyGenerationParameters(new SecureRandom(), 256));
            return (Ed25519PrivateKeyParameters)generator.GenerateKeyPair().Private;
        }

        private static byte[] Sign(Ed25519PrivateKeyParameters key, byte[] payload)
        {
            Ed25519Signer signer = new();
            signer.Init(true, key);
            signer.BlockUpdate(payload, 0, payload.Length);
            return signer.GenerateSignature();
        }

        private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

        private sealed class Handler(Fixture fixture) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
                Task.FromResult(fixture.Handle(request));
        }
    }
}
