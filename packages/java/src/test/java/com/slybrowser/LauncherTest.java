package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class LauncherTest {
  @TempDir Path directory;

  @Test
  void handoffFilesArePrivateAndRemoved() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    Path config;
    Path license;
    Path runtime;
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        executable,
        Map.of("locale", "en-US"),
        "{\"lease\":\"secret\"}",
        directory,
        Collections.singletonList("--no-first-run"),
        Map.of("schemaVersion", 2, "bootstrapToken", "runtime-secret"),
        null)) {
      config = plan.getConfigFile();
      license = plan.getLicenseFile();
      runtime = plan.getRuntimeFile();
      assertTrue(Files.isRegularFile(config));
      assertTrue(Files.isRegularFile(license));
      assertTrue(Files.isRegularFile(runtime));
      assertFalse(String.join(" ", plan.getArguments()).contains("secret"));
      assertFalse(String.join(" ", plan.getArguments()).contains("runtime-secret"));
      assertTrue(String.join(" ", plan.getArguments()).contains("--sly-runtime-file="));
    }
    assertFalse(Files.exists(config));
    assertFalse(Files.exists(license));
    assertFalse(Files.exists(runtime));
  }

  @Test
  void nativeReadyRequestIsPrivateAndWaitsForMarker() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    Path request;
    Path ready;
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        executable,
        Map.of(),
        "{\"lease\":\"secret\"}",
        directory,
        Collections.emptyList(),
        null,
        null,
        true)) {
      request = plan.getNativeReadyRequestFile();
      ready = plan.getNativeReadyFile();
      assertNotNull(request);
      assertNotNull(ready);
      assertNotNull(plan.getNativeReadyNonce());
      assertTrue(Files.isRegularFile(request));
      assertTrue(Files.isRegularFile(ready));
      assertTrue(String.join(" ", plan.getArguments()).contains("--sly-native-ready-request-file="));
      assertEquals(0, Files.size(ready));
      Files.writeString(ready, "{\"schemaVersion\":1,\"kind\":\"slybrowser.native-ready\",\"ready\":true,\"nonce\":\""
          + plan.getNativeReadyNonce() + "\"}");
      plan.waitForNativeReady(1_000);
    }
    assertFalse(Files.exists(request));
    assertFalse(Files.exists(ready));
  }

  @Test
  void longLivedLicenseKeyIsRejected() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    ConfigurationException error = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserLauncher.prepare(
            executable,
            Map.of("licenseKey", "long-lived"),
            "{\"lease\":\"secret\"}",
            directory,
            Collections.emptyList()));
    assertTrue(error.getCode().equals("profile_secret_forbidden"));
    ConfigurationException runtimeError = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserLauncher.prepare(
            executable,
            Map.of("runtimeToken", "short-lived"),
            "{\"lease\":\"secret\"}",
            directory,
            Collections.emptyList()));
    assertTrue(runtimeError.getCode().equals("profile_secret_forbidden"));
    ConfigurationException activationError = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserLauncher.prepare(
            executable,
            Map.of("activationTicket", "activation-secret"),
            "{\"lease\":\"secret\"}",
            directory,
            Collections.emptyList()));
    assertTrue(activationError.getCode().equals("profile_secret_forbidden"));
  }

  @Test
  void seededFingerprintEnvelopeIsValidatedBeforeNativeLaunch() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(executable,
        Map.of("fingerprintMode", "seeded", "fingerprintSeed", "stable-profile-seed", "fingerprintSchemaVersion", 1),
        "{\"lease\":\"test\"}", directory, Collections.emptyList())) {
      assertTrue(Files.readString(plan.getConfigFile()).contains("stable-profile-seed"));
    }
    for (Object invalid : List.of(
        Map.of("fingerprintMode", "seeded", "fingerprintSeed", "missing-schema"),
        Map.of("fingerprintMode", "explicit", "fingerprintSeed", "forbidden", "fingerprintSchemaVersion", 1),
        Map.of("fingerprintSeed", "bad-version", "fingerprintSchemaVersion", 2))) {
      ConfigurationException error = assertThrows(ConfigurationException.class,
          () -> SlyBrowserLauncher.prepare(executable, invalid, "{\"lease\":\"test\"}", directory, Collections.emptyList()));
      assertEquals("profile_invalid", error.getCode());
    }
  }

  @Test
  void runtimeMaterialInExtraArgumentsIsRejected() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    ConfigurationException error = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserLauncher.prepare(
            executable,
            Map.of(),
            "{\"lease\":\"secret\"}",
            directory,
            Collections.singletonList("--sly-runtime-token=secret")));
    assertTrue(error.getCode().equals("license_argument_forbidden"));
  }

  @Test
  void runtimeHandoffSecretsAreRejected() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    ConfigurationException error = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserLauncher.prepare(
            executable,
            Map.of(),
            "{\"lease\":\"secret\"}",
            directory,
            Collections.emptyList(),
            Map.of("schemaVersion", 2, "runtimeToken", "post-activate-secret"),
            null));
    assertTrue(error.getCode().equals("runtime_handoff_secret_forbidden"));
    ConfigurationException activationError = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserLauncher.prepare(
            executable,
            Map.of(),
            "{\"lease\":\"secret\"}",
            directory,
            Collections.emptyList(),
            Map.of("schemaVersion", 2, "activationTicket", "activation-secret"),
            null));
    assertTrue(activationError.getCode().equals("runtime_handoff_secret_forbidden"));
  }

  @Test
  void runtimeTextInNonSecretArgumentValueIsAllowed() throws Exception {
    Path executable = directory.resolve("browser.exe");
    Files.writeString(executable, "test");
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        executable,
        Map.of(),
        "{\"lease\":\"secret\"}",
        directory,
        Collections.singletonList("--enable-features=RuntimeCallStats"))) {
      assertTrue(plan.getArguments().contains("--enable-features=RuntimeCallStats"));
    }
  }

  @Test
  void releaseRootIsPassedAsNonSecretArgument() throws Exception {
    Path executable = Files.writeString(directory.resolve("browser.exe"), "test");
    Path releaseRoot = directory.resolve("release-root");
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        executable,
        Map.of(),
        "{\"lease\":\"secret\"}",
        directory,
        Collections.emptyList(),
        null,
        null,
        false,
        false,
        releaseRoot)) {
      assertEquals(releaseRoot.toAbsolutePath().normalize(), plan.getReleaseRoot());
      assertTrue(plan.getArguments().contains("--sly-release-root=" + releaseRoot.toAbsolutePath().normalize()));
    }
  }
}
