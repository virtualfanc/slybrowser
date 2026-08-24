package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.openqa.selenium.Capabilities;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeDriverService;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.remote.http.ClientConfig;

public final class SlyBrowserWebDriver {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int MAX_LICENSE_BYTES = 64 * 1024;
  private static final int MAX_RUNTIME_BYTES = 64 * 1024;

  private SlyBrowserWebDriver() {}

  public static SlyWebDriverSession launch(
      Path browserExecutable,
      Path driverExecutable,
      String licenseEnvelope) {
    return launch(browserExecutable, driverExecutable, licenseEnvelope, new WebDriverLaunchSettings());
  }

  public static SlyWebDriverSession launch(
      Path browserExecutable,
      Path driverExecutable,
      String licenseEnvelope,
      WebDriverLaunchSettings settings) {
    Path browser = requireExecutable(browserExecutable, "SlyBrowser.exe", "browser");
    Path driverPath = requireExecutable(driverExecutable, "chromedriver.exe", "driver");
    validateSettings(settings);
    Path releaseRoot = settings.releaseRoot == null
        ? releaseRootFromLease(browser, licenseEnvelope)
        : settings.releaseRoot.toAbsolutePath().normalize();
    Path root = (settings.tempRoot == null ? Path.of(System.getProperty("java.io.tmpdir")) : settings.tempRoot)
        .toAbsolutePath().normalize();
    Path driverLicense = writeDriverLicense(root, licenseEnvelope);
    Path driverRuntime = null;
    LaunchPlan plan = null;
    ChromeDriverService service = null;
    ChromeDriver driver = null;
    try {
      List<String> browserArguments = buildBrowserArguments(settings);
      plan = SlyBrowserLauncher.prepare(
          browser,
          settings.profile,
          licenseEnvelope,
          settings.tempRoot,
          browserArguments,
          settings.runtimeHandoff,
          null,
          settings.nativeReady,
          settings.allowRuntimeActivationTicket,
          releaseRoot);
      driverRuntime = writeDriverRuntime(
          root,
          settings.driverRuntimeHandoff != null ? settings.driverRuntimeHandoff : settings.runtimeHandoff,
          settings.allowRuntimeActivationTicket);
      int port = freeLoopbackPort();
      List<String> driverArguments = new ArrayList<>();
      driverArguments.add("--port=" + port);
      driverArguments.add("--allowed-ips=");
      driverArguments.add("--sly-license-file=" + driverLicense);
      if (releaseRoot != null) driverArguments.add("--sly-release-root=" + releaseRoot);
      if (driverRuntime != null) driverArguments.add("--sly-runtime-file=" + driverRuntime);
      service = new ChromeDriverService(
          driverPath.toFile(),
          port,
          Duration.ofMillis(settings.driverStartTimeoutMs),
          driverArguments,
          Collections.emptyMap());
      ChromeOptions options = buildChromeOptions(plan, settings);
      ClientConfig clientConfig = ClientConfig.defaultConfig()
          .connectionTimeout(Duration.ofMillis(settings.driverStartTimeoutMs))
          .readTimeout(Duration.ofMillis(settings.commandTimeoutMs));
      driver = new ChromeDriver(service, options, clientConfig);
      String[] versions = requireExactPair(driver.getCapabilities());
      driver.manage().timeouts()
          .pageLoadTimeout(Duration.ofMillis(settings.commandTimeoutMs))
          .scriptTimeout(Duration.ofMillis(settings.commandTimeoutMs))
          .implicitlyWait(Duration.ZERO);
      if (settings.nativeReady) {
        plan.waitForNativeReady(settings.nativeReadyTimeoutMs);
      }
      return new SlyWebDriverSession(driver, service, plan, driverLicense, driverRuntime, versions[0], versions[1]);
    } catch (IOException error) {
      closeFailedLaunch(driver, service, plan, driverLicense, driverRuntime);
      throw new ConfigurationException("Unable to start project WebDriver", "webdriver_start_failed", error);
    } catch (RuntimeException error) {
      closeFailedLaunch(driver, service, plan, driverLicense, driverRuntime);
      throw error;
    }
  }

  static ChromeOptions buildChromeOptions(LaunchPlan plan, WebDriverLaunchSettings settings) {
    ChromeOptions options = new ChromeOptions();
    options.setBinary(plan.getExecutable().toFile());
    options.setAcceptInsecureCerts(false);
    options.addArguments(plan.getArguments());
    options.setExperimentalOption("excludeSwitches", new ArrayList<>(settings.excludeSwitches));
    Map<String, Object> humanize = new LinkedHashMap<>();
    humanize.put("enabled", settings.humanize);
    humanize.put("preset", settings.humanPreset);
    if (settings.humanConfig != null) humanize.put("config", settings.humanConfig);
    if (settings.humanSeed != null) humanize.put("seed", settings.humanSeed);
    options.setCapability("sly:options", Collections.singletonMap("humanize", humanize));
    return options;
  }

