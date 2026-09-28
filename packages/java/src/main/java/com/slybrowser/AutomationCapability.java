package com.slybrowser;

public final class AutomationCapability {
  private final AutomationBackend backend;
  private final String language;
  private final String frameworkVersion;
  private final boolean nativeHumanize;
  private final boolean persistentContext;

  AutomationCapability(
      AutomationBackend backend,
      String language,
      String frameworkVersion,
      boolean nativeHumanize,
      boolean persistentContext) {
    this.backend = backend;
    this.language = language;
    this.frameworkVersion = frameworkVersion;
    this.nativeHumanize = nativeHumanize;
    this.persistentContext = persistentContext;
  }

  public AutomationBackend getBackend() { return backend; }
  public String getLanguage() { return language; }
  public String getFrameworkVersion() { return frameworkVersion; }
  public boolean hasNativeHumanize() { return nativeHumanize; }
  public boolean hasPersistentContext() { return persistentContext; }
}
