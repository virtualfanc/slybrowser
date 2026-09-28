package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;

public final class LaunchPlan implements AutoCloseable {
  private static final ObjectMapper JSON = new ObjectMapper();

  private final Path executable;
  private final List<String> arguments;
  private final Path configFile;
  private final Path licenseFile;
  private final Path runtimeFile;
  private final Path releaseRoot;
  private final Path humanizeConfigFile;
  private final Path nativeReadyRequestFile;
  private final Path nativeReadyFile;
  private final String nativeReadyNonce;
  private boolean closed;

  LaunchPlan(Path executable, List<String> arguments, Path configFile, Path licenseFile) {
    this(executable, arguments, configFile, licenseFile, null, null);
  }

  LaunchPlan(Path executable, List<String> arguments, Path configFile, Path licenseFile, Path humanizeConfigFile) {
    this(executable, arguments, configFile, licenseFile, null, humanizeConfigFile);
  }

  LaunchPlan(
      Path executable,
      List<String> arguments,
      Path configFile,
      Path licenseFile,
      Path runtimeFile,
      Path humanizeConfigFile) {
    this(executable, arguments, configFile, licenseFile, runtimeFile, null, humanizeConfigFile, null, null, null);
  }

  LaunchPlan(
      Path executable,
      List<String> arguments,
      Path configFile,
      Path licenseFile,
      Path runtimeFile,
      Path releaseRoot,
      Path humanizeConfigFile,
      Path nativeReadyRequestFile,
      Path nativeReadyFile,
      String nativeReadyNonce) {
    this.executable = executable;
    this.arguments = Collections.unmodifiableList(arguments);
    this.configFile = configFile;
    this.licenseFile = licenseFile;
    this.runtimeFile = runtimeFile;
    this.releaseRoot = releaseRoot;
    this.humanizeConfigFile = humanizeConfigFile;
    this.nativeReadyRequestFile = nativeReadyRequestFile;
    this.nativeReadyFile = nativeReadyFile;
    this.nativeReadyNonce = nativeReadyNonce;
  }

  public Path getExecutable() { return executable; }
  public List<String> getArguments() { return arguments; }
  public Path getConfigFile() { return configFile; }
  public Path getLicenseFile() { return licenseFile; }
  public Path getRuntimeFile() { return runtimeFile; }
  public Path getReleaseRoot() { return releaseRoot; }
  public Path getHumanizeConfigFile() { return humanizeConfigFile; }
  public Path getNativeReadyRequestFile() { return nativeReadyRequestFile; }
  public Path getNativeReadyFile() { return nativeReadyFile; }
  public String getNativeReadyNonce() { return nativeReadyNonce; }

  public void waitForNativeReady(long timeoutMs) {
    if (nativeReadyFile == null || nativeReadyNonce == null) return;
    if (timeoutMs <= 0) {
      throw new ConfigurationException("nativeReadyTimeoutMs must be positive", "config_invalid");
    }
    long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
    while (System.nanoTime() < deadline) {
      if (nativeReadyObserved()) return;
      try {
        Thread.sleep(Math.min(50, Math.max(1, (deadline - System.nanoTime()) / 1_000_000L)));
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new ConfigurationException("Interrupted while waiting for native-ready", "native_ready_timeout", error);
      }
    }
    throw new ConfigurationException("SlyBrowser did not report native-ready before returning", "native_ready_timeout");
  }

  private boolean nativeReadyObserved() {
    try {
      if (!Files.exists(nativeReadyFile) || Files.size(nativeReadyFile) == 0) return false;
      JsonNode marker = JSON.readTree(nativeReadyFile.toFile());
      if (marker.path("schemaVersion").asInt() == 1 &&
          "slybrowser.native-ready".equals(marker.path("kind").asText()) &&
          marker.path("ready").asBoolean(false) &&
          nativeReadyNonce.equals(marker.path("nonce").asText())) {
        return true;
      }
      throw new ConfigurationException("Native-ready marker is invalid", "native_ready_invalid");
    } catch (IOException error) {
      return false;
    }
  }

  @Override
  public void close() {
    if (closed) return;
    closed = true;
    delete(nativeReadyRequestFile);
    delete(nativeReadyFile);
    delete(humanizeConfigFile);
    delete(runtimeFile);
    delete(licenseFile);
    delete(configFile);
  }

  private static void delete(Path path) {
    if (path == null) return;
    try {
      Files.deleteIfExists(path);
    } catch (IOException ignored) {
      // Best-effort cleanup matches the other SDKs. The next release cleanup
      // pass removes a locked temporary file after the browser exits.
    }
  }
}
