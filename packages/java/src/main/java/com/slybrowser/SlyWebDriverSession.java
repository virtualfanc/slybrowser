package com.slybrowser;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeDriverService;

public final class SlyWebDriverSession implements AutoCloseable {
  private final ChromeDriver driver;
  private final ChromeDriverService service;
  private final LaunchPlan launchPlan;
  private final Path driverLicenseFile;
  private final Path driverRuntimeFile;
  private final String browserVersion;
  private final String driverVersion;
  private final List<Runnable> closeCallbacks = new ArrayList<>();
  LicenseRuntimeMetadata licenseRuntime;
  private boolean closed;

  SlyWebDriverSession(
      ChromeDriver driver,
      ChromeDriverService service,
      LaunchPlan launchPlan,
      Path driverLicenseFile,
      Path driverRuntimeFile,
      String browserVersion,
      String driverVersion) {
    this.driver = driver;
    this.service = service;
    this.launchPlan = launchPlan;
    this.driverLicenseFile = driverLicenseFile;
    this.driverRuntimeFile = driverRuntimeFile;
    this.browserVersion = browserVersion;
    this.driverVersion = driverVersion;
  }

  public ChromeDriver getDriver() { return driver; }
  public String getBrowserVersion() { return browserVersion; }
  public String getDriverVersion() { return driverVersion; }
  public LicenseRuntimeMetadata getLicenseRuntime() { return licenseRuntime; }
  void addCloseCallback(Runnable callback) { closeCallbacks.add(callback); }

  @Override
  public void close() {
    if (closed) return;
    closed = true;
    try { driver.quit(); }
    finally {
      try { service.close(); }
      finally {
        launchPlan.close();
        if (driverRuntimeFile != null) {
          try { Files.deleteIfExists(driverRuntimeFile); }
          catch (IOException ignored) { /* consumed one-time handoff or next cleanup pass */ }
        }
        try { Files.deleteIfExists(driverLicenseFile); }
        catch (IOException ignored) { /* consumed one-time handoff or next cleanup pass */ }
        for (Runnable callback : closeCallbacks) {
          try { callback.run(); }
          catch (RuntimeException ignored) { /* release is best effort on close */ }
        }
      }
    }
  }
}
