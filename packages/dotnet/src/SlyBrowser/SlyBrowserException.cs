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
