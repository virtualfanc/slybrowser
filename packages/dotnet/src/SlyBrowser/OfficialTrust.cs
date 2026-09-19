namespace SlyBrowser;

internal static class OfficialTrust
{
    private static byte[] Decode(string value) => Convert.FromBase64String(
        value.Replace('-', '+').Replace('_', '/') + new string('=', (4 - value.Length % 4) % 4));

    internal static LicenseServiceClientOptions Create() => new()
    {
        LicenseTrustedKeys = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["launch-candidate-20260824"] = Decode("h9ie2nXxsXVKlxjFIz-or1otChHTF8HS94vV_EjY1KM"),
        },
        ReleaseTrustedKeys = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["release-launch-candidate-20260824"] = Decode("SvSlPQKT9oZ4nIVuJXgd2pFOC0QblDph29vKlz6NJZo"),
        },
        LicenseFileTrustedKeys = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            ["license-file-private-preview-v1"] = Decode("wc3DR5wOqazjZF_3n41EF1cMh5d-qGv2wkZHyd0Sj6s"),
        },
    };
}
