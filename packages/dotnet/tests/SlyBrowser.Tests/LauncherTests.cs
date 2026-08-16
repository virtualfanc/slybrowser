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
            await File.WriteAllTextAsync(executable, "test");
            string secret = "license-secret-must-not-appear-in-arguments";
            string configFile;
            string licenseFile;
            await using (LaunchPlan plan = await SlyBrowserLauncher.PrepareAsync(
                executable,
                new { headless = true },
                $"{{\"lease\":\"{secret}\"}}",
                directory,
                ["--no-first-run"]))
            {
                configFile = plan.ConfigFile;
                licenseFile = plan.LicenseFile;
                Assert.DoesNotContain(secret, string.Join(' ', plan.Arguments));
                Assert.True(File.Exists(configFile));
                Assert.True(File.Exists(licenseFile));
            }
            Assert.False(File.Exists(configFile));
            Assert.False(File.Exists(licenseFile));
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
            await File.WriteAllTextAsync(executable, "test");
            ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
                () => SlyBrowserLauncher.PrepareAsync(
                    executable,
                    new { licenseKey = "long-lived-secret" },
                    "{\"lease\":\"test\"}",
                    directory));
            Assert.Equal("profile_secret_forbidden", error.Code);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
