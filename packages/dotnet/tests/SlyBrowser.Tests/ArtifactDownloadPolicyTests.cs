using System.Net;
using System.Reflection;
using System.Text;

namespace SlyBrowser.Tests;

public sealed class ArtifactDownloadPolicyTests
{
    [Fact]
    public async Task RetriesTransientResponseAndKeepsOnlyFinalBytes()
    {
        using SequenceHandler handler = new(HttpStatusCode.ServiceUnavailable, HttpStatusCode.OK);
        using HttpClient http = new(handler);
        using LicenseServiceClient client = CreateClient(http);
        string destination = Path.Combine(Path.GetTempPath(), $"sly-dotnet-retry-{Guid.NewGuid():N}.part");
        try
        {
            await Download(client, destination);
            Assert.Equal("verified", await File.ReadAllTextAsync(destination, TestContext.Current.CancellationToken));
            Assert.Equal(2, handler.Attempts);
            Assert.Equal(Timeout.InfiniteTimeSpan, http.Timeout);
        }
        finally { if (File.Exists(destination)) File.Delete(destination); }
    }

    [Fact]
    public async Task DoesNotRetryAuthorizationDenial()
    {
        using SequenceHandler handler = new(HttpStatusCode.Forbidden);
        using HttpClient http = new(handler);
        using LicenseServiceClient client = CreateClient(http);
        string destination = Path.Combine(Path.GetTempPath(), $"sly-dotnet-denied-{Guid.NewGuid():N}.part");
        LicenseServiceException error = await Assert.ThrowsAsync<LicenseServiceException>(() => Download(client, destination));
        Assert.Equal(403, error.Status);
        Assert.Equal(1, handler.Attempts);
        Assert.False(File.Exists(destination));
    }

    private static LicenseServiceClient CreateClient(HttpClient http) => new(
        new LicenseAuthorization("https://api.slybrowser.test", "sly_live_00000000-0000-4000-8000-000000000002." + new string('x', 43)),
        new LicenseServiceClientOptions
        {
            LicenseTrustedKeys = new Dictionary<string, byte[]>(),
            ReleaseTrustedKeys = new Dictionary<string, byte[]>(),
            HttpClient = http,
        });

    private static async Task Download(LicenseServiceClient client, string destination)
    {
        MethodInfo method = typeof(LicenseServiceClient).GetMethod("DownloadWithRetryAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Task task = (Task)method.Invoke(client, [new Uri("https://api.slybrowser.test/archive"), "Session test", destination, CancellationToken.None])!;
        await task;
    }

    private sealed class SequenceHandler(params HttpStatusCode[] statuses) : HttpMessageHandler
    {
        public int Attempts { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            HttpStatusCode status = statuses[Math.Min(Attempts, statuses.Length - 1)];
            Attempts++;
            string body = status == HttpStatusCode.OK ? "verified" : "{}";
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            });
        }
    }
}
