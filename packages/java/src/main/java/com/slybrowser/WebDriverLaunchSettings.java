package com.slybrowser;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

public final class WebDriverLaunchSettings {
  public Object profile = Collections.emptyMap();
  public Path tempRoot;
  public Path releaseRoot;
  public Path profileDir;
  public String profileMode;
  public final List<String> browserArguments = new ArrayList<>();
  public final List<String> excludeSwitches = new ArrayList<>(
      Arrays.asList("enable-automation", "enable-unsafe-swiftshader"));
  public boolean headless = true;
  public int viewportWidth = 1920;
  public int viewportHeight = 947;
  public boolean humanize;
  public String humanPreset = "default";
  public Map<String, Number> humanConfig;
  public Integer humanSeed;
  public Object runtimeHandoff;
  public Object driverRuntimeHandoff;
  public boolean allowRuntimeActivationTicket;
  public boolean nativeReady;
  public long nativeReadyTimeoutMs = 15_000;
  public long driverStartTimeoutMs = 15_000;
  public long commandTimeoutMs = 60_000;
}
