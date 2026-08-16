using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace SlyBrowser;

public sealed record LicenseClaims(
    int SchemaVersion,
    string LicenseId,
    string Audience,
    long IssuedAt,
    long NotBefore,
    long ExpiresAt,
    string BrowserMin,
    string BrowserMax,
    IReadOnlyList<string> Features,
    string SessionId,
    string Nonce,
    string? DeviceHash);

public sealed class LicenseVerifier
{
    private const int MaxEnvelopeBytes = 64 * 1024;
    private const int MaxPayloadBytes = 32 * 1024;
    private readonly IReadOnlyDictionary<string, byte[]> _trustedKeys;
    private readonly Func<DateTimeOffset> _now;
    private readonly long _clockSkewSeconds;
    private readonly long _maxLifetimeSeconds;

    public LicenseVerifier(
        IReadOnlyDictionary<string, byte[]> trustedKeys,
        Func<DateTimeOffset>? now = null,
        long clockSkewSeconds = 30,
        long maxLifetimeSeconds = 24 * 60 * 60)
    {
        if (trustedKeys.Values.Any(key => key.Length != 32))
            throw new ArgumentException("Ed25519 public keys must contain exactly 32 bytes", nameof(trustedKeys));
        if (clockSkewSeconds < 0 || maxLifetimeSeconds <= 0)
            throw new ArgumentOutOfRangeException(nameof(clockSkewSeconds));
        _trustedKeys = trustedKeys.ToDictionary(pair => pair.Key, pair => pair.Value.ToArray());
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _clockSkewSeconds = clockSkewSeconds;
        _maxLifetimeSeconds = maxLifetimeSeconds;
    }

