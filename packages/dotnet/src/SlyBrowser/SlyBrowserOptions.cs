namespace SlyBrowser;

/// <summary>User-facing options shared with the Node.js, Python and Java SDKs.</summary>
public sealed class SlyBrowserOptions
{
    public IReadOnlyDictionary<string, object?> Profile { get; init; } =
        new Dictionary<string, object?>(StringComparer.Ordinal);
    public LaunchOptions Launch { get; init; } = new();
    public HumanizeOptions Humanize { get; init; } = new();
}

public sealed class LaunchOptions
{
    public bool Headless { get; init; } = true;
    public string ProfileMode { get; init; } = "ephemeral";
    public string? ProfileDirectory { get; init; }
    public bool UpdateKernel { get; init; } = true;
}

public sealed class HumanizeOptions
{
    public bool Enabled { get; init; }
    public string Preset { get; init; } = "default";
    public int? Seed { get; init; }
    public IReadOnlyDictionary<string, double>? Config { get; init; }
}
