package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.crypto.generators.SCrypt;
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator;
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.bouncycastle.crypto.KeyGenerationParameters;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class LicensedReleaseTest {
  @TempDir Path temp;

  @Test
  void exposesStableAuthorizedAliases() throws Exception {
    assertEquals(
        SlyBrowser.class.getMethod("launchLatest", Path.class, LicensedLaunchSettings.class).getReturnType(),
        SlyBrowser.class.getMethod("launchAuthorized", Path.class, LicensedLaunchSettings.class).getReturnType());
    assertEquals(
        SlyBrowser.class.getMethod("installLatest", Path.class, LicensedLaunchSettings.class).getReturnType(),
        SlyBrowser.class.getMethod("installAuthorized", Path.class, LicensedLaunchSettings.class).getReturnType());
    assertEquals(
        SlyBrowser.class.getMethod("prepareLatestAuthorizedBrowser", Path.class, LicensedLaunchSettings.class).getReturnType(),
        SlyBrowser.class.getMethod("prepareAuthorizedBrowser", Path.class, LicensedLaunchSettings.class).getReturnType());
  }

  @Test
  void readsV2LicenseFileAndFailsClosedOnTampering() throws Exception {
    Ed25519PrivateKeyParameters signingKey = newPrivateKey();
    Path licenseFile = temp.resolve("account.slybrowser-license.json");
    Map<String, Object> document = licenseDocument(signingKey);
    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(document));
    LicenseFileReadOptions options = new LicenseFileReadOptions();
    options.licenseFilePassphrase = "test-passphrase-only";
    options.licenseFileTrustedKeys = Map.of("license-file-test-v1", signingKey.generatePublicKey().getEncoded());
    options.trustedServiceUrls = Set.of("https://api.slybrowser.test");

    LicenseAuthorization authorization = LicenseServiceClient.readAuthorization(licenseFile, options);
    assertEquals("https://api.slybrowser.test", authorization.serviceUrl);
    assertEquals("sly_live_00000000-0000-4000-8000-000000000002." + "x".repeat(43), authorization.licenseKey);
    assertTrue(!Files.readString(licenseFile).contains("sly_live_"));

    Map<String, Object> portableDocument = licenseDocument(
        signingKey,
        "slybrowser-license-file",
        "2033-05-18T03:33:20.000Z",
        "2034-05-18T03:33:20.000Z",
        "lf_portable_java_reader",
        Map.of(),
        "portable-passphrase-only",
        "sly-portable-scrypt-v1",
        "portable-passphrase",
        "portable-passphrase");
    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(portableDocument));
    LicenseFileReadOptions portableOptions = new LicenseFileReadOptions();
    portableOptions.licenseFilePassphrase = "portable-passphrase-only";
    portableOptions.licenseFileTrustedKeys = options.licenseFileTrustedKeys;
    portableOptions.trustedServiceUrls = options.trustedServiceUrls;
    LicenseAuthorization portableAuthorization = LicenseServiceClient.readAuthorization(licenseFile, portableOptions);
    assertEquals("https://api.slybrowser.test", portableAuthorization.serviceUrl);
    assertEquals("sly_live_00000000-0000-4000-8000-000000000002." + "x".repeat(43), portableAuthorization.licenseKey);

    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(new LinkedHashMap<>(document) {{
      put("serviceUrl", "https://evil.example");
    }}));
    assertEquals("license_file_untrusted_origin", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, options)).getCode());

    Map<String, Object> tamperedCiphertext = new LinkedHashMap<>(document);
    tamperedCiphertext.put("ciphertext", corruptBase64Url((String) document.get("ciphertext")));
    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(tamperedCiphertext));
    assertEquals("license_file_signature_invalid", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, options)).getCode());

    Map<String, Object> tamperedSignature = new LinkedHashMap<>(document);
    @SuppressWarnings("unchecked")
    Map<String, Object> signature = new LinkedHashMap<>((Map<String, Object>) document.get("signature"));
    signature.put("signature", corruptBase64Url((String) signature.get("signature")));
    tamperedSignature.put("signature", signature);
    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(tamperedSignature));
    assertEquals("license_file_signature_invalid", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, options)).getCode());

    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(document));
    LicenseFileReadOptions wrongPassphrase = new LicenseFileReadOptions();
    wrongPassphrase.licenseFilePassphrase = "wrong-passphrase";
    wrongPassphrase.licenseFileTrustedKeys = options.licenseFileTrustedKeys;
    wrongPassphrase.trustedServiceUrls = options.trustedServiceUrls;
    assertEquals("license_file_locked", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, wrongPassphrase)).getCode());

    LicenseFileReadOptions unknownKey = new LicenseFileReadOptions();
    unknownKey.licenseFilePassphrase = options.licenseFilePassphrase;
    unknownKey.trustedServiceUrls = options.trustedServiceUrls;
    assertEquals("license_file_key_unknown", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, unknownKey)).getCode());

    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(
        licenseDocument(signingKey, "other-product", "2033-05-18T03:33:20.000Z", "2034-05-18T03:33:20.000Z",
            "lf_test_java_wrong_audience", Map.of())));
    assertEquals("authorization_invalid", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, options)).getCode());

    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(
        licenseDocument(signingKey, "slybrowser-license-file", "2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z",
            "lf_test_java_expired", Map.of())));
    assertEquals("license_file_expired", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, options)).getCode());

    Files.writeString(licenseFile, CanonicalJson.MAPPER.writeValueAsString(
        licenseDocument(signingKey, "slybrowser-license-file", "2033-05-18T03:33:20.000Z", "2034-05-18T03:33:20.000Z",
            "lf_test_java_plan_claim", Map.of("plan", "grid"))));
    assertEquals("license_file_payload_invalid", assertThrows(
        LicenseServiceException.class,
        () -> LicenseServiceClient.readAuthorization(licenseFile, options)).getCode());
  }

  @Test
  void verifiesDownloadsExtractsReusesCacheAndReleases() throws Exception {
    Fixture fixture = new Fixture(false, false);
    LicensedLaunchSettings settings = fixture.settings(temp);
    Path authorization = fixture.writeAuthorization(temp);
    BrowserInstallation first = SlyBrowser.installLatest(authorization, settings);
    BrowserInstallation second = SlyBrowser.installLatest(authorization, settings);
    assertEquals(first, second);
    assertEquals("150.0.8000.1", first.version);
    assertTrue(first.browserExecutable.endsWith("SlyBrowser.exe"));
    assertTrue(first.driverExecutable.endsWith("chromedriver.exe"));
    assertEquals("browser", Files.readString(first.browserExecutable));
    assertEquals(1, fixture.downloads);
    assertEquals(2, fixture.releases);
    BrowserInstallationReference reference = BrowserInstaller.acquireBrowserInstallationReference(first);
    assertTrue(BrowserInstaller.isBrowserInstallationInUse(first));
    assertEquals(1, BrowserInstaller.activeBrowserInstallationReferences(first).size());
    reference.release();
    assertFalse(BrowserInstaller.isBrowserInstallationInUse(first));

    Files.writeString(first.driverExecutable, "tampered");
    BrowserInstallation repaired = SlyBrowser.installLatest(authorization, settings);
    assertEquals("driver", Files.readString(repaired.driverExecutable));
    assertEquals(1, fixture.downloads);
    assertEquals(3, fixture.releases);

    Files.writeString(repaired.browserExecutable, "tampered-again");
    Files.writeString(temp.resolve("downloads").resolve(fixture.artifactSha256 + ".zip"), "corrupt-archive");
    BrowserInstallation repairedAfterArchiveDamage = SlyBrowser.installLatest(authorization, settings);
    assertEquals("browser", Files.readString(repairedAfterArchiveDamage.browserExecutable));
    assertEquals(2, fixture.downloads);
    assertEquals(4, fixture.releases);
    BrowserInstallation unused = fakeInstallation("149.0.0.1", "windows-x64-aaaaaaaaaaaaaaaa", "a");
    BrowserInstallation inUse = fakeInstallation("149.0.0.2", "windows-x64-bbbbbbbbbbbbbbbb", "b");
    BrowserInstallationReference pruneReference = BrowserInstaller.acquireBrowserInstallationReference(inUse);
    BrowserPruneResult pruned = BrowserInstaller.pruneBrowserInstallations(settings.install, "windows", "x64", "latest");
    assertEquals(List.of(unused.root), pruned.removed);
    assertEquals(List.of(inUse.root), pruned.skippedInUse);
    assertTrue(pruned.kept.contains(repairedAfterArchiveDamage.root));
    assertFalse(Files.exists(unused.root));
    assertTrue(Files.exists(inUse.root));
    pruneReference.release();
    BrowserPruneResult secondPrune = BrowserInstaller.pruneBrowserInstallations(settings.install, "windows", "x64", "latest");
    assertEquals(List.of(inUse.root), secondPrune.removed);
    try (java.util.stream.Stream<Path> entries = Files.list(temp.resolve("downloads"))) {
      assertTrue(entries.anyMatch(path -> path.getFileName().toString().contains(".bad-")));
    }
    try (java.util.stream.Stream<Path> entries = Files.list(temp.resolve("stable").resolve("150.0.8000.1"))) {
      assertTrue(entries.anyMatch(path -> path.getFileName().toString().contains(".bad-")));
    }
  }

  private BrowserInstallation fakeInstallation(String version, String identity, String prefix) throws Exception {
    Path root = temp.resolve("stable").resolve(version).resolve(identity);
    Files.createDirectories(root);
    Path browser = root.resolve("SlyBrowser.exe");
    Path driver = root.resolve("chromedriver.exe");
    Files.writeString(browser, "old-browser");
    Files.writeString(driver, "old-driver");
    BrowserInstallation installation = new BrowserInstallation(
        version,
        "windows",
        "x64",
        root,
        browser.toAbsolutePath().normalize(),
        driver.toAbsolutePath().normalize(),
        prefix.repeat(64));
    Map<String, Object> marker = new LinkedHashMap<>();
    marker.put("version", installation.version);
    marker.put("platform", installation.platform);
    marker.put("arch", installation.arch);
    marker.put("root", installation.root.toString());
    marker.put("browserExecutable", installation.browserExecutable.toString());
    marker.put("driverExecutable", installation.driverExecutable.toString());
    marker.put("artifactSha256", installation.artifactSha256);
    Files.writeString(root.resolve(".sly-install.json"), CanonicalJson.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(marker) + "\n");
    return installation;
  }

  @Test
  void authorizedDefaultsKeepUpdatesClosedWhileLatestUpdates() throws Exception {
    Fixture authorizedFixture = new Fixture(false, false);
    LicensedLaunchSettings authorizedSettings = authorizedFixture.settings(temp.resolve("authorized-cache"));
    authorizedSettings.kernelMajor = "150";
    BrowserInstallation authorized = SlyBrowser.installAuthorized(
        authorizedFixture.writeAuthorization(temp),
        authorizedSettings);
    assertEquals("150.0.8000.1", authorized.version);
    assertEquals(0, authorizedFixture.sessionRequests.size());
    assertEquals("project-webdriver", authorizedFixture.runtimeSessionRequests.get(0).get("automationBackend").asText());
    assertEquals(150, authorizedFixture.runtimeSessionRequests.get(0).get("kernelMajor").asInt());
    assertEquals(false, authorizedFixture.runtimeSessionRequests.get(0).get("updateKernel").asBoolean());
    BrowserInstallation cached = SlyBrowser.installAuthorized(
        authorizedFixture.writeAuthorization(temp),
        authorizedSettings);
    assertEquals("150.0.8000.1", cached.version);
    assertEquals("project-webdriver", authorizedFixture.runtimeSessionRequests.get(1).get("automationBackend").asText());
    assertEquals(150, authorizedFixture.runtimeSessionRequests.get(1).get("kernelMajor").asInt());
    assertEquals(false, authorizedFixture.runtimeSessionRequests.get(1).get("updateKernel").asBoolean());
    assertEquals("150.0.8000.1", authorizedFixture.runtimeSessionRequests.get(1).get("browserVersion").asText());
    assertEquals("exact", authorizedFixture.runtimeSessionRequests.get(1).get("versionPolicy").asText());
    Fixture withdrawnFixture = new Fixture(false, true, "release_version_unavailable", 404);
    LicensedLaunchSettings withdrawnSettings = withdrawnFixture.settings(temp.resolve("authorized-cache"));
    withdrawnSettings.kernelMajor = "150";
    LicenseServiceException withdrawn = assertThrows(
        LicenseServiceException.class,
        () -> SlyBrowser.installAuthorized(authorizedFixture.writeAuthorization(temp), withdrawnSettings));
    assertEquals("kernel_update_required", withdrawn.getCode());
    assertEquals(409, withdrawn.getStatus());

    Fixture latestFixture = new Fixture(false, false);
    LicensedLaunchSettings latestSettings = latestFixture.settings(temp.resolve("latest-cache"));
    latestSettings.kernelMajor = "150";
    BrowserInstallation latest = SlyBrowser.installLatest(
        latestFixture.writeAuthorization(temp),
        latestSettings);
    assertEquals("150.0.8000.1", latest.version);
    assertEquals(0, latestFixture.sessionRequests.size());
    assertEquals("project-webdriver", latestFixture.runtimeSessionRequests.get(0).get("automationBackend").asText());
    assertEquals(150, latestFixture.runtimeSessionRequests.get(0).get("kernelMajor").asInt());
    assertEquals(true, latestFixture.runtimeSessionRequests.get(0).get("updateKernel").asBoolean());
  }

  @Test
  void usesV2RuntimeCredentialsForActivationDownloadAndRelease() throws Exception {
    Fixture fixture = new Fixture(false, false);
    LicenseServiceClient client = new LicenseServiceClient(
        new LicenseAuthorization(
            "https://api.slybrowser.test",
            "sly_live_00000000-0000-4000-8000-000000000002." + "x".repeat(43),
            "stable"),
        fixture.settings(temp).trust);
    CreateRuntimeSessionOptions options = new CreateRuntimeSessionOptions();
    options.platform = "windows";
    options.arch = "x64";
    options.automationBackend = AutomationBackend.PLAYWRIGHT;
    options.startupId = "st_javav2runtime0001";
    RuntimeSessionGrant grant = client.createRuntimeSession(options);
    assertEquals(2, grant.schemaVersion);
    assertEquals("reserved", grant.state);
    assertEquals("bootstrap-token", grant.bootstrapToken);
    assertEquals("activation-ticket", grant.activationTicket);
    assertNull(grant.driverActivationTicket);
    assertEquals("download-token", grant.downloadTicket.token);
    assertEquals("150.0.8000.1", grant.browserVersion);

    assertEquals("reserved", client.bootstrapHeartbeat(grant).state);
    InstallOptions installOptions = new InstallOptions();
    installOptions.cacheRoot = temp.resolve("runtime-cache");
    BrowserInstallation installation = BrowserInstaller.installGrantedBrowser(client, grant, installOptions);
    assertEquals("150.0.8000.1", installation.version);
    assertEquals("browser", Files.readString(installation.browserExecutable));
    assertEquals("driver", Files.readString(installation.driverExecutable));
    RuntimeActivationGrant active = client.activateRuntimeSession(grant);
    assertEquals("active", active.state);
    assertEquals("runtime-token", active.runtimeToken);
    assertEquals("active", client.runtimeHeartbeat(active).state);
    assertEquals("closing", client.closeRuntimeSession(active).state);
    client.releaseRuntimeSession(active);
    assertEquals(1, fixture.releases);
    assertEquals(1, fixture.downloads);

    Fixture reservedFixture = new Fixture(false, false);
    LicenseServiceClient reservedClient = new LicenseServiceClient(
        new LicenseAuthorization(
            "https://api.slybrowser.test",
            "sly_live_00000000-0000-4000-8000-000000000002." + "x".repeat(43),
            "stable"),
        reservedFixture.settings(temp).trust);
    CreateRuntimeSessionOptions reservedOptions = new CreateRuntimeSessionOptions();
    reservedOptions.platform = "windows";
    reservedOptions.arch = "x64";
    reservedOptions.startupId = "st_javav2runtime0001";
    RuntimeSessionGrant reserved = reservedClient.createRuntimeSession(reservedOptions);
    reservedClient.releaseRuntimeSession(reserved);
    assertEquals(1, reservedFixture.releases);
  }

  @Test
  void readsRedactedOnlineLicenseInfoWithoutCreatingSession() {
    Fixture fixture = new Fixture(false, false);
    LicenseServiceClient client = new LicenseServiceClient(
        new LicenseAuthorization(
            "https://api.slybrowser.test",
            "sly_live_00000000-0000-4000-8000-000000000002." + "x".repeat(43),
            "stable"),
        fixture.settings(temp).trust);
    CreateSessionOptions options = new CreateSessionOptions();
    options.platform = "windows";
    options.arch = "x64";
    options.kernelMajor = "150";
    options.updateKernel = false;
    LicenseInfo info = client.licenseInfo(options);
    assertEquals(1, info.schemaVersion);
    assertEquals("stable", info.channel);
    assertEquals("active", info.licenseStatus);
    assertEquals("launch", info.plan);
    assertEquals("launch", info.effectivePlan);
    assertEquals(5, info.concurrencyLimit);
    assertEquals(0, info.activeSessions);
    assertEquals(5, info.availableSessions);
    assertEquals(150, info.requestedKernelMajor);
    assertEquals("latest-in-major", info.selectionMode);
    assertEquals(null, info.stableErrorCode);
    assertTrue(info.features.contains("playwright"));
    assertEquals(0, fixture.sessionRequests.size());
    assertEquals(0, fixture.runtimeSessionRequests.size());
    String serialized = info.plan + info.features + info.sessionState + info.updateRights;
    assertFalse(serialized.contains("sly_live_"));
    assertFalse(serialized.contains("session-token"));
    assertFalse(serialized.contains("download-token"));
    assertFalse(serialized.contains("bootstrap-token"));
  }

  @Test
  void javaBootstrapHeartbeatUsesNegativeJitterWindow() {
    assertEquals(285_000, LicensedBrowser.heartbeatDelayMillis(300));
    assertEquals(1_000, LicensedBrowser.heartbeatDelayMillis(5));
    assertEquals(1_000, LicensedBrowser.heartbeatDelayMillis(0));
  }

  @Test
  void rejectsManifestChangedAfterSigning() throws Exception {
    Fixture fixture = new Fixture(true, false);
    ManifestException error = assertThrows(
        ManifestException.class,
        () -> SlyBrowser.installLatest(fixture.writeAuthorization(temp), fixture.settings(temp)));
    assertEquals("manifest_invalid_signature", error.getCode());
    assertEquals(0, fixture.downloads);
    assertEquals(0, fixture.releases);
  }

  @Test
  void preservesSessionLimitErrors() throws Exception {
    Fixture fixture = new Fixture(false, true);
    LicenseServiceException error = assertThrows(
        LicenseServiceException.class,
        () -> SlyBrowser.installLatest(fixture.writeAuthorization(temp), fixture.settings(temp)));
    assertEquals("session_limit", error.getCode());
    assertEquals(409, error.getStatus());
    assertEquals(5L, error.getDetails().get("concurrencyLimit"));
    assertEquals(5L, error.getDetails().get("activeSessions"));
    assertEquals(0L, error.getDetails().get("availableSessions"));
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> actions = (List<Map<String, Object>>) error.getDetails().get("actions");
    assertEquals(Set.of("close_session", "upgrade_plan"), Set.of(
        (String) actions.get(0).get("type"),
        (String) actions.get(1).get("type")));
    assertFalse(actions.get(0).containsKey("api"));
    assertFalse(actions.get(0).containsKey("authorization"));
    String rendered = error.getMessage() + " " + error.getDetails();
    assertFalse(rendered.contains("runtime-token"));
    assertFalse(rendered.contains("download-token"));
    assertFalse(rendered.contains("buyer@example.com"));
    assertFalse(rendered.contains("paynow-secret"));
  }

  @Test
  void verifiesRequestedSelectedDownloadedLaunchedVersionAudit() {
    BrowserVersionAudit audit = LicensedBrowser.verifyBrowserVersionAudit(new BrowserVersionAudit(
        "151.0.0.0",
        "150.0.8000.1",
        "150.0.8000.1",
        "150.0.8000.1",
        "at-or-before",
        "rollback"));
    assertEquals("150.0.8000.1", audit.launched);
    ArtifactException error = assertThrows(
        ArtifactException.class,
        () -> LicensedBrowser.verifyBrowserVersionAudit(new BrowserVersionAudit(
            "150.0.8000.1",
            "150.0.8000.1",
            "150.0.8000.1",
            "151.0.0.0",
            "exact",
            "exact")));
    assertEquals("browser_version_chain_mismatch", error.getCode());
  }

  private static Map<String, Object> licenseDocument(Ed25519PrivateKeyParameters signingKey) throws Exception {
    return licenseDocument(signingKey, "slybrowser-license-file", "2033-05-18T03:33:20.000Z", "2034-05-18T03:33:20.000Z",
        "lf_test_java_reader", Map.of());
  }

  private static Map<String, Object> licenseDocument(
      Ed25519PrivateKeyParameters signingKey,
      String audience,
      String issuedAt,
      String expiresAt,
      String fileId,
      Map<String, Object> secretOverrides) throws Exception {
    return licenseDocument(
        signingKey,
        audience,
        issuedAt,
        expiresAt,
        fileId,
        secretOverrides,
        "test-passphrase-only",
        "sly-test-scrypt-v1",
        "test-private-preview",
        "test-private-preview");
  }

  private static Map<String, Object> licenseDocument(
      Ed25519PrivateKeyParameters signingKey,
      String audience,
      String issuedAt,
      String expiresAt,
      String fileId,
      Map<String, Object> secretOverrides,
      String passphrase,
      String kdfName,
      String kdfPurpose,
      String scope) throws Exception {
    byte[] salt = deterministicBytes("java-license-file-salt", 16);
    byte[] nonce = deterministicBytes("java-license-file-nonce", 12);
    Map<String, Object> kdf = new LinkedHashMap<>();
    kdf.put("name", kdfName);
    kdf.put("purpose", kdfPurpose);
    kdf.put("salt", CanonicalJson.encodeBase64Url(salt));
    kdf.put("cost", 16_384);
    kdf.put("blockSize", 8);
    kdf.put("parallelization", 1);
    kdf.put("keyLength", 32);

    Map<String, Object> encryption = new LinkedHashMap<>();
    encryption.put("algorithm", "AES-256-GCM");
    encryption.put("kdf", kdf);
    encryption.put("nonce", CanonicalJson.encodeBase64Url(nonce));
    encryption.put("aad", "slybrowser-license-v2-public-header");

    Map<String, Object> document = new LinkedHashMap<>();
    document.put("schemaVersion", 2);
    document.put("type", "slybrowser-license");
    document.put("audience", audience);
    document.put("serviceUrl", "https://api.slybrowser.test");
    document.put("licenseId", "00000000-0000-4000-8000-000000000002");
    document.put("channel", "stable");
    document.put("issuedAt", issuedAt);
    document.put("expiresAt", expiresAt);
    document.put("fileId", fileId);
    document.put("encryption", encryption);
    document.put("ciphertext", "");
    document.put("tag", "");
    document.put("signature", new LinkedHashMap<>(Map.of(
        "algorithm", "Ed25519",
        "keyId", "license-file-test-v1",
        "signature", "")));

    Map<String, Object> secret = new LinkedHashMap<>();
    secret.put("schemaVersion", 2);
    secret.put("type", "slybrowser-license-secret");
    secret.put("audience", document.get("audience"));
    secret.put("licenseId", document.get("licenseId"));
    secret.put("fileId", document.get("fileId"));
    secret.put("serviceUrl", document.get("serviceUrl"));
    secret.put("channel", "stable");
    secret.put("licenseKey", "sly_live_" + document.get("licenseId") + "." + "x".repeat(43));
    secret.put("secretVersion", 1);
    secret.put("createdAt", document.get("issuedAt"));
    secret.put("expiresAt", document.get("expiresAt"));
    secret.put("nonce", "java-payload-nonce");
    secret.put("scope", scope);
    secret.putAll(secretOverrides);

    byte[] key = SCrypt.generate(passphrase.getBytes(StandardCharsets.UTF_8), salt, 16_384, 8, 1, 32);
    Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
    cipher.updateAAD(CanonicalJson.serialize(CanonicalJson.object(publicHeader(document))));
    byte[] encrypted = cipher.doFinal(CanonicalJson.serialize(CanonicalJson.object(secret)));
    document.put("ciphertext", CanonicalJson.encodeBase64Url(java.util.Arrays.copyOf(encrypted, encrypted.length - 16)));
    document.put("tag", CanonicalJson.encodeBase64Url(java.util.Arrays.copyOfRange(encrypted, encrypted.length - 16, encrypted.length)));
    @SuppressWarnings("unchecked")
    Map<String, Object> signature = (Map<String, Object>) document.get("signature");
    signature.put("signature", CanonicalJson.encodeBase64Url(sign(signingKey, CanonicalJson.serialize(CanonicalJson.object(signedBody(document))))));
    return document;
  }

  private static Map<String, Object> publicHeader(Map<String, Object> document) {
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("schemaVersion", document.get("schemaVersion"));
    result.put("type", document.get("type"));
    result.put("audience", document.get("audience"));
    result.put("serviceUrl", document.get("serviceUrl"));
    result.put("licenseId", document.get("licenseId"));
    result.put("channel", document.get("channel"));
    result.put("issuedAt", document.get("issuedAt"));
    result.put("expiresAt", document.get("expiresAt"));
    result.put("fileId", document.get("fileId"));
    result.put("encryption", document.get("encryption"));
    return result;
  }

  private static Map<String, Object> signedBody(Map<String, Object> document) {
    Map<String, Object> result = publicHeader(document);
    result.put("ciphertext", document.get("ciphertext"));
    result.put("tag", document.get("tag"));
    return result;
  }

  private static byte[] deterministicBytes(String label, int length) {
    try {
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      for (int index = 0; output.size() < length; index += 1) {
        output.write(MessageDigest.getInstance("SHA-256")
            .digest((label + ":" + index).getBytes(StandardCharsets.UTF_8)));
      }
      return java.util.Arrays.copyOf(output.toByteArray(), length);
    } catch (java.security.NoSuchAlgorithmException | IOException error) {
      throw new RuntimeException(error);
    }
  }

  private static String corruptBase64Url(String value) {
    return (value.startsWith("A") ? "B" : "A") + value.substring(1);
  }

  private static Ed25519PrivateKeyParameters newPrivateKey() {
    Ed25519KeyPairGenerator generator = new Ed25519KeyPairGenerator();
    generator.init(new KeyGenerationParameters(new SecureRandom(), 256));
    return (Ed25519PrivateKeyParameters) generator.generateKeyPair().getPrivate();
  }

  private static byte[] sign(Ed25519PrivateKeyParameters key, byte[] payload) {
    Ed25519Signer signer = new Ed25519Signer();
    signer.init(true, key);
    signer.update(payload, 0, payload.length);
    return signer.generateSignature();
  }

  private static final class Fixture {
    private final Ed25519PrivateKeyParameters leasePrivate = newPrivateKey();
    private final Ed25519PrivateKeyParameters releasePrivate = newPrivateKey();
    private final long now = Instant.now().getEpochSecond();
    private final byte[] archive = archive();
    private final String artifactSha256 = sha256(archive);
    private final String bootstrapToken = "bootstrap-token";
    private final String activationTicket = "activation-ticket";
    private final String driverActivationTicket = "driver-activation-ticket";
    private final String runtimeToken = "runtime-token";
    private final String downloadTicketToken = "download-token";
    private final boolean tamperManifest;
    private final boolean sessionError;
    private final String sessionErrorCode;
    private final int sessionErrorStatus;
    private final String sessionToken = "session-token";
    final List<JsonNode> sessionRequests = new ArrayList<>();
    final List<JsonNode> runtimeSessionRequests = new ArrayList<>();
    int downloads;
    int releases;

    Fixture(boolean tamperManifest, boolean sessionError) {
      this(tamperManifest, sessionError, "session_limit", 409);
    }

    Fixture(boolean tamperManifest, boolean sessionError, String sessionErrorCode, int sessionErrorStatus) {
      this.tamperManifest = tamperManifest;
      this.sessionError = sessionError;
      this.sessionErrorCode = sessionErrorCode;
      this.sessionErrorStatus = sessionErrorStatus;
    }

    Path writeAuthorization(Path directory) throws IOException {
      Path path = directory.resolve("account.authorization.json");
      Files.writeString(path, CanonicalJson.MAPPER.writeValueAsString(Map.of(
          "schemaVersion", 1,
          "serviceUrl", "https://api.slybrowser.test",
          "licenseKey", "sly_live_00000000-0000-4000-8000-000000000002." + "x".repeat(43),
          "channel", "stable")));
      return path;
    }

    LicensedLaunchSettings settings(Path cacheRoot) {
      LicensedLaunchSettings settings = new LicensedLaunchSettings();
      LicenseServiceClientOptions trust = new LicenseServiceClientOptions();
      trust.licenseTrustedKeys = Map.of("lease-test", leasePrivate.generatePublicKey().getEncoded());
      trust.releaseTrustedKeys = Map.of("release-test", releasePrivate.generatePublicKey().getEncoded());
      trust.transport = this::transport;
      trust.artifactDownloader = this::download;
      settings.trust = trust;
      settings.install.cacheRoot = cacheRoot;
      settings.platform = "windows";
      settings.arch = "x64";
      return settings;
    }

    private LicenseServiceClientOptions.TransportResponse transport(
        String method,
        String url,
        Map<String, String> headers,
        byte[] body) {
      if (url.endsWith("/v2/licenses/info") && method.equals("POST")) {
        String policy = "latest";
        String requested = null;
        Object requestedKernelMajor = "latest";
        try {
          JsonNode request = CanonicalJson.MAPPER.readTree(body);
          if (request.has("versionPolicy")) policy = request.get("versionPolicy").asText();
          if (request.has("browserVersion")) requested = request.get("browserVersion").asText();
          if (request.has("kernelMajor")) {
            requestedKernelMajor = request.get("kernelMajor").isTextual()
                ? request.get("kernelMajor").asText()
                : request.get("kernelMajor").asInt();
          }
        } catch (IOException error) {
          throw new RuntimeException(error);
        }
        String browserVersion = "150.0.8000.1";
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", 1);
        response.put("channel", "stable");
        response.put("licenseStatus", "active");
        response.put("plan", "launch");
        response.put("effectivePlan", "launch");
        response.put("paidThrough", now + 86_400);
        response.put("features", new String[] { "browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright", "puppeteer" });
        response.put("concurrencyLimit", 5);
        response.put("activeSessions", 0);
        response.put("availableSessions", 5);
        response.put("sessionState", Map.of(
            "activeBrowserProcesses", 0,
            "limit", 5,
            "available", 5));
        response.put("browserVersion", browserVersion);
        response.put("requestedBrowserVersion", requested);
        response.put("requestedKernelMajor", requestedKernelMajor);
        response.put("versionPolicy", policy);
        response.put("selectionReason", policy.equals("at-or-before") && !browserVersion.equals(requested)
            ? "rollback"
            : policy.equals("at-or-before") ? "exact" : policy);
        response.put("selectionMode", "latest-in-major");
        response.put("availableBrowserVersions", new String[] { browserVersion });
        response.put("latestAvailableVersion", browserVersion);
        response.put("updateAvailable", false);
        response.put("updateRequired", false);
        response.put("updateRights", Map.of(
            "status", "active",
            "channel", "stable",
            "updatesThrough", now + 86_400,
            "exactVersion", true,
            "rollback", true));
        response.put("stableErrorCode", null);
        return json(200, response);
      }
      if (url.endsWith("/v1/licenses/sessions") && method.equals("POST")) {
        if (sessionError) {
          return json(sessionErrorStatus, Map.of("error", sessionLimitError()));
        }
        String policy = "latest";
        String requested = null;
        try {
          JsonNode request = CanonicalJson.MAPPER.readTree(body);
          sessionRequests.add(request);
          if (request.has("versionPolicy")) policy = request.get("versionPolicy").asText();
          if (request.has("browserVersion")) requested = request.get("browserVersion").asText();
        } catch (IOException error) {
          throw new RuntimeException(error);
        }
        String browserVersion = "150.0.8000.1";
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", 1);
        response.put("sessionId", "00000000-0000-4000-8000-000000000001");
        response.put("sessionToken", sessionToken);
        response.put("heartbeatAfterSeconds", 60);
        response.put("expiresAt", now + 600);
        response.put("plan", "launch");
        response.put("concurrencyLimit", 5);
        response.put("activeSessions", 1);
        response.put("browserVersion", browserVersion);
        response.put("requestedBrowserVersion", requested);
        response.put("versionPolicy", policy);
        response.put("selectionReason", policy.equals("at-or-before") && !browserVersion.equals(requested)
            ? "rollback"
            : policy.equals("at-or-before") ? "exact" : policy);
        response.put("availableBrowserVersions", new String[] { browserVersion });
        response.put("updateRights", Map.of(
            "status", "active",
            "channel", "stable",
            "updatesThrough", now + 86_400,
            "exactVersion", true,
            "rollback", true));
        response.put("lease", lease(browserVersion));
        response.put("manifest", manifest());
        return json(201, response);
      }
      if (url.endsWith("/v2/runtime/sessions") && method.equals("POST")) {
        if (sessionError) {
          return json(sessionErrorStatus, Map.of("error", sessionLimitError()));
        }
        String policy = "latest";
        String requested = null;
        String startupId = null;
        String automationBackend = null;
        try {
          JsonNode request = CanonicalJson.MAPPER.readTree(body);
          runtimeSessionRequests.add(request);
          if (request.has("versionPolicy")) policy = request.get("versionPolicy").asText();
          if (request.has("browserVersion")) requested = request.get("browserVersion").asText();
          if (request.has("startupId")) startupId = request.get("startupId").asText();
          if (request.has("automationBackend")) automationBackend = request.get("automationBackend").asText();
        } catch (IOException error) {
          throw new RuntimeException(error);
        }
        String browserVersion = "150.0.8000.1";
        Map<String, Object> ticket = new LinkedHashMap<>();
        ticket.put("token", downloadTicketToken);
        ticket.put("expiresAt", now + 600);
        ticket.put("artifactSha256", artifactSha256);
        ticket.put("artifactUrl", "https://api.slybrowser.test/v1/releases/artifacts/" + artifactSha256 + ".zip");

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("schemaVersion", 2);
        response.put("state", "reserved");
        response.put("startupId", startupId);
        response.put("sessionId", "00000000-0000-4000-8000-000000000001");
        response.put("bootstrapToken", bootstrapToken);
        response.put("activationTicket", activationTicket);
        if ("project-webdriver".equals(automationBackend)) response.put("driverActivationTicket", driverActivationTicket);
        response.put("heartbeatAfterSeconds", 60);
        response.put("expiresAt", now + 600);
        response.put("plan", "launch");
        response.put("concurrencyLimit", 5);
        response.put("activeSessions", 1);
        response.put("browserVersion", browserVersion);
        response.put("requestedBrowserVersion", requested);
        response.put("versionPolicy", policy);
        response.put("selectionReason", policy.equals("at-or-before") && !browserVersion.equals(requested)
            ? "rollback"
            : policy.equals("at-or-before") ? "exact" : policy);
        response.put("availableBrowserVersions", new String[] { browserVersion });
        response.put("updateRights", Map.of(
            "status", "active",
            "channel", "stable",
            "updatesThrough", now + 86_400,
            "exactVersion", true,
            "rollback", true));
        response.put("lease", lease(browserVersion));
        response.put("manifest", manifest());
        response.put("downloadTicket", ticket);
        return json(201, response);
      }
      if (url.endsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/bootstrap-heartbeat")
          && method.equals("POST")) {
        assertEquals("Bootstrap " + bootstrapToken, headers.get("Authorization"));
        return runtimeJson("reserved", false);
      }
      if (url.endsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/activate")
          && method.equals("POST")) {
        assertEquals("Activation " + activationTicket, headers.get("Authorization"));
        return runtimeJson("active", true);
      }
      if (url.endsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/heartbeat")
          && method.equals("POST")) {
        assertEquals("Runtime " + runtimeToken, headers.get("Authorization"));
        return runtimeJson("active", false);
      }
      if (url.endsWith("/v2/runtime/sessions/00000000-0000-4000-8000-000000000001/close")
          && method.equals("POST")) {
        assertEquals("Runtime " + runtimeToken, headers.get("Authorization"));
        return runtimeJson("closing", false);
      }
      if (method.equals("DELETE")) {
        releases += 1;
        return new LicenseServiceClientOptions.TransportResponse(204, new byte[0]);
      }
      throw new AssertionError("Unexpected request: " + method + " " + url);
    }

    private Map<String, Object> sessionLimitError() {
      return Map.of(
          "code", sessionErrorCode,
          "message", "Limit reached for runtime-token buyer@example.com paynow-secret",
          "concurrencyLimit", 5,
          "activeSessions", 5,
          "availableSessions", 0,
          "runtimeToken", runtimeToken,
          "downloadTicket", downloadTicketToken,
          "email", "buyer@example.com",
          "payNowId", "paynow-secret",
          "actions", List.of(
              Map.of(
                  "type", "close_session",
                  "api", "DELETE /v2/runtime/sessions/{sessionId}",
                  "authorization", "Runtime " + runtimeToken),
              Map.of("type", "upgrade_plan", "url", "https://slybrowser.com/#pricing")));
    }

    private void download(String url, Map<String, String> headers, Path destination) {
      if (url.contains("/v2/runtime/artifacts/")) {
        assertEquals("Download " + downloadTicketToken, headers.get("Authorization"));
      } else {
        assertEquals("Session " + sessionToken, headers.get("Authorization"));
      }
      downloads += 1;
      try {
        Files.write(destination, archive);
      } catch (IOException error) {
        throw new RuntimeException(error);
      }
    }

    private LicenseServiceClientOptions.TransportResponse runtimeJson(String state, boolean includeRuntimeToken) {
      Map<String, Object> response = new LinkedHashMap<>();
      response.put("schemaVersion", 2);
      response.put("state", state);
      response.put("startupId", "st_javav2runtime0001");
      response.put("sessionId", "00000000-0000-4000-8000-000000000001");
      if (includeRuntimeToken) response.put("runtimeToken", runtimeToken);
      response.put("heartbeatAfterSeconds", 60);
      response.put("expiresAt", now + 600);
      response.put("plan", "launch");
      response.put("concurrencyLimit", 5);
      response.put("activeSessions", 1);
      response.put("lease", lease("150.0.8000.1"));
      return json(200, response);
    }

    private Map<String, Object> lease(String browserVersion) {
      String browserSha256 = sha256("browser".getBytes(StandardCharsets.UTF_8));
      String driverSha256 = sha256("driver".getBytes(StandardCharsets.UTF_8));
      Map<String, Object> privateModule = new LinkedHashMap<>();
      privateModule.put("path", "SlyBrowser/sly_private_module.dll");
      privateModule.put("sha256", sha256("private-module".getBytes(StandardCharsets.UTF_8)));
      privateModule.put("size", "private-module".getBytes(StandardCharsets.UTF_8).length);
      privateModule.put("abi", "windows-x64");
      Map<String, Object> resource = new LinkedHashMap<>();
      resource.put("path", "SlyBrowser/resources.pak");
      resource.put("sha256", sha256("resources".getBytes(StandardCharsets.UTF_8)));
      resource.put("size", "resources".getBytes(StandardCharsets.UTF_8).length);
      Map<String, Object> codeSignature = new LinkedHashMap<>();
      codeSignature.put("scheme", "authenticode");
      codeSignature.put("subject", "CN=SlyBrowser Test Publisher");
      codeSignature.put("certificateSha256", "3".repeat(64));
      codeSignature.put("timestampRequired", true);
      Map<String, Object> artifact = new LinkedHashMap<>();
      artifact.put("sha256", artifactSha256);
      artifact.put("platform", "windows");
      artifact.put("arch", "x64");
      artifact.put("archiveFormat", "zip");
      artifact.put("browserExecutable", "SlyBrowser.exe");
      artifact.put("driverExecutable", "chromedriver.exe");
      artifact.put("browserSha256", browserSha256);
      artifact.put("driverSha256", driverSha256);
      artifact.put("privateModules", new Object[] { privateModule });
      artifact.put("resources", new Object[] { resource });
      artifact.put("codeSignature", codeSignature);
      Map<String, Object> claims = new LinkedHashMap<>();
      claims.put("schemaVersion", 2);
      claims.put("licenseId", "00000000-0000-4000-8000-000000000002");
      claims.put("audience", "slybrowser");
      claims.put("issuedAt", now);
      claims.put("notBefore", now);
      claims.put("expiresAt", now + 600);
      claims.put("browserVersion", browserVersion);
      claims.put("browserMin", browserVersion);
      claims.put("browserMax", browserVersion);
      claims.put("planId", "launch");
      claims.put("concurrencyLimit", 5);
      claims.put("licenseStatus", "active");
      claims.put("artifactSha256", artifactSha256);
      claims.put("browserSha256", browserSha256);
      claims.put("driverSha256", driverSha256);
      claims.put("artifact", artifact);
      claims.put("leaseGeneration", now + 600);
      claims.put("features", new String[] {
          "browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright"
      });
      claims.put("sessionId", "00000000-0000-4000-8000-000000000001");
      claims.put("nonce", "test-nonce");
      byte[] payload;
      try {
        payload = CanonicalJson.MAPPER.writeValueAsBytes(claims);
      } catch (IOException error) {
        throw new RuntimeException(error);
      }
      return Map.of(
          "algorithm", "Ed25519",
          "keyId", "lease-test",
          "payload", CanonicalJson.encodeBase64Url(payload),
          "signature", CanonicalJson.encodeBase64Url(sign(leasePrivate, payload)));
    }

    private Map<String, Object> manifest() {
      Map<String, Object> artifact = new LinkedHashMap<>();
      artifact.put("platform", "windows");
      artifact.put("arch", "x64");
      artifact.put("url", "https://api.slybrowser.test/v1/releases/artifacts/" + artifactSha256 + ".zip");
      artifact.put("sha256", artifactSha256);
      artifact.put("size", archive.length);
      artifact.put("archiveFormat", "zip");
      artifact.put("browserExecutable", "SlyBrowser.exe");
      artifact.put("driverExecutable", "chromedriver.exe");
      artifact.put("browserSha256", sha256("browser".getBytes(StandardCharsets.UTF_8)));
      artifact.put("driverSha256", sha256("driver".getBytes(StandardCharsets.UTF_8)));
      Map<String, Object> privateModule = new LinkedHashMap<>();
      privateModule.put("path", "SlyBrowser/sly_private_module.dll");
      privateModule.put("sha256", sha256("private-module".getBytes(StandardCharsets.UTF_8)));
      privateModule.put("size", "private-module".getBytes(StandardCharsets.UTF_8).length);
      privateModule.put("abi", "windows-x64");
      artifact.put("privateModules", new Object[] { privateModule });
      Map<String, Object> resource = new LinkedHashMap<>();
      resource.put("path", "SlyBrowser/resources.pak");
      resource.put("sha256", sha256("resources".getBytes(StandardCharsets.UTF_8)));
      resource.put("size", "resources".getBytes(StandardCharsets.UTF_8).length);
      artifact.put("resources", new Object[] { resource });
      Map<String, Object> codeSignature = new LinkedHashMap<>();
      codeSignature.put("scheme", "authenticode");
      codeSignature.put("subject", "CN=SlyBrowser Test Publisher");
      codeSignature.put("certificateSha256", "3".repeat(64));
      codeSignature.put("timestampRequired", true);
      artifact.put("codeSignature", codeSignature);

      Map<String, Object> unsigned = new LinkedHashMap<>();
      unsigned.put("schemaVersion", 1);
      unsigned.put("browserVersion", "150.0.8000.1");
      unsigned.put("sdkCompatibility", ">=0.1.0 <1.0.0");
      unsigned.put("status", "available");
      unsigned.put("publishedAt", Instant.ofEpochSecond(now).toString());
      unsigned.put("artifacts", new Object[] { artifact });
      unsigned.put("evidence", Map.of(
          "sbom", evidence("sbom", "0".repeat(64), "application/vnd.cyclonedx+json"),
          "provenance", evidence("provenance", "1".repeat(64), "application/vnd.in-toto+json"),
          "chromiumPatchInventory", evidence("patches", "2".repeat(64), "application/vnd.slybrowser.chromium-patch-inventory+json"),
          "sourceBoundary", Map.of("sdk", "open-source", "chromiumPatches", "inventory-and-approved-patches", "proprietaryCore", "private")));
      byte[] payload = CanonicalJson.serialize(CanonicalJson.object(unsigned));
      Map<String, Object> manifest = new LinkedHashMap<>(unsigned);
      manifest.put("signature", Map.of(
          "algorithm", "ed25519",
          "keyId", "release-test",
          "value", CanonicalJson.encodeBase64Url(sign(releasePrivate, payload))));
      if (tamperManifest) manifest.put("browserVersion", "151.0.0.0");
      return manifest;
    }

    private static Map<String, Object> evidence(String name, String sha256, String mediaType) {
      return Map.of(
          "url", "https://api.slybrowser.test/evidence/" + name + ".json",
          "sha256", sha256,
          "size", 1,
          "mediaType", mediaType);
    }

    private static LicenseServiceClientOptions.TransportResponse json(int status, Object value) {
      try {
        return new LicenseServiceClientOptions.TransportResponse(
            status,
            CanonicalJson.MAPPER.writeValueAsBytes(value));
      } catch (IOException error) {
        throw new RuntimeException(error);
      }
    }

    private static Ed25519PrivateKeyParameters newPrivateKey() {
      Ed25519KeyPairGenerator generator = new Ed25519KeyPairGenerator();
      generator.init(new KeyGenerationParameters(new SecureRandom(), 256));
      return (Ed25519PrivateKeyParameters) generator.generateKeyPair().getPrivate();
    }

    private static byte[] sign(Ed25519PrivateKeyParameters key, byte[] payload) {
      Ed25519Signer signer = new Ed25519Signer();
      signer.init(true, key);
      signer.update(payload, 0, payload.length);
      return signer.generateSignature();
    }

    private static byte[] archive() {
      try {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
          write(zip, "SlyBrowser.exe", "browser");
          write(zip, "chromedriver.exe", "driver");
        }
        return bytes.toByteArray();
      } catch (IOException error) {
        throw new RuntimeException(error);
      }
    }

    private static void write(ZipOutputStream zip, String name, String value) throws IOException {
      zip.putNextEntry(new ZipEntry(name));
      zip.write(value.getBytes(StandardCharsets.UTF_8));
      zip.closeEntry();
    }

    private static String sha256(byte[] value) {
      try {
        return ReleaseManifestVerifier.hex(MessageDigest.getInstance("SHA-256").digest(value));
      } catch (java.security.NoSuchAlgorithmException error) {
        throw new RuntimeException(error);
      }
    }
  }
}
