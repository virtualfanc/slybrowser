package com.slybrowser;

import java.nio.file.Path;
import java.util.List;

public final class BrowserPruneResult {
  public final List<Path> removed;
  public final List<Path> skippedInUse;
  public final List<Path> kept;

  BrowserPruneResult(List<Path> removed, List<Path> skippedInUse, List<Path> kept) {
    this.removed = List.copyOf(removed);
    this.skippedInUse = List.copyOf(skippedInUse);
    this.kept = List.copyOf(kept);
  }
}
