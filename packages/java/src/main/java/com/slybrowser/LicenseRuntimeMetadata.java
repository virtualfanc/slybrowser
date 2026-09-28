package com.slybrowser;

public final class LicenseRuntimeMetadata {
  public final String sessionId;
  public final String plan;
  public final int concurrencyLimit;
  public final String browserVersion;
  public final String versionPolicy;
  public final String selectionReason;
  public final BrowserVersionAudit versionAudit;

  public LicenseRuntimeMetadata(
      String sessionId,
      String plan,
      int concurrencyLimit,
      String browserVersion,
      String versionPolicy,
      String selectionReason,
      BrowserVersionAudit versionAudit) {
    this.sessionId = sessionId;
    this.plan = plan;
    this.concurrencyLimit = concurrencyLimit;
    this.browserVersion = browserVersion;
    this.versionPolicy = versionPolicy;
    this.selectionReason = selectionReason;
    this.versionAudit = versionAudit;
  }
}
