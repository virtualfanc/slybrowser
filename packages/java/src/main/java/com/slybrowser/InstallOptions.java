package com.slybrowser;

import java.nio.file.Path;

public final class InstallOptions {
  public Path cacheRoot;
  public long lockTimeoutMs = 60_000;
  public Extractor extractor;

  @FunctionalInterface
  public interface Extractor {
    void extract(Path archive, Path destination);
  }
}
