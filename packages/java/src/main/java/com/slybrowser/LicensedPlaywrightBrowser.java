package com.slybrowser;

import com.microsoft.playwright.Browser;

public final class LicensedPlaywrightBrowser implements AutoCloseable {
  private final Browser browser;
  private final Runnable release;
  private boolean closed;
  public final LicenseRuntimeMetadata licenseRuntime;

  LicensedPlaywrightBrowser(Browser browser, LicenseRuntimeMetadata licenseRuntime, Runnable release) {
    this.browser = browser;
    this.licenseRuntime = licenseRuntime;
    this.release = release;
  }

  public Browser browser() {
    return browser;
  }

  @Override
  public void close() {
    RuntimeException failure = null;
    try {
      browser.close();
    } catch (RuntimeException error) {
      failure = error;
    } finally {
      if (!closed) {
        closed = true;
        try {
          release.run();
        } catch (RuntimeException error) {
          if (failure == null) failure = error;
          else failure.addSuppressed(error);
        }
      }
    }
    if (failure != null) throw failure;
  }
}
