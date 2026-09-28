package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;

public final class ReleaseManifestVerifier {
  private static final Set<String> PLATFORMS = Set.of("windows", "linux", "macos");
  private static final Set<String> ARCHES = Set.of("x64", "arm64");
  private static final Set<String> STATUSES = Set.of("available", "revoked");
  private static final Set<String> CODE_SIGNATURE_SCHEMES = Set.of("authenticode", "apple-developer-id", "x509-code-signing");

  private ReleaseManifestVerifier() {}

  public static ReleaseManifest verify(JsonNode document, Map<String, byte[]> trustedKeys) {
    if (document == null || !document.isObject()) {
      throw new ManifestException("Manifest must be an object", "manifest_invalid");
    }
    JsonNode signature = document.get("signature");
    if (signature == null || !signature.isObject() ||
        !fieldSet(signature).equals(Set.of("algorithm", "keyId", "value"))) {
      throw new ManifestException("Manifest signature block is invalid", "manifest_invalid_signature");
    }
    if (!"ed25519".equals(text(signature, "algorithm", "manifest_invalid_signature"))) {
      throw new ManifestException("Manifest signature algorithm is unsupported", "manifest_algorithm_unsupported");
    }
    String keyId = text(signature, "keyId", "manifest_key_unknown");
    byte[] publicKey = trustedKeys.get(keyId);
    if (publicKey == null || publicKey.length != 32) {
      throw new ManifestException("Manifest signing key is unknown", "manifest_key_unknown");
    }
    byte[] signatureBytes;
    try {
      signatureBytes = CanonicalJson.decodeBase64Url(text(signature, "value", "manifest_invalid_signature"), 64);
    } catch (RuntimeException error) {
      throw new ManifestException("Manifest signature encoding is invalid", "manifest_invalid_signature", error);
    }
    ObjectNode unsigned = document.deepCopy();
    unsigned.remove("signature");
    byte[] payload = CanonicalJson.serialize(unsigned);
    Ed25519Signer signer = new Ed25519Signer();
    signer.init(false, new Ed25519PublicKeyParameters(publicKey, 0));
    signer.update(payload, 0, payload.length);
    if (!signer.verifySignature(signatureBytes)) {
      throw new ManifestException("Manifest signature is invalid", "manifest_invalid_signature");
    }
    if (integer(document, "schemaVersion", "manifest_schema_unsupported") != 1) {
      throw new ManifestException("Manifest schema is unsupported", "manifest_schema_unsupported");
    }
    String browserVersion = text(document, "browserVersion", "manifest_invalid");
    String sdkCompatibility = text(document, "sdkCompatibility", "manifest_invalid");
    String status = text(document, "status", "manifest_invalid");
    if (!STATUSES.contains(status)) {
      throw new ManifestException("Manifest release status is invalid", "manifest_invalid");
    }
    JsonNode artifactsNode = document.get("artifacts");
    if (artifactsNode == null || !artifactsNode.isArray() || artifactsNode.size() == 0) {
      throw new ManifestException("Manifest artifacts are invalid", "manifest_invalid");
    }
    List<ReleaseArtifact> artifacts = new ArrayList<>();
    for (JsonNode artifact : artifactsNode) artifacts.add(parseArtifact(artifact));
    Set<String> identities = new HashSet<>();
    for (ReleaseArtifact artifact : artifacts) {
      if (!identities.add(artifact.platform + "/" + artifact.arch)) {
        throw new ManifestException("Manifest has duplicate platform artifacts", "manifest_duplicate_artifact");
      }
    }
    if (document.has("evidence")) parseEvidence(document.get("evidence"));
    return new ReleaseManifest(browserVersion, sdkCompatibility, status, artifacts, keyId);
  }

