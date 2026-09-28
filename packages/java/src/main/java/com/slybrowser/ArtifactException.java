package com.slybrowser;

public final class ArtifactException extends SlyBrowserException {
  public ArtifactException(String message, String code) {
    super(message, code);
  }

  public ArtifactException(String message, String code, Throwable cause) {
    super(message, code, cause);
  }
}
