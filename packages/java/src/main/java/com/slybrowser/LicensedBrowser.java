package com.slybrowser;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Playwright;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

public final class LicensedBrowser {
  private static final int MAX_BOOTSTRAP_HEARTBEAT_FAILURES = 10;

  private LicensedBrowser() {}

  public static BrowserVersionAudit verifyBrowserVersionAudit(BrowserVersionAudit audit) {
    if (!audit.downloaded.equals(audit.selected) || !audit.launched.equals(audit.selected)) {
      throw new ArtifactException(
          "Browser version chain mismatch: selected=" + audit.selected +
              ", downloaded=" + audit.downloaded + ", launched=" + audit.launched,
          "browser_version_chain_mismatch");
    }
    if (audit.policy.equals("latest") && audit.requested != null ||
        audit.policy.equals("exact") && !Objects.equals(audit.requested, audit.selected) ||
        audit.policy.equals("at-or-before") && (audit.requested == null ||
            ReleaseManifestVerifier.compareVersion(audit.selected, audit.requested) > 0)) {
      throw new ArtifactException(
          "Requested and selected browser versions violate the declared policy",
          "browser_version_policy_mismatch");
    }
    return audit;
  }

  public static AuthorizedInstallation prepareAuthorizedBrowser(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return prepareLatestAuthorizedBrowser(authorizationFile, withDefaultUpdateKernel(settings, false));
  }

  public static AuthorizedInstallation prepareLatestAuthorizedBrowser(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return prepareLatestAuthorizedBrowser(authorizationFile, settings, AutomationBackend.PROJECT_WEBDRIVER);
  }

  private static AuthorizedInstallation prepareLatestAuthorizedBrowser(
      Path authorizationFile,
      LicensedLaunchSettings settings,
      AutomationBackend automationBackend) {
    if (settings == null || settings.trust == null) {
      throw new ConfigurationException("Licensed launch settings and trust keys are required", "config_invalid");
    }
    LicenseFileReadOptions readOptions = new LicenseFileReadOptions(settings.trust.allowInsecureLocalhost);
    readOptions.licenseFilePassphrase = settings.trust.licenseFilePassphrase;
    readOptions.licenseFileTrustedKeys = settings.trust.licenseFileTrustedKeys;
    readOptions.trustedServiceUrls = settings.trust.trustedServiceUrls;
    LicenseAuthorization authorization = LicenseServiceClient.readAuthorization(authorizationFile, readOptions);
    LicenseServiceClient client = new LicenseServiceClient(authorization, settings.trust);
    CreateRuntimeSessionOptions sessionOptions = new CreateRuntimeSessionOptions();
    sessionOptions.platform = settings.platform;
    sessionOptions.arch = settings.arch;
    sessionOptions.automationBackend = automationBackend;
    sessionOptions.deviceHash = settings.deviceHash;
    sessionOptions.kernelMajor = settings.kernelMajor;
    sessionOptions.updateKernel = settings.updateKernel == null ? Boolean.TRUE : settings.updateKernel;
    sessionOptions.browserVersion = settings.browserVersion;
    sessionOptions.versionPolicy = settings.versionPolicy;
    BrowserInstallation current = null;
    if (Boolean.FALSE.equals(sessionOptions.updateKernel) &&
        sessionOptions.browserVersion == null &&
        sessionOptions.versionPolicy == null) {
      current = BrowserInstaller.findCurrentBrowserInstallation(
          settings.install,
          settings.platform,
          settings.arch,
          settings.kernelMajor);
      if (current != null) {
        sessionOptions.browserVersion = current.version;
        sessionOptions.versionPolicy = "exact";
      }
    }
    RuntimeSessionGrant grant;
    try {
      grant = client.createRuntimeSession(sessionOptions);
    } catch (LicenseServiceException error) {
      if (current != null && error.getCode().equals("release_version_unavailable")) {
        throw new LicenseServiceException(
            "The current local browser release was withdrawn; update is required before continuing",
            "kernel_update_required",
            409,
            error);
      }
      throw error;
    }
    BootstrapHeartbeat heartbeat = new BootstrapHeartbeat(client, grant);
    heartbeat.start();
    try {
      BrowserInstallation installation = BrowserInstaller.installGrantedBrowser(
          client,
          grant,
          settings.install);
      if (heartbeat.failure != null && heartbeat.consecutiveFailures >= MAX_BOOTSTRAP_HEARTBEAT_FAILURES) {
        throw heartbeat.failure;
      }
      return new AuthorizedInstallation(client, grant, installation);
    } catch (RuntimeException error) {
      try { client.releaseRuntimeSession(grant); } catch (RuntimeException ignored) { }
      throw error;
    } finally {
      heartbeat.close();
    }
  }

