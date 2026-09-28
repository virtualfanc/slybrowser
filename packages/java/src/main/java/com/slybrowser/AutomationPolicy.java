package com.slybrowser;

import com.microsoft.playwright.Playwright;
import java.util.Collections;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class AutomationPolicy {
  private static final Set<String> SUPPORTED_PLAYWRIGHT_LINES = Collections.singleton("1.61");
  private static final Pattern VERSION = Pattern.compile(
      "^(?<major>[0-9]+)\\.(?<minor>[0-9]+)(?:\\.[0-9]+)?(?:[-+][0-9A-Za-z.-]+)?$");

  private AutomationPolicy() {}

  public static String validatePlaywrightVersion(String version) {
    Matcher match = VERSION.matcher(version);
    if (!match.matches()) {
      throw new ConfigurationException(
          "Invalid Playwright version: " + version,
          "framework_version_invalid");
    }
    String line = match.group("major") + "." + match.group("minor");
    if (!SUPPORTED_PLAYWRIGHT_LINES.contains(line)) {
      throw new ConfigurationException(
          "Unsupported Playwright version " + version + "; supported lines: "
              + String.join(", ", SUPPORTED_PLAYWRIGHT_LINES),
          "framework_version_unsupported");
    }
    return version;
  }

  public static String resolvePlaywrightVersion(String explicitVersion) {
    if (explicitVersion != null) return validatePlaywrightVersion(explicitVersion);
    Package metadata = Playwright.class.getPackage();
    String version = metadata == null ? null : metadata.getImplementationVersion();
    if (version == null || version.trim().isEmpty()) {
      throw new ConfigurationException(
          "Unable to determine the installed com.microsoft.playwright version; pass frameworkVersion explicitly",
          "framework_version_missing");
    }
    return validatePlaywrightVersion(version);
  }

  public static AutomationCapability capability() {
    return capability(AutomationBackend.PROJECT_WEBDRIVER, null);
  }

  public static AutomationCapability capability(AutomationBackend backend, String frameworkVersion) {
    if (backend == AutomationBackend.PROJECT_WEBDRIVER) {
      if (frameworkVersion != null) {
        throw new ConfigurationException(
            "Project WebDriver does not accept a framework version",
            "framework_version_forbidden");
      }
      return new AutomationCapability(backend, "java", null, true, true);
    }
    return new AutomationCapability(
        backend,
        "java",
        resolvePlaywrightVersion(frameworkVersion),
        true,
        true);
  }

  static void requirePlaywrightHumanizeSupport(boolean requested) {
    // Humanize for framework transports is handed to the native browser via
    // --sly-humanize-config. The SDK must not install a language-local substitute.
  }
}