  private static List<String> buildBrowserArguments(WebDriverLaunchSettings settings) {
    List<String> arguments = new ArrayList<>();
    arguments.add("--no-first-run");
    arguments.add("--no-default-browser-check");
    arguments.addAll(settings.browserArguments);
    if (settings.headless && arguments.stream().noneMatch(value -> value.startsWith("--headless"))) {
      arguments.add("--headless=new");
    }
    if (arguments.stream().noneMatch(value -> value.startsWith("--window-size"))) {
      arguments.add("--window-size=" + settings.viewportWidth + "," + settings.viewportHeight);
    }
    if (settings.profileDir != null && arguments.stream().noneMatch(value -> value.startsWith("--user-data-dir"))) {
      arguments.add("--user-data-dir=" + settings.profileDir.toAbsolutePath().normalize());
    }
    return arguments;
  }

  private static void validateSettings(WebDriverLaunchSettings settings) {
    if (settings == null) throw new ConfigurationException("WebDriver settings are required", "config_invalid");
    if (settings.driverStartTimeoutMs < 1_000 || settings.commandTimeoutMs < 1_000) {
      throw new ConfigurationException("WebDriver timeouts must be at least 1000 milliseconds", "config_invalid");
    }
    if (settings.nativeReady && settings.nativeReadyTimeoutMs <= 0) {
      throw new ConfigurationException("nativeReadyTimeoutMs must be positive", "config_invalid");
    }
    if (settings.viewportWidth < 320 || settings.viewportHeight < 240) {
      throw new ConfigurationException("WebDriver viewport is invalid", "config_invalid");
    }
    String mode = settings.profileMode == null ? (settings.profileDir == null ? "ephemeral" : "persistent") : settings.profileMode;
    if ("persistent".equals(mode) && settings.profileDir == null) {
      throw new ConfigurationException("Persistent profile mode requires profileDir", "persistent_profile_dir_required");
    }
    if ("ephemeral".equals(mode) && settings.profileDir != null) {
      throw new ConfigurationException("Ephemeral profile mode cannot use profileDir", "ephemeral_profile_dir_forbidden");
    }
    if (!"ephemeral".equals(mode) && !"persistent".equals(mode)) {
      throw new ConfigurationException("Unsupported profile mode: " + mode, "config_invalid");
    }
  }

  static Path deriveReleaseRoot(Path browserExecutable, String artifactBrowserExecutable) {
    if (artifactBrowserExecutable == null || artifactBrowserExecutable.isBlank()) return null;
    String[] expected = artifactBrowserExecutable.replace('\\', '/').split("/");
    List<String> expectedParts = new ArrayList<>();
    for (String part : expected) {
      if (!part.isBlank()) expectedParts.add(part);
    }
    if (expectedParts.isEmpty()) return null;
    Path actual = browserExecutable.toAbsolutePath().normalize();
    if (actual.getNameCount() < expectedParts.size()) return null;
    int offset = actual.getNameCount() - expectedParts.size();
    for (int index = 0; index < expectedParts.size(); index++) {
      if (!actual.getName(offset + index).toString().equalsIgnoreCase(expectedParts.get(index))) {
        return null;
      }
    }
    Path releaseRoot = actual;
    for (int index = 0; index < expectedParts.size(); index++) {
      releaseRoot = releaseRoot.getParent();
      if (releaseRoot == null) return null;
    }
    return releaseRoot;
  }

  static Path releaseRootFromLease(Path browserExecutable, String licenseEnvelope) {
    try {
      JsonNode envelope = JSON.readTree(licenseEnvelope);
      JsonNode payload = envelope.get("payload");
      if (payload == null || !payload.isTextual() || payload.asText().isEmpty()) return null;
      JsonNode claims = JSON.readTree(Base64.getUrlDecoder().decode(payload.asText()));
      JsonNode artifactExecutable = claims.path("artifact").get("browserExecutable");
      return artifactExecutable != null && artifactExecutable.isTextual()
          ? deriveReleaseRoot(browserExecutable, artifactExecutable.asText())
          : null;
    } catch (IllegalArgumentException | IOException error) {
      return null;
    }
  }

  private static Path requireExecutable(Path value, String expectedName, String kind) {
    if (value == null) throw new ConfigurationException(kind + " executable is required", kind + "_missing");
    Path path = value.toAbsolutePath().normalize();
    if (!Files.isRegularFile(path)) {
      throw new ConfigurationException(kind + " executable does not exist", kind + "_missing");
    }
    if (!path.getFileName().toString().equalsIgnoreCase(expectedName)) {
      throw new ConfigurationException(
          "Expected the project " + kind + " executable named " + expectedName,
          kind + "_executable_invalid");
    }
    return path;
  }

