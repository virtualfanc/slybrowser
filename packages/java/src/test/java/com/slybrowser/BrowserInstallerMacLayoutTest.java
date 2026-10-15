package com.slybrowser;

import static org.junit.jupiter.api.Assertions.*;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

final class BrowserInstallerMacLayoutTest {
  private static final String BROWSER = "SlyBrowser/SlyBrowser.app/Contents/MacOS/SlyBrowser";
  private static final String DRIVER = "SlyBrowser/chromedriver";
  @TempDir Path temp;

  @Test
  void installsDiscoversAndRepairsExactMacBundle() throws Exception {
    Case fixture = fixture("macos", BROWSER, DRIVER, "browser");
    BrowserInstallation installed = BrowserInstaller.installGrantedBrowser(null, fixture.grant, fixture.options);
    assertEquals("browser", Files.readString(installed.browserExecutable));
    assertEquals(installed.root, BrowserInstaller.findCurrentBrowserInstallation(fixture.options, "macos", "arm64", "latest").root);
    assertEquals(installed.root, BrowserInstaller.installGrantedBrowser(null, fixture.grant, fixture.options).root);
    Files.writeString(installed.driverExecutable, "tampered");
    BrowserInstallation repaired = BrowserInstaller.installGrantedBrowser(null, fixture.grant, fixture.options);
    assertEquals("driver", Files.readString(repaired.driverExecutable));
  }

  @Test
  void rejectsOtherSeparatedLayouts() throws Exception {
    for (String[] values : List.of(
        new String[]{"linux", BROWSER, DRIVER},
        new String[]{"macos", "SlyBrowser/Other.app/Contents/MacOS/SlyBrowser", DRIVER},
        new String[]{"macos", BROWSER, "SlyBrowser/otherdriver"})) {
      Case fixture = fixture(values[0], values[1], values[2], "browser");
      ArtifactException error = assertThrows(ArtifactException.class,
          () -> BrowserInstaller.installGrantedBrowser(null, fixture.grant, fixture.options));
      assertEquals("artifact_layout_invalid", error.getCode());
    }
  }

  @Test
  void retainsSignedExecutableHashCheckForMacBundle() throws Exception {
    Case fixture = fixture("macos", BROWSER, DRIVER, "tampered");
    ArtifactException error = assertThrows(ArtifactException.class,
        () -> BrowserInstaller.installGrantedBrowser(null, fixture.grant, fixture.options));
    assertEquals("artifact_runtime_hash_mismatch", error.getCode());
  }

  private Case fixture(String platform, String browser, String driver, String browserBytes) throws Exception {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
      for (String[] entry : List.of(new String[]{browser, browserBytes}, new String[]{driver, "driver"})) {
        zip.putNextEntry(new ZipEntry(entry[0]));
        zip.write(entry[1].getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
      }
    }
    byte[] archive = bytes.toByteArray();
    ReleaseArtifact artifact = new ReleaseArtifact(platform, "arm64", "https://api.slybrowser.test/artifact.zip",
        sha(archive), archive.length, "zip", browser, driver,
        sha("browser".getBytes(StandardCharsets.UTF_8)), sha("driver".getBytes(StandardCharsets.UTF_8)), List.of(), List.of(), null);
    LicensedSessionGrant grant = new LicensedSessionGrant("modeled-session", "modeled-token", 60, Long.MAX_VALUE,
        "free", List.of(), 1, 0, "148.0.7778.179", null, null, "exact", "test", null,
        List.of(), null, null, null, Map.of(), "", null, null, artifact, platform, "arm64");
    InstallOptions options = new InstallOptions();
    options.cacheRoot = temp.resolve(UUID.randomUUID().toString());
    Path downloads = options.cacheRoot.resolve("downloads");
    Files.createDirectories(downloads);
    Files.write(downloads.resolve(artifact.sha256 + ".zip"), archive);
    return new Case(grant, options);
  }

  private static String sha(byte[] bytes) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
  }

  private record Case(LicensedSessionGrant grant, InstallOptions options) {}
}
