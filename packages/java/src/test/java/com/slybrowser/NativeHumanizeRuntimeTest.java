package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.openqa.selenium.By;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.interactions.Actions;

final class NativeHumanizeRuntimeTest {
  private static final ObjectMapper JSON = new ObjectMapper();

  @Test
  @SuppressWarnings("unchecked")
  void scoresNativeHumanizeRuntimeWhenConfigured() throws Exception {
    String browser = System.getProperty("slybrowser.integration.browser");
    String driver = System.getProperty("slybrowser.integration.driver");
    String license = System.getProperty("slybrowser.integration.license");
    String authorization = System.getProperty("slybrowser.integration.authorizationFile");
    String output = System.getProperty("slybrowser.integration.output");
    assumeTrue(
        output != null && (
            authorizationConfigured(authorization) ||
            (browser != null && driver != null && license != null)),
        "SlyBrowser runtime integration properties are not configured");

    Instant started = Instant.now();
    WebDriverLaunchSettings settings = new WebDriverLaunchSettings();
    settings.headless = !Boolean.getBoolean("slybrowser.integration.headed");
    settings.viewportWidth = 800;
    settings.viewportHeight = 600;
    settings.humanize = true;
    settings.humanPreset = "careful";
    settings.humanSeed = 42424;
    settings.commandTimeoutMs = 30_000;
    settings.browserArguments.add("--force-device-scale-factor=1.75");

    SlyWebDriverSession session = authorization != null
        ? LicensedBrowser.launchAuthorized(Path.of(authorization), licensedSettings(settings))
        : SlyBrowserWebDriver.launch(
            Path.of(browser),
            Path.of(driver),
            Files.readString(Path.of(license), StandardCharsets.UTF_8),
            settings);
    try (session) {
      org.openqa.selenium.WebDriver webDriver = session.getDriver();
      JavascriptExecutor js = (JavascriptExecutor) webDriver;
      webDriver.get(dataUrl(String.join("\n",
          "<input id='name' style='position:absolute;left:40px;top:40px;width:240px;height:40px' onclick='window.inputClicks=(window.inputClicks||0)+1'>",
          "<button id='target' style='position:absolute;left:420px;top:260px;width:220px;height:90px' onclick='window.clicked=(window.clicked||0)+1'>Target</button>",
          "<iframe id='test-frame' style='position:absolute;left:80px;top:380px;width:500px;height:180px'",
          "  srcdoc=\"<button id='frame-target' style='position:absolute;left:120px;top:40px;width:180px;height:70px' onclick='window.clicked=(window.clicked||0)+1'>Frame target</button>\"></iframe>")));

      webDriver.findElement(By.cssSelector("#name")).sendKeys("java-humanize");
      webDriver.findElement(By.cssSelector("#target")).click();
      Map<String, Object> geometry = (Map<String, Object>) js.executeScript(String.join("\n",
          "const target = document.querySelector('#target');",
          "const bounding = target.getBoundingClientRect();",
          "const client = target.getClientRects()[0];",
          "return {",
          "  dpr: devicePixelRatio,",
          "  bounding: {x: bounding.x, y: bounding.y, width: bounding.width, height: bounding.height},",
          "  client: {x: client.x, y: client.y, width: client.width, height: client.height},",
          "  clicked: window.clicked || 0,",
          "  inputClicks: window.inputClicks || 0,",
          "  typed: document.querySelector('#name').value,",
          "};"));

      WebElement frame = webDriver.findElement(By.cssSelector("#test-frame"));
      webDriver.switchTo().frame(frame);
      webDriver.findElement(By.cssSelector("#frame-target")).click();
      Number frameClicked = (Number) js.executeScript("return window.clicked || 0");
      webDriver.switchTo().parentFrame();
      new Actions(webDriver)
          .moveByOffset(40, 40)
          .pause(Duration.ofMillis(20))
          .moveByOffset(140, 80)
          .perform();

      Map<String, Object> checks = checks(geometry, frameClicked, "java-humanize", 1.75);
      double score = score(checks);
      assertEquals(100.0, score, 0.001, "Java SDK Native Humanize score must match Node");

      Map<String, Object> report = new LinkedHashMap<>();
      report.put("schemaVersion", 1);
      report.put("generatedAt", Instant.now().toString());
      report.put("status", "PASS");
      report.put("score", score);
      report.put("checks", checks);
      report.put("runtime", Map.of(
          "java", System.getProperty("java.version"),
          "vendor", System.getProperty("java.vendor"),
          "platform", System.getProperty("os.name")));
      report.put("matrix", Map.of(
          "sdk", "java",
          "headed", Boolean.getBoolean("slybrowser.integration.headed"),
          "page", true,
          "frame", true,
          "elementClick", true,
          "elementType", true,
          "dpi", 1.75,
          "commandTimeoutMs", 30_000));
      report.put("geometry", geometry);
      report.put("frameClicked", frameClicked);
      report.put("durationMs", Duration.between(started, Instant.now()).toMillis());
      Path outputPath = Path.of(output).toAbsolutePath().normalize();
      Files.createDirectories(outputPath.getParent());
      JSON.writerWithDefaultPrettyPrinter().writeValue(outputPath.toFile(), report);
    }
  }

