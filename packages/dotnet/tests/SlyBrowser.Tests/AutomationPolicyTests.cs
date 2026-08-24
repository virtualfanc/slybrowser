namespace SlyBrowser.Tests;

public sealed class AutomationPolicyTests
{
    [Fact]
    public void ProjectWebDriverIsTheDefaultBackend()
    {
        AutomationCapability capability = AutomationPolicy.Capability();
        Assert.Equal(AutomationBackend.ProjectWebDriver, capability.Backend);
        Assert.Equal("dotnet", capability.Language);
        Assert.True(capability.NativeHumanize);
        Assert.True(capability.PersistentContext);
        Assert.Null(capability.FrameworkVersion);
    }

    [Fact]
    public void OnlyValidatedPlaywrightLineIsAccepted()
    {
        Assert.Equal("1.61.0", AutomationPolicy.ValidatePlaywrightVersion("1.61.0"));
        ConfigurationException error = Assert.Throws<ConfigurationException>(
            () => AutomationPolicy.ValidatePlaywrightVersion("1.62.0"));
        Assert.Equal("framework_version_unsupported", error.Code);
    }

    [Fact]
    public void PlaywrightAdvertisesNativeHumanizeControlPlane()
    {
        AutomationCapability capability = AutomationPolicy.Capability(
            AutomationBackend.Playwright,
            "1.61.0");
        Assert.Equal(AutomationBackend.Playwright, capability.Backend);
        Assert.Equal("dotnet", capability.Language);
        Assert.Equal("1.61.0", capability.FrameworkVersion);
        Assert.True(capability.NativeHumanize);
        Assert.True(capability.PersistentContext);
    }
}
