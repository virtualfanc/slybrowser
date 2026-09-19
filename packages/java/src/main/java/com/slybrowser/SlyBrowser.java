package com.slybrowser;

import com.microsoft.playwright.Playwright;
import java.nio.file.Path;

/** User-facing Java entry point. */
public final class SlyBrowser {
  private SlyBrowser() {}

  public static SlyWebDriverSession launch(Path authorizationFile, SlyBrowserOptions options) {
    return LicensedBrowser.launchLatest(authorizationFile, licensedSettings(options));
  }

  public static SlyWebDriverSession launch(Path authorizationFile) {
    return launch(authorizationFile, new SlyBrowserOptions());
  }

  public static LicensedPlaywrightBrowser launchPlaywright(
      Playwright playwright, Path authorizationFile, SlyBrowserOptions options) {
    return LicensedBrowser.launchLatestPlaywright(
        playwright, authorizationFile, licensedSettings(options), playwrightSettings(options));
  }

  public static LicensedPlaywrightContext launchPlaywrightPersistent(
      Playwright playwright,
      Path userDataDirectory,
      Path authorizationFile,
      SlyBrowserOptions options) {
    PlaywrightPersistentLaunchSettings framework = new PlaywrightPersistentLaunchSettings();
    applyFrameworkOptions(options, framework);
    return LicensedBrowser.launchLatestPlaywrightPersistent(
        playwright, userDataDirectory, authorizationFile, licensedSettings(options), framework);
  }

  private static LicensedLaunchSettings licensedSettings(SlyBrowserOptions supplied) {
    SlyBrowserOptions options = supplied == null ? new SlyBrowserOptions() : supplied;
    validate(options);
    LicensedLaunchSettings settings = new LicensedLaunchSettings();
    settings.updateKernel = options.launch.updateKernel;
    settings.webdriver.profile = options.profile;
    settings.webdriver.headless = options.launch.headless;
    settings.webdriver.profileMode = options.launch.profileMode;
    settings.webdriver.profileDir = options.launch.profileDirectory;
    settings.webdriver.humanize = options.humanize.enabled;
    settings.webdriver.humanPreset = options.humanize.preset;
    settings.webdriver.humanSeed = options.humanize.seed;
    settings.webdriver.humanConfig = options.humanize.config;
    return settings;
  }

  private static PlaywrightLaunchSettings playwrightSettings(SlyBrowserOptions supplied) {
    SlyBrowserOptions options = supplied == null ? new SlyBrowserOptions() : supplied;
    validate(options);
    PlaywrightLaunchSettings settings = new PlaywrightLaunchSettings();
    settings.profile = options.profile;
    settings.humanize = options.humanize.enabled;
    settings.humanPreset = options.humanize.preset;
    settings.humanSeed = options.humanize.seed;
    settings.humanConfig = options.humanize.config;
    settings.configure = launchOptions -> launchOptions.setHeadless(options.launch.headless);
    return settings;
  }

  private static void applyFrameworkOptions(
      SlyBrowserOptions supplied, PlaywrightPersistentLaunchSettings settings) {
    SlyBrowserOptions options = supplied == null ? new SlyBrowserOptions() : supplied;
    validate(options);
    settings.profile = options.profile;
    settings.humanize = options.humanize.enabled;
    settings.humanPreset = options.humanize.preset;
    settings.humanSeed = options.humanize.seed;
    settings.humanConfig = options.humanize.config;
    settings.configure = launchOptions -> launchOptions.setHeadless(options.launch.headless);
  }

  private static void validate(SlyBrowserOptions options) {
    if (options.profile == null || options.launch == null || options.humanize == null) {
      throw new ConfigurationException("profile, launch and humanize must be objects", "launch_options_invalid");
    }
    if (!"ephemeral".equals(options.launch.profileMode)
        && !"persistent".equals(options.launch.profileMode)) {
      throw new ConfigurationException(
          "launch.profileMode must be ephemeral or persistent", "launch_options_invalid");
    }
    if (!"default".equals(options.humanize.preset)
        && !"careful".equals(options.humanize.preset)) {
      throw new ConfigurationException(
          "humanize.preset must be default or careful", "humanize_preset_invalid");
    }
  }

  static SlyWebDriverSession launch(
      Path browserExecutable, Path driverExecutable, String licenseEnvelope) {
    return SlyBrowserWebDriver.launch(browserExecutable, driverExecutable, licenseEnvelope);
  }

  static SlyWebDriverSession launch(
      Path browserExecutable,
      Path driverExecutable,
      String licenseEnvelope,
      WebDriverLaunchSettings settings) {
    return SlyBrowserWebDriver.launch(browserExecutable, driverExecutable, licenseEnvelope, settings);
  }

  static AuthorizedInstallation prepareLatestAuthorizedBrowser(
      Path authorizationFile, LicensedLaunchSettings settings) {
    return LicensedBrowser.prepareLatestAuthorizedBrowser(authorizationFile, settings);
  }

  static AuthorizedInstallation prepareAuthorizedBrowser(
      Path authorizationFile, LicensedLaunchSettings settings) {
    return LicensedBrowser.prepareAuthorizedBrowser(authorizationFile, settings);
  }

  static BrowserInstallation installLatest(
      Path authorizationFile, LicensedLaunchSettings settings) {
    return LicensedBrowser.installLatest(authorizationFile, settings);
  }

  static BrowserInstallation installAuthorized(
      Path authorizationFile, LicensedLaunchSettings settings) {
    return LicensedBrowser.installAuthorized(authorizationFile, settings);
  }

  static SlyWebDriverSession launchLatest(
      Path authorizationFile, LicensedLaunchSettings settings) {
    return LicensedBrowser.launchLatest(authorizationFile, settings);
  }

  static SlyWebDriverSession launchAuthorized(
      Path authorizationFile, LicensedLaunchSettings settings) {
    return LicensedBrowser.launchAuthorized(authorizationFile, settings);
  }

  static LicensedPlaywrightBrowser launchLatestPlaywright(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchLatestPlaywright(playwright, authorizationFile, settings, playwrightSettings);
  }

  static LicensedPlaywrightBrowser launchAuthorizedPlaywright(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchAuthorizedPlaywright(playwright, authorizationFile, settings, playwrightSettings);
  }

  static LicensedPlaywrightContext launchLatestPlaywrightPersistent(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchLatestPlaywrightPersistent(
        playwright, userDataDir, authorizationFile, settings, playwrightSettings);
  }

  static LicensedPlaywrightContext launchAuthorizedPlaywrightPersistent(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchAuthorizedPlaywrightPersistent(
        playwright, userDataDir, authorizationFile, settings, playwrightSettings);
  }
}
