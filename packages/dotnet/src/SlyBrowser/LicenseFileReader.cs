using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Generators;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace SlyBrowser;

internal static class LicenseFileReader
{
    private static readonly HashSet<string> TopLevelFields = new(StringComparer.Ordinal)
    {
        "schemaVersion",
        "type",
        "audience",
        "serviceUrl",
        "licenseId",
        "channel",
        "issuedAt",
        "expiresAt",
        "fileId",
        "encryption",
        "ciphertext",
        "tag",
        "signature",
    };
    private static readonly HashSet<string> SecretFields = new(StringComparer.Ordinal)
    {
        "schemaVersion",
        "type",
        "audience",
        "licenseId",
        "fileId",
        "serviceUrl",
        "channel",
        "licenseKey",
        "secretVersion",
        "createdAt",
        "expiresAt",
        "nonce",
        "scope",
    };

    public static LicenseAuthorization Read(JsonElement root, LicenseFileReadOptions? options)
    {
        options ??= new LicenseFileReadOptions();
        if (root.ValueKind != JsonValueKind.Object ||
            !PropertySet(root).SetEquals(TopLevelFields) ||
            RequiredInteger(root, "schemaVersion") != 2 ||
            RequiredString(root, "type") != "slybrowser-license" ||
            RequiredString(root, "audience") != "slybrowser-license-file" ||
            RequiredString(root, "channel") != "stable")
            throw Fail("authorization_invalid", "License file fields are invalid");
        string serviceUrl = NormalizeServiceUrl(RequiredString(root, "serviceUrl"), options.AllowInsecureLocalhost);
        if (!options.TrustedServiceUrls
                .Select(url => NormalizeServiceUrl(url, options.AllowInsecureLocalhost))
                .Contains(serviceUrl, StringComparer.Ordinal))
            throw Fail("license_file_untrusted_origin", "License file service URL is not trusted", 403);

        Dictionary<string, object?> document = ToDictionary(root);
        document["serviceUrl"] = serviceUrl;
        JsonElement normalizedRoot = JsonSerializer.SerializeToElement(document);
        string licenseId = RequiredString(normalizedRoot, "licenseId");
        if (!System.Text.RegularExpressions.Regex.IsMatch(licenseId, @"^[0-9a-f-]{36}$"))
            throw Fail("authorization_invalid", "License file identity fields are invalid");
        DateTimeOffset issuedAt = Timestamp(RequiredString(normalizedRoot, "issuedAt"));
        DateTimeOffset expiresAt = Timestamp(RequiredString(normalizedRoot, "expiresAt"));
        if (expiresAt <= issuedAt)
            throw Fail("authorization_invalid", "License file identity fields are invalid");
        if (expiresAt <= DateTimeOffset.UtcNow)
            throw Fail("license_file_expired", "License file has expired", 401);
        JsonElement encryption = RequiredObject(normalizedRoot, "encryption");
        JsonElement kdf = RequiredObject(encryption, "kdf");
        JsonElement signature = RequiredObject(normalizedRoot, "signature");
        string kdfName = RequiredString(kdf, "name");
        string kdfPurpose = RequiredString(kdf, "purpose");
        string? expectedScope =
            kdfName == "sly-test-scrypt-v1" && kdfPurpose == "test-private-preview" ? kdfPurpose :
            kdfName == "sly-portable-scrypt-v1" && kdfPurpose == "portable-passphrase" ? kdfPurpose :
            null;
        if (RequiredString(encryption, "algorithm") != "AES-256-GCM" ||
            RequiredString(encryption, "aad") != "slybrowser-license-v2-public-header" ||
            expectedScope is null ||
            RequiredInteger(kdf, "cost") != 16_384 ||
            RequiredInteger(kdf, "blockSize") != 8 ||
            RequiredInteger(kdf, "parallelization") != 1 ||
            RequiredInteger(kdf, "keyLength") != 32 ||
            RequiredString(signature, "algorithm") != "Ed25519")
            throw Fail("authorization_invalid", "License file algorithms are invalid");
        string keyId = RequiredString(signature, "keyId");
        if (!options.LicenseFileTrustedKeys.TryGetValue(keyId, out byte[]? publicKey))
            throw Fail("license_file_key_unknown", "License file signing key is not trusted", 403);
        if (publicKey.Length != 32)
            throw Fail("license_file_key_invalid", "License file signing key is invalid", 403);
        byte[] signedBody = CanonicalJson.Serialize(JsonSerializer.SerializeToElement(SignedBody(normalizedRoot)));
        byte[] signatureBytes = Decode(RequiredString(signature, "signature"), 64);
        Ed25519Signer verifier = new();
        verifier.Init(false, new Ed25519PublicKeyParameters(publicKey, 0));
        verifier.BlockUpdate(signedBody, 0, signedBody.Length);
        if (!verifier.VerifySignature(signatureBytes))
            throw Fail("license_file_signature_invalid", "License file signature is invalid", 401);
        if (options.LicenseFilePassphrase is not { Length: >= 12 })
            throw Fail("license_file_locked", "License file passphrase is missing or too short", 401);
        JsonElement payload = Decrypt(normalizedRoot, options.LicenseFilePassphrase);
        string licenseKey = RequiredString(payload, "licenseKey");
        if (!PropertySet(payload).SetEquals(SecretFields))
            throw Fail("license_file_payload_invalid", "License file payload contains unsupported claims");
        if (RequiredInteger(payload, "schemaVersion") != 2 ||
            RequiredString(payload, "type") != "slybrowser-license-secret" ||
            RequiredString(payload, "audience") != RequiredString(normalizedRoot, "audience") ||
            RequiredString(payload, "licenseId") != licenseId ||
            RequiredString(payload, "fileId") != RequiredString(normalizedRoot, "fileId") ||
            NormalizeServiceUrl(RequiredString(payload, "serviceUrl"), options.AllowInsecureLocalhost) != serviceUrl ||
            RequiredString(payload, "channel") != "stable" ||
            RequiredInteger(payload, "secretVersion") != 1 ||
            RequiredString(payload, "expiresAt") != RequiredString(normalizedRoot, "expiresAt") ||
            RequiredString(payload, "scope") != expectedScope ||
            !System.Text.RegularExpressions.Regex.IsMatch(licenseKey, @"^sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$") ||
            !licenseKey.StartsWith($"sly_live_{licenseId}.", StringComparison.Ordinal))
            throw Fail("license_file_payload_invalid", "License file payload does not match its public header");
        return new LicenseAuthorization(serviceUrl, licenseKey);
    }

