namespace SlyBrowser;

public sealed class LicenseFileReadOptions
{
    public bool AllowInsecureLocalhost { get; init; }
    public string? LicenseFilePassphrase { get; init; }
    public IReadOnlyDictionary<string, byte[]> LicenseFileTrustedKeys { get; init; } =
        new Dictionary<string, byte[]>(StringComparer.Ordinal);
    public IReadOnlySet<string> TrustedServiceUrls { get; init; } =
        new HashSet<string>(["https://api.slybrowser.com"], StringComparer.Ordinal);
}
