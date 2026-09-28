package com.slybrowser;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.BrowserType;
import com.microsoft.playwright.Playwright;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class SlyBrowserPlaywright {
  private SlyBrowserPlaywright() {}

  public static Browser launch(
      Playwright playwright,
      Path executable,
      String licenseEnvelope,
      PlaywrightLaunchSettings suppliedSettings) {
    Objects.requireNonNull(playwright, "playwright");
    PlaywrightLaunchSettings settings = suppliedSettings == null
        ? new PlaywrightLaunchSettings()
        : suppliedSettings;
    AutomationPolicy.resolvePlaywrightVersion(settings.frameworkVersion);
    AutomationPolicy.requirePlaywrightHumanizeSupport(settings.humanize);
    validateNativeReady(settings.nativeReady, settings.nativeReadyTimeoutMs);
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        executable,
        settings.profile,
        licenseEnvelope,
        settings.tempRoot,
        Collections.emptyList(),
        settings.runtimeHandoff,
        nativeHumanizeControl("playwright", settings.humanize, settings.humanPreset, settings.humanConfig, settings.humanSeed),
        settings.nativeReady,
        settings.allowRuntimeActivationTicket,
        settings.releaseRoot == null
            ? SlyBrowserWebDriver.releaseRootFromLease(executable, licenseEnvelope)
            : settings.releaseRoot)) {
      BrowserType.LaunchOptions options = new BrowserType.LaunchOptions();
      if (settings.configure != null) settings.configure.accept(options);
      if (options.executablePath != null) {
        throw new ConfigurationException(
            "The browser executable must be passed to the SlyBrowser adapter",
            "executable_option_conflict");
      }
      options.executablePath = plan.getExecutable();
      options.args = mergeArguments(plan.getArguments(), options.args);
      Browser browser = playwright.chromium().launch(options);
      try {
        if (settings.nativeReady) plan.waitForNativeReady(settings.nativeReadyTimeoutMs);
        return browser;
      } catch (RuntimeException error) {
        try { browser.close(); } catch (RuntimeException ignored) { }
        throw error;
      }
    }
  }

  public static BrowserContext launchPersistentContext(
      Playwright playwright,
      Path userDataDir,
      Path executable,
      String licenseEnvelope,
      PlaywrightPersistentLaunchSettings suppliedSettings) {
    Objects.requireNonNull(playwright, "playwright");
    PlaywrightPersistentLaunchSettings settings = suppliedSettings == null
        ? new PlaywrightPersistentLaunchSettings()
        : suppliedSettings;
    AutomationPolicy.resolvePlaywrightVersion(settings.frameworkVersion);
    AutomationPolicy.requirePlaywrightHumanizeSupport(settings.humanize);
    validateNativeReady(settings.nativeReady, settings.nativeReadyTimeoutMs);
    try (LaunchPlan plan = SlyBrowserLauncher.prepare(
        executable,
        settings.profile,
        licenseEnvelope,
        settings.tempRoot,
        Collections.emptyList(),
        settings.runtimeHandoff,
        nativeHumanizeControl("playwright", settings.humanize, settings.humanPreset, settings.humanConfig, settings.humanSeed),
        settings.nativeReady,
        settings.allowRuntimeActivationTicket,
        settings.releaseRoot == null
            ? SlyBrowserWebDriver.releaseRootFromLease(executable, licenseEnvelope)
            : settings.releaseRoot)) {
      BrowserType.LaunchPersistentContextOptions options =
          new BrowserType.LaunchPersistentContextOptions();
      if (settings.configure != null) settings.configure.accept(options);
      if (options.executablePath != null) {
        throw new ConfigurationException(
            "The browser executable must be passed to the SlyBrowser adapter",
            "executable_option_conflict");
      }
      options.executablePath = plan.getExecutable();
      options.args = mergeArguments(plan.getArguments(), options.args);
      BrowserContext context = playwright.chromium().launchPersistentContext(
          userDataDir.toAbsolutePath().normalize(),
          options);
      try {
        if (settings.nativeReady) plan.waitForNativeReady(settings.nativeReadyTimeoutMs);
        return context;
      } catch (RuntimeException error) {
        try { context.close(); } catch (RuntimeException ignored) { }
        throw error;
      }
    }
  }

  private static List<String> mergeArguments(List<String> handoff, List<String> existing) {
    List<String> result = new ArrayList<>(handoff);
    if (existing != null) result.addAll(existing);
    return result;
  }

  private static void validateNativeReady(boolean nativeReady, long timeoutMs) {
    if (nativeReady && timeoutMs <= 0) {
      throw new ConfigurationException("nativeReadyTimeoutMs must be positive", "config_invalid");
    }
  }

  private static Object nativeHumanizeControl(
      String backend,
      boolean enabled,
      String preset,
      Object config,
      Integer seed) {
    if (!enabled) return null;
    String selectedPreset = preset == null ? "default" : preset;
    if (!"default".equals(selectedPreset) && !"careful".equals(selectedPreset)) {
      throw new ConfigurationException("Unknown Humanize preset: " + selectedPreset, "humanize_preset_invalid");
    }
    if (seed != null && seed < 0) {
      throw new ConfigurationException("Native Humanize seed must be a non-negative integer", "humanize_seed_invalid");
    }
    Map<String, Object> humanize = new LinkedHashMap<>();
    humanize.put("enabled", true);
    humanize.put("version", 1);
    humanize.put("preset", selectedPreset);
    humanize.put("config", config == null ? defaultHumanizeConfig(selectedPreset) : config);
    if (seed != null) humanize.put("seed", seed);
    Map<String, Object> control = new LinkedHashMap<>();
    control.put("schemaVersion", 1);
    control.put("kind", "slybrowser.native-humanize-control");
    control.put("backend", backend);
    control.put("humanize", humanize);
    return control;
  }

  private static Map<String, Integer> defaultHumanizeConfig(String preset) {
    Map<String, Integer> config = new LinkedHashMap<>();
    config.put("mouseStepsMin", 10);
    config.put("mouseStepsMax", 16);
    config.put("mouseStepDelayMin", "careful".equals(preset) ? 8 : 7);
    config.put("mouseStepDelayMax", "careful".equals(preset) ? 24 : 18);
    config.put("clickHoldMin", "careful".equals(preset) ? 65 : 45);
    config.put("clickHoldMax", "careful".equals(preset) ? 145 : 105);
    config.put("keyDelayMin", "careful".equals(preset) ? 55 : 35);
    config.put("keyDelayMax", "careful".equals(preset) ? 155 : 115);
    config.put("thinkDelayMin", "careful".equals(preset) ? 220 : 120);
    config.put("thinkDelayMax", "careful".equals(preset) ? 620 : 360);
    return config;
  }
}
