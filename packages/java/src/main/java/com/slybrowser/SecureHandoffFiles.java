package com.slybrowser;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

final class SecureHandoffFiles {
  private SecureHandoffFiles() {}

  static void restrictWindowsAcl(Path path) throws IOException {
    if (!System.getProperty("os.name", "").startsWith("Windows")) return;
    Process identityProcess = new ProcessBuilder("whoami").redirectErrorStream(true).start();
    byte[] identityOutput = identityProcess.getInputStream().readAllBytes();
    try {
      if (identityProcess.waitFor() != 0) {
        throw new IOException("Unable to determine current Windows identity");
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("Interrupted while determining current Windows identity", error);
    }
    String identity = new String(identityOutput, StandardCharsets.UTF_8).trim();
    if (identity.isEmpty()) throw new IOException("Current Windows identity is empty");

    Process aclProcess = new ProcessBuilder(
        "icacls",
        path.toString(),
        "/inheritance:r",
        "/grant:r",
        identity + ":(F)")
        .redirectErrorStream(true)
        .start();
    try {
      if (aclProcess.waitFor() != 0) {
        String output = new String(aclProcess.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        throw new IOException("Unable to restrict private handoff ACL: " + output.trim());
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IOException("Interrupted while restricting private handoff ACL", error);
    }
  }
}