  public static BrowserInstallation installLatest(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    try (AuthorizedInstallation authorized = prepareLatestAuthorizedBrowser(authorizationFile, settings)) {
      return authorized.installation;
    }
  }

  public static BrowserInstallation installAuthorized(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    try (AuthorizedInstallation authorized = prepareAuthorizedBrowser(authorizationFile, settings)) {
      return authorized.installation;
    }
  }

  public static SlyWebDriverSession launchLatest(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    AuthorizedInstallation authorized = prepareLatestAuthorizedBrowser(authorizationFile, settings);
    BrowserInstallationReference reference = BrowserInstaller.acquireBrowserInstallationReference(authorized.installation);
    SlyWebDriverSession session = null;
    BootstrapHeartbeat heartbeat = new BootstrapHeartbeat(authorized.client, authorized.grant);
    Object previousRuntimeHandoff = settings.webdriver.runtimeHandoff;
    Object previousDriverRuntimeHandoff = settings.webdriver.driverRuntimeHandoff;
    boolean previousAllowRuntimeActivationTicket = settings.webdriver.allowRuntimeActivationTicket;
    try {
      heartbeat.start();
      settings.webdriver.runtimeHandoff = runtimeBootstrapHandoff(
          authorized.client,
          authorized.grant,
          previousRuntimeHandoff);
      settings.webdriver.driverRuntimeHandoff = driverRuntimeBootstrapHandoff(
          authorized.client,
          authorized.grant,
          previousDriverRuntimeHandoff);
      settings.webdriver.allowRuntimeActivationTicket = true;
      session = SlyBrowserWebDriver.launch(
          authorized.installation.browserExecutable,
          authorized.installation.driverExecutable,
          authorized.grant.leaseEnvelope,
          settings.webdriver);
      BrowserVersionAudit audit = verifyBrowserVersionAudit(new BrowserVersionAudit(
          authorized.grant.requestedBrowserVersion,
          authorized.grant.browserVersion,
          authorized.installation.version,
          session.getBrowserVersion(),
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason));
      heartbeat.close();
      session.licenseRuntime = new LicenseRuntimeMetadata(
          authorized.grant.sessionId,
          authorized.grant.plan,
          authorized.grant.concurrencyLimit,
          authorized.grant.browserVersion,
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason,
          audit);
      session.addCloseCallback(() -> {
        try { authorized.release(); }
        finally { reference.release(); }
      });
      return session;
    } catch (RuntimeException error) {
      heartbeat.close();
      if (session != null) {
        try { session.close(); } catch (RuntimeException ignored) { }
      }
      try { reference.release(); } catch (RuntimeException ignored) { }
      try { authorized.release(); } catch (RuntimeException ignored) { }
      throw error;
    } finally {
      settings.webdriver.runtimeHandoff = previousRuntimeHandoff;
      settings.webdriver.driverRuntimeHandoff = previousDriverRuntimeHandoff;
      settings.webdriver.allowRuntimeActivationTicket = previousAllowRuntimeActivationTicket;
    }
  }

  public static SlyWebDriverSession launchAuthorized(
      Path authorizationFile,
      LicensedLaunchSettings settings) {
    return launchWithAuthorizedDefaults(authorizationFile, settings, false);
  }

