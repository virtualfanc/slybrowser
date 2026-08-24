package com.slybrowser;

import com.microsoft.playwright.BrowserType;
import java.nio.file.Path;
import java.util.Collections;
import java.util.function.Consumer;

public final class PlaywrightLaunchSettings {
  public Object profile = Collections.emptyMap();
  public Path tempRoot;
  public String frameworkVersion;
  public boolean humanize;
  public String humanPreset = "default";
  public Object humanConfig;
  public Integer humanSeed;
  public Object runtimeHandoff;
  public boolean allowRuntimeActivationTicket;
  public Path releaseRoot;
  public boolean nativeReady;
  public long nativeReadyTimeoutMs = 15_000;
  public Consumer<BrowserType.LaunchOptions> configure;
}