  private static Path writeDriverLicense(Path root, String envelope) {
    byte[] payload = envelope == null ? new byte[0] : envelope.getBytes(StandardCharsets.UTF_8);
    if (payload.length == 0 || payload.length > MAX_LICENSE_BYTES) {
      throw new ConfigurationException("License lease is missing or too large", "license_invalid_envelope");
    }
    try {
      Files.createDirectories(root);
      Path path = Files.createTempFile(root, "sly-driver-license-", ".json");
      try {
        Set<PosixFilePermission> permissions = EnumSet.of(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE);
        Files.setPosixFilePermissions(path, permissions);
      } catch (UnsupportedOperationException ignored) {
        // Windows ACLs are inherited from the user-private temporary directory.
      }
      Files.write(path, payload);
      SecureHandoffFiles.restrictWindowsAcl(path);
      return path;
    } catch (IOException error) {
      throw new ConfigurationException("Unable to create driver license handoff", "handoff_write_failed", error);
    }
  }

  private static Path writeDriverRuntime(Path root, Object runtimeHandoff, boolean allowRuntimeActivationTicket) {
    if (runtimeHandoff == null) return null;
    try {
      JsonNode runtimeNode = JSON.valueToTree(runtimeHandoff);
        if (!runtimeNode.isObject() || runtimeNode.has("licenseKey") ||
            runtimeNode.has("runtimeToken") || (!allowRuntimeActivationTicket && runtimeNode.has("activationTicket")) ||
            runtimeNode.has("downloadTicket")) {
        throw new ConfigurationException(
            "Runtime handoff must not contain long-lived keys, runtime tokens or download tickets",
            "runtime_handoff_secret_forbidden");
      }
      byte[] payload = JSON.writeValueAsBytes(runtimeNode);
      if (payload.length == 0 || payload.length > MAX_RUNTIME_BYTES) {
        throw new ConfigurationException("Runtime handoff file is missing or too large", "runtime_handoff_invalid");
      }
      Files.createDirectories(root);
      Path path = Files.createTempFile(root, "sly-driver-runtime-", ".json");
      try {
        Set<PosixFilePermission> permissions = EnumSet.of(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE);
        Files.setPosixFilePermissions(path, permissions);
      } catch (UnsupportedOperationException ignored) {
        // Windows ACLs are inherited from the user-private temporary directory.
      }
      Files.write(path, payload);
      SecureHandoffFiles.restrictWindowsAcl(path);
      return path;
    } catch (IOException error) {
      throw new ConfigurationException("Unable to create driver runtime handoff", "handoff_write_failed", error);
    }
  }

  private static int freeLoopbackPort() {
    try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      return socket.getLocalPort();
    } catch (IOException error) {
      throw new ConfigurationException("Unable to allocate a loopback WebDriver port", "webdriver_port_failed", error);
    }
  }

  @SuppressWarnings("unchecked")
  private static String[] requireExactPair(Capabilities capabilities) {
    String browserVersion = capabilities.getBrowserVersion();
    Object chromeValue = capabilities.getCapability("chrome");
    String driverVersion = "";
    if (chromeValue instanceof Map) {
      Object reported = ((Map<String, Object>) chromeValue).get("chromedriverVersion");
      if (reported != null) driverVersion = String.valueOf(reported).split("\\s+", 2)[0];
    }
    if (browserVersion == null || browserVersion.isEmpty() || driverVersion.isEmpty()) {
      throw new ConfigurationException("Project WebDriver did not report exact versions", "webdriver_version_missing");
    }
    if (!browserVersion.equals(driverVersion)) {
      throw new ConfigurationException(
          "SlyBrowser and project WebDriver versions do not match",
          "webdriver_version_mismatch");
    }
    return new String[] { browserVersion, driverVersion };
  }

  private static void closeFailedLaunch(
      ChromeDriver driver,
      ChromeDriverService service,
      LaunchPlan plan,
      Path driverLicense,
      Path driverRuntime) {
    if (driver != null) {
      try { driver.quit(); } catch (RuntimeException ignored) { /* original error wins */ }
    }
    if (service != null) {
      try { service.close(); } catch (RuntimeException ignored) { /* original error wins */ }
    }
    if (plan != null) plan.close();
    if (driverRuntime != null) {
      try { Files.deleteIfExists(driverRuntime); }
      catch (IOException ignored) { /* consumed one-time handoff or next cleanup pass */ }
    }
    try { Files.deleteIfExists(driverLicense); }
    catch (IOException ignored) { /* consumed one-time handoff or next cleanup pass */ }
  }
}
