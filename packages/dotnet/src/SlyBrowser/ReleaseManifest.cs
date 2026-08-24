using System.Security.Cryptography;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace SlyBrowser;

public sealed record ReleaseArtifact(
    string Platform,
    string Arch,
    string Url,
    string Sha256,
    long Size,
    string ArchiveFormat,
    string BrowserExecutable,
    string DriverExecutable,
    string BrowserSha256,
    string DriverSha256,
    IReadOnlyList<ReleasePrivateModule> PrivateModules,
    IReadOnlyList<ReleaseResourceFile> Resources,
    ReleaseCodeSignature? CodeSignature);

public sealed record ReleasePrivateModule(
    string Path,
    string Sha256,
    long Size,
    string Abi);

public sealed record ReleaseResourceFile(
    string Path,
    string Sha256,
    long Size);

public sealed record ReleaseCodeSignature(
    string Scheme,
    string Subject,
    string CertificateSha256,
    bool TimestampRequired);

public sealed record ReleaseManifest(
    string BrowserVersion,
    string SdkCompatibility,
    string Status,
    IReadOnlyList<ReleaseArtifact> Artifacts,
    string SigningKeyId)
{
    public ReleaseArtifact Select(string platform, string arch)
    {
        ReleaseArtifact[] matches = Artifacts
            .Where(item => item.Platform == platform && item.Arch == arch)
            .ToArray();
        if (matches.Length != 1)
        {
            string available = string.Join(", ", Artifacts.Select(item => $"{item.Platform}/{item.Arch}").Order());
            throw new ManifestException(
                $"No signed artifact supports {platform}/{arch}; available targets: {available}",
                "artifact_not_found");
        }
        return matches[0];
    }
}

public static class ReleaseManifestVerifier
{
    private static readonly HashSet<string> Platforms = new(StringComparer.Ordinal) { "windows", "linux", "macos" };
    private static readonly HashSet<string> Architectures = new(StringComparer.Ordinal) { "x64", "arm64" };
    private static readonly HashSet<string> CodeSignatureSchemes = new(StringComparer.Ordinal)
    {
        "authenticode",
        "apple-developer-id",
        "x509-code-signing",
    };
    private static readonly HashSet<string> EvidenceTypes = new(StringComparer.Ordinal)
    {
        "application/vnd.cyclonedx+json",
        "application/vnd.in-toto+json",
        "application/vnd.slybrowser.chromium-patch-inventory+json",
    };

    public static ReleaseManifest Verify(JsonElement document, IReadOnlyDictionary<string, byte[]> trustedKeys)
    {
        if (document.ValueKind != JsonValueKind.Object)
            throw new ManifestException("Manifest must be an object", "manifest_invalid");
        if (!document.TryGetProperty("signature", out JsonElement signature) || signature.ValueKind != JsonValueKind.Object)
            throw new ManifestException("Manifest signature block is invalid", "manifest_invalid_signature");
        if (!PropertySet(signature).SetEquals(["algorithm", "keyId", "value"]))
            throw new ManifestException("Manifest signature block is invalid", "manifest_invalid_signature");
        if (RequiredString(signature, "algorithm", "manifest_invalid_signature") != "ed25519")
            throw new ManifestException("Manifest signature algorithm is unsupported", "manifest_algorithm_unsupported");
        string keyId = RequiredString(signature, "keyId", "manifest_key_unknown");
        if (!trustedKeys.TryGetValue(keyId, out byte[]? publicKey) || publicKey.Length != 32)
            throw new ManifestException("Manifest signing key is unknown", "manifest_key_unknown");
        byte[] signatureBytes;
        try { signatureBytes = CanonicalJson.DecodeBase64Url(RequiredString(signature, "value", "manifest_invalid_signature"), 64); }
        catch (FormatException exception)
        {
            throw new ManifestException("Manifest signature encoding is invalid", "manifest_invalid_signature", exception);
        }
        if (signatureBytes.Length != 64)
            throw new ManifestException("Manifest signature length is invalid", "manifest_invalid_signature");

        using JsonDocument unsigned = JsonDocument.Parse(RemoveSignature(document));
        byte[] payload = CanonicalJson.Serialize(unsigned.RootElement);
        Ed25519Signer signer = new();
        signer.Init(false, new Ed25519PublicKeyParameters(publicKey, 0));
        signer.BlockUpdate(payload, 0, payload.Length);
        if (!signer.VerifySignature(signatureBytes))
            throw new ManifestException("Manifest signature is invalid", "manifest_invalid_signature");

        if (RequiredInteger(document, "schemaVersion", "manifest_schema_unsupported") != 1)
            throw new ManifestException("Manifest schema is unsupported", "manifest_schema_unsupported");
        string browserVersion = RequiredString(document, "browserVersion", "manifest_invalid");
        string sdkCompatibility = RequiredString(document, "sdkCompatibility", "manifest_invalid");
        string status = RequiredString(document, "status", "manifest_invalid");
        if (status is not "available" and not "revoked")
            throw new ManifestException("Manifest release status is invalid", "manifest_invalid");
        if (!document.TryGetProperty("artifacts", out JsonElement artifactsElement) ||
            artifactsElement.ValueKind != JsonValueKind.Array ||
            artifactsElement.GetArrayLength() == 0)
            throw new ManifestException("Manifest artifacts are invalid", "manifest_invalid");
        List<ReleaseArtifact> artifacts = [];
        foreach (JsonElement artifact in artifactsElement.EnumerateArray()) artifacts.Add(ParseArtifact(artifact));
        if (artifacts.Select(item => $"{item.Platform}/{item.Arch}").Distinct(StringComparer.Ordinal).Count() != artifacts.Count)
            throw new ManifestException("Manifest has duplicate platform artifacts", "manifest_duplicate_artifact");
        if (document.TryGetProperty("evidence", out JsonElement _)) ParseEvidence(document);
        return new ReleaseManifest(browserVersion, sdkCompatibility, status, artifacts, keyId);
    }