  public static boolean isSdkCompatible(String range, String version) {
    versionParts(version);
    String[] tokens = range == null ? new String[0] : range.trim().split("\\s+");
    if (tokens.length == 0 || tokens[0].isEmpty()) {
      throw new ManifestException("Manifest SDK compatibility is invalid", "manifest_invalid");
    }
    for (String token : tokens) {
      if (token.startsWith("^")) {
        if (!isCaretCompatible(token.substring(1), version)) return false;
        continue;
      }
      java.util.regex.Matcher match = java.util.regex.Pattern
          .compile("^(>=|<=|>|<|=)?(\\d+(?:\\.\\d+){0,7})$")
          .matcher(token);
      if (!match.matches()) throw new ManifestException("Manifest SDK compatibility is invalid", "manifest_invalid");
      int comparison = compareVersion(version, match.group(2));
      String operator = match.group(1) == null ? "=" : match.group(1);
      if (operator.equals(">=") && comparison < 0) return false;
      if (operator.equals("<=") && comparison > 0) return false;
      if (operator.equals(">") && comparison <= 0) return false;
      if (operator.equals("<") && comparison >= 0) return false;
      if (operator.equals("=") && comparison != 0) return false;
    }
    return true;
  }

  private static boolean isCaretCompatible(String base, String version) {
    int[] parts = versionParts(base);
    int major = parts.length > 0 ? parts[0] : 0;
    int minor = parts.length > 1 ? parts[1] : 0;
    int patch = parts.length > 2 ? parts[2] : 0;
    String upper = major > 0
        ? (major + 1) + ".0.0"
        : minor > 0
            ? "0." + (minor + 1) + ".0"
            : "0.0." + (patch + 1);
    return compareVersion(version, base) >= 0 && compareVersion(version, upper) < 0;
  }

  public static int compareVersion(String left, String right) {
    int[] a = versionParts(left);
    int[] b = versionParts(right);
    int length = Math.max(a.length, b.length);
    for (int index = 0; index < length; index++) {
      int difference = (index < a.length ? a[index] : 0) - (index < b.length ? b[index] : 0);
      if (difference != 0) return Integer.signum(difference);
    }
    return 0;
  }

  public static void verifyArtifact(Path path, ReleaseArtifact artifact) {
    try {
      if (!Files.isRegularFile(path)) throw new ArtifactException("Browser artifact is missing", "artifact_missing");
      if (Files.size(path) != artifact.size) {
        throw new ArtifactException("Browser artifact size does not match", "artifact_size_mismatch");
      }
      if (!sha256(path).equals(artifact.sha256)) {
        throw new ArtifactException("Browser artifact checksum does not match", "artifact_hash_mismatch");
      }
    } catch (IOException error) {
      throw new ArtifactException("Unable to verify browser artifact", "artifact_read_failed", error);
    }
  }

