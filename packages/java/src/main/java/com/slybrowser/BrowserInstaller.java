package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class BrowserInstaller {
  private BrowserInstaller() {}

  public static BrowserInstallation installGrantedBrowser(
      LicenseServiceClient client,
      LicensedSessionGrant grant,
      InstallOptions supplied) {
    return installGrantedBrowser(
        InstallGrantView.from(grant),
        supplied,
        destination -> client.downloadArtifact(grant, destination));
  }

  public static BrowserInstallation installGrantedBrowser(
      LicenseServiceClient client,
      RuntimeSessionGrant grant,
      InstallOptions supplied) {
    return installGrantedBrowser(
        InstallGrantView.from(grant),
        supplied,
        destination -> client.downloadRuntimeArtifact(grant, destination));
  }

  private static BrowserInstallation installGrantedBrowser(
      InstallGrantView grant,
      InstallOptions supplied,
      ArtifactDownloader downloader) {
    InstallOptions options = supplied == null ? new InstallOptions() : supplied;
    Path cacheRoot = (options.cacheRoot == null ? defaultCacheRoot() : options.cacheRoot)
        .toAbsolutePath().normalize();
    String identity = grant.platform + "-" + grant.arch + "-" + grant.artifact.sha256.substring(0, 16);
    Path installRoot = cacheRoot.resolve("stable").resolve(grant.browserVersion).resolve(identity);
    BrowserInstallation existing = readInstallation(installRoot, grant);
    if (existing != null) return existing;
    try {
      Files.createDirectories(installRoot.getParent());
    } catch (IOException error) {
      throw new ArtifactException("Unable to create browser cache directory", "artifact_cache_failed", error);
    }
    Path lockPath = installRoot.resolveSibling(installRoot.getFileName() + ".lock");
    try (LockFile ignored = acquireLock(lockPath, options.lockTimeoutMs)) {
      BrowserInstallation raced = readInstallation(installRoot, grant);
      if (raced != null) return raced;
      Path downloads = cacheRoot.resolve("downloads");
      Files.createDirectories(downloads);
      Path archive = downloads.resolve(grant.artifact.sha256 + ".zip");
      boolean archiveValid;
      try {
        ReleaseManifestVerifier.verifyArtifact(archive, grant.artifact);
        archiveValid = true;
      } catch (ArtifactException error) {
        archiveValid = false;
      }
      if (!archiveValid) {
        quarantinePath(archive);
        Path temporaryArchive = downloads.resolve(grant.artifact.sha256 + "." + ProcessHandle.current().pid() + "." + System.nanoTime() + "." + UUID.randomUUID() + ".part");
        try {
          downloader.download(temporaryArchive);
          assertDownloadedSize(temporaryArchive, grant.artifact.size);
          ReleaseManifestVerifier.verifyArtifact(temporaryArchive, grant.artifact);
          Files.move(temporaryArchive, archive);
        } catch (RuntimeException | IOException error) {
          try { Files.deleteIfExists(temporaryArchive); } catch (IOException ignoredError) { }
          throw error instanceof RuntimeException ? (RuntimeException) error :
              new ArtifactException("Unable to cache browser artifact", "artifact_cache_failed", error);
        }
      }
      ReleaseManifestVerifier.verifyArtifact(archive, grant.artifact);
      Path temporaryDirectory = installRoot.getParent().resolve(".extract-" + ProcessHandle.current().pid() + "-" + UUID.randomUUID());
      try {
        Files.createDirectory(temporaryDirectory);
        if (options.extractor == null) unzip(archive, temporaryDirectory, maximumExpandedBytes(grant.artifact.size));
        else options.extractor.extract(archive, temporaryDirectory);
        RuntimePair pair = verifyRuntime(temporaryDirectory, grant);
        quarantinePath(installRoot);
        Files.move(temporaryDirectory, installRoot);
        BrowserInstallation installation = new BrowserInstallation(
            grant.browserVersion,
            grant.platform,
            grant.arch,
            installRoot,
            installRoot.resolve(grant.artifact.browserExecutable).toAbsolutePath().normalize(),
            installRoot.resolve(grant.artifact.driverExecutable).toAbsolutePath().normalize(),
            grant.artifact.sha256);
        writeInstallation(installRoot, installation);
        writeCurrentPointers(cacheRoot, installation);
        if (pair.browser == null || pair.driver == null) throw new AssertionError();
        return installation;
      } finally {
        deleteTree(temporaryDirectory);
      }
    } catch (IOException error) {
      throw new ArtifactException("Unable to install authorized browser", "artifact_install_failed", error);
    }
  }

  public static BrowserInstallation findCurrentBrowserInstallation(
      InstallOptions supplied,
      String platform,
      String arch,
      String kernelMajor) {
    InstallOptions options = supplied == null ? new InstallOptions() : supplied;
    Path cacheRoot = (options.cacheRoot == null ? defaultCacheRoot() : options.cacheRoot)
        .toAbsolutePath().normalize();
    String selectedPlatform = platform == null ? currentPlatform() : platform;
    String selectedArch = arch == null ? currentArch() : arch;
    String selectedKernel = kernelMajor == null ? "latest" : kernelMajor;
    if (!selectedKernel.equals("latest") && !selectedKernel.matches("^[1-9][0-9]*$")) {
      throw new ArtifactException("kernelMajor must be a positive integer or latest", "version_policy_invalid");
    }
    Path pointer = cacheRoot.resolve("stable")
        .resolve("current")
        .resolve(selectedPlatform + "-" + selectedArch + "-" + selectedKernel + ".json");
    try {
      if (!Files.isRegularFile(pointer)) return null;
      JsonNode document = CanonicalJson.MAPPER.readTree(Files.readString(pointer));
      JsonNode root = document.get("root");
      if (root == null || !root.isTextual()) return null;
      return readLooseInstallation(Path.of(root.asText()), selectedPlatform, selectedArch, selectedKernel);
    } catch (IOException error) {
      return null;
    }
  }

  public static BrowserInstallationReference acquireBrowserInstallationReference(BrowserInstallation installation) {
    Path root = installation.root.toAbsolutePath().normalize();
    Path refs = root.resolve(".sly-refs");
    try {
      Files.createDirectories(refs);
      Path reference = refs.resolve(ProcessHandle.current().pid() + "-" + System.nanoTime() + "-" + UUID.randomUUID() + ".json");
      Map<String, Object> value = new LinkedHashMap<>();
      value.put("schemaVersion", 1);
      value.put("processId", ProcessHandle.current().pid());
      value.put("acquiredAt", Instant.now().toString());
      value.put("version", installation.version);
      value.put("platform", installation.platform);
      value.put("arch", installation.arch);
      value.put("artifactSha256", installation.artifactSha256);
      value.put("root", root.toString());
      value.put("browserExecutable", installation.browserExecutable.toAbsolutePath().normalize().toString());
      value.put("driverExecutable", installation.driverExecutable.toAbsolutePath().normalize().toString());
      Files.writeString(
          reference,
          CanonicalJson.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value) + "\n",
          StandardOpenOption.CREATE_NEW,
          StandardOpenOption.WRITE);
      return new BrowserInstallationReference(installation, reference);
    } catch (IOException error) {
      throw new ArtifactException("Unable to record browser installation reference", "artifact_cache_failed", error);
    }
  }

  public static List<Path> activeBrowserInstallationReferences(BrowserInstallation installation) {
    Path root = installation.root.toAbsolutePath().normalize();
    Path refs = root.resolve(".sly-refs");
    List<Path> active = new ArrayList<>();
    if (!Files.isDirectory(refs)) return active;
    try (DirectoryStream<Path> entries = Files.newDirectoryStream(refs, "*.json")) {
      for (Path reference : entries) {
        try {
          JsonNode document = CanonicalJson.MAPPER.readTree(Files.readString(reference));
          Path referencedRoot = Path.of(text(document, "root")).toAbsolutePath().normalize();
          if (!referencedRoot.equals(root) || !text(document, "artifactSha256").equals(installation.artifactSha256)) {
            continue;
          }
          JsonNode processId = document.get("processId");
          long pid = processId == null || !processId.canConvertToLong() ? -1L : processId.asLong();
          if (processIsAlive(pid)) {
            active.add(reference);
          } else {
            deleteReference(reference);
          }
        } catch (Exception error) {
          deleteReference(reference);
        }
      }
    } catch (IOException error) {
      return active;
    }
    return active;
  }

  public static boolean isBrowserInstallationInUse(BrowserInstallation installation) {
    return !activeBrowserInstallationReferences(installation).isEmpty();
  }

  public static BrowserPruneResult pruneBrowserInstallations(
      InstallOptions supplied,
      String platform,
      String arch,
      String kernelMajor) {
    InstallOptions options = supplied == null ? new InstallOptions() : supplied;
    Path cacheRoot = (options.cacheRoot == null ? defaultCacheRoot() : options.cacheRoot)
        .toAbsolutePath().normalize();
    String selectedPlatform = platform == null ? currentPlatform() : platform;
    String selectedArch = arch == null ? currentArch() : arch;
    String selectedKernel = kernelMajor == null ? "latest" : kernelMajor;
    if (!selectedKernel.equals("latest") && !selectedKernel.matches("^[1-9][0-9]*$")) {
      throw new ArtifactException("kernelMajor must be a positive integer or latest", "version_policy_invalid");
    }
    Path stable = cacheRoot.resolve("stable");
    Set<Path> currentRoots = currentInstallationRoots(cacheRoot);
    List<Path> removed = new ArrayList<>();
    List<Path> skippedInUse = new ArrayList<>();
    List<Path> kept = new ArrayList<>();
    if (!Files.isDirectory(stable)) return new BrowserPruneResult(removed, skippedInUse, kept);
    try (DirectoryStream<Path> versions = Files.newDirectoryStream(stable)) {
      for (Path versionRoot : versions) {
        String version = versionRoot.getFileName().toString();
        if (!Files.isDirectory(versionRoot) || version.equals("current") ||
            !version.matches("^\\d+(\\.\\d+){0,7}$") ||
            !matchesKernelMajor(version, selectedKernel)) continue;
        try (DirectoryStream<Path> identities = Files.newDirectoryStream(versionRoot)) {
          for (Path root : identities) {
            if (!Files.isDirectory(root)) continue;
            BrowserInstallation installation = readLooseInstallation(root, selectedPlatform, selectedArch, selectedKernel);
            if (installation == null) continue;
            if (currentRoots.contains(installation.root.toAbsolutePath().normalize())) {
              kept.add(installation.root);
              continue;
            }
            if (isBrowserInstallationInUse(installation)) {
              skippedInUse.add(installation.root);
              continue;
            }
            deleteTree(installation.root);
            removed.add(installation.root);
          }
        }
        if (isDirectoryEmpty(versionRoot)) Files.deleteIfExists(versionRoot);
      }
    } catch (IOException error) {
      throw new ArtifactException("Unable to prune browser cache", "artifact_cache_failed", error);
    }
    removed.sort(Comparator.comparing(Path::toString));
    skippedInUse.sort(Comparator.comparing(Path::toString));
    kept.sort(Comparator.comparing(Path::toString));
    return new BrowserPruneResult(removed, skippedInUse, kept);
  }

  private static Set<Path> currentInstallationRoots(Path cacheRoot) {
    Path current = cacheRoot.resolve("stable").resolve("current");
    Set<Path> roots = new HashSet<>();
    if (!Files.isDirectory(current)) return roots;
    try (DirectoryStream<Path> pointers = Files.newDirectoryStream(current, "*.json")) {
      for (Path pointer : pointers) {
        try {
          JsonNode document = CanonicalJson.MAPPER.readTree(Files.readString(pointer));
          roots.add(Path.of(text(document, "root")).toAbsolutePath().normalize());
        } catch (Exception ignored) { }
      }
    } catch (IOException ignored) { }
    return roots;
  }

  private static boolean isDirectoryEmpty(Path directory) throws IOException {
    try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory)) {
      return !entries.iterator().hasNext();
    }
  }

  private static boolean processIsAlive(long pid) {
    if (pid <= 0) return false;
    return ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
  }

  private static void deleteReference(Path reference) {
    try {
      Files.deleteIfExists(reference);
    } catch (IOException ignored) { }
  }

  private static BrowserInstallation readInstallation(Path root, InstallGrantView grant) {
    try {
      Path metadata = root.resolve(".sly-install.json");
      if (!Files.isRegularFile(metadata)) return null;
      JsonNode document = CanonicalJson.MAPPER.readTree(Files.readString(metadata));
      BrowserInstallation installation = new BrowserInstallation(
          text(document, "version"),
          text(document, "platform"),
          text(document, "arch"),
          Path.of(text(document, "root")).toAbsolutePath().normalize(),
          Path.of(text(document, "browserExecutable")).toAbsolutePath().normalize(),
          Path.of(text(document, "driverExecutable")).toAbsolutePath().normalize(),
          text(document, "artifactSha256"));
      if (!installation.version.equals(grant.browserVersion) ||
          !installation.artifactSha256.equals(grant.artifact.sha256) ||
          !installation.root.equals(root.toAbsolutePath().normalize()) ||
          !installation.browserExecutable.equals(root.resolve(grant.artifact.browserExecutable).toAbsolutePath().normalize()) ||
          !installation.driverExecutable.equals(root.resolve(grant.artifact.driverExecutable).toAbsolutePath().normalize())) {
        return null;
      }
      verifyRuntime(root, grant);
      return installation;
    } catch (Exception error) {
      return null;
    }
  }

  private static BrowserInstallation readLooseInstallation(Path root, String platform, String arch, String kernelMajor) {
    try {
      Path metadata = root.resolve(".sly-install.json");
      if (!Files.isRegularFile(metadata)) return null;
      JsonNode document = CanonicalJson.MAPPER.readTree(Files.readString(metadata));
      BrowserInstallation installation = new BrowserInstallation(
          text(document, "version"),
          text(document, "platform"),
          text(document, "arch"),
          Path.of(text(document, "root")).toAbsolutePath().normalize(),
          Path.of(text(document, "browserExecutable")).toAbsolutePath().normalize(),
          Path.of(text(document, "driverExecutable")).toAbsolutePath().normalize(),
          text(document, "artifactSha256"));
      Path resolvedRoot = root.toAbsolutePath().normalize();
      if (!installation.platform.equals(platform) ||
          !installation.arch.equals(arch) ||
          !matchesKernelMajor(installation.version, kernelMajor) ||
          !installation.root.equals(resolvedRoot) ||
          !installation.browserExecutable.startsWith(resolvedRoot) ||
          !installation.driverExecutable.startsWith(resolvedRoot) ||
          !installation.browserExecutable.getParent().equals(installation.driverExecutable.getParent()) ||
          !Files.isRegularFile(installation.browserExecutable) ||
          !Files.isRegularFile(installation.driverExecutable)) {
        return null;
      }
      return installation;
    } catch (Exception error) {
      return null;
    }
  }

  private static void writeInstallation(Path root, BrowserInstallation installation) throws IOException {
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("version", installation.version);
    value.put("platform", installation.platform);
    value.put("arch", installation.arch);
    value.put("root", installation.root.toString());
    value.put("browserExecutable", installation.browserExecutable.toString());
    value.put("driverExecutable", installation.driverExecutable.toString());
    value.put("artifactSha256", installation.artifactSha256);
    Files.writeString(root.resolve(".sly-install.json"), CanonicalJson.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value) + "\n");
  }

  private static void writeCurrentPointers(Path cacheRoot, BrowserInstallation installation) throws IOException {
    Path current = cacheRoot.resolve("stable").resolve("current");
    Files.createDirectories(current);
    Map<String, Object> value = new LinkedHashMap<>();
    value.put("schemaVersion", 1);
    value.put("version", installation.version);
    value.put("platform", installation.platform);
    value.put("arch", installation.arch);
    value.put("artifactSha256", installation.artifactSha256);
    value.put("root", installation.root.toString());
    value.put("updatedAt", java.time.Instant.now().toString());
    String payload = CanonicalJson.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(value) + "\n";
    String major = installation.version.split("\\.")[0];
    Files.writeString(current.resolve(installation.platform + "-" + installation.arch + "-latest.json"), payload);
    Files.writeString(current.resolve(installation.platform + "-" + installation.arch + "-" + major + ".json"), payload);
  }

  private static RuntimePair verifyRuntime(Path root, InstallGrantView grant) throws IOException {
    Path resolvedRoot = root.toAbsolutePath().normalize();
    Path browser = resolvedRoot.resolve(grant.artifact.browserExecutable).toAbsolutePath().normalize();
    Path driver = resolvedRoot.resolve(grant.artifact.driverExecutable).toAbsolutePath().normalize();
    if (!browser.startsWith(resolvedRoot) ||
        !driver.startsWith(resolvedRoot) ||
        !browser.getParent().equals(driver.getParent()) ||
        !Files.isRegularFile(browser) ||
        !Files.isRegularFile(driver)) {
      throw new ArtifactException("Installed browser and project WebDriver layout is invalid", "artifact_layout_invalid");
    }
    if (!ReleaseManifestVerifier.sha256(browser).equals(grant.artifact.browserSha256) ||
        !ReleaseManifestVerifier.sha256(driver).equals(grant.artifact.driverSha256)) {
      throw new ArtifactException("Installed browser or project WebDriver hash does not match the signed manifest", "artifact_runtime_hash_mismatch");
    }
    return new RuntimePair(browser, driver);
  }

  private static LockFile acquireLock(Path path, long timeoutMs) throws IOException {
    long deadline = System.currentTimeMillis() + timeoutMs;
    while (true) {
      try {
        Files.writeString(path, Long.toString(ProcessHandle.current().pid()), java.nio.file.StandardOpenOption.CREATE_NEW);
        return new LockFile(path);
      } catch (java.nio.file.FileAlreadyExistsException error) {
        if (System.currentTimeMillis() >= deadline) {
          throw new ArtifactException("Timed out waiting for the browser installation lock", "install_lock_timeout");
        }
        try { Thread.sleep(100); } catch (InterruptedException interrupted) {
          Thread.currentThread().interrupt();
          throw new ArtifactException("Interrupted while waiting for browser installation lock", "install_lock_interrupted", interrupted);
        }
      }
    }
  }

  private static long maximumExpandedBytes(long archiveSize) {
    return Math.min(Math.max(archiveSize * 20, 2L * 1024 * 1024 * 1024), 16L * 1024 * 1024 * 1024);
  }

  private static void unzip(Path archive, Path destination, long maximumExpandedBytes) {
    try (ZipInputStream input = new ZipInputStream(Files.newInputStream(archive))) {
      long expanded = 0;
      byte[] buffer = new byte[1024 * 1024];
      ZipEntry entry;
      while ((entry = input.getNextEntry()) != null) {
        String normalizedName = entry.getName().replace('\\', '/');
        if (normalizedName.startsWith("/") ||
            normalizedName.matches("^[A-Za-z]:.*") ||
            List.of(normalizedName.split("/")).contains("..")) {
          throw new ArtifactException("Archive contains an unsafe path", "artifact_archive_invalid");
        }
        Path output = destination.resolve(entry.getName()).toAbsolutePath().normalize();
        if (!output.startsWith(destination.toAbsolutePath().normalize())) {
          throw new ArtifactException("Archive contains an unsafe path", "artifact_archive_invalid");
        }
        if (entry.isDirectory()) {
          Files.createDirectories(output);
        } else {
          Files.createDirectories(output.getParent());
          try (OutputStream file = Files.newOutputStream(output)) {
            int read;
            while ((read = input.read(buffer)) >= 0) {
              if (read == 0) continue;
              expanded += read;
              if (expanded > maximumExpandedBytes) {
                throw new ArtifactException("Browser archive expands beyond its allowed size", "artifact_expanded_too_large");
              }
              file.write(buffer, 0, read);
            }
          }
        }
      }
    } catch (IOException error) {
      throw new ArtifactException("Unable to extract browser artifact", "artifact_extract_failed", error);
    }
  }

  private static void assertDownloadedSize(Path path, long expectedSize) {
    try {
      if (Files.size(path) > expectedSize) {
        throw new ArtifactException("Browser artifact download exceeds its signed size", "artifact_size_mismatch");
      }
    } catch (IOException error) {
      throw new ArtifactException("Unable to verify browser artifact size", "artifact_read_failed", error);
    }
  }

  private static void quarantinePath(Path path) throws IOException {
    if (path == null || !Files.exists(path)) return;
    for (int attempt = 0; attempt < 5; attempt++) {
      Path target = path.resolveSibling(path.getFileName() + ".bad-" + ProcessHandle.current().pid() + "-" + System.nanoTime() + "-" + attempt);
      try {
        Files.move(path, target);
        return;
      } catch (java.nio.file.NoSuchFileException error) {
        return;
      } catch (java.nio.file.FileAlreadyExistsException error) {
        continue;
      }
    }
    throw new ArtifactException("Unable to quarantine invalid browser cache", "artifact_cache_failed");
  }

  private static void deleteTree(Path path) throws IOException {
    if (path == null || !Files.exists(path)) return;
    try (java.util.stream.Stream<Path> paths = Files.walk(path)) {
      paths.sorted(java.util.Comparator.reverseOrder()).forEach(item -> {
        try { Files.deleteIfExists(item); }
        catch (IOException error) { throw new RuntimeException(error); }
      });
    } catch (RuntimeException error) {
      if (error.getCause() instanceof IOException) throw (IOException) error.getCause();
      throw error;
    }
  }

  private static Path defaultCacheRoot() {
    String os = System.getProperty("os.name").toLowerCase();
    if (os.contains("win")) {
      String local = System.getenv("LOCALAPPDATA");
      return Path.of(local == null ? System.getProperty("user.home") : local, "SlyBrowser", "cache");
    }
    if (os.contains("mac")) return Path.of(System.getProperty("user.home"), "Library", "Caches", "SlyBrowser");
    String xdg = System.getenv("XDG_CACHE_HOME");
    return Path.of(xdg == null ? Path.of(System.getProperty("user.home"), ".cache").toString() : xdg, "slybrowser");
  }

  private static String currentPlatform() {
    String os = System.getProperty("os.name").toLowerCase();
    if (os.contains("win")) return "windows";
    if (os.contains("linux")) return "linux";
    if (os.contains("mac")) return "macos";
    throw new ArtifactException("Unsupported platform", "platform_unsupported");
  }

  private static String currentArch() {
    String arch = System.getProperty("os.arch").toLowerCase();
    if (arch.equals("amd64") || arch.equals("x86_64")) return "x64";
    if (arch.equals("aarch64") || arch.equals("arm64")) return "arm64";
    throw new ArtifactException("Unsupported architecture", "platform_unsupported");
  }

  private static boolean matchesKernelMajor(String version, String kernelMajor) {
    return kernelMajor.equals("latest") || version.split("\\.")[0].equals(kernelMajor);
  }

  private static String text(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || !value.isTextual()) throw new ArtifactException("Install metadata is invalid", "artifact_metadata_invalid");
    return value.asText();
  }

  @FunctionalInterface
  private interface ArtifactDownloader {
    void download(Path destination);
  }

  private static final class InstallGrantView {
    final String browserVersion;
    final String platform;
    final String arch;
    final ReleaseArtifact artifact;

    private InstallGrantView(String browserVersion, String platform, String arch, ReleaseArtifact artifact) {
      this.browserVersion = browserVersion;
      this.platform = platform;
      this.arch = arch;
      this.artifact = artifact;
    }

    static InstallGrantView from(LicensedSessionGrant grant) {
      return new InstallGrantView(grant.browserVersion, grant.platform, grant.arch, grant.artifact);
    }

    static InstallGrantView from(RuntimeSessionGrant grant) {
      return new InstallGrantView(grant.browserVersion, grant.platform, grant.arch, grant.artifact);
    }
  }

  private static final class RuntimePair {
    final Path browser;
    final Path driver;

    RuntimePair(Path browser, Path driver) {
      this.browser = browser;
      this.driver = driver;
    }
  }

  private static final class LockFile implements AutoCloseable {
    private final Path path;

    LockFile(Path path) {
      this.path = path;
    }

    @Override
    public void close() throws IOException {
      Files.deleteIfExists(path);
    }
  }
}
