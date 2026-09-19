package com.slybrowser;

import java.util.Base64;
import java.util.Map;

final class OfficialTrust {
  static final Map<String, byte[]> LICENSE_LEASE_KEYS = Map.of(
      "launch-candidate-20260824", decode("h9ie2nXxsXVKlxjFIz-or1otChHTF8HS94vV_EjY1KM"));
  static final Map<String, byte[]> RELEASE_MANIFEST_KEYS = Map.of(
      "release-launch-candidate-20260824", decode("SvSlPQKT9oZ4nIVuJXgd2pFOC0QblDph29vKlz6NJZo"));
  static final Map<String, byte[]> LICENSE_FILE_KEYS = Map.of(
      "license-file-private-preview-v1", decode("wc3DR5wOqazjZF_3n41EF1cMh5d-qGv2wkZHyd0Sj6s"));

  private OfficialTrust() {}

  static LicenseServiceClientOptions create() {
    LicenseServiceClientOptions options = new LicenseServiceClientOptions();
    options.licenseTrustedKeys = LICENSE_LEASE_KEYS;
    options.releaseTrustedKeys = RELEASE_MANIFEST_KEYS;
    options.licenseFileTrustedKeys = LICENSE_FILE_KEYS;
    return options;
  }

  private static byte[] decode(String value) {
    return Base64.getUrlDecoder().decode(value);
  }
}
