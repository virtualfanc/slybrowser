package com.slybrowser;

import java.util.List;
import java.util.stream.Collectors;

public final class ReleaseManifest {
  public final String browserVersion;
  public final String sdkCompatibility;
  public final String status;
  public final List<ReleaseArtifact> artifacts;
  public final String signingKeyId;

  ReleaseManifest(String browserVersion, String sdkCompatibility, String status, List<ReleaseArtifact> artifacts, String signingKeyId) {
    this.browserVersion = browserVersion;
    this.sdkCompatibility = sdkCompatibility;
    this.status = status;
    this.artifacts = List.copyOf(artifacts);
    this.signingKeyId = signingKeyId;
  }

  public ReleaseArtifact select(String platform, String arch) {
    List<ReleaseArtifact> matches = artifacts.stream()
        .filter(item -> item.platform.equals(platform) && item.arch.equals(arch))
        .collect(Collectors.toList());
    if (matches.size() != 1) {
      String available = artifacts.stream()
          .map(item -> item.platform + "/" + item.arch)
          .sorted()
          .collect(Collectors.joining(", "));
      throw new ManifestException(
          "No signed artifact supports " + platform + "/" + arch + "; available targets: " + available,
          "artifact_not_found");
    }
    return matches.get(0);
  }
}
