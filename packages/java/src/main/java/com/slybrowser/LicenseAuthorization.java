package com.slybrowser;

public final class LicenseAuthorization {
  public final String serviceUrl;
  public final String licenseKey;
  public final String channel;

  public LicenseAuthorization(String serviceUrl, String licenseKey) {
    this(serviceUrl, licenseKey, "stable");
  }

  public LicenseAuthorization(String serviceUrl, String licenseKey, String channel) {
    this.serviceUrl = serviceUrl;
    this.licenseKey = licenseKey;
    this.channel = channel;
  }
}
