package com.slybrowser;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class LicenseInfo {
  public final int schemaVersion;
  public final String channel;
  public final String licenseStatus;
  public final String plan;
  public final String effectivePlan;
  public final Long paidThrough;
  public final List<String> features;
  public final int concurrencyLimit;
  public final int activeSessions;
  public final int availableSessions;
  public final Map<String, Integer> sessionState;
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
  public final String stableErrorCode;

  LicenseInfo(
      int schemaVersion,
      String channel,
      String licenseStatus,
      String plan,
      String effectivePlan,
      Long paidThrough,
      List<String> features,
      int concurrencyLimit,
      int activeSessions,
      int availableSessions,
      Map<String, Integer> sessionState,
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
      String stableErrorCode) {
    this.schemaVersion = schemaVersion;
    this.channel = channel;
    this.licenseStatus = licenseStatus;
    this.plan = plan;
    this.effectivePlan = effectivePlan;
    this.paidThrough = paidThrough;
    this.features = List.copyOf(features);
    this.concurrencyLimit = concurrencyLimit;
    this.activeSessions = activeSessions;
    this.availableSessions = availableSessions;
    this.sessionState = Collections.unmodifiableMap(new LinkedHashMap<>(sessionState));
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
    this.stableErrorCode = stableErrorCode;
  }
}
