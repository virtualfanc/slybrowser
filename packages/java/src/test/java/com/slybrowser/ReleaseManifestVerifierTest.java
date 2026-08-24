package com.slybrowser;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

final class ReleaseManifestVerifierTest {
  @Test
  void supportsCaretSdkCompatibilityRanges() {
    assertTrue(ReleaseManifestVerifier.isSdkCompatible("^0.1.0", "0.1.0"));
    assertTrue(ReleaseManifestVerifier.isSdkCompatible("^0.1.0", "0.1.9"));
    assertFalse(ReleaseManifestVerifier.isSdkCompatible("^0.1.0", "0.2.0"));
    assertTrue(ReleaseManifestVerifier.isSdkCompatible("^1.2.3", "1.9.0"));
    assertFalse(ReleaseManifestVerifier.isSdkCompatible("^1.2.3", "2.0.0"));
  }
}