    private static JsonElement Decrypt(JsonElement document, string passphrase)
    {
        JsonElement encryption = RequiredObject(document, "encryption");
        JsonElement kdf = RequiredObject(encryption, "kdf");
        try
        {
            byte[] salt = Decode(RequiredString(kdf, "salt"), 16);
            byte[] nonce = Decode(RequiredString(encryption, "nonce"), 12);
            byte[] tag = Decode(RequiredString(document, "tag"), 16);
            byte[] ciphertext = Decode(RequiredString(document, "ciphertext"), 64 * 1024);
            if (salt.Length != 16 || nonce.Length != 12 || tag.Length != 16)
                throw new FormatException("invalid encryption parameter length");
            byte[] key = SCrypt.Generate(Encoding.UTF8.GetBytes(passphrase), salt, 16_384, 8, 1, 32);
            byte[] plaintext = new byte[ciphertext.Length];
            using AesGcm aes = new(key, 16);
            aes.Decrypt(nonce, ciphertext, tag, plaintext, CanonicalJson.Serialize(JsonSerializer.SerializeToElement(PublicHeader(document))));
            return JsonDocument.Parse(plaintext).RootElement.Clone();
        }
        catch (Exception exception) when (exception is CryptographicException or JsonException or FormatException or ArgumentException)
        {
            throw Fail("license_file_locked", "License file cannot be decrypted", 401, exception);
        }
    }

    private static Dictionary<string, object?> PublicHeader(JsonElement document) => new(StringComparer.Ordinal)
    {
        ["schemaVersion"] = document.GetProperty("schemaVersion").GetInt32(),
        ["type"] = document.GetProperty("type").GetString(),
        ["audience"] = document.GetProperty("audience").GetString(),
        ["serviceUrl"] = document.GetProperty("serviceUrl").GetString(),
        ["licenseId"] = document.GetProperty("licenseId").GetString(),
        ["channel"] = document.GetProperty("channel").GetString(),
        ["issuedAt"] = document.GetProperty("issuedAt").GetString(),
        ["expiresAt"] = document.GetProperty("expiresAt").GetString(),
        ["fileId"] = document.GetProperty("fileId").GetString(),
        ["encryption"] = JsonSerializer.Deserialize<object?>(document.GetProperty("encryption").GetRawText()),
    };

    private static Dictionary<string, object?> SignedBody(JsonElement document)
    {
        Dictionary<string, object?> result = PublicHeader(document);
        result["ciphertext"] = document.GetProperty("ciphertext").GetString();
        result["tag"] = document.GetProperty("tag").GetString();
        return result;
    }

    private static Dictionary<string, object?> ToDictionary(JsonElement document) =>
        JsonSerializer.Deserialize<Dictionary<string, object?>>(document.GetRawText()) ??
        throw Fail("authorization_invalid", "License file fields are invalid");

    private static string NormalizeServiceUrl(string value, bool allowInsecureLocalhost)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? url))
            throw Fail("authorization_invalid", "Authorization service URL is invalid");
        bool local = url.Host is "127.0.0.1" or "localhost" or "::1";
        if (url.Scheme != Uri.UriSchemeHttps && !(allowInsecureLocalhost && local && url.Scheme == Uri.UriSchemeHttp))
            throw Fail("authorization_invalid", "Authorization service URL must use HTTPS");
        if (!string.IsNullOrEmpty(url.Query) || !string.IsNullOrEmpty(url.Fragment))
            throw Fail("authorization_invalid", "Authorization service URL is invalid");
        return url.ToString().TrimEnd('/');
    }

    private static JsonElement RequiredObject(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.Object)
            throw Fail("authorization_invalid", "License file fields are invalid");
        return value;
    }

    private static DateTimeOffset Timestamp(string value)
    {
        if (!DateTimeOffset.TryParse(value, out DateTimeOffset timestamp))
            throw Fail("authorization_invalid", "License file timestamp is invalid");
        return timestamp.ToUniversalTime();
    }

    private static string RequiredString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String)
            throw Fail("authorization_invalid", $"License file {name} is invalid");
        string? text = value.GetString();
        if (string.IsNullOrEmpty(text) || text.Length > 2048)
            throw Fail("authorization_invalid", $"License file {name} is invalid");
        return text;
    }

    private static long RequiredInteger(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value) || !value.TryGetInt64(out long integer))
            throw Fail("authorization_invalid", $"License file {name} is invalid");
        return integer;
    }

    private static HashSet<string> PropertySet(JsonElement value) =>
        value.EnumerateObject().Select(property => property.Name).ToHashSet(StringComparer.Ordinal);

    private static byte[] Decode(string value, int maxBytes)
    {
        try { return CanonicalJson.DecodeBase64Url(value, maxBytes); }
        catch (FormatException exception) { throw Fail("authorization_invalid", "License file encoding is invalid", 0, exception); }
    }

    private static LicenseServiceException Fail(string code, string message, int status = 0, Exception? exception = null) =>
        new(message, code, status, exception);
}
