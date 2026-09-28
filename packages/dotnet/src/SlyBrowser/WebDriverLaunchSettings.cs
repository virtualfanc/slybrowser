namespace SlyBrowser;

public sealed class WebDriverLaunchSettings
{
    public object Profile { get; init; } = new { };
    public object? RuntimeHandoff { get; init; }
    public object? DriverRuntimeHandoff { get; init; }
    public bool AllowRuntimeActivationTicket { get; init; }
    public bool NativeReady { get; init; }
    public TimeSpan NativeReadyTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public string? TempRoot { get; init; }
    public string? ReleaseRoot { get; init; }
    public string? ProfileDirectory { get; init; }
    public string? ProfileMode { get; init; }
    public IList<string> BrowserArguments { get; init; } = [];
    public IList<string> ExcludedSwitches { get; init; } = ["enable-automation", "enable-unsafe-swiftshader"];
    public bool Headless { get; init; } = true;
    public int ViewportWidth { get; init; } = 1920;
    public int ViewportHeight { get; init; } = 947;
    public bool Humanize { get; init; }
    public string HumanPreset { get; init; } = "default";
    public IReadOnlyDictionary<string, double>? HumanConfig { get; init; }
    public int? HumanSeed { get; init; }
    public TimeSpan DriverStartTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan CommandTimeout { get; init; } = TimeSpan.FromSeconds(60);
}
