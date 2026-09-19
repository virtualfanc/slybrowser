using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace SlyBrowser;

public enum AutomationBackend
{
    ProjectWebDriver,
    Playwright,
}

public sealed record AutomationCapability(
    AutomationBackend Backend,
    string Language,
    string? FrameworkVersion,
    bool NativeHumanize,
    bool PersistentContext);

public static partial class AutomationPolicy
{
    private static readonly HashSet<string> SupportedPlaywrightLines = ["1.61"];

    [GeneratedRegex("^(?<major>[0-9]+)\\.(?<minor>[0-9]+)(?:\\.[0-9]+)?(?:[-+][0-9A-Za-z.-]+)?$")]
    private static partial Regex VersionPattern();

    public static string ValidatePlaywrightVersion(string version)
    {
        Match match = VersionPattern().Match(version);
        if (!match.Success)
            throw new ConfigurationException(
                $"Invalid Playwright version: {version}",
                "framework_version_invalid");
        string line = $"{match.Groups["major"].Value}.{match.Groups["minor"].Value}";
        if (!SupportedPlaywrightLines.Contains(line))
            throw new ConfigurationException(
                $"Unsupported Playwright version {version}; supported lines: {string.Join(", ", SupportedPlaywrightLines)}",
                "framework_version_unsupported");
        return version;
    }

    public static string ResolvePlaywrightVersion(string? explicitVersion = null)
    {
        if (explicitVersion is not null) return ValidatePlaywrightVersion(explicitVersion);
        Assembly assembly = typeof(IPlaywright).Assembly;
        string? version = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion
            ?? assembly.GetName().Version?.ToString(3);
        if (string.IsNullOrWhiteSpace(version))
            throw new ConfigurationException(
                "Unable to determine the installed Microsoft.Playwright version",
                "framework_version_missing");
        return ValidatePlaywrightVersion(version);
    }

    public static AutomationCapability Capability(
        AutomationBackend backend = AutomationBackend.ProjectWebDriver,
        string? frameworkVersion = null)
    {
        if (backend is AutomationBackend.ProjectWebDriver)
        {
            if (frameworkVersion is not null)
                throw new ConfigurationException(
                    "Project WebDriver does not accept a framework version",
                    "framework_version_forbidden");
            return new(backend, "dotnet", null, true, true);
        }
        return new(backend, "dotnet", ResolvePlaywrightVersion(frameworkVersion), true, true);
    }

    internal static void RequirePlaywrightHumanizeSupport(bool requested)
    {
        _ = requested;
    }
}
