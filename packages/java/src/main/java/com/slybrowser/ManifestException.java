package com.slybrowser;

public final class ManifestException extends SlyBrowserException {
  public ManifestException(String message, String code) {
    super(message, code);
  }

  public ManifestException(String message, String code, Throwable cause) {
    super(message, code, cause);
  }
}
