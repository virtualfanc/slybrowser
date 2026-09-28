package com.slybrowser;

import java.util.Map;
import java.util.Set;

public final class LicenseFileReadOptions {
  public boolean allowInsecureLocalhost;
  public Map<String, byte[]> licenseFileTrustedKeys = Map.of();
  public Set<String> trustedServiceUrls = Set.of("https://api.slybrowser.com");
  public LicenseServiceClientOptions.JsonTransport transport;

  public LicenseFileReadOptions() {}

  public LicenseFileReadOptions(boolean allowInsecureLocalhost) {
    this.allowInsecureLocalhost = allowInsecureLocalhost;
  }
}
