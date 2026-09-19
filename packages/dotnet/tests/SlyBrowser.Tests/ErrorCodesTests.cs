using System.Text.Json;

namespace SlyBrowser.Tests;

public class ErrorCodesTests
{
    [Fact]
    public void LicenseServiceErrorCodesMatchSharedContract()
    {
        string contractPath = FindRepositoryFile("contracts/error-codes.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(contractPath));
        string[] codes = document.RootElement.GetProperty("codes")
            .EnumerateArray()
            .Select(entry => entry.GetProperty("code").GetString()!)
            .ToArray();

        Assert.Equal(codes, ErrorCodes.LicenseService);
        Assert.Equal(codes.Length, new HashSet<string>(codes, StringComparer.Ordinal).Count);
        Assert.True(ErrorCodes.IsLicenseServiceErrorCode("session_limit"));
        Assert.False(ErrorCodes.IsLicenseServiceErrorCode("not_a_slybrowser_error"));
    }

    private static string FindRepositoryFile(string relativePath)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null)
        {
            string candidate = Path.Combine(directory.FullName, relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(candidate)) return candidate;
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"Unable to locate {relativePath}");
    }
}
