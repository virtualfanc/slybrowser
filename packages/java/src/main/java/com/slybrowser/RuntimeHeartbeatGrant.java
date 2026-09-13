package com.slybrowser;

import java.util.List;

public class RuntimeHeartbeatGrant {
  public final int schemaVersion;
  public final String state;
  public final String startupId;
  public final String sessionId;
  public final int heartbeatAfterSeconds;
  public long expiresAt;
  public final String plan;
  public final List<String> features;
  public final int concurrencyLimit;
  public final int activeSessions;
  public final String browserVersion;
  public final AutomationBackend automationBackend;
  public String leaseEnvelope;
  public LicenseClaims claims;

  public RuntimeHeartbeatGrant(
      int schemaVersion,
      String state,
      String startupId,
      String sessionId,
      int heartbeatAfterSeconds,
      long expiresAt,
      String plan,
      List<String> features,
      int concurrencyLimit,
      int activeSessions,
      String browserVersion,
      AutomationBackend automationBackend,
      String leaseEnvelope,
      LicenseClaims claims) {
    this.schemaVersion = schemaVersion;
    this.state = state;
    this.startupId = startupId;
    this.sessionId = sessionId;
    this.heartbeatAfterSeconds = heartbeatAfterSeconds;
    this.expiresAt = expiresAt;
    this.plan = plan;
    this.features = List.copyOf(features);
    this.concurrencyLimit = concurrencyLimit;
    this.activeSessions = activeSessions;
    this.browserVersion = browserVersion;
    this.automationBackend = automationBackend;
    this.leaseEnvelope = leaseEnvelope;
    this.claims = claims;
  }
}