    public static bool IsSdkCompatible(string range, string version)
    {
        _ = VersionParts(version);
        string[] tokens = range.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (tokens.Length == 0) throw new ManifestException("Manifest SDK compatibility is invalid", "manifest_invalid");
        foreach (string token in tokens)
        {
            if (token.StartsWith('^'))
            {
                if (!IsCaretCompatible(token[1..], version)) return false;
                continue;
            }
            System.Text.RegularExpressions.Match match =
                System.Text.RegularExpressions.Regex.Match(token, @"^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,7})$");
            if (!match.Success) throw new ManifestException("Manifest SDK compatibility is invalid", "manifest_invalid");
            int comparison = CompareVersion(version, match.Groups[2].Value);
            string op = match.Groups[1].Success ? match.Groups[1].Value : "=";
            if (op == ">=" && comparison < 0) return false;
            if (op == "<=" && comparison > 0) return false;
            if (op == ">" && comparison <= 0) return false;
            if (op == "<" && comparison >= 0) return false;
            if (op == "=" && comparison != 0) return false;
        }
        return true;
    }

    private static bool IsCaretCompatible(string rangeBase, string version)
    {
        int[] parts = VersionParts(rangeBase);
        int major = parts.Length > 0 ? parts[0] : 0;
        int minor = parts.Length > 1 ? parts[1] : 0;
        int patch = parts.Length > 2 ? parts[2] : 0;
        string upper = major > 0
            ? $"{major + 1}.0.0"
            : minor > 0
                ? $"0.{minor + 1}.0"
                : $"0.0.{patch + 1}";
        return CompareVersion(version, rangeBase) >= 0 && CompareVersion(version, upper) < 0;
    }

    public static int CompareVersion(string left, string right)
    {
        int[] a = VersionParts(left);
        int[] b = VersionParts(right);
        int length = Math.Max(a.Length, b.Length);
        for (int index = 0; index < length; index++)
        {
            int difference = (index < a.Length ? a[index] : 0) - (index < b.Length ? b[index] : 0);
            if (difference != 0) return Math.Sign(difference);
        }
        return 0;
    }

    public static async Task VerifyArtifactAsync(string path, ReleaseArtifact artifact, CancellationToken cancellationToken = default)
    {
        FileInfo info = new(path);
        if (!info.Exists) throw new ArtifactException("Browser artifact is missing", "artifact_missing");
        if (info.Length != artifact.Size) throw new ArtifactException("Browser artifact size does not match", "artifact_size_mismatch");
        await using FileStream stream = File.OpenRead(path);
        byte[] digest = await SHA256.HashDataAsync(stream, cancellationToken);
        if (!Convert.ToHexString(digest).ToLowerInvariant().Equals(artifact.Sha256, StringComparison.Ordinal))
            throw new ArtifactException("Browser artifact checksum does not match", "artifact_hash_mismatch");
    }

