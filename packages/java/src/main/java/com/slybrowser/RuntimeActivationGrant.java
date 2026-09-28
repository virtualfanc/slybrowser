package com.slybrowser;

public final class RuntimeActivationGrant extends RuntimeHeartbeatGrant {
  public final String runtimeToken;

  public RuntimeActivationGrant(RuntimeHeartbeatGrant heartbeat, String runtimeToken) {
    super(
        heartbeat.schemaVersion,
        heartbeat.state,
        heartbeat.startupId,
        heartbeat.sessionId,
        heartbeat.heartbeatAfterSeconds,
        heartbeat.expiresAt,
        heartbeat.plan,
        heartbeat.features,
        heartbeat.concurrencyLimit,
        heartbeat.activeSessions,
        heartbeat.browserVersion,
        heartbeat.automationBackend,
        heartbeat.leaseEnvelope,
        heartbeat.claims);
    this.runtimeToken = runtimeToken;
  }
}
