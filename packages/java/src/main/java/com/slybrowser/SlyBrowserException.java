package com.slybrowser;

public class SlyBrowserException extends RuntimeException {
  private final String code;

  public SlyBrowserException(String message, String code) {
    super(message);
    this.code = code;
  }

  public SlyBrowserException(String message, String code, Throwable cause) {
    super(message, cause);
    this.code = code;
  }

  public String getCode() {
    return code;
  }
}
