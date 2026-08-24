package com.slybrowser;

public final class ConfigurationException extends SlyBrowserException {
  public ConfigurationException(String message, String code) {
    super(message, code);
  }

  public ConfigurationException(String message, String code, Throwable cause) {
    super(message, code, cause);
  }
}
