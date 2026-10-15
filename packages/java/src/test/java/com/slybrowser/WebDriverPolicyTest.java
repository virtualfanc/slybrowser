package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.openqa.selenium.chrome.ChromeOptions;

final class WebDriverPolicyTest {
  @TempDir Path temp;

  private static String nativeBrowserName() {
    String os = System.getProperty("os.name");
    return os.startsWith("Windows") ? "SlyBrowser.exe"
        : os.startsWith("Mac") || os.startsWith("Darwin") ? "SlyBrowser" : "chrome";
  }

  private static String nativeDriverName() {
    return System.getProperty("os.name").startsWith("Windows") ? "chromedriver.exe" : "chromedriver";
  }

  @Test
  void acceptsNativeProjectNamesBeforeValidatingSettings() throws Exception {
    Path browser = Files.createFile(temp.resolve(nativeBrowserName()));
    Path driver = Files.createFile(temp.resolve(nativeDriverName()));
    WebDriverLaunchSettings settings = new WebDriverLaunchSettings();
    settings.driverStartTimeoutMs = 1;
    ConfigurationException error = assertThrows(ConfigurationException.class,
        () -> SlyBrowserWebDriver.launch(browser, driver, "{}", settings));
    assertEquals("config_invalid", error.getCode());
  }

  @Test
  void appliesNativeCasePolicyToBothExecutables() throws Exception {
    Path browser = Files.createFile(temp.resolve(nativeBrowserName().toUpperCase(java.util.Locale.ROOT)));
    Path driver = Files.createFile(temp.resolve(nativeDriverName().toUpperCase(java.util.Locale.ROOT)));
    WebDriverLaunchSettings settings = new WebDriverLaunchSettings();
    settings.driverStartTimeoutMs = 1;
    ConfigurationException error = assertThrows(ConfigurationException.class,
        () -> SlyBrowserWebDriver.launch(browser, driver, "{}", settings));
    if (System.getProperty("os.name").startsWith("Windows")) {
      assertEquals("config_invalid", error.getCode());
    } else {
      assertEquals("browser_executable_invalid", error.getCode());
      Path nativeBrowser = Files.writeString(temp.resolve(nativeBrowserName()), "");
      error = assertThrows(ConfigurationException.class,
          () -> SlyBrowserWebDriver.launch(nativeBrowser, driver, "{}", settings));
      assertEquals("driver_executable_invalid", error.getCode());
    }
  }

  @Test
  void rejectsNonProjectExecutableNamesBeforeStartingAnything() throws Exception {
    Path browser = Files.createFile(temp.resolve("chrome.exe"));
    Path driver = Files.createFile(temp.resolve("system-driver.exe"));
    ConfigurationException browserError = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserWebDriver.launch(browser, driver, "{}"));
    assertEquals("browser_executable_invalid", browserError.getCode());

    Path slyBrowser = Files.createFile(temp.resolve(nativeBrowserName()));
    ConfigurationException driverError = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserWebDriver.launch(slyBrowser, driver, "{}"));
    assertEquals("driver_executable_invalid", driverError.getCode());
  }

  @Test
  @SuppressWarnings("unchecked")
  void buildsNativeHumanizeCapabilityWithoutFrameworkSubstitution() throws Exception {
    Path browser = Files.createFile(temp.resolve("SlyBrowser.exe"));
    WebDriverLaunchSettings settings = new WebDriverLaunchSettings();
    settings.humanize = true;
    settings.humanPreset = "careful";
    settings.humanSeed = 42424;
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        browser,
        Collections.emptyMap(),
        "{}",
        temp,
        Collections.emptyList())) {
      ChromeOptions options = SlyBrowserWebDriver.buildChromeOptions(plan, settings);
      Map<String, Object> capabilities = options.asMap();
      Map<String, Object> sly = (Map<String, Object>) capabilities.get("sly:options");
      Map<String, Object> humanize = (Map<String, Object>) sly.get("humanize");
      assertEquals(true, humanize.get("enabled"));
      assertEquals("careful", humanize.get("preset"));
      assertEquals(42424, humanize.get("seed"));
      Map<String, Object> chrome = (Map<String, Object>) capabilities.get("goog:chromeOptions");
      assertEquals(browser.toAbsolutePath().normalize().toString(), chrome.get("binary"));
      assertTrue(((Iterable<String>) chrome.get("args")).iterator().hasNext());
    }
  }

  @Test
  void derivesReleaseRootFromSignedArtifactPath() throws Exception {
    Path root = temp.toAbsolutePath().normalize();
    Path browser = root.resolve("SlyBrowser").resolve("SlyBrowser.exe");
    assertEquals(root, SlyBrowserWebDriver.deriveReleaseRoot(browser, "SlyBrowser/SlyBrowser.exe"));
    assertEquals(null, SlyBrowserWebDriver.deriveReleaseRoot(browser, "OtherBrowser/SlyBrowser.exe"));
  }

  @Test
  void rejectsRuntimeHandoffSecretsBeforeStartingProjectWebDriver() throws Exception {
    Path browser = Files.createFile(temp.resolve(nativeBrowserName()));
    Path driver = Files.createFile(temp.resolve(nativeDriverName()));
    WebDriverLaunchSettings settings = new WebDriverLaunchSettings();
    settings.runtimeHandoff = Map.of(
        "schemaVersion", 2,
        "downloadTicket", "must-stay-in-service");

    ConfigurationException error = assertThrows(
        ConfigurationException.class,
        () -> SlyBrowserWebDriver.launch(browser, driver, "{\"lease\":\"secret\"}", settings));
    assertEquals("runtime_handoff_secret_forbidden", error.getCode());
  }
}
