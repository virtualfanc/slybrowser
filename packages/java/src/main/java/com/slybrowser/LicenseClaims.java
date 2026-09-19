package com.slybrowser;

import java.util.List;

public final class LicenseClaims {
  public final int schemaVersion;
  public final String licenseId;
  public final String audience;
  public final long issuedAt;
  public final long notBefore;
  public final long expiresAt;
  public final String browserVersion;
  public final String browserMin;
  public final String browserMax;
  public final String planId;
  public final Integer concurrencyLimit;
  public final Long paidThrough;
  public final String licenseStatus;
  public final String artifactSha256;
  public final String browserSha256;
  public final String driverSha256;
  public final Long leaseGeneration;
  public final List<String> features;
  public final String sessionId;
  public final String nonce;
  public final String deviceHash;

  LicenseClaims(
      int schemaVersion,
      String licenseId,
      String audience,
      long issuedAt,
      long notBefore,
      long expiresAt,
      String browserVersion,
      String browserMin,
      String browserMax,
      String planId,
      Integer concurrencyLimit,
      Long paidThrough,
      String licenseStatus,
      String artifactSha256,
      String browserSha256,
      String driverSha256,
      Long leaseGeneration,
      List<String> features,
      String sessionId,
      String nonce,
      String deviceHash) {
    this.schemaVersion = schemaVersion;
    this.licenseId = licenseId;
    this.audience = audience;
    this.issuedAt = issuedAt;
    this.notBefore = notBefore;
    this.expiresAt = expiresAt;
    this.browserVersion = browserVersion;
    this.browserMin = browserMin;
    this.browserMax = browserMax;
    this.planId = planId;
    this.concurrencyLimit = concurrencyLimit;
    this.paidThrough = paidThrough;
    this.licenseStatus = licenseStatus;
    this.artifactSha256 = artifactSha256;
    this.browserSha256 = browserSha256;
    this.driverSha256 = driverSha256;
    this.leaseGeneration = leaseGeneration;
    this.features = List.copyOf(features);
    this.sessionId = sessionId;
    this.nonce = nonce;
    this.deviceHash = deviceHash;
  }
}
