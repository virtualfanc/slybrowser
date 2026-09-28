package com.slybrowser;

import java.nio.file.Path;
import java.util.Objects;

public final class BrowserInstallation {
  public final String version;
  public final String platform;
  public final String arch;
  public final Path root;
  public final Path browserExecutable;
  public final Path driverExecutable;
  public final String artifactSha256;

  BrowserInstallation(
      String version,
      String platform,
      String arch,
      Path root,
      Path browserExecutable,
      Path driverExecutable,
      String artifactSha256) {
    this.version = version;
    this.platform = platform;
    this.arch = arch;
    this.root = root;
    this.browserExecutable = browserExecutable;
    this.driverExecutable = driverExecutable;
    this.artifactSha256 = artifactSha256;
  }

  @Override
  public boolean equals(Object other) {
    if (!(other instanceof BrowserInstallation)) return false;
    BrowserInstallation value = (BrowserInstallation) other;
    return Objects.equals(version, value.version) &&
        Objects.equals(platform, value.platform) &&
        Objects.equals(arch, value.arch) &&
        Objects.equals(root, value.root) &&
        Objects.equals(browserExecutable, value.browserExecutable) &&
        Objects.equals(driverExecutable, value.driverExecutable) &&
        Objects.equals(artifactSha256, value.artifactSha256);
  }

  @Override
  public int hashCode() {
    return Objects.hash(version, platform, arch, root, browserExecutable, driverExecutable, artifactSha256);
  }
}
