package com.slybrowser;

import java.nio.file.Path;
import java.util.Collections;
import java.util.Map;

/** User-facing options shared with the Node.js, Python and .NET SDKs. */
public final class SlyBrowserOptions {
  public Map<String, Object> profile = Collections.emptyMap();
  public LaunchOptions launch = new LaunchOptions();
  public HumanizeOptions humanize = new HumanizeOptions();

  public static final class LaunchOptions {
    public boolean headless = true;
    public String profileMode = "ephemeral";
    public Path profileDirectory;
    public boolean updateKernel = true;
  }

  public static final class HumanizeOptions {
    public boolean enabled;
    public String preset = "default";
    public Integer seed;
    public Map<String, Number> config;
  }
}