    public LicenseClaims Verify(
        string envelopeJson,
        string browserVersion,
        string audience = "slybrowser",
        IEnumerable<string>? requiredFeatures = null,
        string? deviceHash = null)
    {
        if (Encoding.UTF8.GetByteCount(envelopeJson) > MaxEnvelopeBytes)
            throw Fail("license_invalid_envelope", "License envelope exceeds its size limit");

        JsonDocument envelope;
        try { envelope = JsonDocument.Parse(envelopeJson); }
        catch (JsonException exception)
        {
            throw Fail("license_invalid_envelope", "License envelope is not valid JSON", exception);
        }
        using (envelope)
        {
            JsonElement root = envelope.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                root.EnumerateObject().Select(property => property.Name).OrderBy(name => name).SequenceEqual(
                    new[] { "algorithm", "keyId", "payload", "signature" }) is false)
                throw Fail("license_invalid_envelope", "License envelope fields are invalid");
            if (RequiredString(root, "algorithm") != "Ed25519")
                throw Fail("license_algorithm_unsupported", "License algorithm is not allowed");
            string keyId = RequiredString(root, "keyId");
            if (!_trustedKeys.TryGetValue(keyId, out byte[]? publicKey))
                throw Fail("license_key_unknown", "License signing key is not trusted");

            byte[] payload;
            byte[] signature;
            try
            {
                payload = DecodeBase64Url(RequiredString(root, "payload"), MaxPayloadBytes);
                signature = DecodeBase64Url(RequiredString(root, "signature"), 64);
            }
            catch (FormatException exception)
            {
                throw Fail("license_invalid_envelope", "License encoding is invalid", exception);
            }
            if (signature.Length != 64)
                throw Fail("license_invalid_signature", "License signature length is invalid");

            Ed25519Signer signer = new();
            signer.Init(false, new Ed25519PublicKeyParameters(publicKey, 0));
            signer.BlockUpdate(payload, 0, payload.Length);
            if (!signer.VerifySignature(signature))
                throw Fail("license_invalid_signature", "License signature is invalid");

            JsonDocument claims;
            try { claims = JsonDocument.Parse(payload); }
            catch (JsonException exception)
            {
                throw Fail("license_invalid_claims", "License payload is not valid JSON", exception);
            }
            using (claims)
            {
                return ValidateClaims(
                    claims.RootElement,
                    browserVersion,
                    audience,
                    requiredFeatures ?? Array.Empty<string>(),
                    deviceHash);
            }
        }
    }

    private LicenseClaims ValidateClaims(
        JsonElement root,
        string browserVersion,
        string audience,
        IEnumerable<string> requiredFeatures,
        string? deviceHash)
    {
        if (root.ValueKind != JsonValueKind.Object)
            throw Fail("license_invalid_claims", "License payload must be an object");
        int schemaVersion = checked((int)RequiredInteger(root, "schemaVersion"));
        if (schemaVersion != 1)
            throw Fail("license_schema_unsupported", "License schema is not supported");
        string claimAudience = RequiredString(root, "audience");
        if (!StringComparer.Ordinal.Equals(claimAudience, audience))
            throw Fail("license_wrong_audience", "License audience does not match");

        long issuedAt = RequiredInteger(root, "issuedAt");
        long notBefore = RequiredInteger(root, "notBefore");
        long expiresAt = RequiredInteger(root, "expiresAt");
        if (notBefore < issuedAt || expiresAt <= notBefore)
            throw Fail("license_invalid_time", "License time range is invalid");
        if (expiresAt - issuedAt > _maxLifetimeSeconds)
            throw Fail("license_lifetime_exceeded", "License lifetime exceeds policy");
        long now = _now().ToUnixTimeSeconds();
        if (issuedAt > now + _clockSkewSeconds || notBefore > now + _clockSkewSeconds)
            throw Fail("license_not_yet_valid", "License is not yet valid");
        if (expiresAt <= now - _clockSkewSeconds)
            throw Fail("license_expired", "License has expired");

        string browserMin = RequiredString(root, "browserMin");
        string browserMax = RequiredString(root, "browserMax");
        if (!Version.TryParse(browserVersion, out Version? current) ||
            !Version.TryParse(browserMin, out Version? minimum) ||
            !Version.TryParse(browserMax, out Version? maximum))
            throw Fail("license_invalid_claims", "Browser version is invalid");
        if (current < minimum || current > maximum)
            throw Fail("license_browser_unsupported", "Browser version is outside the license range");

        if (!root.TryGetProperty("features", out JsonElement featuresElement) ||
            featuresElement.ValueKind != JsonValueKind.Array)
            throw Fail("license_invalid_claims", "License features are invalid");
        List<string> features = [];
        foreach (JsonElement feature in featuresElement.EnumerateArray())
        {
            if (feature.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(feature.GetString()))
                throw Fail("license_invalid_claims", "License features are invalid");
            features.Add(feature.GetString()!);
        }
        if (features.Count != features.Distinct(StringComparer.Ordinal).Count())
            throw Fail("license_invalid_claims", "License features are invalid");
        string[] missing = requiredFeatures.Except(features, StringComparer.Ordinal).Order().ToArray();
        if (missing.Length > 0)
            throw Fail("license_feature_denied", $"License does not grant: {string.Join(", ", missing)}");

        string? claimDeviceHash = root.TryGetProperty("deviceHash", out JsonElement deviceElement)
            ? deviceElement.GetString()
            : null;
        if (deviceHash is not null && !StringComparer.Ordinal.Equals(deviceHash, claimDeviceHash))
            throw Fail("license_device_mismatch", "License device binding does not match");

        return new LicenseClaims(
            schemaVersion,
            RequiredString(root, "licenseId"),
            claimAudience,
            issuedAt,
            notBefore,
            expiresAt,
            browserMin,
            browserMax,
            features,
            RequiredString(root, "sessionId"),
            RequiredString(root, "nonce"),
            claimDeviceHash);
    }

    private static string RequiredString(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || element.ValueKind != JsonValueKind.String)
            throw Fail("license_invalid_claims", $"Claim {name} is invalid");
        string? value = element.GetString();
        if (string.IsNullOrEmpty(value) || value.Length > 512)
            throw Fail("license_invalid_claims", $"Claim {name} is invalid");
        return value;
    }

    private static long RequiredInteger(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement element) || !element.TryGetInt64(out long value))
            throw Fail("license_invalid_claims", $"Claim {name} is invalid");
        return value;
    }

    private static byte[] DecodeBase64Url(string value, int maxBytes)
    {
        if (string.IsNullOrEmpty(value) || value.Any(character =>
                !(char.IsAsciiLetterOrDigit(character) || character is '-' or '_')))
            throw new FormatException("Invalid base64url");
        string padded = value.Replace('-', '+').Replace('_', '/');
        padded += new string('=', (4 - padded.Length % 4) % 4);
        byte[] decoded = Convert.FromBase64String(padded);
        if (decoded.Length > maxBytes) throw new FormatException("Base64url value is too large");
        return decoded;
    }

    private static LicenseException Fail(string code, string message, Exception? exception = null) =>
        new(message, code, exception);
}
