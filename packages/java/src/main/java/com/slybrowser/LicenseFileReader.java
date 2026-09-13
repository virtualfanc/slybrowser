package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

final class LicenseFileReader {
  private static final Set<String> TOP_LEVEL_FIELDS = Set.of(
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
      "signature");
  private static final Set<String> SECRET_FIELDS = Set.of(
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
      "scope");

  private LicenseFileReader() {}

  static LicenseAuthorization read(JsonNode root, LicenseFileReadOptions options) {
    LicenseFileReadOptions readOptions = options == null ? new LicenseFileReadOptions() : options;
    if (root == null || !root.isObject() ||
        !ReleaseManifestVerifier.fieldSet(root).equals(TOP_LEVEL_FIELDS) ||
        integer(root, "schemaVersion") != 2 ||
        !"slybrowser-license".equals(text(root, "type")) ||
        !"slybrowser-license-file".equals(text(root, "audience")) ||
        !"stable".equals(text(root, "channel"))) {
      throw fail("authorization_invalid", "License file fields are invalid");
    }
    String serviceUrl = normalizeServiceUrl(text(root, "serviceUrl"), readOptions.allowInsecureLocalhost);
    if (!readOptions.trustedServiceUrls.stream()
        .map((url) -> normalizeServiceUrl(url, readOptions.allowInsecureLocalhost))
        .anyMatch(serviceUrl::equals)) {
      throw fail("license_file_untrusted_origin", "License file service URL is not trusted", 403);
    }
    ObjectNode document = root.deepCopy();
    document.put("serviceUrl", serviceUrl);
    String licenseId = text(document, "licenseId");
    if (!licenseId.matches("[0-9a-f-]{36}")) {
      throw fail("authorization_invalid", "License file identity fields are invalid");
    }
    Instant issuedAt = timestamp(text(document, "issuedAt"));
    Instant expiresAt = timestamp(text(document, "expiresAt"));
    if (!expiresAt.isAfter(issuedAt)) {
      throw fail("authorization_invalid", "License file identity fields are invalid");
    }
    if (!expiresAt.isAfter(Instant.now())) {
      throw fail("license_file_expired", "License file has expired", 401);
    }
    JsonNode encryption = object(document.get("encryption"));
    JsonNode kdf = object(encryption.get("kdf"));
    JsonNode signature = object(document.get("signature"));
    String kdfName = text(kdf, "name");
    String kdfPurpose = text(kdf, "purpose");
    String expectedScope =
        ("sly-test-scrypt-v1".equals(kdfName) && "test-private-preview".equals(kdfPurpose)) ||
        ("sly-portable-scrypt-v1".equals(kdfName) && "portable-passphrase".equals(kdfPurpose))
            ? kdfPurpose
            : null;
    if (!"AES-256-GCM".equals(text(encryption, "algorithm")) ||
        !"slybrowser-license-v2-public-header".equals(text(encryption, "aad")) ||
        expectedScope == null ||
        integer(kdf, "cost") != 16_384 ||
        integer(kdf, "blockSize") != 8 ||
        integer(kdf, "parallelization") != 1 ||
        integer(kdf, "keyLength") != 32 ||
        !"Ed25519".equals(text(signature, "algorithm"))) {
      throw fail("authorization_invalid", "License file algorithms are invalid");
    }
    String keyId = text(signature, "keyId");
    byte[] publicKey = readOptions.licenseFileTrustedKeys.get(keyId);
    if (publicKey == null) {
      throw fail("license_file_key_unknown", "License file signing key is not trusted", 403);
    }
    if (publicKey.length != 32) {
      throw fail("license_file_key_invalid", "License file signing key is invalid", 403);
    }
    byte[] signedBody = CanonicalJson.serialize(signedBody(document));
    byte[] signatureBytes = decode(text(signature, "signature"), 64);
    Ed25519Signer verifier = new Ed25519Signer();
    verifier.init(false, new Ed25519PublicKeyParameters(publicKey, 0));
    verifier.update(signedBody, 0, signedBody.length);
    if (!verifier.verifySignature(signatureBytes)) {
      throw fail("license_file_signature_invalid", "License file signature is invalid", 401);
    }
    if (readOptions.licenseFilePassphrase == null || readOptions.licenseFilePassphrase.length() < 12) {
      throw fail("license_file_locked", "License file passphrase is missing or too short", 401);
    }
    JsonNode payload = decrypt(document, readOptions.licenseFilePassphrase);
    String licenseKey = text(payload, "licenseKey");
    if (!ReleaseManifestVerifier.fieldSet(payload).equals(SECRET_FIELDS)) {
      throw fail("license_file_payload_invalid", "License file payload contains unsupported claims");
    }
    if (integer(payload, "schemaVersion") != 2 ||
        !"slybrowser-license-secret".equals(text(payload, "type")) ||
        !text(document, "audience").equals(text(payload, "audience")) ||
        !licenseId.equals(text(payload, "licenseId")) ||
        !text(document, "fileId").equals(text(payload, "fileId")) ||
        !serviceUrl.equals(normalizeServiceUrl(text(payload, "serviceUrl"), readOptions.allowInsecureLocalhost)) ||
        !"stable".equals(text(payload, "channel")) ||
        integer(payload, "secretVersion") != 1 ||
        !text(document, "expiresAt").equals(text(payload, "expiresAt")) ||
        !expectedScope.equals(text(payload, "scope")) ||
        !licenseKey.matches("^sly_live_[0-9a-f-]{36}\\.[A-Za-z0-9_-]{40,}$") ||
        !licenseKey.startsWith("sly_live_" + licenseId + ".")) {
      throw fail("license_file_payload_invalid", "License file payload does not match its public header");
    }
    return new LicenseAuthorization(serviceUrl, licenseKey, "stable");
  }

