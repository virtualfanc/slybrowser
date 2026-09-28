namespace SlyBrowser;

public class SlyBrowserException : Exception
{
    public string Code { get; }

    public SlyBrowserException(string message, string code, Exception? innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }
}

public sealed class ConfigurationException : SlyBrowserException
{
    public ConfigurationException(string message, string code, Exception? innerException = null)
        : base(message, code, innerException) { }
}

public sealed class LicenseException : SlyBrowserException
{
    public LicenseException(string message, string code, Exception? innerException = null)
        : base(message, code, innerException) { }
}

public sealed class LicenseServiceException : SlyBrowserException
{
    public int Status { get; }
    public IReadOnlyDictionary<string, object?> Details { get; }

    public LicenseServiceException(
        string message,
        string code,
        int status = 0,
        Exception? innerException = null,
        IReadOnlyDictionary<string, object?>? details = null)
        : base(message, code, innerException)
    {
        Status = status;
        Details = details is null
            ? new Dictionary<string, object?>(StringComparer.Ordinal)
            : details.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    }
}

public sealed class ManifestException : SlyBrowserException
{
    public ManifestException(string message, string code, Exception? innerException = null)
        : base(message, code, innerException) { }
}

public sealed class ArtifactException : SlyBrowserException
{
    public ArtifactException(string message, string code, Exception? innerException = null)
        : base(message, code, innerException) { }
}
