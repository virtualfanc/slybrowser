package com.slybrowser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class SlyBrowserLauncher {
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int MAX_CONFIG_BYTES = 1024 * 1024;
  private static final int MAX_LICENSE_BYTES = 64 * 1024;
  private static final int MAX_RUNTIME_BYTES = 64 * 1024;

  private SlyBrowserLauncher() {}

  public static LaunchPlan prepare(
      Path executable,
      Object profile,
      String licenseEnvelope,
      Path tempRoot,
      List<String> extraArguments) {
    return prepare(executable, profile, licenseEnvelope, tempRoot, extraArguments, null);
  }

  public static LaunchPlan prepare(
      Path executable,
      Object profile,
      String licenseEnvelope,
      Path tempRoot,
      List<String> extraArguments,
      Object humanizeControl) {
    return prepare(executable, profile, licenseEnvelope, tempRoot, extraArguments, null, humanizeControl);
  }

  public static LaunchPlan prepare(
      Path executable,
      Object profile,
      String licenseEnvelope,
      Path tempRoot,
      List<String> extraArguments,
      Object runtimeHandoff,
      Object humanizeControl) {
    return prepare(executable, profile, licenseEnvelope, tempRoot, extraArguments, runtimeHandoff, humanizeControl, false);
  }

  public static LaunchPlan prepare(
      Path executable,
      Object profile,
      String licenseEnvelope,
      Path tempRoot,
      List<String> extraArguments,
      Object runtimeHandoff,
      Object humanizeControl,
      boolean nativeReady) {
    return prepare(executable, profile, licenseEnvelope, tempRoot, extraArguments, runtimeHandoff, humanizeControl, nativeReady, false);
  }

  public static LaunchPlan prepare(
      Path executable,
      Object profile,
      String licenseEnvelope,
      Path tempRoot,
      List<String> extraArguments,
      Object runtimeHandoff,
      Object humanizeControl,
      boolean nativeReady,
      boolean allowRuntimeActivationTicket) {
    return prepare(
        executable,
        profile,
        licenseEnvelope,
        tempRoot,
        extraArguments,
        runtimeHandoff,
        humanizeControl,
        nativeReady,
        allowRuntimeActivationTicket,
        null);
  }

  public static LaunchPlan prepare(
      Path executable,
      Object profile,
      String licenseEnvelope,
      Path tempRoot,
      List<String> extraArguments,
      Object runtimeHandoff,
      Object humanizeControl,
      boolean nativeReady,
      boolean allowRuntimeActivationTicket,
      Path releaseRoot) {
    Path executablePath = executable.toAbsolutePath().normalize();
    if (!Files.isRegularFile(executablePath)) {
      throw new ConfigurationException("Browser executable does not exist", "browser_missing");
    }
    Path releaseRootPath = releaseRoot == null ? null : releaseRoot.toAbsolutePath().normalize();
    List<String> extra = extraArguments == null
        ? Collections.emptyList()
        : new ArrayList<>(extraArguments);
    for (String argument : extra) {
      if (isForbiddenSecretArgument(argument)) {
        throw new ConfigurationException(
            "License and runtime material must not be passed in extra browser arguments",
            "license_argument_forbidden");
      }
    }

    byte[] config;
    try {
      JsonNode node = JSON.valueToTree(profile == null ? Collections.emptyMap() : profile);
      if (!node.isObject()) {
        throw new ConfigurationException("Launch options must be an object", "config_invalid");
      }
      if (node.has("licenseKey") || node.has("runtimeToken") ||
          node.has("bootstrapToken") || node.has("activationTicket") || node.has("downloadTicket")) {
        throw new ConfigurationException(
            "License and runtime secrets must never be placed in the browser profile handoff",
            "profile_secret_forbidden");
      }
      config = JSON.writeValueAsBytes(node);
    } catch (IllegalArgumentException | IOException error) {
      throw new ConfigurationException("Launch options are not valid JSON", "config_invalid", error);
    }
    byte[] license = licenseEnvelope == null
        ? new byte[0]
        : licenseEnvelope.getBytes(StandardCharsets.UTF_8);
    if (config.length > MAX_CONFIG_BYTES) {
      throw new ConfigurationException("Launch configuration is too large", "config_too_large");
    }
    if (license.length == 0 || license.length > MAX_LICENSE_BYTES) {
      throw new ConfigurationException("License lease is missing or too large", "license_invalid_envelope");
    }

    Path root = (tempRoot == null ? Path.of(System.getProperty("java.io.tmpdir")) : tempRoot)
        .toAbsolutePath().normalize();
    try {
      Files.createDirectories(root);
      Path configFile = writePrivateFile(root, "sly-config-", config);
      Path licenseFile = null;
      Path runtimeFile = null;
      Path humanizeConfigFile = null;
      Path nativeReadyRequestFile = null;
      Path nativeReadyFile = null;
      String nativeReadyNonce = null;
      try {
        licenseFile = writePrivateFile(root, "sly-license-", license);
        if (runtimeHandoff != null) {
          JsonNode runtimeNode = JSON.valueToTree(runtimeHandoff);
          if (!runtimeNode.isObject() || runtimeNode.has("licenseKey") ||
              runtimeNode.has("runtimeToken") || (!allowRuntimeActivationTicket && runtimeNode.has("activationTicket")) ||
              runtimeNode.has("downloadTicket")) {
            throw new ConfigurationException(
                "Runtime handoff must not contain long-lived keys, runtime tokens or download tickets",
                "runtime_handoff_secret_forbidden");
          }
          byte[] runtimeBytes = JSON.writeValueAsBytes(runtimeNode);
          if (runtimeBytes.length == 0 || runtimeBytes.length > MAX_RUNTIME_BYTES) {
            throw new ConfigurationException(
                "Runtime handoff file is missing or too large",
                "runtime_handoff_invalid");
          }
          runtimeFile = writePrivateFile(root, "sly-runtime-", runtimeBytes);
        }
        if (humanizeControl != null) {
          byte[] humanizeBytes = JSON.writeValueAsBytes(humanizeControl);
          if (humanizeBytes.length > MAX_LICENSE_BYTES) {
            throw new ConfigurationException(
                "Native Humanize control file is too large",
                "humanize_config_too_large");
          }
          humanizeConfigFile = writePrivateFile(root, "sly-humanize-", humanizeBytes);
        }
        if (nativeReady) {
          nativeReadyNonce = UUID.randomUUID().toString();
          nativeReadyFile = writePrivateFile(root, "sly-native-ready-", new byte[0]);
          Map<String, Object> request = new LinkedHashMap<>();
          request.put("schemaVersion", 1);
          request.put("kind", "slybrowser.native-ready-request");
          request.put("readyFile", nativeReadyFile.toString());
          request.put("nonce", nativeReadyNonce);
          nativeReadyRequestFile = writePrivateFile(
              root,
              "sly-native-ready-request-",
              JSON.writeValueAsBytes(request));
        }
        List<String> arguments = new ArrayList<>();
        arguments.add("--sly-config-file=" + configFile);
        arguments.add("--sly-license-file=" + licenseFile);
        if (releaseRootPath != null) {
          arguments.add("--sly-release-root=" + releaseRootPath);
        }
        if (runtimeFile != null) {
          arguments.add("--sly-runtime-file=" + runtimeFile);
        }
        if (humanizeConfigFile != null) {
          arguments.add("--sly-humanize-config=" + humanizeConfigFile);
        }
        if (nativeReadyRequestFile != null) {
          arguments.add("--sly-native-ready-request-file=" + nativeReadyRequestFile);
        }
        arguments.addAll(extra);
        return new LaunchPlan(
            executablePath,
            arguments,
            configFile,
            licenseFile,
            runtimeFile,
            releaseRootPath,
            humanizeConfigFile,
            nativeReadyRequestFile,
            nativeReadyFile,
            nativeReadyNonce);
      } catch (RuntimeException | IOException error) {
        if (nativeReadyRequestFile != null) Files.deleteIfExists(nativeReadyRequestFile);
        if (nativeReadyFile != null) Files.deleteIfExists(nativeReadyFile);
        if (humanizeConfigFile != null) Files.deleteIfExists(humanizeConfigFile);
        if (runtimeFile != null) Files.deleteIfExists(runtimeFile);
        if (licenseFile != null) Files.deleteIfExists(licenseFile);
        Files.deleteIfExists(configFile);
        throw error;
      }
    } catch (IOException error) {
      throw new ConfigurationException("Unable to create private launch handoff", "handoff_write_failed", error);
    }
  }

  private static boolean isForbiddenSecretArgument(String argument) {
    int equalsIndex = argument.indexOf('=');
    if (equalsIndex < 0) {
      return false;
    }
    String switchName = argument.substring(0, equalsIndex).toLowerCase();
    return switchName.contains("license") || switchName.contains("runtime");
  }

  private static Path writePrivateFile(Path directory, String prefix, byte[] payload) throws IOException {
    Path path = Files.createTempFile(directory, prefix, ".json");
    try {
      Set<PosixFilePermission> permissions = EnumSet.of(
          PosixFilePermission.OWNER_READ,
          PosixFilePermission.OWNER_WRITE);
      Files.setPosixFilePermissions(path, permissions);
    } catch (UnsupportedOperationException ignored) {
      // Windows ACLs are inherited from the user-private temporary directory.
    }
    Files.write(path, payload);
    SecureHandoffFiles.restrictWindowsAcl(path);
    return path;
  }
}
