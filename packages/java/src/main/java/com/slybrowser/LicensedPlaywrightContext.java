package com.slybrowser;

import com.microsoft.playwright.BrowserContext;

public final class LicensedPlaywrightContext implements AutoCloseable {
  private final BrowserContext context;
  private final Runnable release;
  private boolean closed;
  public final LicenseRuntimeMetadata licenseRuntime;

  LicensedPlaywrightContext(BrowserContext context, LicenseRuntimeMetadata licenseRuntime, Runnable release) {
    this.context = context;
    this.licenseRuntime = licenseRuntime;
    this.release = release;
  }

  public BrowserContext context() {
    return context;
  }

  @Override
  public void close() {
    RuntimeException failure = null;
    try {
      context.close();
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
