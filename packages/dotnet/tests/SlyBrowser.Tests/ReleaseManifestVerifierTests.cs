namespace SlyBrowser.Tests;

using System.Text;
using System.Text.Json;

public sealed class ReleaseManifestVerifierTests
{
    [Fact]
    public void SupportsCaretSdkCompatibilityRanges()
    {
        Assert.True(ReleaseManifestVerifier.IsSdkCompatible("^0.1.0", "0.1.0"));
        Assert.True(ReleaseManifestVerifier.IsSdkCompatible("^0.1.0", "0.1.9"));
        Assert.False(ReleaseManifestVerifier.IsSdkCompatible("^0.1.0", "0.2.0"));
        Assert.True(ReleaseManifestVerifier.IsSdkCompatible("^1.2.3", "1.9.0"));
        Assert.False(ReleaseManifestVerifier.IsSdkCompatible("^1.2.3", "2.0.0"));
    }

    [Fact]
    public void CanonicalJsonMatchesJsonStringifyPlusEscaping()
    {
        JsonElement element = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
        {
            ["publishedAt"] = "2026-08-24T14:35:34.0167890+00:00",
        });

        string canonical = Encoding.UTF8.GetString(CanonicalJson.Serialize(element));

        Assert.Equal("{\"publishedAt\":\"2026-08-24T14:35:34.0167890+00:00\"}", canonical);
    }
}