    private static ReleaseArtifact ParseArtifact(JsonElement value)
    {
        HashSet<string> requiredFields = new(StringComparer.Ordinal)
        {
            "arch", "archiveFormat", "browserExecutable", "browserSha256", "driverExecutable",
            "driverSha256", "platform", "privateModules", "resources", "sha256", "size", "url",
        };
        HashSet<string> allowedFields = new(requiredFields, StringComparer.Ordinal) { "codeSignature" };
        HashSet<string> actualFields = PropertySet(value);
        if (value.ValueKind != JsonValueKind.Object ||
            !requiredFields.IsSubsetOf(actualFields) ||
            !actualFields.IsSubsetOf(allowedFields))
            throw new ManifestException("Artifact fields are invalid", "manifest_invalid");
        string platform = RequiredString(value, "platform", "manifest_invalid");
        string arch = RequiredString(value, "arch", "manifest_invalid");
        string url = RequiredString(value, "url", "manifest_invalid");
        string archiveFormat = RequiredString(value, "archiveFormat", "manifest_invalid");
        string browserExecutable = RequiredString(value, "browserExecutable", "manifest_invalid");
        string driverExecutable = RequiredString(value, "driverExecutable", "manifest_invalid");
        string sha256 = RequiredString(value, "sha256", "manifest_invalid");
        string browserSha256 = RequiredString(value, "browserSha256", "manifest_invalid");
        string driverSha256 = RequiredString(value, "driverSha256", "manifest_invalid");
        long size = RequiredInteger(value, "size", "manifest_invalid");
        if (!Platforms.Contains(platform))
            throw new ManifestException("Artifact platform is invalid", "manifest_invalid");
        if (!Architectures.Contains(arch))
            throw new ManifestException("Artifact architecture is invalid", "manifest_invalid");
        if (!url.StartsWith("https://", StringComparison.Ordinal))
            throw new ManifestException("Artifact URL must use HTTPS", "manifest_invalid");
        if (archiveFormat != "zip" || !SafeRelativePath(browserExecutable) || !SafeRelativePath(driverExecutable) ||
            !Hex64(sha256) || !Hex64(browserSha256) || !Hex64(driverSha256) || size <= 0)
            throw new ManifestException("Artifact runtime metadata is invalid", "manifest_invalid");
        IReadOnlyList<ReleasePrivateModule> privateModules = ParsePrivateModules(value.GetProperty("privateModules"));
        IReadOnlyList<ReleaseResourceFile> resources = ParseResources(value.GetProperty("resources"));
        ReleaseCodeSignature? codeSignature = value.TryGetProperty("codeSignature", out JsonElement codeSignatureElement)
            ? ParseCodeSignature(codeSignatureElement)
            : null;
        return new ReleaseArtifact(
            platform, arch, url, sha256, size, archiveFormat, browserExecutable, driverExecutable,
            browserSha256, driverSha256, privateModules, resources, codeSignature);
    }

