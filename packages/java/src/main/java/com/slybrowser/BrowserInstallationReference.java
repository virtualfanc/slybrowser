package com.slybrowser;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public final class BrowserInstallationReference implements AutoCloseable {
  public final BrowserInstallation installation;
  public final Path referenceFile;
  private boolean released;

  BrowserInstallationReference(BrowserInstallation installation, Path referenceFile) {
    this.installation = installation;
    this.referenceFile = referenceFile;
  }

  public synchronized void release() {
    if (released) return;
    released = true;
    try {
      Files.deleteIfExists(referenceFile);
    } catch (IOException error) {
      throw new ArtifactException("Unable to release browser installation reference", "artifact_cache_failed", error);
    }
  }

  @Override
  public void close() {
    release();
  }
}
