package com.slybrowser;

import java.util.List;
import java.util.Map;

public final class RuntimeSessionGrant extends RuntimeHeartbeatGrant {
  public final String bootstrapToken;
  public final String activationTicket;
  public final String driverActivationTicket;
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
  public final ReleaseManifest manifest;
  public final ReleaseArtifact artifact;
  public final String platform;
  public final String arch;
  public final AutomationBackend automationBackend;
  public final RuntimeDownloadTicket downloadTicket;

  public RuntimeSessionGrant(
      int schemaVersion,
      String state,
      String startupId,
      String sessionId,
      String bootstrapToken,
      String activationTicket,
      String driverActivationTicket,
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
      String arch,
      AutomationBackend automationBackend,
      RuntimeDownloadTicket downloadTicket) {
    super(
        schemaVersion,
        state,
        startupId,
        sessionId,
        heartbeatAfterSeconds,
        expiresAt,
        plan,
        features,
        concurrencyLimit,
        activeSessions,
        browserVersion,
        automationBackend,
        leaseEnvelope,
        claims);
    this.bootstrapToken = bootstrapToken;
    this.activationTicket = activationTicket;
    this.driverActivationTicket = driverActivationTicket;
    this.requestedBrowserVersion = requestedBrowserVersion;
    this.requestedKernelMajor = requestedKernelMajor;
    this.versionPolicy = versionPolicy;
    this.selectionReason = selectionReason;
    this.selectionMode = selectionMode;
    this.availableBrowserVersions = List.copyOf(availableBrowserVersions);
    this.latestAvailableVersion = latestAvailableVersion;
    this.updateAvailable = updateAvailable;
    this.updateRequired = updateRequired;
    this.updateRights = Map.copyOf(updateRights);
    this.manifest = manifest;
    this.artifact = artifact;
    this.platform = platform;
    this.arch = arch;
    this.automationBackend = automationBackend;
    this.downloadTicket = downloadTicket;
  }
}