    private static IReadOnlyList<ReleasePrivateModule> ParsePrivateModules(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() == 0)
            throw new ManifestException("Artifact private module metadata is invalid", "manifest_invalid");
        List<ReleasePrivateModule> modules = [];
        foreach (JsonElement item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object ||
                !PropertySet(item).SetEquals(["abi", "path", "sha256", "size"]))
                throw new ManifestException("Artifact private module metadata is invalid", "manifest_invalid");
            string path = RequiredString(item, "path", "manifest_invalid");
            string sha256 = RequiredString(item, "sha256", "manifest_invalid");
            long size = RequiredInteger(item, "size", "manifest_invalid");
            string abi = RequiredString(item, "abi", "manifest_invalid");
            if (!SafeRelativePath(path) || !Hex64(sha256) || size <= 0 || abi.Length > 128)
                throw new ManifestException("Artifact private module metadata is invalid", "manifest_invalid");
            modules.Add(new ReleasePrivateModule(path, sha256, size, abi));
        }
        return modules;
    }

    private static IReadOnlyList<ReleaseResourceFile> ParseResources(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() == 0)
            throw new ManifestException("Artifact resource metadata is invalid", "manifest_invalid");
        List<ReleaseResourceFile> resources = [];
        foreach (JsonElement item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object ||
                !PropertySet(item).SetEquals(["path", "sha256", "size"]))
                throw new ManifestException("Artifact resource metadata is invalid", "manifest_invalid");
            string path = RequiredString(item, "path", "manifest_invalid");
            string sha256 = RequiredString(item, "sha256", "manifest_invalid");
            long size = RequiredInteger(item, "size", "manifest_invalid");
            if (!SafeRelativePath(path) || !Hex64(sha256) || size <= 0)
                throw new ManifestException("Artifact resource metadata is invalid", "manifest_invalid");
            resources.Add(new ReleaseResourceFile(path, sha256, size));
        }
        return resources;
    }

    private static ReleaseCodeSignature ParseCodeSignature(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object ||
            !PropertySet(value).SetEquals(["certificateSha256", "scheme", "subject", "timestampRequired"]))
            throw new ManifestException("Artifact code signature metadata is invalid", "manifest_invalid");
        string scheme = RequiredString(value, "scheme", "manifest_invalid");
        string subject = RequiredString(value, "subject", "manifest_invalid");
        string certificateSha256 = RequiredString(value, "certificateSha256", "manifest_invalid");
        if (!CodeSignatureSchemes.Contains(scheme) || subject.Length > 512 || !Hex64(certificateSha256) ||
            !value.TryGetProperty("timestampRequired", out JsonElement timestampRequired) ||
            timestampRequired.ValueKind is not JsonValueKind.True and not JsonValueKind.False)
            throw new ManifestException("Artifact code signature metadata is invalid", "manifest_invalid");
        return new ReleaseCodeSignature(scheme, subject, certificateSha256, timestampRequired.GetBoolean());
    }

    private static void ParseEvidence(JsonElement document)
    {
        if (!document.TryGetProperty("evidence", out JsonElement evidence) || evidence.ValueKind != JsonValueKind.Object)
            throw new ManifestException("Release evidence is missing", "manifest_evidence_missing");
        if (!PropertySet(evidence).SetEquals(["chromiumPatchInventory", "provenance", "sbom", "sourceBoundary"]))
            throw new ManifestException("Release evidence fields are invalid", "manifest_evidence_invalid");
        ParseEvidenceArtifact(evidence.GetProperty("sbom"), "application/vnd.cyclonedx+json");
        ParseEvidenceArtifact(evidence.GetProperty("provenance"), "application/vnd.in-toto+json");
        ParseEvidenceArtifact(evidence.GetProperty("chromiumPatchInventory"), "application/vnd.slybrowser.chromium-patch-inventory+json");
        JsonElement boundary = evidence.GetProperty("sourceBoundary");
        if (boundary.ValueKind != JsonValueKind.Object ||
            RequiredString(boundary, "sdk", "manifest_evidence_invalid") != "open-source" ||
            RequiredString(boundary, "chromiumPatches", "manifest_evidence_invalid") != "inventory-and-approved-patches" ||
            RequiredString(boundary, "proprietaryCore", "manifest_evidence_invalid") != "private")
            throw new ManifestException("Source boundary is invalid", "manifest_evidence_invalid");
    }

    private static void ParseEvidenceArtifact(JsonElement value, string mediaType)
    {
        if (value.ValueKind != JsonValueKind.Object || !PropertySet(value).SetEquals(["mediaType", "sha256", "size", "url"]) ||
            RequiredString(value, "mediaType", "manifest_evidence_invalid") != mediaType ||
            !RequiredString(value, "url", "manifest_evidence_invalid").StartsWith("https://", StringComparison.Ordinal) ||
            !Hex64(RequiredString(value, "sha256", "manifest_evidence_invalid")) ||
            RequiredInteger(value, "size", "manifest_evidence_invalid") <= 0 ||
            !EvidenceTypes.Contains(mediaType))
            throw new ManifestException("Release evidence is invalid", "manifest_evidence_invalid");
    }

    private static byte[] RemoveSignature(JsonElement document)
    {
        using MemoryStream stream = new();
        using (Utf8JsonWriter writer = new(stream))
        {
            writer.WriteStartObject();
            foreach (JsonProperty property in document.EnumerateObject())
            {
                if (property.Name == "signature") continue;
                property.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return stream.ToArray();
    }

    private static HashSet<string> PropertySet(JsonElement value) =>
        value.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);

    private static string RequiredString(JsonElement root, string name, string code)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || element.ValueKind != JsonValueKind.String)
            throw new ManifestException("Manifest field is invalid", code);
        string? value = element.GetString();
        if (string.IsNullOrEmpty(value) || value.Length > 512)
            throw new ManifestException("Manifest field is invalid", code);
        return value;
    }

    private static long RequiredInteger(JsonElement root, string name, string code)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || !element.TryGetInt64(out long value))
            throw new ManifestException("Manifest field is invalid", code);
        return value;
    }

    private static bool SafeRelativePath(string value)
    {
        string normalized = value.Replace('\\', '/');
        return value.Length is > 0 and <= 512 &&
               !normalized.StartsWith("/", StringComparison.Ordinal) &&
               !(normalized.Length >= 2 && normalized[1] == ':') &&
               !normalized.Split('/').Contains("..", StringComparer.Ordinal);
    }

    private static bool Hex64(string value) =>
        value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static int[] VersionParts(string value)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d+(?:\.\d+){0,7}$"))
            throw new ManifestException("SDK version is invalid", "sdk_version_invalid");
        return value.Split('.').Select(int.Parse).ToArray();
    }
}
