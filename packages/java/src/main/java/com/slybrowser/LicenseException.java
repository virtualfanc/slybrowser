package com.slybrowser;

public final class LicenseException extends SlyBrowserException {
  public LicenseException(String message, String code) {
    super(message, code);
  }

  public LicenseException(String message, String code, Throwable cause) {
    super(message, code, cause);
  }
}
