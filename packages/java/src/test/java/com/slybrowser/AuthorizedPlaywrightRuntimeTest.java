package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class AuthorizedPlaywrightRuntimeTest {
  private static final ObjectMapper JSON = new ObjectMapper();

  @Test
  void launchesAuthorizedPlaywrightWhenConfigured() throws Exception {
    String authorization = value("slybrowser.integration.authorizationFile", "SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE");
    String output = value("slybrowser.integration.output", "SLYBROWSER_INTEGRATION_OUTPUT");
    assumeTrue(authorizationConfigured(authorization) && output != null, "Authorized Playwright integration properties are not configured");
    assumeTrue("1".equals(System.getenv("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD")),
        "Authorized Playwright integration must not allow Playwright-managed browser downloads");

    Instant started = Instant.now();
    boolean headed = Boolean.parseBoolean(value("slybrowser.integration.headed", "SLYBROWSER_INTEGRATION_HEADED", "false"))
        || "1".equals(value("slybrowser.integration.headed", "SLYBROWSER_INTEGRATION_HEADED", "false"));
    PlaywrightLaunchSettings playwrightSettings = new PlaywrightLaunchSettings();
    playwrightSettings.frameworkVersion = value("slybrowser.integration.frameworkVersion", "SLYBROWSER_INTEGRATION_FRAMEWORK_VERSION", "1.61.0");
    playwrightSettings.humanize = true;
    playwrightSettings.humanPreset = "careful";
    playwrightSettings.humanSeed = 52525;
    playwrightSettings.nativeReady = true;
    playwrightSettings.nativeReadyTimeoutMs = 30_000;
    playwrightSettings.configure = options -> {
      options.headless = !headed;
      options.args = java.util.List.of("--window-size=900,700", "--force-device-scale-factor=1.5");
    };

    try (Playwright playwright = Playwright.create();
         LicensedPlaywrightBrowser runtime = LicensedBrowser.launchAuthorizedPlaywright(
             playwright,
             Path.of(authorization),
             licensedSettings(),
             playwrightSettings)) {
      Page page = runtime.browser().newPage();
      page.navigate(dataUrl("<title>sly-java-playwright-ok</title><button id='target'>Target</button>"));
      assertEquals("sly-java-playwright-ok", page.title());
      @SuppressWarnings("unchecked")
      Map<String, Object> signals = (Map<String, Object>) page.evaluate(String.join("\n",
          "() => ({",
          "  webdriver: navigator.webdriver,",
          "  userAgent: navigator.userAgent,",
          "  chromeType: typeof window.chrome,",
          "  dpr: devicePixelRatio,",
          "})"));
      assertFalse(Boolean.TRUE.equals(signals.get("webdriver")));
      assertEquals("object", signals.get("chromeType"));

      Map<String, Object> report = new LinkedHashMap<>();
      report.put("schemaVersion", 1);
      report.put("generatedAt", Instant.now().toString());
      report.put("status", "PASS");
      report.put("language", "java");
      report.put("backend", "playwright");
      report.put("headed", headed);
      report.put("browserVersion", runtime.licenseRuntime.browserVersion);
      Map<String, Object> versionAudit = new LinkedHashMap<>();
      versionAudit.put("requested", runtime.licenseRuntime.versionAudit.requested);
      versionAudit.put("selected", runtime.licenseRuntime.versionAudit.selected);
      versionAudit.put("downloaded", runtime.licenseRuntime.versionAudit.downloaded);
      versionAudit.put("launched", runtime.licenseRuntime.versionAudit.launched);
      versionAudit.put("policy", runtime.licenseRuntime.versionAudit.policy);
      versionAudit.put("selectionReason", runtime.licenseRuntime.versionAudit.selectionReason);
      report.put("versionAudit", versionAudit);
      report.put("signals", signals);
      report.put("durationMs", Duration.between(started, Instant.now()).toMillis());
      Path outputPath = Path.of(output).toAbsolutePath().normalize();
      Files.createDirectories(outputPath.getParent());
      JSON.writerWithDefaultPrettyPrinter().writeValue(outputPath.toFile(), report);
    }
  }

  private static boolean authorizationConfigured(String authorization) {
    return authorization != null &&
        value("slybrowser.integration.cacheRoot", "SLYBROWSER_INTEGRATION_CACHE_ROOT") != null &&
        value("slybrowser.integration.licenseKeyId", "SLYBROWSER_INTEGRATION_LICENSE_KEY_ID") != null &&
        value("slybrowser.integration.licensePublicKeyHex", "SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX") != null &&
        value("slybrowser.integration.releaseKeyId", "SLYBROWSER_INTEGRATION_RELEASE_KEY_ID") != null &&
        value("slybrowser.integration.releasePublicKeyBase64url", "SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL") != null;
  }

  private static LicensedLaunchSettings licensedSettings() {
    LicenseServiceClientOptions trust = new LicenseServiceClientOptions();
    trust.licenseTrustedKeys = Map.of(
        value("slybrowser.integration.licenseKeyId", "SLYBROWSER_INTEGRATION_LICENSE_KEY_ID"),
        hex(value("slybrowser.integration.licensePublicKeyHex", "SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX")));
    trust.releaseTrustedKeys = Map.of(
        value("slybrowser.integration.releaseKeyId", "SLYBROWSER_INTEGRATION_RELEASE_KEY_ID"),
        base64url(value("slybrowser.integration.releasePublicKeyBase64url", "SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL")));
    InstallOptions install = new InstallOptions();
    install.cacheRoot = Path.of(value("slybrowser.integration.cacheRoot", "SLYBROWSER_INTEGRATION_CACHE_ROOT"));
    LicensedLaunchSettings settings = new LicensedLaunchSettings();
    settings.trust = trust;
    settings.install = install;
    settings.platform = value("slybrowser.integration.platform", "SLYBROWSER_INTEGRATION_PLATFORM", "windows");
    settings.arch = value("slybrowser.integration.arch", "SLYBROWSER_INTEGRATION_ARCH", "x64");
    settings.updateKernel = Boolean.FALSE;
    return settings;
  }

  private static String dataUrl(String markup) {
    return "data:text/html;charset=utf-8;base64,"
        + Base64.getEncoder().encodeToString(markup.getBytes(StandardCharsets.UTF_8));
  }

  private static String value(String property, String environment) {
    return value(property, environment, null);
  }

  private static String value(String property, String environment, String defaultValue) {
    String fromProperty = System.getProperty(property);
    if (fromProperty != null && !fromProperty.isBlank()) return fromProperty;
    String fromEnvironment = System.getenv(environment);
    if (fromEnvironment != null && !fromEnvironment.isBlank()) return fromEnvironment;
    return defaultValue;
  }

  private static byte[] hex(String value) {
    if (value.length() % 2 != 0) throw new IllegalArgumentException("hex value has odd length");
    byte[] bytes = new byte[value.length() / 2];
    for (int index = 0; index < bytes.length; index++) {
      bytes[index] = (byte) Integer.parseInt(value.substring(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  private static byte[] base64url(String value) {
    return Base64.getUrlDecoder().decode(value + "=".repeat((4 - value.length() % 4) % 4));
  }
}
