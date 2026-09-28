package com.slybrowser;

final class LicensedLaunchSettings {
  public LicenseServiceClientOptions trust = OfficialTrust.create();
  public InstallOptions install = new InstallOptions();
  public String platform;
  public String arch;
  public String deviceHash;
  public String kernelMajor;
  public Boolean updateKernel;
  public String browserVersion;
  public String versionPolicy;
  public WebDriverLaunchSettings webdriver = new WebDriverLaunchSettings();
}
