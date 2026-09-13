namespace SlyBrowser.Tests;

public sealed class LauncherTests
{
    [Fact]
    public async Task HandoffFilesAreRemovedAndSecretIsNotInArguments()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            string secret = "license-secret-must-not-appear-in-arguments";
            string runtimeSecret = "bootstrap-token-must-not-appear-in-arguments";
            string configFile;
            string licenseFile;
            string runtimeFile;
            await using (LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
                executable,
                new { headless = true },
                $"{{\"lease\":\"{secret}\"}}",
                directory,
                ["--no-first-run"],
                runtimeHandoff: new { schemaVersion = 2, bootstrapToken = runtimeSecret },
                cancellationToken: TestContext.Current.CancellationToken))
            {
                configFile = plan.ConfigFile;
                licenseFile = plan.LicenseFile;
                runtimeFile = plan.RuntimeFile!;
                Assert.DoesNotContain(secret, string.Join(' ', plan.Arguments));
                Assert.DoesNotContain(runtimeSecret, string.Join(' ', plan.Arguments));
                Assert.Contains(plan.Arguments, argument => argument.StartsWith("--sly-runtime-file=", StringComparison.Ordinal));
                Assert.True(File.Exists(configFile));
                Assert.True(File.Exists(licenseFile));
                Assert.True(File.Exists(runtimeFile));
            }
            Assert.False(File.Exists(configFile));
            Assert.False(File.Exists(licenseFile));
            Assert.False(File.Exists(runtimeFile));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task LongLivedLicenseKeyInProfileHandoffIsRejected()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { licenseKey = "long-lived-secret" },
                    "{\"lease\":\"test\"}",
                    directory,
                    cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal("profile_secret_forbidden", error.Code);

            ConfigurationException runtimeError = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { runtimeToken = "short-lived-secret" },
                    "{\"lease\":\"test\"}",
                    directory,
                    cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal("profile_secret_forbidden", runtimeError.Code);

            ConfigurationException activationError = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { activationTicket = "activation-secret" },
                    "{\"lease\":\"test\"}",
                    directory,
                    cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal("profile_secret_forbidden", activationError.Code);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task SeededFingerprintEnvelopeIsValidatedBeforeNativeLaunch()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            await using (LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(executable,
                new { fingerprintMode = "seeded", fingerprintSeed = "stable-profile-seed", fingerprintSchemaVersion = 1 },
                "{\"lease\":\"test\"}", directory, cancellationToken: TestContext.Current.CancellationToken))
                Assert.Contains("stable-profile-seed", await File.ReadAllTextAsync(plan.ConfigFile, TestContext.Current.CancellationToken));
            foreach (object invalid in new object[] {
                new { fingerprintMode = "seeded", fingerprintSeed = "missing-schema" },
                new { fingerprintMode = "explicit", fingerprintSeed = "forbidden", fingerprintSchemaVersion = 1 },
                new { fingerprintSeed = "bad-version", fingerprintSchemaVersion = 2 },
            })
            {
                ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(() => SlyBrowserLauncher.PrepareAsync(
                    executable, invalid, "{\"lease\":\"test\"}", directory, cancellationToken: TestContext.Current.CancellationToken));
                Assert.Equal("profile_invalid", error.Code);
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task RuntimeMaterialInExtraArgumentsIsRejected()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { },
                    "{\"lease\":\"test\"}",
                    directory,
                    ["--sly-runtime-token=secret"],
                    cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal("license_argument_forbidden", error.Code);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task RuntimeHandoffSecretsAreRejected()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { },
                    "{\"lease\":\"test\"}",
                    directory,
                    runtimeHandoff: new { schemaVersion = 2, runtimeToken = "post-activate-secret" },
                    cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal("runtime_handoff_secret_forbidden", error.Code);

            ConfigurationException activationError = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { },
                    "{\"lease\":\"test\"}",
                    directory,
                    runtimeHandoff: new { schemaVersion = 2, activationTicket = "activation-secret" },
                    cancellationToken: TestContext.Current.CancellationToken));
            Assert.Equal("runtime_handoff_secret_forbidden", activationError.Code);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task RuntimeTextInNonSecretArgumentValueIsAllowed()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            await using LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
                executable,
                new { },
                "{\"lease\":\"test\"}",
                directory,
                ["--enable-features=RuntimeCallStats"],
                cancellationToken: TestContext.Current.CancellationToken);
            Assert.Contains("--enable-features=RuntimeCallStats", plan.Arguments);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task ReleaseRootIsPassedAsNonSecretNativeArgument()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            string releaseRoot = Path.Combine(directory, "release-root");
            Directory.CreateDirectory(releaseRoot);
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            await using LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
                executable,
                new { },
                "{\"lease\":\"test\"}",
                directory,
                releaseRoot: releaseRoot,
                cancellationToken: TestContext.Current.CancellationToken);
            string resolvedReleaseRoot = Path.GetFullPath(releaseRoot);
            Assert.Equal(resolvedReleaseRoot, plan.ReleaseRoot);
            Assert.Contains($"--sly-release-root={resolvedReleaseRoot}", plan.Arguments);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task LegacyPositionalCancellationTokenOverloadStillWorks()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"sly-dotnet-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string executable = Path.Combine(directory, "browser.exe");
            await File.WriteAllTextAsync(executable, "test", TestContext.Current.CancellationToken);
            await using LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
                executable,
                new { },
                "{\"lease\":\"test\"}",
                directory,
                Array.Empty<string>(),
                null,
                TestContext.Current.CancellationToken);
            Assert.True(File.Exists(plan.ConfigFile));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