  private static JsonNode decrypt(ObjectNode document, String passphrase) {
    JsonNode encryption = object(document.get("encryption"));
    JsonNode kdf = object(encryption.get("kdf"));
    try {
      byte[] salt = decode(text(kdf, "salt"), 16);
      byte[] nonce = decode(text(encryption, "nonce"), 12);
      byte[] tag = decode(text(document, "tag"), 16);
      byte[] ciphertext = decode(text(document, "ciphertext"), 64 * 1024);
      if (salt.length != 16 || nonce.length != 12 || tag.length != 16) {
        throw new IllegalArgumentException("invalid encryption parameter length");
      }
      byte[] key = SCrypt.generate(passphrase.getBytes(StandardCharsets.UTF_8), salt, 16_384, 8, 1, 32);
      byte[] encrypted = new byte[ciphertext.length + tag.length];
      System.arraycopy(ciphertext, 0, encrypted, 0, ciphertext.length);
      System.arraycopy(tag, 0, encrypted, ciphertext.length, tag.length);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
      cipher.updateAAD(CanonicalJson.serialize(publicHeader(document)));
      return CanonicalJson.MAPPER.readTree(cipher.doFinal(encrypted));
    } catch (GeneralSecurityException | java.io.IOException | IllegalArgumentException error) {
      throw fail("license_file_locked", "License file cannot be decrypted", 401);
    }
  }

  private static ObjectNode publicHeader(JsonNode document) {
    ObjectNode result = CanonicalJson.MAPPER.createObjectNode();
    result.set("schemaVersion", document.get("schemaVersion"));
    result.set("type", document.get("type"));
    result.set("audience", document.get("audience"));
    result.set("serviceUrl", document.get("serviceUrl"));
    result.set("licenseId", document.get("licenseId"));
    result.set("channel", document.get("channel"));
    result.set("issuedAt", document.get("issuedAt"));
    result.set("expiresAt", document.get("expiresAt"));
    result.set("fileId", document.get("fileId"));
    result.set("encryption", document.get("encryption"));
    return result;
  }

  private static ObjectNode signedBody(JsonNode document) {
    ObjectNode result = publicHeader(document);
    result.set("ciphertext", document.get("ciphertext"));
    result.set("tag", document.get("tag"));
    return result;
  }

  private static String normalizeServiceUrl(String value, boolean allowInsecureLocalhost) {
    URI uri = URI.create(value);
    boolean local = Set.of("127.0.0.1", "localhost", "::1").contains(uri.getHost());
    if (!"https".equals(uri.getScheme()) && !(allowInsecureLocalhost && local && "http".equals(uri.getScheme()))) {
      throw fail("authorization_invalid", "Authorization service URL must use HTTPS");
    }
    if (uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getHost() == null) {
      throw fail("authorization_invalid", "Authorization service URL is invalid");
    }
    return value.replaceAll("/+$", "");
  }

  private static Instant timestamp(String value) {
    try {
      return Instant.parse(value);
    } catch (DateTimeParseException error) {
      throw fail("authorization_invalid", "License file timestamp is invalid", 0, error);
    }
  }

  private static JsonNode object(JsonNode value) {
    if (value == null || !value.isObject()) throw fail("authorization_invalid", "License file fields are invalid");
    return value;
  }

  private static String text(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || !value.isTextual() || value.asText().isEmpty() || value.asText().length() > 2048) {
      throw fail("authorization_invalid", "License file " + name + " is invalid");
    }
    return value.asText();
  }

  private static long integer(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || !value.canConvertToLong()) {
      throw fail("authorization_invalid", "License file " + name + " is invalid");
    }
    return value.asLong();
  }

  private static byte[] decode(String value, int maxBytes) {
    try {
      return CanonicalJson.decodeBase64Url(value, maxBytes);
    } catch (IllegalArgumentException error) {
      throw fail("authorization_invalid", "License file encoding is invalid", 0, error);
    }
  }

  private static LicenseServiceException fail(String code, String message) {
    return new LicenseServiceException(message, code, 0);
  }

  private static LicenseServiceException fail(String code, String message, int status) {
    return new LicenseServiceException(message, code, status);
  }

  private static LicenseServiceException fail(String code, String message, int status, Throwable cause) {
    return new LicenseServiceException(message, code, status, cause);
  }
}
