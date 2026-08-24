package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

public final class LicenseVerifier {
  private static final int MAX_ENVELOPE_BYTES = 64 * 1024;
  private static final int MAX_PAYLOAD_BYTES = 32 * 1024;
  private final Map<String, byte[]> trustedKeys;
  private final Clock clock;
  private final long clockSkewSeconds;
  private final long maxLifetimeSeconds;

  public LicenseVerifier(Map<String, byte[]> trustedKeys) {
    this(trustedKeys, Clock.systemUTC(), 30, 24 * 60 * 60);
  }

  public LicenseVerifier(
      Map<String, byte[]> trustedKeys,
      Clock clock,
      long clockSkewSeconds,
      long maxLifetimeSeconds) {
    for (byte[] key : trustedKeys.values()) {
      if (key.length != 32) throw new IllegalArgumentException("Ed25519 public keys must contain exactly 32 bytes");
    }
    this.trustedKeys = Map.copyOf(trustedKeys);
    this.clock = clock;
    this.clockSkewSeconds = clockSkewSeconds;
    this.maxLifetimeSeconds = maxLifetimeSeconds;
  }

  public LicenseClaims verify(
      String envelopeJson,
      String browserVersion,
      List<String> requiredFeatures,
      String deviceHash) {
    if (envelopeJson == null || envelopeJson.getBytes(StandardCharsets.UTF_8).length > MAX_ENVELOPE_BYTES) {
      throw fail("license_invalid_envelope", "License envelope exceeds its size limit");
    }
    JsonNode envelope;
    try {
      envelope = CanonicalJson.MAPPER.readTree(envelopeJson);
    } catch (Exception error) {
      throw fail("license_invalid_envelope", "License envelope is not valid JSON", error);
    }
    if (!envelope.isObject() || !ReleaseManifestVerifier.fieldSet(envelope)
        .equals(Set.of("algorithm", "keyId", "payload", "signature"))) {
      throw fail("license_invalid_envelope", "License envelope fields are invalid");
    }
    if (!"Ed25519".equals(text(envelope, "algorithm"))) {
      throw fail("license_algorithm_unsupported", "License algorithm is not allowed");
    }
    String keyId = text(envelope, "keyId");
    byte[] publicKey = trustedKeys.get(keyId);
    if (publicKey == null) throw fail("license_key_unknown", "License signing key is not trusted");
    byte[] payload;
    byte[] signature;
    try {
      payload = CanonicalJson.decodeBase64Url(
          text(envelope, "payload", ((MAX_PAYLOAD_BYTES + 2) / 3) * 4),
          MAX_PAYLOAD_BYTES);
      signature = CanonicalJson.decodeBase64Url(text(envelope, "signature", 128), 64);
    } catch (RuntimeException error) {
      throw fail("license_invalid_envelope", "License encoding is invalid", error);
    }
    if (signature.length != 64) throw fail("license_invalid_signature", "License signature length is invalid");
    Ed25519Signer signer = new Ed25519Signer();
    signer.init(false, new Ed25519PublicKeyParameters(publicKey, 0));
    signer.update(payload, 0, payload.length);
    if (!signer.verifySignature(signature)) {
      throw fail("license_invalid_signature", "License signature is invalid");
    }
    try {
      return validateClaims(
          CanonicalJson.MAPPER.readTree(payload),
          browserVersion,
          requiredFeatures == null ? List.of() : requiredFeatures,
          deviceHash);
    } catch (LicenseException error) {
      throw error;
    } catch (Exception error) {
      throw fail("license_invalid_claims", "License payload is not valid JSON", error);
    }
  }

