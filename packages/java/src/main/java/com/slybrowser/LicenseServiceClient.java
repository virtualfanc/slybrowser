package com.slybrowser;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.InputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class LicenseServiceClient {
  private static final int NETWORK_TIMEOUT_MILLIS = 30_000;
  private static final Set<String> PLANS = Set.of("free", "basic", "pro", "max", "ultra");
  private static final Set<String> SAFE_ERROR_DETAIL_FIELDS = Set.of(
      "state",
      "concurrencyLimit",
      "activeSessions",
      "availableSessions",
      "retryAfterSeconds",
      "action",
      "dimension");
  private final LicenseVerifier licenseVerifier;
  private final Map<String, byte[]> releaseTrustedKeys;
  private final LicenseServiceClientOptions.JsonTransport transport;
  private final LicenseServiceClientOptions.ArtifactDownloader artifactDownloader;
  private final String sdkVersion;
  public final LicenseAuthorization authorization;

  public LicenseServiceClient(LicenseAuthorization authorization, LicenseServiceClientOptions options) {
    this.authorization = parseAuthorization(authorization, options.allowInsecureLocalhost);
    this.licenseVerifier = new LicenseVerifier(options.licenseTrustedKeys);
    this.releaseTrustedKeys = Map.copyOf(options.releaseTrustedKeys);
    this.transport = options.transport == null ? LicenseServiceClient::defaultTransport : options.transport;
    this.artifactDownloader = options.artifactDownloader == null
        ? LicenseServiceClient::defaultArtifactDownloader
        : options.artifactDownloader;
    this.sdkVersion = options.sdkVersion;
  }

  public static LicenseAuthorization readAuthorization(Path path, boolean allowInsecureLocalhost) {
    LicenseFileReadOptions options = new LicenseFileReadOptions(allowInsecureLocalhost);
    return readAuthorization(path, options);
  }

  public static LicenseAuthorization readAuthorization(Path path, LicenseFileReadOptions options) {
    try {
      byte[] raw = Files.readAllBytes(path.toAbsolutePath().normalize());
      if (raw.length > 64 * 1024) throw fail("authorization_invalid", "Authorization file is too large");
      JsonNode root = CanonicalJson.MAPPER.readTree(raw);
      if (root != null && root.isObject() && root.has("schemaVersion") && root.get("schemaVersion").asInt() == 2) {
        return LicenseFileReader.read(root, options);
      }
      return parseAuthorization(root, options != null && options.allowInsecureLocalhost);
    } catch (LicenseServiceException error) {
      throw error;
    } catch (IOException error) {
      throw fail("authorization_invalid", "Authorization file is not valid JSON", 0, error);
    }
  }

  public LicenseInfo licenseInfo(CreateSessionOptions supplied) {
    CreateSessionOptions options = supplied == null ? new CreateSessionOptions() : supplied;
    String platform = options.platform == null ? currentPlatform() : options.platform;
    String arch = options.arch == null ? currentArch() : options.arch;
    String policy = options.versionPolicy == null
        ? (options.browserVersion == null ? "latest" : "exact")
        : options.versionPolicy;
    if (!Set.of("latest", "exact", "at-or-before").contains(policy)) {
      throw fail("version_policy_invalid", "Unsupported browser version policy: " + policy);
    }
    if (policy.equals("latest") && options.browserVersion != null) {
      throw fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (!policy.equals("latest") && options.browserVersion == null) {
      throw fail("version_policy_invalid", policy + " selection requires a browser version");
    }
    if (options.browserVersion != null) ReleaseManifestVerifier.compareVersion(options.browserVersion, options.browserVersion);
    Object kernelMajor = normalizeKernelMajor(options.kernelMajor);
    boolean updateKernel = options.updateKernel != null && options.updateKernel.booleanValue();
    if (options.browserVersion != null && kernelMajor instanceof Integer &&
        browserMajor(options.browserVersion) != (Integer) kernelMajor) {
      throw fail("version_policy_invalid", "browserVersion does not match kernelMajor");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("platform", platform);
    body.put("arch", arch);
    body.put("channel", authorization.channel);
    body.put("sdkVersion", sdkVersion);
    if (options.deviceHash != null) body.put("deviceHash", options.deviceHash);
    body.put("kernelMajor", kernelMajor);
    body.put("updateKernel", updateKernel);
    body.put("versionPolicy", policy);
    if (options.browserVersion != null) body.put("browserVersion", options.browserVersion);
    JsonNode root = request("POST", "/v2/licenses/info", "License " + authorization.licenseKey, body);

    String status = text(root, "licenseStatus");
    String plan = text(root, "plan");
    String effectivePlan = text(root, "effectivePlan");
    String browserVersion = text(root, "browserVersion");
    String returnedPolicy = text(root, "versionPolicy");
    String selectionReason = text(root, "selectionReason");
    String requestedBrowserVersion = root.has("requestedBrowserVersion") && !root.get("requestedBrowserVersion").isNull()
        ? root.get("requestedBrowserVersion").asText()
        : null;
    if (integer(root, "schemaVersion") != 1 ||
        !"stable".equals(text(root, "channel")) ||
        !Set.of("active", "hold", "revoked").contains(status) ||
        !PLANS.contains(plan) ||
        !PLANS.contains(effectivePlan) ||
        !returnedPolicy.equals(policy) ||
        !Set.of("latest", "exact", "rollback").contains(selectionReason) ||
        !java.util.Objects.equals(requestedBrowserVersion, options.browserVersion) ||
        (root.has("stableErrorCode") && !root.get("stableErrorCode").isNull())) {
      throw fail("license_service_invalid_response", "License service info response is invalid");
    }
    int concurrency = (int) integer(root, "concurrencyLimit");
    int active = (int) integer(root, "activeSessions");
    int availableSessions = (int) integer(root, "availableSessions");
    JsonNode state = root.get("sessionState");
    if (state == null || !state.isObject() ||
        integer(state, "activeBrowserProcesses") != active ||
        integer(state, "limit") != concurrency ||
        integer(state, "available") != availableSessions) {
      throw fail("license_service_invalid_response", "License service session-state response is invalid");
    }
    Map<String, Integer> sessionState = new LinkedHashMap<>();
    sessionState.put("activeBrowserProcesses", active);
    sessionState.put("limit", concurrency);
    sessionState.put("available", availableSessions);
    Long paidThrough = root.has("paidThrough") && !root.get("paidThrough").isNull()
        ? root.get("paidThrough").asLong()
        : null;
    return new LicenseInfo(
        1, "stable", status, plan, effectivePlan, paidThrough,
        responseFeatures(root.get("features"), List.of()),
        concurrency, active, availableSessions, sessionState, browserVersion, requestedBrowserVersion,
        optionalKernelMajor(root), policy, selectionReason, optionalSelectionMode(root),
        stringArray(root.get("availableBrowserVersions")), optionalVersion(root, "latestAvailableVersion"),
        optionalBoolean(root, "updateAvailable"), optionalBoolean(root, "updateRequired"),
        updateRights(root.get("updateRights")), null);
  }

  public LicensedSessionGrant createSession(CreateSessionOptions supplied) {
    CreateSessionOptions options = supplied == null ? new CreateSessionOptions() : supplied;
    String platform = options.platform == null ? currentPlatform() : options.platform;
    String arch = options.arch == null ? currentArch() : options.arch;
    String policy = options.versionPolicy == null
        ? (options.browserVersion == null ? "latest" : "exact")
        : options.versionPolicy;
    if (!Set.of("latest", "exact", "at-or-before").contains(policy)) {
      throw fail("version_policy_invalid", "Unsupported browser version policy: " + policy);
    }
    if (policy.equals("latest") && options.browserVersion != null) {
      throw fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (!policy.equals("latest") && options.browserVersion == null) {
      throw fail("version_policy_invalid", policy + " selection requires a browser version");
    }
    if (options.browserVersion != null) ReleaseManifestVerifier.compareVersion(options.browserVersion, options.browserVersion);
    Object kernelMajor = normalizeKernelMajor(options.kernelMajor);
    boolean updateKernel = options.updateKernel != null && options.updateKernel.booleanValue();
    if (options.browserVersion != null && kernelMajor instanceof Integer &&
        browserMajor(options.browserVersion) != (Integer) kernelMajor) {
      throw fail("version_policy_invalid", "browserVersion does not match kernelMajor");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("platform", platform);
    body.put("arch", arch);
    body.put("channel", authorization.channel);
    body.put("sdkVersion", sdkVersion);
    if (options.deviceHash != null) body.put("deviceHash", options.deviceHash);
    body.put("kernelMajor", kernelMajor);
    body.put("updateKernel", updateKernel);
    body.put("versionPolicy", policy);
    if (options.browserVersion != null) body.put("browserVersion", options.browserVersion);
    JsonNode root = request("POST", "/v1/licenses/sessions", "License " + authorization.licenseKey, body);

    String sessionId = text(root, "sessionId");
    String sessionToken = text(root, "sessionToken");
    String browserVersion = text(root, "browserVersion");
    int heartbeat = (int) integer(root, "heartbeatAfterSeconds");
    long expiresAt = integer(root, "expiresAt");
    String returnedPolicy = text(root, "versionPolicy");
    String selectionReason = text(root, "selectionReason");
    String requestedBrowserVersion = root.has("requestedBrowserVersion") && !root.get("requestedBrowserVersion").isNull()
        ? root.get("requestedBrowserVersion").asText()
        : null;
    if (!returnedPolicy.equals(policy) ||
        !Set.of("latest", "exact", "rollback").contains(selectionReason) ||
        !java.util.Objects.equals(requestedBrowserVersion, options.browserVersion)) {
      throw fail("license_service_invalid_response", "License service version-selection response is invalid");
    }
    if (policy.equals("exact") && !browserVersion.equals(options.browserVersion)) {
      throw fail("release_version_mismatch", "Requested browser " + options.browserVersion + " but service selected " + browserVersion);
    }
    if (policy.equals("at-or-before") && ReleaseManifestVerifier.compareVersion(browserVersion, options.browserVersion) > 0) {
      throw fail("release_version_mismatch", "Rollback selection is newer than the requested browser version");
    }
    List<String> available = stringArray(root.get("availableBrowserVersions"));
    Map<String, Object> rights = updateRights(root.get("updateRights"));
    Object requestedKernelMajor = optionalKernelMajor(root);
    String selectionMode = optionalSelectionMode(root);
    String latestAvailableVersion = optionalVersion(root, "latestAvailableVersion");
    Boolean updateAvailable = optionalBoolean(root, "updateAvailable");
    Boolean updateRequired = optionalBoolean(root, "updateRequired");
    String leaseEnvelope = root.get("lease").toString();
    LicenseClaims claims = licenseVerifier.verify(
        leaseEnvelope,
        browserVersion,
        requiredLeaseFeatures(null),
        options.deviceHash);
    if (!claims.sessionId.equals(sessionId) || claims.expiresAt != expiresAt) {
      throw fail("license_service_invalid_response", "Signed lease does not match the allocated session");
    }
    ReleaseManifest manifest = ReleaseManifestVerifier.verify(root.get("manifest"), releaseTrustedKeys);
    if (!manifest.browserVersion.equals(browserVersion)) {
      throw fail("license_service_invalid_response", "Release manifest does not match the signed lease");
    }
    if (!ReleaseManifestVerifier.isSdkCompatible(manifest.sdkCompatibility, sdkVersion)) {
      throw fail("sdk_version_unsupported", "Browser " + browserVersion + " does not support SDK " + sdkVersion);
    }
    ReleaseArtifact artifact = manifest.select(platform, arch);
    if (!origin(artifact.url).equals(origin(authorization.serviceUrl))) {
      throw fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
    }
    String plan = text(root, "plan");
    int concurrency = (int) integer(root, "concurrencyLimit");
    int active = (int) integer(root, "activeSessions");
    if (!PLANS.contains(plan)) {
      throw fail("license_service_invalid_response", "License service plan response is invalid");
    }
    List<String> features = responseFeatures(root.get("features"), claims.features);
    assertClaimsMatchPlan(claims, plan, concurrency, features);
    return new LicensedSessionGrant(
        sessionId, sessionToken, heartbeat, expiresAt, plan, features, concurrency, active,
        browserVersion, requestedBrowserVersion, requestedKernelMajor, policy, selectionReason,
        selectionMode, available, latestAvailableVersion, updateAvailable, updateRequired, rights,
        leaseEnvelope, claims, manifest, artifact, platform, arch);
  }

  public RuntimeSessionGrant createRuntimeSession(CreateRuntimeSessionOptions supplied) {
    CreateRuntimeSessionOptions options = supplied == null ? new CreateRuntimeSessionOptions() : supplied;
    String platform = options.platform == null ? currentPlatform() : options.platform;
    String arch = options.arch == null ? currentArch() : options.arch;
    String startupId = options.startupId == null ? newStartupId() : options.startupId;
    if (!startupId.matches("^st_[A-Za-z0-9_-]{16,120}$")) {
      throw fail("startup_id_invalid", "Runtime startup ID is invalid");
    }
    String policy = options.versionPolicy == null
        ? (options.browserVersion == null ? "latest" : "exact")
        : options.versionPolicy;
    if (!Set.of("latest", "exact", "at-or-before").contains(policy)) {
      throw fail("version_policy_invalid", "Unsupported browser version policy: " + policy);
    }
    if (policy.equals("latest") && options.browserVersion != null) {
      throw fail("version_policy_invalid", "Latest selection cannot include a requested browser version");
    }
    if (!policy.equals("latest") && options.browserVersion == null) {
      throw fail("version_policy_invalid", policy + " selection requires a browser version");
    }
    if (options.browserVersion != null) ReleaseManifestVerifier.compareVersion(options.browserVersion, options.browserVersion);
    Object kernelMajor = normalizeKernelMajor(options.kernelMajor);
    boolean updateKernel = options.updateKernel != null && options.updateKernel.booleanValue();
    if (options.browserVersion != null && kernelMajor instanceof Integer &&
        browserMajor(options.browserVersion) != (Integer) kernelMajor) {
      throw fail("version_policy_invalid", "browserVersion does not match kernelMajor");
    }
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("startupId", startupId);
    body.put("platform", platform);
    body.put("arch", arch);
    body.put("channel", authorization.channel);
    body.put("sdkVersion", sdkVersion);
    if (options.automationBackend != null) body.put("automationBackend", options.automationBackend.value());
    if (options.deviceHash != null) body.put("deviceHash", options.deviceHash);
    body.put("kernelMajor", kernelMajor);
    body.put("updateKernel", updateKernel);
    body.put("versionPolicy", policy);
    if (options.browserVersion != null) body.put("browserVersion", options.browserVersion);
    JsonNode root = request("POST", "/v2/runtime/sessions", "License " + authorization.licenseKey, body);

    if (integer(root, "schemaVersion") != 2 ||
        !Set.of("reserved", "active", "closing").contains(text(root, "state")) ||
        !startupId.equals(text(root, "startupId"))) {
      throw fail("license_service_invalid_response", "Runtime session response is invalid");
    }
    String sessionId = text(root, "sessionId");
    String bootstrapToken = text(root, "bootstrapToken");
    String activationTicket = text(root, "activationTicket");
    String driverActivationTicket = optionalText(root, "driverActivationTicket");
    if (options.automationBackend == AutomationBackend.PROJECT_WEBDRIVER && driverActivationTicket == null) {
      throw fail("license_service_invalid_response", "Project WebDriver runtime session is missing a driver activation ticket");
    }
    String browserVersion = text(root, "browserVersion");
    int heartbeat = (int) integer(root, "heartbeatAfterSeconds");
    long expiresAt = integer(root, "expiresAt");
    String returnedPolicy = text(root, "versionPolicy");
    String selectionReason = text(root, "selectionReason");
    String requestedBrowserVersion = root.has("requestedBrowserVersion") && !root.get("requestedBrowserVersion").isNull()
        ? root.get("requestedBrowserVersion").asText()
        : null;
    if (!returnedPolicy.equals(policy) ||
        !Set.of("latest", "exact", "rollback").contains(selectionReason) ||
        !java.util.Objects.equals(requestedBrowserVersion, options.browserVersion)) {
      throw fail("license_service_invalid_response", "Runtime version-selection response is invalid");
    }
    if (policy.equals("exact") && !browserVersion.equals(options.browserVersion)) {
      throw fail("release_version_mismatch", "Requested browser " + options.browserVersion + " but service selected " + browserVersion);
    }
    if (policy.equals("at-or-before") && ReleaseManifestVerifier.compareVersion(browserVersion, options.browserVersion) > 0) {
      throw fail("release_version_mismatch", "Rollback selection is newer than the requested browser version");
    }
    List<String> available = stringArray(root.get("availableBrowserVersions"));
    Map<String, Object> rights = updateRights(root.get("updateRights"));
    Object requestedKernelMajor = optionalKernelMajor(root);
    String selectionMode = optionalSelectionMode(root);
    String latestAvailableVersion = optionalVersion(root, "latestAvailableVersion");
    Boolean updateAvailable = optionalBoolean(root, "updateAvailable");
    Boolean updateRequired = optionalBoolean(root, "updateRequired");
    String leaseEnvelope = root.get("lease").toString();
    LicenseClaims claims = licenseVerifier.verify(
        leaseEnvelope,
        browserVersion,
        requiredLeaseFeatures(options.automationBackend),
        options.deviceHash);
    if (!claims.sessionId.equals(sessionId) || claims.expiresAt != expiresAt) {
      throw fail("license_service_invalid_response", "Runtime lease does not match the allocated session");
    }
    ReleaseManifest manifest = ReleaseManifestVerifier.verify(root.get("manifest"), releaseTrustedKeys);
    if (!manifest.browserVersion.equals(browserVersion)) {
      throw fail("license_service_invalid_response", "Release manifest does not match the runtime lease");
    }
    if (!ReleaseManifestVerifier.isSdkCompatible(manifest.sdkCompatibility, sdkVersion)) {
      throw fail("sdk_version_unsupported", "Browser " + browserVersion + " does not support SDK " + sdkVersion);
    }
    ReleaseArtifact artifact = manifest.select(platform, arch);
    if (!origin(artifact.url).equals(origin(authorization.serviceUrl))) {
      throw fail("artifact_origin_invalid", "Authorized artifacts must be served by the license service origin");
    }
    JsonNode ticket = root.get("downloadTicket");
    if (ticket == null || !ticket.isObject()) {
      throw fail("license_service_invalid_response", "Runtime download ticket response is invalid");
    }
    String ticketToken = text(ticket, "token");
    long ticketExpiresAt = integer(ticket, "expiresAt");
    String artifactSha256 = text(ticket, "artifactSha256");
    String artifactUrl = text(ticket, "artifactUrl");
    if (ticketExpiresAt != expiresAt ||
        !artifactSha256.equals(artifact.sha256) ||
        !origin(artifactUrl).equals(origin(authorization.serviceUrl))) {
      throw fail("license_service_invalid_response", "Runtime download ticket response is invalid");
    }
    String plan = text(root, "plan");
    int concurrency = (int) integer(root, "concurrencyLimit");
    int active = (int) integer(root, "activeSessions");
    if (!PLANS.contains(plan)) {
      throw fail("license_service_invalid_response", "Runtime plan response is invalid");
    }
    List<String> features = responseFeatures(root.get("features"), claims.features);
    assertClaimsMatchPlan(claims, plan, concurrency, features);
    return new RuntimeSessionGrant(
        2, text(root, "state"), startupId, sessionId, bootstrapToken, activationTicket, driverActivationTicket, heartbeat, expiresAt,
        plan, features, concurrency, active, browserVersion, requestedBrowserVersion, requestedKernelMajor,
        policy, selectionReason, selectionMode, available, latestAvailableVersion, updateAvailable, updateRequired,
        rights, leaseEnvelope, claims, manifest, artifact, platform, arch,
        options.automationBackend,
        new RuntimeDownloadTicket(ticketToken, ticketExpiresAt, artifactSha256, artifactUrl));
  }

  public void heartbeat(LicensedSessionGrant grant) {
    JsonNode root = request(
        "POST",
        "/v1/licenses/sessions/" + encode(grant.sessionId) + "/heartbeat",
        "Session " + grant.sessionToken,
        Map.of());
    String leaseEnvelope = root.get("lease").toString();
    long expiresAt = integer(root, "expiresAt");
    LicenseClaims claims = licenseVerifier.verify(
        leaseEnvelope,
        grant.browserVersion,
        requiredLeaseFeatures(null),
        grant.claims.deviceHash);
    if (!claims.sessionId.equals(grant.sessionId) || claims.expiresAt != expiresAt) {
      throw fail("license_service_invalid_response", "Heartbeat lease does not match the active session");
    }
    String plan = text(root, "plan");
    int concurrency = (int) integer(root, "concurrencyLimit");
    if (!PLANS.contains(plan)) {
      throw fail("license_service_invalid_response", "Heartbeat plan response is invalid");
    }
    List<String> features = responseFeatures(root.get("features"), claims.features);
    assertClaimsMatchPlan(claims, plan, concurrency, features);
    grant.leaseEnvelope = leaseEnvelope;
    grant.claims = claims;
    grant.expiresAt = expiresAt;
  }

  public RuntimeHeartbeatGrant bootstrapHeartbeat(RuntimeSessionGrant grant) {
    JsonNode root = request(
        "POST",
        "/v2/runtime/sessions/" + encode(grant.sessionId) + "/bootstrap-heartbeat",
        "Bootstrap " + grant.bootstrapToken,
        null);
    return runtimeHeartbeatGrant(root, grant);
  }

  public RuntimeActivationGrant activateRuntimeSession(RuntimeSessionGrant grant) {
    JsonNode root = request(
        "POST",
        "/v2/runtime/sessions/" + encode(grant.sessionId) + "/activate",
        "Activation " + grant.activationTicket,
        null);
    RuntimeHeartbeatGrant heartbeat = runtimeHeartbeatGrant(root, grant);
    String runtimeToken = text(root, "runtimeToken");
    if (!"active".equals(heartbeat.state)) {
      throw fail("license_service_invalid_response", "Runtime activation response is invalid");
    }
    return new RuntimeActivationGrant(heartbeat, runtimeToken);
  }

  public RuntimeHeartbeatGrant runtimeHeartbeat(RuntimeActivationGrant grant) {
    JsonNode root = request(
        "POST",
        "/v2/runtime/sessions/" + encode(grant.sessionId) + "/heartbeat",
        "Runtime " + grant.runtimeToken,
        null);
    return runtimeHeartbeatGrant(root, grant);
  }

  public RuntimeHeartbeatGrant closeRuntimeSession(RuntimeActivationGrant grant) {
    JsonNode root = request(
        "POST",
        "/v2/runtime/sessions/" + encode(grant.sessionId) + "/close",
        "Runtime " + grant.runtimeToken,
        null);
    return runtimeHeartbeatGrant(root, grant);
  }

  public void release(LicensedSessionGrant grant) {
    request(
        "DELETE",
        "/v1/licenses/sessions/" + encode(grant.sessionId),
        "Session " + grant.sessionToken,
        null);
  }

  public void releaseRuntimeSession(RuntimeSessionGrant grant) {
    request(
        "DELETE",
        "/v2/runtime/sessions/" + encode(grant.sessionId),
        "Bootstrap " + grant.bootstrapToken,
        null);
  }

  public void releaseRuntimeSession(RuntimeActivationGrant grant) {
    request(
        "DELETE",
        "/v2/runtime/sessions/" + encode(grant.sessionId),
        "Runtime " + grant.runtimeToken,
        null);
  }

  public void downloadArtifact(LicensedSessionGrant grant, Path destination) {
    artifactDownloader.download(
        grant.artifact.url,
        Map.of("Authorization", "Session " + grant.sessionToken),
        destination);
  }

  public void downloadRuntimeArtifact(RuntimeSessionGrant grant, Path destination) {
    URI uri = URI.create(grant.downloadTicket.artifactUrl);
    String path = uri.getPath();
    if (path.startsWith("/v1/releases/artifacts/")) {
      path = path.replaceFirst("^/v1/releases/artifacts/", "/v2/runtime/artifacts/");
    }
    if (!path.startsWith("/v2/runtime/artifacts/")) {
      throw fail("license_service_invalid_response", "Runtime artifact URL is invalid");
    }
    URI runtimeUri = URI.create(uri.getScheme() + "://" + uri.getAuthority() + path);
    artifactDownloader.download(
        runtimeUri.toString(),
        Map.of("Authorization", "Download " + grant.downloadTicket.token),
        destination);
  }

  private RuntimeHeartbeatGrant runtimeHeartbeatGrant(JsonNode root, RuntimeHeartbeatGrant grant) {
    if (integer(root, "schemaVersion") != 2 ||
        !grant.startupId.equals(text(root, "startupId")) ||
        !grant.sessionId.equals(text(root, "sessionId")) ||
        !Set.of("reserved", "active", "closing").contains(text(root, "state"))) {
      throw fail("license_service_invalid_response", "Runtime heartbeat response is invalid");
    }
    long expiresAt = integer(root, "expiresAt");
    int heartbeat = (int) integer(root, "heartbeatAfterSeconds");
    String leaseEnvelope = root.get("lease").toString();
    LicenseClaims claims = licenseVerifier.verify(
        leaseEnvelope,
        grant.browserVersion,
        requiredLeaseFeatures(grant.automationBackend),
        grant.claims.deviceHash);
    if (!claims.sessionId.equals(grant.sessionId) || claims.expiresAt != expiresAt) {
      throw fail("license_service_invalid_response", "Runtime heartbeat lease does not match the active session");
    }
    String plan = text(root, "plan");
    int concurrency = (int) integer(root, "concurrencyLimit");
    int active = (int) integer(root, "activeSessions");
    if (!PLANS.contains(plan)) {
      throw fail("license_service_invalid_response", "Runtime heartbeat plan response is invalid");
    }
    List<String> features = responseFeatures(root.get("features"), claims.features);
    assertClaimsMatchPlan(claims, plan, concurrency, features);
    return new RuntimeHeartbeatGrant(
        2, text(root, "state"), grant.startupId, grant.sessionId, heartbeat, expiresAt,
        plan, features, concurrency, active, grant.browserVersion, grant.automationBackend, leaseEnvelope, claims);
  }

  private JsonNode request(String method, String path, String authorization, Object body) {
    byte[] raw = null;
    try {
      raw = body == null ? null : CanonicalJson.MAPPER.writeValueAsBytes(body);
    } catch (JsonProcessingException error) {
      throw fail("license_service_invalid_request", "License service request body is invalid", 0, error);
    }
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Authorization", authorization);
    if (raw != null) headers.put("Content-Type", "application/json");
    LicenseServiceClientOptions.TransportResponse response = transport.send(
        method,
        this.authorization.serviceUrl + path,
        headers,
        raw);
    if (response.status == 204) return CanonicalJson.MAPPER.createObjectNode();
    JsonNode value;
    try {
      value = CanonicalJson.MAPPER.readTree(response.body);
    } catch (IOException error) {
      throw fail("license_service_invalid_response", "License service returned invalid JSON", response.status, error);
    }
    if (response.status < 200 || response.status >= 300) {
      JsonNode error = value.get("error");
      String code = safeRemoteErrorCode(error);
      String message = remoteErrorMessage(response.status, code);
      throw new LicenseServiceException(message, code, response.status, safeErrorDetails(error));
    }
    if (!value.isObject()) throw fail("license_service_invalid_response", "License service returned an invalid object", response.status);
    return value;
  }

  private static LicenseServiceClientOptions.TransportResponse defaultTransport(
      String method,
      String url,
      Map<String, String> headers,
      byte[] body) {
    HttpURLConnection connection = null;
    try {
      connection = openConnection(url, method, headers);
      if (body != null) {
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream output = connection.getOutputStream()) {
          output.write(body);
        }
      }
      int status = connection.getResponseCode();
      try (InputStream input = responseStream(connection, status)) {
        return new LicenseServiceClientOptions.TransportResponse(
            status,
            input == null ? new byte[0] : input.readAllBytes());
      }
    } catch (IOException error) {
      throw fail("license_service_error", "License service request failed", 0, error);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private static void defaultArtifactDownloader(String url, Map<String, String> headers, Path destination) {
    HttpURLConnection connection = null;
    try {
      connection = openConnection(url, "GET", headers);
      int status = connection.getResponseCode();
      if (status != 200) {
        throw fail("artifact_download_failed", "Artifact download failed with HTTP " + status, status);
      }
      try (InputStream input = connection.getInputStream(); OutputStream output = Files.newOutputStream(destination)) {
        input.transferTo(output);
      }
    } catch (IOException error) {
      throw fail("artifact_download_failed", "Artifact download failed", 0, error);
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private static HttpURLConnection openConnection(String url, String method, Map<String, String> headers)
      throws IOException {
    HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
    connection.setRequestMethod(method);
    connection.setInstanceFollowRedirects(false);
    connection.setConnectTimeout(NETWORK_TIMEOUT_MILLIS);
    connection.setReadTimeout(NETWORK_TIMEOUT_MILLIS);
    headers.forEach(connection::setRequestProperty);
    return connection;
  }

  private static InputStream responseStream(HttpURLConnection connection, int status) throws IOException {
    if (status >= 400) {
      InputStream error = connection.getErrorStream();
      return error == null ? InputStream.nullInputStream() : error;
    }
    return connection.getInputStream();
  }

  private static LicenseAuthorization parseAuthorization(LicenseAuthorization authorization, boolean allowInsecureLocalhost) {
    return validateAuthorization(authorization.serviceUrl, authorization.licenseKey, authorization.channel, allowInsecureLocalhost);
  }

  private static LicenseAuthorization parseAuthorization(JsonNode value, boolean allowInsecureLocalhost) {
    if (value == null || !value.isObject() ||
        !ReleaseManifestVerifier.fieldSet(value).equals(Set.of("schemaVersion", "serviceUrl", "licenseKey", "channel")) ||
        integer(value, "schemaVersion") != 1 ||
        !"stable".equals(text(value, "channel"))) {
      throw fail("authorization_invalid", "Authorization file fields are invalid");
    }
    return validateAuthorization(text(value, "serviceUrl"), text(value, "licenseKey"), "stable", allowInsecureLocalhost);
  }

  private static LicenseAuthorization validateAuthorization(
      String serviceUrl,
      String licenseKey,
      String channel,
      boolean allowInsecureLocalhost) {
    if (!"stable".equals(channel) || !licenseKey.matches("^sly_live_[0-9a-f-]{36}\\.[A-Za-z0-9_-]{40,}$")) {
      throw fail("authorization_invalid", "Authorization key format is invalid");
    }
    URI uri = URI.create(serviceUrl);
    boolean local = Set.of("127.0.0.1", "localhost", "::1").contains(uri.getHost());
    if (!"https".equals(uri.getScheme()) && !(allowInsecureLocalhost && local && "http".equals(uri.getScheme()))) {
      throw fail("authorization_invalid", "Authorization service URL must use HTTPS");
    }
    return new LicenseAuthorization(serviceUrl.replaceAll("/+$", ""), licenseKey, "stable");
  }

  private static List<String> stringArray(JsonNode value) {
    if (value == null || !value.isArray()) {
      throw fail("license_service_invalid_response", "License service array response is invalid");
    }
    List<String> result = new ArrayList<>();
    for (JsonNode item : value) {
      if (!item.isTextual() || item.asText().isEmpty()) {
        throw fail("license_service_invalid_response", "License service array response is invalid");
      }
      result.add(item.asText());
    }
    return result;
  }

  private static List<String> responseFeatures(JsonNode value, List<String> fallback) {
    return value == null || value.isNull() ? List.copyOf(fallback) : stringArray(value);
  }

  private static List<String> requiredLeaseFeatures(AutomationBackend backend) {
    List<String> features = new ArrayList<>(List.of("browser", "release-download", "webdriver"));
    if (backend == AutomationBackend.PLAYWRIGHT) features.add("playwright");
    return features;
  }

  private static boolean sameStringSet(List<String> left, List<String> right) {
    return left.size() == right.size() &&
        new java.util.HashSet<>(left).equals(new java.util.HashSet<>(right));
  }

  private static void assertClaimsMatchPlan(
      LicenseClaims claims,
      String plan,
      int concurrency,
      List<String> features) {
    if (claims.planId != null && !claims.planId.equals(plan)) {
      throw fail("license_service_invalid_response", "Signed lease plan does not match the service response");
    }
    if (claims.concurrencyLimit != null && claims.concurrencyLimit != concurrency) {
      throw fail("license_service_invalid_response", "Signed lease concurrency does not match the service response");
    }
    if (!sameStringSet(claims.features, features)) {
      throw fail("license_service_invalid_response", "Signed lease features do not match the service response");
    }
  }

  private static Map<String, Object> updateRights(JsonNode value) {
    if (value == null || !value.isObject() ||
        !"active".equals(text(value, "status")) ||
        !"stable".equals(text(value, "channel")) ||
        value.get("exactVersion") == null ||
        !value.get("exactVersion").asBoolean(false) ||
        value.get("rollback") == null ||
        !value.get("rollback").asBoolean(false) ||
        value.get("updatesThrough") == null) {
      throw fail("license_service_invalid_response", "License service update-rights response is invalid");
    }
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("status", "active");
    result.put("channel", "stable");
    result.put("updatesThrough", value.get("updatesThrough").isNull() ? null : value.get("updatesThrough").asLong());
    result.put("exactVersion", true);
    result.put("rollback", true);
    return result;
  }

  private static Object optionalKernelMajor(JsonNode root) {
    JsonNode value = root.get("requestedKernelMajor");
    if (value == null || value.isNull()) return null;
    if (value.isTextual() && value.asText().equals("latest")) return "latest";
    if (value.canConvertToInt() && value.asInt() > 0) return value.asInt();
    throw fail("license_service_invalid_response", "License service requested-kernel response is invalid");
  }

  private static String optionalSelectionMode(JsonNode root) {
    JsonNode value = root.get("selectionMode");
    if (value == null || value.isNull()) return null;
    if (value.isTextual() && Set.of("latest", "latest-in-major", "cached-approved", "exact", "rollback").contains(value.asText())) {
      return value.asText();
    }
    throw fail("license_service_invalid_response", "License service selection-mode response is invalid");
  }

  private static String optionalVersion(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || value.isNull()) return null;
    if (value.isTextual() && value.asText().matches("^\\d+(?:\\.\\d+){0,7}$")) return value.asText();
    throw fail("license_service_invalid_response", "License service " + name + " response is invalid");
  }

  private static Boolean optionalBoolean(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || value.isNull()) return null;
    if (value.isBoolean()) return value.asBoolean();
    throw fail("license_service_invalid_response", "License service " + name + " response is invalid");
  }

  private static String text(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || !value.isTextual() || value.asText().isEmpty()) {
      throw fail("license_service_invalid_response", "License service response field is invalid");
    }
    return value.asText();
  }

  private static String optionalText(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || value.isNull()) return null;
    if (value.isTextual() && !value.asText().isEmpty()) return value.asText();
    throw fail("license_service_invalid_response", "License service response field is invalid");
  }

  private static long integer(JsonNode root, String name) {
    JsonNode value = root.get(name);
    if (value == null || !value.canConvertToLong()) {
      throw fail("license_service_invalid_response", "License service response field is invalid");
    }
    return value.asLong();
  }

  private static String currentPlatform() {
    String name = System.getProperty("os.name").toLowerCase();
    if (name.contains("win")) return "windows";
    if (name.contains("linux")) return "linux";
    if (name.contains("mac")) return "macos";
    throw fail("platform_unsupported", "Unsupported platform");
  }

  private static String currentArch() {
    String arch = System.getProperty("os.arch").toLowerCase();
    if (arch.equals("amd64") || arch.equals("x86_64")) return "x64";
    if (arch.equals("aarch64") || arch.equals("arm64")) return "arm64";
    throw fail("platform_unsupported", "Unsupported architecture");
  }

  private static String encode(String value) {
    return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20");
  }

  private static String origin(String url) {
    URI uri = URI.create(url);
    return uri.getScheme() + "://" + uri.getAuthority();
  }

  private static String newStartupId() {
    return "st_" + UUID.randomUUID().toString().replace("-", "");
  }

  private static Object normalizeKernelMajor(String value) {
    if (value == null || value.equals("latest")) return "latest";
    if (value.matches("^[1-9][0-9]*$")) {
      try {
        return Integer.parseInt(value);
      } catch (NumberFormatException error) {
        throw fail("version_policy_invalid", "kernelMajor must be a positive integer or latest", 0, error);
      }
    }
    throw fail("version_policy_invalid", "kernelMajor must be a positive integer or latest");
  }

  private static int browserMajor(String browserVersion) {
    return Integer.parseInt(browserVersion.split("\\.")[0]);
  }

  private static String safeRemoteErrorCode(JsonNode error) {
    if (error == null || !error.isObject() || !error.has("code") || !error.get("code").isTextual()) {
      return "license_service_error";
    }
    String code = error.get("code").asText();
    return code.matches("^[a-z0-9_]{2,96}$") ? code : "license_service_error";
  }

  private static String remoteErrorMessage(int status, String code) {
    if (code.equals("license_plan_expired")) {
      return "The SlyBrowser paid plan has expired. Renew the plan before starting SlyBrowser.";
    }
    return "License service request failed with HTTP " + status + " (" + code + ")";
  }

  private static Map<String, Object> safeErrorDetails(JsonNode error) {
    if (error == null || !error.isObject()) return Map.of();
    Map<String, Object> details = new LinkedHashMap<>();
    error.fields().forEachRemaining(field -> {
      String key = field.getKey();
      JsonNode value = field.getValue();
      if (SAFE_ERROR_DETAIL_FIELDS.contains(key)) {
        Object safeValue = safeErrorDetailValue(key, value);
        if (safeValue != null) details.put(key, safeValue);
      } else if (key.equals("actions") && value.isArray()) {
        List<Map<String, Object>> actions = safeErrorActions(value);
        if (!actions.isEmpty()) details.put("actions", actions);
      }
    });
    return details;
  }

  private static Object safeErrorDetailValue(String key, JsonNode value) {
    if (Set.of("concurrencyLimit", "activeSessions", "availableSessions", "retryAfterSeconds").contains(key)) {
      return value.isIntegralNumber() ? value.asLong() : null;
    }
    if (!value.isTextual()) return null;
    String text = value.asText();
    return text.matches("^[a-z0-9_:-]{1,96}$") ? text : null;
  }

  private static List<Map<String, Object>> safeErrorActions(JsonNode value) {
    List<Map<String, Object>> actions = new ArrayList<>();
    value.forEach(action -> {
      if (!action.isObject()) return;
      Map<String, Object> sanitized = new LinkedHashMap<>();
      JsonNode type = action.get("type");
      if (type != null && type.isTextual() && type.asText().matches("^[a-z0-9_:-]{1,96}$")) {
        sanitized.put("type", type.asText());
      }
      JsonNode url = action.get("url");
      if (url != null && url.isTextual() && url.asText().startsWith("https://slybrowser.com/")) {
        sanitized.put("url", url.asText());
      }
      if (!sanitized.isEmpty()) actions.add(sanitized);
    });
    return actions;
  }

  private static Object jsonValue(JsonNode value) {
    if (value == null || value.isNull()) return null;
    if (value.isObject()) {
      Map<String, Object> result = new LinkedHashMap<>();
      value.fields().forEachRemaining(field -> result.put(field.getKey(), jsonValue(field.getValue())));
      return result;
    }
    if (value.isArray()) {
      List<Object> result = new ArrayList<>();
      value.elements().forEachRemaining(item -> result.add(jsonValue(item)));
      return result;
    }
    if (value.isTextual()) return value.asText();
    if (value.isBoolean()) return value.asBoolean();
    if (value.isIntegralNumber()) return value.asLong();
    if (value.isFloatingPointNumber()) return value.asDouble();
    return value.toString();
  }

  private static LicenseServiceException fail(String code, String message) {
    return new LicenseServiceException(message, code, 0);
  }

  private static LicenseServiceException fail(String code, String message, int status) {
    return new LicenseServiceException(message, code, status);
  }

  private static LicenseServiceException fail(String code, String message, int status, Throwable cause) {
    return new LicenseServiceException(message, code, status, cause);
  }
}
