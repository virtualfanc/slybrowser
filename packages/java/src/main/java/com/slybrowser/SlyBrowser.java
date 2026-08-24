package com.slybrowser;

import com.microsoft.playwright.Playwright;
import java.nio.file.Path;

/** Default Java entry point. Explicit framework backends use SlyBrowserPlaywright. */
public final class SlyBrowser {
  private SlyBrowser() {}

  public static SlyWebDriverSession launch(
      Path browserExecutable,
      Path driverExecutable,
      String licenseEnvelope) {
    return SlyBrowserWebDriver.launch(browserExecutable, driverExecutable, licenseEnvelope);
  }

  public static SlyWebDriverSession launch(
      Path browserExecutable,
      Path driverExecutable,
      String licenseEnvelope,
      WebDriverLaunchSettings settings) {
    return SlyBrowserWebDriver.launch(browserExecutable, driverExecutable, licenseEnvelope, settings);
  }

  public static AuthorizedInstallation prepareLatestAuthorizedBrowser(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return LicensedBrowser.prepareLatestAuthorizedBrowser(authorizationFile, settings);
  }

  public static AuthorizedInstallation prepareAuthorizedBrowser(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return LicensedBrowser.prepareAuthorizedBrowser(authorizationFile, settings);
  }

  public static BrowserInstallation installLatest(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return LicensedBrowser.installLatest(authorizationFile, settings);
  }

  public static BrowserInstallation installAuthorized(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return LicensedBrowser.installAuthorized(authorizationFile, settings);
  }

  public static SlyWebDriverSession launchLatest(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return LicensedBrowser.launchLatest(authorizationFile, settings);
  }

  public static SlyWebDriverSession launchAuthorized(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return LicensedBrowser.launchAuthorized(authorizationFile, settings);
  }

  public static LicensedPlaywrightBrowser launchLatestPlaywright(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchLatestPlaywright(playwright, authorizationFile, settings, playwrightSettings);
  }

  public static LicensedPlaywrightBrowser launchAuthorizedPlaywright(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchAuthorizedPlaywright(playwright, authorizationFile, settings, playwrightSettings);
  }

  public static LicensedPlaywrightContext launchLatestPlaywrightPersistent(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchLatestPlaywrightPersistent(
        playwright,
        userDataDir,
        authorizationFile,
        settings,
        playwrightSettings);
  }

  public static LicensedPlaywrightContext launchAuthorizedPlaywrightPersistent(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings playwrightSettings) {
    return LicensedBrowser.launchAuthorizedPlaywrightPersistent(
        playwright,
        userDataDir,
        authorizationFile,
        settings,
        playwrightSettings);
  }
}