  static String sha256(Path path) throws IOException {
    try (InputStream input = Files.newInputStream(path)) {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] buffer = new byte[1024 * 1024];
      int read;
      while ((read = input.read(buffer)) >= 0) {
        if (read > 0) digest.update(buffer, 0, read);
      }
      return hex(digest.digest());
    } catch (java.security.NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  static String hex(byte[] bytes) {
    StringBuilder builder = new StringBuilder(bytes.length * 2);
    for (byte value : bytes) builder.append(String.format("%02x", value));
    return builder.toString();
  }

  private static ReleaseArtifact parseArtifact(JsonNode value) {
    Set<String> requiredArtifactFields = Set.of(
        "platform", "arch", "url", "sha256", "size", "archiveFormat",
        "browserExecutable", "driverExecutable", "browserSha256", "driverSha256",
        "privateModules", "resources");
    Set<String> allowedArtifactFields = new HashSet<>(requiredArtifactFields);
    allowedArtifactFields.add("codeSignature");
    if (value == null || !value.isObject() ||
        !fieldSet(value).containsAll(requiredArtifactFields) ||
        !allowedArtifactFields.containsAll(fieldSet(value))) {
      throw new ManifestException("Artifact fields are invalid", "manifest_invalid");
    }
    String platform = text(value, "platform", "manifest_invalid");
    String arch = text(value, "arch", "manifest_invalid");
    String url = text(value, "url", "manifest_invalid");
    String sha256 = text(value, "sha256", "manifest_invalid");
    long size = integer(value, "size", "manifest_invalid");
    String archiveFormat = text(value, "archiveFormat", "manifest_invalid");
    String browserExecutable = text(value, "browserExecutable", "manifest_invalid");
    String driverExecutable = text(value, "driverExecutable", "manifest_invalid");
    String browserSha256 = text(value, "browserSha256", "manifest_invalid");
    String driverSha256 = text(value, "driverSha256", "manifest_invalid");
    if (!PLATFORMS.contains(platform) || !ARCHES.contains(arch) || !url.startsWith("https://") ||
        !(archiveFormat.equals("7z") || archiveFormat.equals("zip")) || !hex64(sha256) || !hex64(browserSha256) || !hex64(driverSha256) ||
        size <= 0 || !safeRelativePath(browserExecutable) || !safeRelativePath(driverExecutable)) {
      throw new ManifestException("Artifact runtime metadata is invalid", "manifest_invalid");
    }
    List<ReleasePrivateModule> privateModules = parsePrivateModules(value.get("privateModules"));
    List<ReleaseResourceFile> resources = parseResources(value.get("resources"));
    ReleaseCodeSignature codeSignature = value.has("codeSignature") ? parseCodeSignature(value.get("codeSignature")) : null;
    return new ReleaseArtifact(
        platform, arch, url, sha256, size, archiveFormat, browserExecutable, driverExecutable,
        browserSha256, driverSha256, privateModules, resources, codeSignature);
  }

  private static List<ReleasePrivateModule> parsePrivateModules(JsonNode value) {
    if (value == null || !value.isArray() || value.size() == 0) {
      throw new ManifestException("Artifact private module metadata is invalid", "manifest_invalid");
    }
    List<ReleasePrivateModule> modules = new ArrayList<>();
    for (JsonNode item : value) {
      if (item == null || !item.isObject() || !fieldSet(item).equals(Set.of("path", "sha256", "size", "abi"))) {
        throw new ManifestException("Artifact private module metadata is invalid", "manifest_invalid");
      }
      String path = text(item, "path", "manifest_invalid");
      String sha256 = text(item, "sha256", "manifest_invalid");
      long size = integer(item, "size", "manifest_invalid");
      String abi = text(item, "abi", "manifest_invalid");
      if (!safeRelativePath(path) || !hex64(sha256) || size <= 0 || abi.length() > 128) {
        throw new ManifestException("Artifact private module metadata is invalid", "manifest_invalid");
      }
      modules.add(new ReleasePrivateModule(path, sha256, size, abi));
    }
    return modules;
  }

  private static List<ReleaseResourceFile> parseResources(JsonNode value) {
    if (value == null || !value.isArray() || value.size() == 0) {
      throw new ManifestException("Artifact resource metadata is invalid", "manifest_invalid");
    }
    List<ReleaseResourceFile> resources = new ArrayList<>();
    for (JsonNode item : value) {
      if (item == null || !item.isObject() || !fieldSet(item).equals(Set.of("path", "sha256", "size"))) {
        throw new ManifestException("Artifact resource metadata is invalid", "manifest_invalid");
      }
      String path = text(item, "path", "manifest_invalid");
      String sha256 = text(item, "sha256", "manifest_invalid");
      long size = integer(item, "size", "manifest_invalid");
      if (!safeRelativePath(path) || !hex64(sha256) || size <= 0) {
        throw new ManifestException("Artifact resource metadata is invalid", "manifest_invalid");
      }
      resources.add(new ReleaseResourceFile(path, sha256, size));
    }
    return resources;
  }

  private static ReleaseCodeSignature parseCodeSignature(JsonNode value) {
    if (value == null || !value.isObject() ||
        !fieldSet(value).equals(Set.of("scheme", "subject", "certificateSha256", "timestampRequired"))) {
      throw new ManifestException("Artifact code signature metadata is invalid", "manifest_invalid");
    }
    String scheme = text(value, "scheme", "manifest_invalid");
    String subject = text(value, "subject", "manifest_invalid");
    String certificateSha256 = text(value, "certificateSha256", "manifest_invalid");
    JsonNode timestamp = value.get("timestampRequired");
    if (!CODE_SIGNATURE_SCHEMES.contains(scheme) || subject.length() > 512 || !hex64(certificateSha256) ||
        timestamp == null || !timestamp.isBoolean()) {
      throw new ManifestException("Artifact code signature metadata is invalid", "manifest_invalid");
    }
    return new ReleaseCodeSignature(scheme, subject, certificateSha256, timestamp.asBoolean());
  }

  private static void parseEvidence(JsonNode evidence) {
    if (evidence == null || !evidence.isObject() ||
        !fieldSet(evidence).equals(Set.of("sbom", "provenance", "chromiumPatchInventory", "sourceBoundary"))) {
      throw new ManifestException("Release evidence fields are invalid", "manifest_evidence_invalid");
    }
    parseEvidenceArtifact(evidence.get("sbom"), "application/vnd.cyclonedx+json");
    parseEvidenceArtifact(evidence.get("provenance"), "application/vnd.in-toto+json");
    parseEvidenceArtifact(evidence.get("chromiumPatchInventory"), "application/vnd.slybrowser.chromium-patch-inventory+json");
    JsonNode boundary = evidence.get("sourceBoundary");
    if (boundary == null || !boundary.isObject() ||
        !"open-source".equals(text(boundary, "sdk", "manifest_evidence_invalid")) ||
        !"inventory-and-approved-patches".equals(text(boundary, "chromiumPatches", "manifest_evidence_invalid")) ||
        !"private".equals(text(boundary, "proprietaryCore", "manifest_evidence_invalid"))) {
      throw new ManifestException("Source boundary is invalid", "manifest_evidence_invalid");
    }
  }

  private static void parseEvidenceArtifact(JsonNode value, String mediaType) {
    if (value == null || !value.isObject() || !fieldSet(value).equals(Set.of("url", "sha256", "size", "mediaType")) ||
        !mediaType.equals(text(value, "mediaType", "manifest_evidence_invalid")) ||
        !text(value, "url", "manifest_evidence_invalid").startsWith("https://") ||
        !hex64(text(value, "sha256", "manifest_evidence_invalid")) ||
        integer(value, "size", "manifest_evidence_invalid") <= 0) {
      throw new ManifestException("Release evidence is invalid", "manifest_evidence_invalid");
    }
  }

  static Set<String> fieldSet(JsonNode value) {
    Set<String> result = new HashSet<>();
    value.fieldNames().forEachRemaining(result::add);
    return result;
  }

  private static String text(JsonNode root, String name, String code) {
    JsonNode value = root.get(name);
    if (value == null || !value.isTextual() || value.asText().isEmpty() || value.asText().length() > 512) {
      throw new ManifestException("Manifest field is invalid", code);
    }
    return value.asText();
  }

  private static long integer(JsonNode root, String name, String code) {
    JsonNode value = root.get(name);
    if (value == null || !value.canConvertToLong()) {
      throw new ManifestException("Manifest field is invalid", code);
    }
    return value.asLong();
  }

  private static int[] versionParts(String value) {
    if (value == null || !value.matches("^\\d+(?:\\.\\d+){0,7}$")) {
      throw new ManifestException("SDK version is invalid", "sdk_version_invalid");
    }
    String[] text = value.split("\\.");
    int[] parts = new int[text.length];
    for (int index = 0; index < text.length; index++) parts[index] = Integer.parseInt(text[index]);
    return parts;
  }

  private static boolean safeRelativePath(String value) {
    String normalized = value.replace('\\', '/');
    return !normalized.isEmpty() && normalized.length() <= 512 &&
        !normalized.startsWith("/") &&
        !(normalized.length() >= 2 && normalized.charAt(1) == ':') &&
        !List.of(normalized.split("/")).contains("..");
  }

  private static boolean hex64(String value) {
    return value != null && value.matches("^[a-f0-9]{64}$");
  }
}