  private LicenseClaims validateClaims(
      JsonNode root,
      String browserVersion,
      List<String> requiredFeatures,
      String deviceHash) {
    if (!root.isObject()) throw fail("license_invalid_claims", "License payload must be an object");
    int schemaVersion = (int) integer(root, "schemaVersion");
    if (schemaVersion != 1 && schemaVersion != 2) throw fail("license_schema_unsupported", "License schema is not supported");
    String audience = text(root, "audience");
    if (!"slybrowser".equals(audience)) throw fail("license_wrong_audience", "License audience does not match");
    long issuedAt = integer(root, "issuedAt");
    long notBefore = integer(root, "notBefore");
    long expiresAt = integer(root, "expiresAt");
    if (notBefore < issuedAt || expiresAt <= notBefore) {
      throw fail("license_invalid_time", "License time range is invalid");
    }
    if (expiresAt - issuedAt > maxLifetimeSeconds) {
      throw fail("license_lifetime_exceeded", "License lifetime exceeds policy");
    }
    long now = clock.instant().getEpochSecond();
    if (issuedAt > now + clockSkewSeconds || notBefore > now + clockSkewSeconds) {
      throw fail("license_not_yet_valid", "License is not yet valid");
    }
    if (expiresAt <= now - clockSkewSeconds) {
      throw fail("license_expired", "License has expired");
    }
    String browserMin = text(root, "browserMin");
    String browserMax = text(root, "browserMax");
    String claimBrowserVersion = root.has("browserVersion") && !root.get("browserVersion").isNull()
        ? text(root, "browserVersion")
        : null;
    if (schemaVersion == 2 && !browserVersion.equals(claimBrowserVersion)) {
      throw fail("license_browser_unsupported", "Browser version is outside the license range");
    }
    if (ReleaseManifestVerifier.compareVersion(browserVersion, browserMin) < 0 ||
        ReleaseManifestVerifier.compareVersion(browserVersion, browserMax) > 0) {
      throw fail("license_browser_unsupported", "Browser version is outside the license range");
    }
    String planId = root.has("planId") && !root.get("planId").isNull() ? text(root, "planId") : null;
    Integer concurrencyLimit = null;
    if (root.has("concurrencyLimit") && !root.get("concurrencyLimit").isNull()) {
      long claimConcurrency = integer(root, "concurrencyLimit");
      if (claimConcurrency < 1 || claimConcurrency > 100000) {
        throw fail("license_invalid_claims", "Claim concurrencyLimit is invalid");
      }
      concurrencyLimit = (int) claimConcurrency;
    }
    Long paidThrough = null;
    if (root.has("paidThrough") && !root.get("paidThrough").isNull()) {
      paidThrough = integer(root, "paidThrough");
      if (paidThrough < 0) throw fail("license_invalid_claims", "Claim paidThrough is invalid");
    }
    String licenseStatus = root.has("licenseStatus") && !root.get("licenseStatus").isNull()
        ? text(root, "licenseStatus")
        : null;
    if (licenseStatus != null && !List.of("active", "hold", "revoked").contains(licenseStatus)) {
      throw fail("license_invalid_claims", "Claim licenseStatus is invalid");
    }
    String artifactSha256 = root.has("artifactSha256") && !root.get("artifactSha256").isNull()
        ? text(root, "artifactSha256")
        : null;
    if (artifactSha256 != null && !artifactSha256.matches("^[a-f0-9]{64}$")) {
      throw fail("license_invalid_claims", "Claim artifactSha256 is invalid");
    }
    String browserSha256 = root.has("browserSha256") && !root.get("browserSha256").isNull()
        ? text(root, "browserSha256")
        : null;
    if (browserSha256 != null && !browserSha256.matches("^[a-f0-9]{64}$")) {
      throw fail("license_invalid_claims", "Claim browserSha256 is invalid");
    }
    String driverSha256 = root.has("driverSha256") && !root.get("driverSha256").isNull()
        ? text(root, "driverSha256")
        : null;
    if (driverSha256 != null && !driverSha256.matches("^[a-f0-9]{64}$")) {
      throw fail("license_invalid_claims", "Claim driverSha256 is invalid");
    }
    Long leaseGeneration = null;
    if (root.has("leaseGeneration") && !root.get("leaseGeneration").isNull()) {
      leaseGeneration = integer(root, "leaseGeneration");
      if (leaseGeneration < 1) throw fail("license_invalid_claims", "Claim leaseGeneration is invalid");
    }
    validateArtifact(root, schemaVersion, artifactSha256, browserSha256, driverSha256);
    JsonNode featuresNode = root.get("features");
    if (featuresNode == null || !featuresNode.isArray()) {
      throw fail("license_invalid_claims", "License features are invalid");
    }
    List<String> features = new ArrayList<>();
    for (JsonNode feature : featuresNode) {
      if (!feature.isTextual() || feature.asText().isEmpty()) {
        throw fail("license_invalid_claims", "License features are invalid");
      }
      features.add(feature.asText());
    }
    if (features.size() != new HashSet<>(features).size()) {
      throw fail("license_invalid_claims", "License features are invalid");
    }
    for (String required : requiredFeatures) {
      if (!features.contains(required)) {
        throw fail("license_feature_denied", "License does not grant: " + required);
      }
    }
    String claimDeviceHash = root.has("deviceHash") && !root.get("deviceHash").isNull()
        ? root.get("deviceHash").asText()
        : null;
    if (deviceHash != null && !deviceHash.equals(claimDeviceHash)) {
      throw fail("license_device_mismatch", "License device binding does not match");
    }
    return new LicenseClaims(
        schemaVersion,
        text(root, "licenseId"),
        audience,
        issuedAt,
        notBefore,
        expiresAt,
        claimBrowserVersion,
        browserMin,
        browserMax,
        planId,
        concurrencyLimit,
        paidThrough,
        licenseStatus,
        artifactSha256,
        browserSha256,
        driverSha256,
        leaseGeneration,
        features,
        text(root, "sessionId"),
        text(root, "nonce"),
        claimDeviceHash);
  }

