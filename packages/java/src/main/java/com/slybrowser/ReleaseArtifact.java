package com.slybrowser;

import java.util.List;

public final class ReleaseArtifact {
  public final String platform;
  public final String arch;
  public final String url;
  public final String sha256;
  public final long size;
  public final String archiveFormat;
  public final String browserExecutable;
  public final String driverExecutable;
  public final String browserSha256;
  public final String driverSha256;
  public final List<ReleasePrivateModule> privateModules;
  public final List<ReleaseResourceFile> resources;
  public final ReleaseCodeSignature codeSignature;

  ReleaseArtifact(
      String platform,
      String arch,
      String url,
      String sha256,
      long size,
      String archiveFormat,
      String browserExecutable,
      String driverExecutable,
      String browserSha256,
      String driverSha256,
      List<ReleasePrivateModule> privateModules,
      List<ReleaseResourceFile> resources,
      ReleaseCodeSignature codeSignature) {
    this.platform = platform;
    this.arch = arch;
    this.url = url;
    this.sha256 = sha256;
    this.size = size;
    this.archiveFormat = archiveFormat;
    this.browserExecutable = browserExecutable;
    this.driverExecutable = driverExecutable;
    this.browserSha256 = browserSha256;
    this.driverSha256 = driverSha256;
    this.privateModules = List.copyOf(privateModules);
    this.resources = List.copyOf(resources);
    this.codeSignature = codeSignature;
  }
}

final class ReleasePrivateModule {
  public final String path;
  public final String sha256;
  public final long size;
  public final String abi;

  ReleasePrivateModule(String path, String sha256, long size, String abi) {
    this.path = path;
    this.sha256 = sha256;
    this.size = size;
    this.abi = abi;
  }
}

final class ReleaseResourceFile {
  public final String path;
  public final String sha256;
  public final long size;

  ReleaseResourceFile(String path, String sha256, long size) {
    this.path = path;
    this.sha256 = sha256;
    this.size = size;
  }
}

final class ReleaseCodeSignature {
  public final String scheme;
  public final String subject;
  public final String certificateSha256;
  public final boolean timestampRequired;

  ReleaseCodeSignature(String scheme, String subject, String certificateSha256, boolean timestampRequired) {
    this.scheme = scheme;
    this.subject = subject;
    this.certificateSha256 = certificateSha256;
    this.timestampRequired = timestampRequired;
  }
}
