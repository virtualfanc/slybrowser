package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

final class BrowserInstallerTest {
  @Test
  void sevenZipPreflightRejectsUnsafeAndOversizedEntries() {
    String listing = String.join("\n",
        "7-Zip listing",
        "----------",
        "Path = SlyBrowser",
        "Size = 8",
        "Attributes = A",
        "",
        "Path = ../outside",
        "Size = 1",
        "Attributes = A",
        "");

    ArtifactException unsafe = assertThrows(
        ArtifactException.class, () -> BrowserInstaller.inspect7zListing(listing, 8));
    assertEquals("artifact_layout_invalid", unsafe.getCode());

    ArtifactException oversized = assertThrows(
        ArtifactException.class,
        () -> BrowserInstaller.inspect7zListing(listing.replace("../outside", "chromedriver"), 8));
    assertEquals("artifact_expanded_too_large", oversized.getCode());
  }
}