  public static LicensedPlaywrightBrowser launchLatestPlaywright(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings playwrightSettings) {
    return launchPlaywrightWithAuthorizedDefaults(playwright, authorizationFile, settings, playwrightSettings, true);
  }

  public static LicensedPlaywrightBrowser launchAuthorizedPlaywright(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings playwrightSettings) {
    return launchPlaywrightWithAuthorizedDefaults(playwright, authorizationFile, settings, playwrightSettings, false);
  }

  public static LicensedPlaywrightContext launchLatestPlaywrightPersistent(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings playwrightSettings) {
    return launchPlaywrightPersistentWithAuthorizedDefaults(
        playwright,
        userDataDir,
        authorizationFile,
        settings,
        playwrightSettings,
        true);
  }

  public static LicensedPlaywrightContext launchAuthorizedPlaywrightPersistent(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings playwrightSettings) {
    return launchPlaywrightPersistentWithAuthorizedDefaults(
        playwright,
        userDataDir,
        authorizationFile,
        settings,
        playwrightSettings,
        false);
  }

  private static SlyWebDriverSession launchWithAuthorizedDefaults(
      Path authorizationFile,
      LicensedLaunchSettings settings,
      boolean updateKernelDefault) {
    AuthorizedInstallation authorized = prepareLatestAuthorizedBrowser(
        authorizationFile,
        withDefaultUpdateKernel(settings, updateKernelDefault));
    BrowserInstallationReference reference = BrowserInstaller.acquireBrowserInstallationReference(authorized.installation);
    SlyWebDriverSession session = null;
    BootstrapHeartbeat heartbeat = new BootstrapHeartbeat(authorized.client, authorized.grant);
    Object previousRuntimeHandoff = settings.webdriver.runtimeHandoff;
    Object previousDriverRuntimeHandoff = settings.webdriver.driverRuntimeHandoff;
    boolean previousAllowRuntimeActivationTicket = settings.webdriver.allowRuntimeActivationTicket;
    try {
      heartbeat.start();
      settings.webdriver.runtimeHandoff = runtimeBootstrapHandoff(
          authorized.client,
          authorized.grant,
          previousRuntimeHandoff);
      settings.webdriver.driverRuntimeHandoff = driverRuntimeBootstrapHandoff(
          authorized.client,
          authorized.grant,
          previousDriverRuntimeHandoff);
      settings.webdriver.allowRuntimeActivationTicket = true;
      session = SlyBrowserWebDriver.launch(
          authorized.installation.browserExecutable,
          authorized.installation.driverExecutable,
          authorized.grant.leaseEnvelope,
          settings.webdriver);
      BrowserVersionAudit audit = verifyBrowserVersionAudit(new BrowserVersionAudit(
          authorized.grant.requestedBrowserVersion,
          authorized.grant.browserVersion,
          authorized.installation.version,
          session.getBrowserVersion(),
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason));
      heartbeat.close();
      session.licenseRuntime = new LicenseRuntimeMetadata(
          authorized.grant.sessionId,
          authorized.grant.plan,
          authorized.grant.concurrencyLimit,
          authorized.grant.browserVersion,
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason,
          audit);
      session.addCloseCallback(() -> {
        try { authorized.release(); }
        finally { reference.release(); }
      });
      return session;
    } catch (RuntimeException error) {
      heartbeat.close();
      if (session != null) {
        try { session.close(); } catch (RuntimeException ignored) { }
      }
      try { reference.release(); } catch (RuntimeException ignored) { }
      try { authorized.release(); } catch (RuntimeException ignored) { }
      throw error;
    } finally {
      settings.webdriver.runtimeHandoff = previousRuntimeHandoff;
      settings.webdriver.driverRuntimeHandoff = previousDriverRuntimeHandoff;
      settings.webdriver.allowRuntimeActivationTicket = previousAllowRuntimeActivationTicket;
    }
  }

