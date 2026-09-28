package com.slybrowser;

public final class AuthorizedInstallation implements AutoCloseable {
  public final LicenseServiceClient client;
  public final RuntimeSessionGrant grant;
  public final BrowserInstallation installation;
  private boolean released;

  AuthorizedInstallation(
      LicenseServiceClient client,
      RuntimeSessionGrant grant,
      BrowserInstallation installation) {
    this.client = client;
    this.grant = grant;
    this.installation = installation;
  }

  public void release() {
    if (released) return;
    released = true;
    client.releaseRuntimeSession(grant);
  }

  @Override
  public void close() {
    release();
  }
}
