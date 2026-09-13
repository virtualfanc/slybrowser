package com.slybrowser;

public final class RuntimeDownloadTicket {
  public final String token;
  public final long expiresAt;
  public final String artifactSha256;
  public final String artifactUrl;

  public RuntimeDownloadTicket(String token, long expiresAt, String artifactSha256, String artifactUrl) {
    this.token = token;
    this.expiresAt = expiresAt;
    this.artifactSha256 = artifactSha256;
    this.artifactUrl = artifactUrl;
  }
}