  private static LicensedPlaywrightBrowser launchPlaywrightWithAuthorizedDefaults(
      Playwright playwright,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightLaunchSettings suppliedPlaywrightSettings,
      boolean updateKernelDefault) {
    AuthorizedInstallation authorized = prepareLatestAuthorizedBrowser(
        authorizationFile,
        withDefaultUpdateKernel(settings, updateKernelDefault),
        AutomationBackend.PLAYWRIGHT);
    BrowserInstallationReference reference = BrowserInstaller.acquireBrowserInstallationReference(authorized.installation);
    BootstrapHeartbeat heartbeat = new BootstrapHeartbeat(authorized.client, authorized.grant);
    Browser browser = null;
    try {
      heartbeat.start();
      PlaywrightLaunchSettings launchSettings = withRuntimeHandoff(
          suppliedPlaywrightSettings == null ? new PlaywrightLaunchSettings() : suppliedPlaywrightSettings,
          runtimeBootstrapHandoff(
              authorized.client,
              authorized.grant,
              suppliedPlaywrightSettings == null ? null : suppliedPlaywrightSettings.runtimeHandoff));
      browser = SlyBrowserPlaywright.launch(
          playwright,
          authorized.installation.browserExecutable,
          authorized.grant.leaseEnvelope,
          launchSettings);
      BrowserVersionAudit audit = verifyBrowserVersionAudit(new BrowserVersionAudit(
          authorized.grant.requestedBrowserVersion,
          authorized.grant.browserVersion,
          authorized.installation.version,
          normalizeFrameworkBrowserVersion(browser.version()),
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason));
      heartbeat.close();
      LicenseRuntimeMetadata runtime = new LicenseRuntimeMetadata(
          authorized.grant.sessionId,
          authorized.grant.plan,
          authorized.grant.concurrencyLimit,
          authorized.grant.browserVersion,
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason,
          audit);
      return new LicensedPlaywrightBrowser(browser, runtime, () -> {
        try { releaseFrameworkAuthorization(authorized); }
        finally { reference.release(); }
      });
    } catch (RuntimeException error) {
      heartbeat.close();
      if (browser != null) {
        try { browser.close(); } catch (RuntimeException ignored) { }
      }
      try { reference.release(); } catch (RuntimeException ignored) { }
      try { authorized.release(); } catch (RuntimeException ignored) { }
      throw error;
    }
  }

  private static LicensedPlaywrightContext launchPlaywrightPersistentWithAuthorizedDefaults(
      Playwright playwright,
      Path userDataDir,
      Path authorizationFile,
      LicensedLaunchSettings settings,
      PlaywrightPersistentLaunchSettings suppliedPlaywrightSettings,
      boolean updateKernelDefault) {
    AuthorizedInstallation authorized = prepareLatestAuthorizedBrowser(
        authorizationFile,
        withDefaultUpdateKernel(settings, updateKernelDefault),
        AutomationBackend.PLAYWRIGHT);
    BrowserInstallationReference reference = BrowserInstaller.acquireBrowserInstallationReference(authorized.installation);
    BootstrapHeartbeat heartbeat = new BootstrapHeartbeat(authorized.client, authorized.grant);
    BrowserContext context = null;
    try {
      heartbeat.start();
      PlaywrightPersistentLaunchSettings launchSettings = withRuntimeHandoff(
          suppliedPlaywrightSettings == null ? new PlaywrightPersistentLaunchSettings() : suppliedPlaywrightSettings,
          runtimeBootstrapHandoff(
              authorized.client,
              authorized.grant,
              suppliedPlaywrightSettings == null ? null : suppliedPlaywrightSettings.runtimeHandoff));
      context = SlyBrowserPlaywright.launchPersistentContext(
          playwright,
          userDataDir,
          authorized.installation.browserExecutable,
          authorized.grant.leaseEnvelope,
          launchSettings);
      BrowserVersionAudit audit = verifyBrowserVersionAudit(new BrowserVersionAudit(
          authorized.grant.requestedBrowserVersion,
          authorized.grant.browserVersion,
          authorized.installation.version,
          normalizeFrameworkBrowserVersion(context.browser().version()),
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason));
      heartbeat.close();
      LicenseRuntimeMetadata runtime = new LicenseRuntimeMetadata(
          authorized.grant.sessionId,
          authorized.grant.plan,
          authorized.grant.concurrencyLimit,
          authorized.grant.browserVersion,
          authorized.grant.versionPolicy,
          authorized.grant.selectionReason,
          audit);
      return new LicensedPlaywrightContext(context, runtime, () -> {
        try { releaseFrameworkAuthorization(authorized); }
        finally { reference.release(); }
      });
    } catch (RuntimeException error) {
      heartbeat.close();
      if (context != null) {
        try { context.close(); } catch (RuntimeException ignored) { }
      }
      try { reference.release(); } catch (RuntimeException ignored) { }
      try { authorized.release(); } catch (RuntimeException ignored) { }
      throw error;
    }
  }

