namespace SlyBrowser.Tests;

public sealed class BrowserInstallerTests
{
    [Fact]
    public void SevenZipPreflightRejectsUnsafeAndOversizedEntries()
    {
        string listing = string.Join('\n', new[]
        {
            "7-Zip listing",
            "----------",
            "Path = SlyBrowser.exe",
            "Size = 8",
            "Attributes = A",
            "",
            "Path = ../outside",
            "Size = 1",
            "Attributes = A",
            "",
        });

        ArtifactException unsafeEntry = Assert.Throws<ArtifactException>(
            () => BrowserInstaller.Inspect7zListing(listing, 8));
        Assert.Equal("artifact_layout_invalid", unsafeEntry.Code);

        ArtifactException oversized = Assert.Throws<ArtifactException>(
            () => BrowserInstaller.Inspect7zListing(listing.Replace("../outside", "chromedriver.exe"), 8));
        Assert.Equal("artifact_expanded_too_large", oversized.Code);
    }
}
