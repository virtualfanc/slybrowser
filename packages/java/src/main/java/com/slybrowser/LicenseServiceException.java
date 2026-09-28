package com.slybrowser;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

public final class LicenseServiceException extends SlyBrowserException {
  private final int status;
  private final Map<String, Object> details;

  public LicenseServiceException(String message, String code, int status) {
    this(message, code, status, Map.of(), null);
  }

  public LicenseServiceException(String message, String code, int status, Throwable cause) {
    this(message, code, status, Map.of(), cause);
  }

  public LicenseServiceException(String message, String code, int status, Map<String, Object> details) {
    this(message, code, status, details, null);
  }

  public LicenseServiceException(String message, String code, int status, Map<String, Object> details, Throwable cause) {
    super(message, code, cause);
    this.status = status;
    this.details = Collections.unmodifiableMap(new LinkedHashMap<>(details));
  }

  public int getStatus() {
    return status;
  }

  public Map<String, Object> getDetails() {
    return details;
  }
}
