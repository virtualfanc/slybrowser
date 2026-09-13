package com.slybrowser;

import java.util.List;
import java.util.Map;
import java.util.Collections;
import java.util.LinkedHashMap;

public final class LicensedSessionGrant {
  public final String sessionId;
  public final String sessionToken;
  public final int heartbeatAfterSeconds;
  public long expiresAt;
  public final String plan;
  public final List<String> features;
  public final int concurrencyLimit;
  public final int activeSessions;
  public final String browserVersion;
  public final String requestedBrowserVersion;
  public final Object requestedKernelMajor;
  public final String versionPolicy;
  public final String selectionReason;
  public final String selectionMode;
  public final List<String> availableBrowserVersions;
  public final String latestAvailableVersion;
  public final Boolean updateAvailable;
  public final Boolean updateRequired;
  public final Map<String, Object> updateRights;
  public String leaseEnvelope;
  public LicenseClaims claims;
  public final ReleaseManifest manifest;
  public final ReleaseArtifact artifact;
  public final String platform;
  public final String arch;

  LicensedSessionGrant(
      String sessionId,
      String sessionToken,
      int heartbeatAfterSeconds,
      long expiresAt,
      String plan,
      List<String> features,
      int concurrencyLimit,
      int activeSessions,
      String browserVersion,
      String requestedBrowserVersion,
      Object requestedKernelMajor,
      String versionPolicy,
      String selectionReason,
      String selectionMode,
      List<String> availableBrowserVersions,
      String latestAvailableVersion,
      Boolean updateAvailable,
      Boolean updateRequired,
      Map<String, Object> updateRights,
      String leaseEnvelope,
      LicenseClaims claims,
      ReleaseManifest manifest,
      ReleaseArtifact artifact,
      String platform,
      String arch) {
    this.sessionId = sessionId;
    this.sessionToken = sessionToken;
    this.heartbeatAfterSeconds = heartbeatAfterSeconds;
    this.expiresAt = expiresAt;
    this.plan = plan;
    this.features = List.copyOf(features);
    this.concurrencyLimit = concurrencyLimit;
    this.activeSessions = activeSessions;
    this.browserVersion = browserVersion;
    this.requestedBrowserVersion = requestedBrowserVersion;
    this.requestedKernelMajor = requestedKernelMajor;
    this.versionPolicy = versionPolicy;
    this.selectionReason = selectionReason;
    this.selectionMode = selectionMode;
    this.availableBrowserVersions = List.copyOf(availableBrowserVersions);
    this.latestAvailableVersion = latestAvailableVersion;
    this.updateAvailable = updateAvailable;
    this.updateRequired = updateRequired;
    this.updateRights = Collections.unmodifiableMap(new LinkedHashMap<>(updateRights));
    this.leaseEnvelope = leaseEnvelope;
    this.claims = claims;
    this.manifest = manifest;
    this.artifact = artifact;
    this.platform = platform;
    this.arch = arch;
  }
}