  private static Map<String, Object> runtimeBootstrapHandoff(
      LicenseServiceClient client,
      RuntimeSessionGrant grant,
      Object existing) {
    return runtimeBootstrapHandoff(client, grant, existing, grant.activationTicket);
  }

  private static void releaseFrameworkAuthorization(AuthorizedInstallation authorized) {
    try {
      authorized.release();
    } catch (LicenseServiceException error) {
      boolean alreadyClosed = error.getStatus() == 401 && "session_invalid".equals(error.getCode());
      boolean rateLimited = error.getStatus() == 429 && "request_rate_limited".equals(error.getCode());
      if (!alreadyClosed && !rateLimited) {
        throw error;
      }
    }
  }

  private static Map<String, Object> driverRuntimeBootstrapHandoff(
      LicenseServiceClient client,
      RuntimeSessionGrant grant,
      Object existing) {
    if (grant.driverActivationTicket == null || grant.driverActivationTicket.isEmpty()) {
      throw new ConfigurationException(
          "Project WebDriver runtime session is missing a driver activation ticket",
          "license_service_invalid_response");
    }
    return runtimeBootstrapHandoff(client, grant, existing, grant.driverActivationTicket);
  }

  private static Map<String, Object> runtimeBootstrapHandoff(
      LicenseServiceClient client,
      RuntimeSessionGrant grant,
      Object existing,
      String activationTicket) {
    Map<String, Object> result = new LinkedHashMap<>();
    if (existing instanceof Map<?, ?>) {
      Map<?, ?> values = (Map<?, ?>) existing;
      for (Map.Entry<?, ?> entry : values.entrySet()) {
        if (entry.getKey() instanceof String) result.put((String) entry.getKey(), entry.getValue());
      }
    } else if (existing != null) {
      result.put("userRuntimeHandoff", existing);
    }
    result.put("schemaVersion", 2);
    result.put("serviceUrl", client.authorization.serviceUrl);
    result.put("state", grant.state);
    result.put("startupId", grant.startupId);
    result.put("sessionId", grant.sessionId);
    result.put("bootstrapToken", grant.bootstrapToken);
    result.put("activationTicket", activationTicket);
    result.put("heartbeatAfterSeconds", grant.heartbeatAfterSeconds);
    result.put("expiresAt", grant.expiresAt);
    result.put("plan", grant.plan);
    result.put("features", grant.features);
    result.put("concurrencyLimit", grant.concurrencyLimit);
    result.put("activeSessions", grant.activeSessions);
    result.put("browserVersion", grant.browserVersion);
    if (grant.automationBackend != null) result.put("automationBackend", grant.automationBackend.value());
    return result;
  }

  private static final class BootstrapHeartbeat implements AutoCloseable {
    private final LicenseServiceClient client;
    private final RuntimeSessionGrant grant;
    private final Thread thread;
    private volatile boolean stopped;
    private volatile RuntimeException failure;
    private volatile int consecutiveFailures;

    BootstrapHeartbeat(LicenseServiceClient client, RuntimeSessionGrant grant) {
      this.client = client;
      this.grant = grant;
      this.thread = new Thread(this::run, "sly-bootstrap-license-heartbeat");
      this.thread.setDaemon(true);
    }

    void start() {
      thread.start();
    }

