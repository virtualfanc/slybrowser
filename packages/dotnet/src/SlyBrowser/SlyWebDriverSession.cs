using System.Diagnostics;
using OpenQA.Selenium.Remote;

namespace SlyBrowser;

public sealed class SlyWebDriverSession : IDisposable, IAsyncDisposable
{
    private readonly Process _driverProcess;
    private readonly Uri _driverServiceUrl;
    private readonly LaunchPlan _launchPlan;
    private readonly string _driverLicenseFile;
    private readonly string? _driverRuntimeFile;
    private readonly List<Func<ValueTask>> _closeCallbacks = [];
    private bool _disposed;

    internal SlyWebDriverSession(
        RemoteWebDriver driver,
        Process driverProcess,
        Uri driverServiceUrl,
        LaunchPlan launchPlan,
        string driverLicenseFile,
        string? driverRuntimeFile,
        string browserVersion,
        string driverVersion)
    {
        Driver = driver;
        _driverProcess = driverProcess;
        _driverServiceUrl = driverServiceUrl;
        _launchPlan = launchPlan;
        _driverLicenseFile = driverLicenseFile;
        _driverRuntimeFile = driverRuntimeFile;
        BrowserVersion = browserVersion;
        DriverVersion = driverVersion;
    }

    public RemoteWebDriver Driver { get; }
    public string BrowserVersion { get; }
    public string DriverVersion { get; }
    public LicenseRuntimeMetadata? LicenseRuntime { get; internal set; }

    internal void AddCloseCallback(Func<ValueTask> callback) => _closeCallbacks.Add(callback);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { Driver.Quit(); }
        finally
        {
            RequestShutdown(_driverServiceUrl);
            StopProcess(_driverProcess);
            _launchPlan.Dispose();
            TryDelete(_driverRuntimeFile);
            TryDelete(_driverLicenseFile);
            Driver.Dispose();
            _driverProcess.Dispose();
            foreach (Func<ValueTask> callback in _closeCallbacks)
            {
                try { callback().AsTask().GetAwaiter().GetResult(); }
                catch { /* release is best effort on close; explicit service state remains authoritative */ }
            }
            GC.SuppressFinalize(this);
        }
    }

    public ValueTask DisposeAsync()
    {
        Dispose();
        return ValueTask.CompletedTask;
    }

    internal static void StopProcess(Process? process)
    {
        if (process is null) return;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(3_000);
            }
        }
        catch (InvalidOperationException) { }
    }

    internal static void RequestShutdown(Uri serviceUrl)
    {
        try
        {
            using HttpClient client = new() { Timeout = TimeSpan.FromSeconds(1) };
            client.GetAsync(new Uri(serviceUrl, "shutdown")).GetAwaiter().GetResult().Dispose();
        }
        catch { /* WebDriver shutdown is best effort; StopProcess remains the fallback */ }
    }

    internal static void TryDelete(string? path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try { File.Delete(path); }
        catch (FileNotFoundException) { }
    }
}