  private static String dataUrl(String markup) {
    return "data:text/html;charset=utf-8;base64,"
        + Base64.getEncoder().encodeToString(markup.getBytes(StandardCharsets.UTF_8));
  }

  private static boolean authorizationConfigured(String authorization) {
    return authorization != null &&
        System.getProperty("slybrowser.integration.cacheRoot") != null &&
        System.getProperty("slybrowser.integration.licenseKeyId") != null &&
        System.getProperty("slybrowser.integration.licensePublicKeyHex") != null &&
        System.getProperty("slybrowser.integration.releaseKeyId") != null &&
        System.getProperty("slybrowser.integration.releasePublicKeyBase64url") != null;
  }

  private static LicensedLaunchSettings licensedSettings(WebDriverLaunchSettings webdriver) {
    LicenseServiceClientOptions trust = new LicenseServiceClientOptions();
    trust.licenseTrustedKeys = Map.of(
        System.getProperty("slybrowser.integration.licenseKeyId"),
        hex(System.getProperty("slybrowser.integration.licensePublicKeyHex")));
    trust.releaseTrustedKeys = Map.of(
        System.getProperty("slybrowser.integration.releaseKeyId"),
        base64url(System.getProperty("slybrowser.integration.releasePublicKeyBase64url")));
    InstallOptions install = new InstallOptions();
    install.cacheRoot = Path.of(System.getProperty("slybrowser.integration.cacheRoot"));
    LicensedLaunchSettings settings = new LicensedLaunchSettings();
    settings.trust = trust;
    settings.install = install;
    settings.platform = "windows";
    settings.arch = "x64";
    settings.updateKernel = Boolean.FALSE;
    settings.webdriver = webdriver;
    return settings;
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

  @SuppressWarnings("unchecked")
  private static Map<String, Object> checks(
      Map<String, Object> geometry,
      Number frameClicked,
      String typed,
      double dpr) {
    Map<String, Object> bounding = (Map<String, Object>) geometry.get("bounding");
    Map<String, Object> client = (Map<String, Object>) geometry.get("client");
    boolean consistent = true;
    for (String name : new String[] {"x", "y", "width", "height"}) {
      consistent = consistent && Math.abs(number(bounding.get(name)) - number(client.get(name))) <= 0.01;
    }
    Map<String, Object> checks = new LinkedHashMap<>();
    checks.put("page", true);
    checks.put("frame", number(frameClicked) == 1);
    checks.put("elementClick", number(geometry.get("clicked")) == 1);
    checks.put("elementType", typed.equals(geometry.get("typed")));
    checks.put("noPreparatoryClickForTyping", number(geometry.get("inputClicks")) == 0);
    checks.put("dpi", Math.abs(number(geometry.get("dpr")) - dpr) <= 0.001);
    checks.put("geometry", consistent);
    return checks;
  }

  private static double score(Map<String, Object> checks) {
    long passed = checks.values().stream().filter(Boolean.TRUE::equals).count();
    return passed * 100.0 / checks.size();
  }

  private static double number(Object value) {
    assertTrue(value instanceof Number, "Expected numeric value but got " + value);
    return ((Number) value).doubleValue();
  }
}