    private void run() {
      while (!stopped) {
        try {
          Thread.sleep(heartbeatDelayMillis(grant.heartbeatAfterSeconds));
          if (stopped) return;
          RuntimeHeartbeatGrant renewal = client.bootstrapHeartbeat(grant);
          grant.expiresAt = renewal.expiresAt;
          grant.leaseEnvelope = renewal.leaseEnvelope;
          grant.claims = renewal.claims;
          failure = null;
          consecutiveFailures = 0;
        } catch (InterruptedException ignored) {
          Thread.currentThread().interrupt();
          return;
        } catch (RuntimeException error) {
          failure = error;
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_BOOTSTRAP_HEARTBEAT_FAILURES) return;
        }
      }
    }

    @Override
    public void close() {
      stopped = true;
      thread.interrupt();
      try { thread.join(2_000); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
    }
  }

  static long heartbeatDelayMillis(int heartbeatAfterSeconds) {
    long base = Math.max(1, heartbeatAfterSeconds);
    return base * 1_000;
  }

  private static LicensedLaunchSettings withDefaultUpdateKernel(LicensedLaunchSettings settings, boolean updateKernel) {
    if (settings == null || settings.updateKernel != null) return settings;
    LicensedLaunchSettings copy = new LicensedLaunchSettings();
    copy.trust = settings.trust;
    copy.install = settings.install;
    copy.platform = settings.platform;
    copy.arch = settings.arch;
    copy.deviceHash = settings.deviceHash;
    copy.kernelMajor = settings.kernelMajor;
    copy.updateKernel = updateKernel;
    copy.browserVersion = settings.browserVersion;
    copy.versionPolicy = settings.versionPolicy;
    copy.webdriver = settings.webdriver;
    return copy;
  }

  private static PlaywrightLaunchSettings withRuntimeHandoff(
      PlaywrightLaunchSettings settings,
      Object runtimeHandoff) {
    PlaywrightLaunchSettings copy = new PlaywrightLaunchSettings();
    copy.profile = settings.profile;
    copy.tempRoot = settings.tempRoot;
    copy.frameworkVersion = settings.frameworkVersion;
    copy.humanize = settings.humanize;
    copy.humanPreset = settings.humanPreset;
    copy.humanConfig = settings.humanConfig;
    copy.humanSeed = settings.humanSeed;
    copy.runtimeHandoff = runtimeHandoff;
    copy.allowRuntimeActivationTicket = true;
    copy.releaseRoot = settings.releaseRoot;
    copy.nativeReady = settings.nativeReady;
    copy.nativeReadyTimeoutMs = settings.nativeReadyTimeoutMs;
    copy.configure = settings.configure;
    return copy;
  }

  private static PlaywrightPersistentLaunchSettings withRuntimeHandoff(
      PlaywrightPersistentLaunchSettings settings,
      Object runtimeHandoff) {
    PlaywrightPersistentLaunchSettings copy = new PlaywrightPersistentLaunchSettings();
    copy.profile = settings.profile;
    copy.tempRoot = settings.tempRoot;
    copy.frameworkVersion = settings.frameworkVersion;
    copy.humanize = settings.humanize;
    copy.humanPreset = settings.humanPreset;
    copy.humanConfig = settings.humanConfig;
    copy.humanSeed = settings.humanSeed;
    copy.runtimeHandoff = runtimeHandoff;
    copy.allowRuntimeActivationTicket = true;
    copy.releaseRoot = settings.releaseRoot;
    copy.nativeReady = settings.nativeReady;
    copy.nativeReadyTimeoutMs = settings.nativeReadyTimeoutMs;
    copy.configure = settings.configure;
    return copy;
  }

  private static String normalizeFrameworkBrowserVersion(String value) {
    java.util.regex.Matcher matcher = java.util.regex.Pattern
        .compile("(\\d+\\.\\d+\\.\\d+\\.\\d+)")
        .matcher(value);
    if (!matcher.find()) {
      throw new ArtifactException(
          "Framework browser returned an unsupported version string: " + value,
          "browser_version_invalid");
    }
    return matcher.group(1);
  }
}
