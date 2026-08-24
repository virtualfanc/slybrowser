package com.slybrowser;

import java.nio.file.Path;
import java.util.Map;

public final class LicenseServiceClientOptions {
  public Map<String, byte[]> licenseTrustedKeys = Map.of();
  public Map<String, byte[]> releaseTrustedKeys = Map.of();
  public Map<String, byte[]> licenseFileTrustedKeys = Map.of();
  public String licenseFilePassphrase;
  public java.util.Set<String> trustedServiceUrls = java.util.Set.of("https://api.slybrowser.com");
  public JsonTransport transport;
  public ArtifactDownloader artifactDownloader;
  public boolean allowInsecureLocalhost;
  public String sdkVersion = "0.1.0";

  @FunctionalInterface
  public interface JsonTransport {
    TransportResponse send(String method, String url, Map<String, String> headers, byte[] body);
  }

  @FunctionalInterface
  public interface ArtifactDownloader {
    void download(String url, Map<String, String> headers, Path destination);
  }

  public static final class TransportResponse {
    public final int status;
    public final byte[] body;

    public TransportResponse(int status, byte[] body) {
      this.status = status;
      this.body = body;
    }
  }
}
