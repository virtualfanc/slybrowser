using System.Reflection;

namespace SlyBrowser.Tests;

public sealed class SlyBrowserPublicApiTests
{
    [Fact]
    public void ExposesOnlyTheUserFacingLaunchFamily()
    {
        string[] methods = typeof(SlyBrowserClient)
            .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
            .Select(method => method.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(
            ["LaunchAsync", "LaunchPlaywrightAsync", "LaunchPlaywrightPersistentAsync"],
            methods);
    }

    [Fact]
    public async Task UsesOfficialTrustAndRejectsUnsupportedValues()
    {
        MethodInfo mapper = typeof(SlyBrowserClient).GetMethod(
            "LicensedSettings",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        LicensedLaunchSettings settings = (LicensedLaunchSettings)mapper.Invoke(
            null,
            [new SlyBrowserOptions()])!;
        Assert.NotEmpty(settings.Trust.LicenseTrustedKeys);
        Assert.NotEmpty(settings.Trust.ReleaseTrustedKeys);
        Assert.NotEmpty(settings.Trust.LicenseFileTrustedKeys);
        Assert.Equal("ephemeral", settings.WebDriver.ProfileMode);

        SlyBrowserOptions invalid = new()
        {
            Launch = new LaunchOptions { ProfileMode = "shared" },
        };
        ConfigurationException error = await Assert.ThrowsAsync<ConfigurationException>(
            () => SlyBrowserClient.LaunchAsync(
                "account.authorization.json",
                invalid,
                TestContext.Current.CancellationToken));
        Assert.Equal("launch_options_invalid", error.Code);
    }
}
