using System.Diagnostics;
using System.Text;

namespace SlyBrowser;

internal static class SecureHandoffFiles
{
    internal static void RestrictWindowsAcl(string path)
    {
        if (!OperatingSystem.IsWindows()) return;
        string identity = Run("whoami").Trim();
        if (string.IsNullOrWhiteSpace(identity))
            throw new ConfigurationException("Unable to determine current Windows identity", "handoff_acl_failed");
        Run("icacls", path, "/inheritance:r", "/grant:r", $"{identity}:(F)");
    }

    private static string Run(string fileName, params string[] arguments)
    {
        ProcessStartInfo start = new()
        {
            FileName = fileName,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        using Process process = Process.Start(start)
            ?? throw new ConfigurationException("Unable to start handoff ACL helper", "handoff_acl_failed");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new ConfigurationException(
                $"Handoff ACL helper failed: {(string.IsNullOrWhiteSpace(stderr) ? stdout : stderr).Trim()}",
                "handoff_acl_failed");
        return stdout;
    }
}