  private static void validateArtifact(
      JsonNode root,
      int schemaVersion,
      String artifactSha256,
      String browserSha256,
      String driverSha256) {
    JsonNode artifact = root.get("artifact");
    if (artifact == null || artifact.isNull()) {
      if (schemaVersion == 2) throw fail("license_invalid_claims", "Claim artifact is invalid");
      return;
    }
    if (!artifact.isObject()) throw fail("license_invalid_claims", "Claim artifact is invalid");
    String platform = text(artifact, "platform");
    String arch = text(artifact, "arch");
    String archiveFormat = text(artifact, "archiveFormat");
    if (!List.of("windows", "linux", "macos").contains(platform) ||
        !List.of("x64", "arm64").contains(arch) ||
        !"zip".equals(archiveFormat)) {
      throw fail("license_invalid_claims", "Claim artifact is invalid");
    }
    String artifactHash = text(artifact, "sha256");
    String browserHash = text(artifact, "browserSha256");
    String driverHash = text(artifact, "driverSha256");
    if (!artifactHash.matches("^[a-f0-9]{64}$") || !browserHash.matches("^[a-f0-9]{64}$") ||
        !driverHash.matches("^[a-f0-9]{64}$") || !artifactHash.equals(artifactSha256) ||
        !browserHash.equals(browserSha256) || !driverHash.equals(driverSha256)) {
      throw fail("license_invalid_claims", "Claim artifact does not match flat hashes");
    }
    text(artifact, "browserExecutable");
    text(artifact, "driverExecutable");
    validateHashArray(artifact.get("privateModules"), true);
    validateHashArray(artifact.get("resources"), false);
    if (artifact.has("codeSignature")) {
      JsonNode signature = artifact.get("codeSignature");
      if (signature == null || !signature.isObject()) throw fail("license_invalid_claims", "Claim artifact is invalid");
      String scheme = text(signature, "scheme");
      String certificateSha256 = text(signature, "certificateSha256");
      JsonNode timestampRequired = signature.get("timestampRequired");
      if (!List.of("authenticode", "apple-developer-id", "x509-code-signing").contains(scheme) ||
          !certificateSha256.matches("^[a-f0-9]{64}$") ||
          timestampRequired == null || !timestampRequired.isBoolean()) {
        throw fail("license_invalid_claims", "Claim artifact is invalid");
      }
      text(signature, "subject");
    }
  }

  private static void validateHashArray(JsonNode values, boolean requireAbi) {
    if (values == null || !values.isArray()) throw fail("license_invalid_claims", "Claim artifact is invalid");
    for (JsonNode value : values) {
      if (!value.isObject()) throw fail("license_invalid_claims", "Claim artifact is invalid");
      String sha256 = text(value, "sha256");
      long size = integer(value, "size");
      if (!sha256.matches("^[a-f0-9]{64}$") || size < 0) throw fail("license_invalid_claims", "Claim artifact is invalid");
      text(value, "path");
      if (requireAbi) text(value, "abi");
    }
  }

  private static String text(JsonNode root, String name) {
    return text(root, name, 512);
  }

  private static String text(JsonNode root, String name, int maximum) {
    JsonNode value = root.get(name);
    if (value == null || !value.isTextual() || value.asText().isEmpty() || value.asText().length() > maximum) {
      throw fail("license_invalid_claims", "Claim " + name + " is invalid");
    }
    return value.asText();
  }

  private static long integer(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || !value.canConvertToLong()) {
      throw fail("license_invalid_claims", "Claim " + name + " is invalid");
    }
    return value.asLong();
  }

  private static LicenseException fail(String code, String message) {
    return new LicenseException(message, code);
  }

  private static LicenseException fail(String code, String message, Throwable cause) {
    return new LicenseException(message, code, cause);
  }
}
