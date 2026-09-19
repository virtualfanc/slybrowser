import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { ConfigurationError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface LaunchPlan {
  executable: string;
  arguments: string[];
  configFile: string;
  licenseFile: string;
  driverLicenseFile?: string;
  runtimeFile?: string;
  driverRuntimeFile?: string;
  releaseRoot?: string;
  humanizeConfigFile?: string;
  nativeReadyRequestFile?: string;
  nativeReadyFile?: string;
  nativeReadyNonce?: string;
  waitForNativeReady(timeout?: number): Promise<void>;
  cleanup(): Promise<void>;
}

export interface NetworkAlignmentDiagnostic {
  configured: boolean;
  aligned: boolean;
  source?: string;
  exitIp?: string;
  missing: string[];
}

const FIRST_RELEASE_UNSUPPORTED_FEATURE_CODE = "launch_feature_unsupported";

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnsupportedLaunchFeature(field: string): never {
  throw new ConfigurationError(
    `${field} is not supported in the first SlyBrowser release`,
    FIRST_RELEASE_UNSUPPORTED_FEATURE_CODE,
  );
}

function isUnsupportedWebRtcMode(value: unknown): boolean {
  return value === "proxy" || (isRecord(value) && value.mode === "replace");
}

function assertFingerprintProfile(options: Record<string, unknown>): void {
  const profile = isRecord(options.profile) ? options.profile : options;
  const hasMode = hasOwn(profile, "fingerprintMode");
  const hasSeed = hasOwn(profile, "fingerprintSeed");
  const hasSchema = hasOwn(profile, "fingerprintSchemaVersion");
  if (!hasMode && !hasSeed && !hasSchema) return;
  const mode = hasMode ? profile.fingerprintMode : (hasSeed || hasSchema ? "seeded" : "explicit");
  if (mode !== "explicit" && mode !== "seeded") throw new ConfigurationError("profile.fingerprintMode is invalid", "profile_invalid");
  if (hasSeed && (typeof profile.fingerprintSeed !== "string" || profile.fingerprintSeed.length === 0 || profile.fingerprintSeed.length > 128)) {
    throw new ConfigurationError("profile.fingerprintSeed is invalid", "profile_invalid");
  }
  if (hasSchema && profile.fingerprintSchemaVersion !== 1) throw new ConfigurationError("profile.fingerprintSchemaVersion is unsupported", "profile_invalid");
  if (mode === "explicit" && (hasSeed || hasSchema)) throw new ConfigurationError("profile.fingerprintSeed requires seeded fingerprint mode", "profile_invalid");
  if (mode === "seeded" && (!hasSeed || !hasSchema)) throw new ConfigurationError("Seeded fingerprint mode requires seed and schema version", "profile_invalid");
}

function assertFirstReleaseNetworkAndGeoBoundary(options: Record<string, unknown>): void {
  if (hasOwn(options, "proxy")) rejectUnsupportedLaunchFeature("proxy");
  if (hasOwn(options, "proxyAlignment")) rejectUnsupportedLaunchFeature("proxyAlignment");
  if (hasOwn(options, "geolocation")) rejectUnsupportedLaunchFeature("geolocation");
  if (hasOwn(options, "geo")) rejectUnsupportedLaunchFeature("geo");
  if (hasOwn(options, "geoIp") || hasOwn(options, "geoip")) rejectUnsupportedLaunchFeature("geoIp");
  if (hasOwn(options, "webrtc") && isUnsupportedWebRtcMode(options.webrtc)) {
    rejectUnsupportedLaunchFeature("webrtc proxy mode");
  }

  if (isRecord(options.profile)) {
    if (hasOwn(options.profile, "geolocation")) rejectUnsupportedLaunchFeature("profile.geolocation");
    if (hasOwn(options.profile, "geo")) rejectUnsupportedLaunchFeature("profile.geo");
    if (hasOwn(options.profile, "geoIp") || hasOwn(options.profile, "geoip")) rejectUnsupportedLaunchFeature("profile.geoIp");
    if (hasOwn(options.profile, "webrtc") && isUnsupportedWebRtcMode(options.profile.webrtc)) {
      rejectUnsupportedLaunchFeature("profile.webrtc proxy mode");
    }
  }
}

export function diagnoseNetworkAlignment(options: Record<string, unknown>): NetworkAlignmentDiagnostic {
  if (options.proxy !== undefined || options.proxyAlignment !== undefined) {
    return {
      configured: true,
      aligned: false,
      missing: ["proxy is not supported in the first SlyBrowser release"],
    };
  }
  return { configured: false, aligned: true, missing: [] };
}

export function normalizeNetworkSafety(options: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...options };
  assertFirstReleaseNetworkAndGeoBoundary(normalized);
  assertFingerprintProfile(normalized);
  return normalized;
}

async function privateFile(directory: string, prefix: string, payload: Buffer): Promise<string> {
  const path = resolve(directory, `${prefix}${randomUUID()}.json`);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  await protectWindowsHandoffFile(path);
  return path;
}

async function protectWindowsHandoffFile(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const { stdout } = await execFileAsync("whoami", [], { windowsHide: true });
  const identity = stdout.trim();
  if (!identity) {
    throw new ConfigurationError("Unable to determine current Windows identity", "handoff_acl_failed");
  }
  try {
    await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`], { windowsHide: true });
  } catch (error) {
    await rm(path, { force: true });
    throw new ConfigurationError("Unable to restrict private handoff ACL", "handoff_acl_failed");
  }
}

function isForbiddenSecretArgument(argument: string): boolean {
  const equalsIndex = argument.indexOf("=");
  if (equalsIndex < 0) return false;
  const switchName = argument.slice(0, equalsIndex).toLowerCase();
  return switchName.includes("license") || switchName.includes("runtime");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

async function nativeReadyObserved(path: string, nonce: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
  if (!text.trim()) return false;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("Native-ready marker is invalid", "native_ready_invalid");
  }
  const marker = value as Record<string, unknown>;
  if (marker.schemaVersion !== 1 ||
      marker.kind !== "slybrowser.native-ready" ||
      marker.ready !== true ||
      marker.nonce !== nonce) {
    throw new ConfigurationError("Native-ready marker is invalid", "native_ready_invalid");
  }
  return true;
}

async function waitForNativeReadyFile(
  path: string | undefined,
  nonce: string | undefined,
  timeout = 15_000,
): Promise<void> {
  if (path === undefined || nonce === undefined) return;
  if (!Number.isFinite(timeout) || timeout < 1) {
    throw new ConfigurationError("nativeReadyTimeout must be a positive number of milliseconds", "config_invalid");
  }
  const deadline = Date.now() + timeout;
  do {
    if (await nativeReadyObserved(path, nonce)) return;
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new ConfigurationError("SlyBrowser did not report native-ready before returning", "native_ready_timeout");
}

export async function prepareLaunch(
  executable: string,
  options: Record<string, unknown>,
  lease: string | Buffer | Record<string, unknown>,
  settings: {
    tempRoot?: string | undefined;
    extraArguments?: readonly string[] | undefined;
    includeDriverLease?: boolean | undefined;
    runtimeHandoff?: Record<string, unknown> | undefined;
    driverRuntimeHandoff?: Record<string, unknown> | undefined;
    includeDriverRuntime?: boolean | undefined;
    allowRuntimeActivationTicket?: boolean | undefined;
    releaseRoot?: string | undefined;
    humanizeControl?: Record<string, unknown> | undefined;
    nativeReady?: boolean | undefined;
  } = {},
): Promise<LaunchPlan> {
  const executablePath = resolve(executable);
  try {
    await access(executablePath, constants.R_OK);
    if (!(await stat(executablePath)).isFile()) throw new Error();
  } catch {
    throw new ConfigurationError("Browser executable does not exist", "browser_missing");
  }
  const extraArguments = [...(settings.extraArguments ?? [])];
  const releaseRoot = settings.releaseRoot === undefined ? undefined : resolve(settings.releaseRoot);
  if (extraArguments.some(isForbiddenSecretArgument)) {
    throw new ConfigurationError(
      "License and runtime material must not be passed in extra browser arguments",
      "license_argument_forbidden",
    );
  }
  if (["licenseKey", "runtimeToken", "bootstrapToken", "activationTicket", "downloadTicket"].some((name) =>
      Object.prototype.hasOwnProperty.call(options, name))) {
    throw new ConfigurationError(
      "License and runtime secrets must never be placed in the browser profile handoff",
      "profile_secret_forbidden",
    );
  }
  const forbiddenRuntimeHandoffSecrets = [
    "licenseKey",
    "runtimeToken",
    ...(settings.allowRuntimeActivationTicket === true ? [] : ["activationTicket"]),
    "downloadTicket",
  ];
  for (const runtimeHandoff of [settings.runtimeHandoff, settings.driverRuntimeHandoff]) {
    if (runtimeHandoff !== undefined &&
        forbiddenRuntimeHandoffSecrets.some((name) =>
          Object.prototype.hasOwnProperty.call(runtimeHandoff, name))) {
      throw new ConfigurationError(
        "Runtime handoff must not contain long-lived keys, runtime tokens or download tickets",
        "runtime_handoff_secret_forbidden",
      );
    }
  }
  const root = resolve(settings.tempRoot ?? tmpdir());
  await mkdir(root, { recursive: true });
  const normalizedOptions = normalizeNetworkSafety(options);
  const configBytes = Buffer.from(JSON.stringify(normalizedOptions), "utf8");
  if (configBytes.length > 1024 * 1024) {
    throw new ConfigurationError("Launch configuration is too large", "config_too_large");
  }
  const leaseBytes = Buffer.isBuffer(lease)
    ? lease
    : Buffer.from(typeof lease === "string" ? lease : JSON.stringify(lease), "utf8");
  if (!leaseBytes.length || leaseBytes.length > 64 * 1024) {
    throw new ConfigurationError("License lease is missing or too large", "license_invalid_envelope");
  }
  const configFile = await privateFile(root, "sly-config-", configBytes);
  let licenseFile: string | undefined;
  let driverLicenseFile: string | undefined;
  let runtimeFile: string | undefined;
  let driverRuntimeFile: string | undefined;
  let humanizeConfigFile: string | undefined;
  let nativeReadyRequestFile: string | undefined;
  let nativeReadyFile: string | undefined;
  let nativeReadyNonce: string | undefined;
  try {
    licenseFile = await privateFile(root, "sly-license-", leaseBytes);
    if (settings.includeDriverLease) {
      driverLicenseFile = await privateFile(root, "sly-driver-license-", leaseBytes);
    }
    if (settings.runtimeHandoff !== undefined) {
      const runtimeBytes = Buffer.from(JSON.stringify(settings.runtimeHandoff), "utf8");
      if (runtimeBytes.length === 0 || runtimeBytes.length > 64 * 1024) {
        throw new ConfigurationError("Runtime handoff file is missing or too large", "runtime_handoff_invalid");
      }
      runtimeFile = await privateFile(root, "sly-runtime-", runtimeBytes);
    }
    const driverRuntimeHandoff = settings.driverRuntimeHandoff ?? (settings.includeDriverRuntime ? settings.runtimeHandoff : undefined);
    if (driverRuntimeHandoff !== undefined) {
      const driverRuntimeBytes = Buffer.from(JSON.stringify(driverRuntimeHandoff), "utf8");
      if (driverRuntimeBytes.length === 0 || driverRuntimeBytes.length > 64 * 1024) {
        throw new ConfigurationError("Runtime handoff file is missing or too large", "runtime_handoff_invalid");
      }
      driverRuntimeFile = await privateFile(root, "sly-driver-runtime-", driverRuntimeBytes);
    }
    if (settings.humanizeControl !== undefined) {
      const humanizeBytes = Buffer.from(JSON.stringify(settings.humanizeControl), "utf8");
      if (humanizeBytes.length > 64 * 1024) {
        throw new ConfigurationError("Native Humanize control file is too large", "humanize_config_too_large");
      }
      humanizeConfigFile = await privateFile(root, "sly-humanize-", humanizeBytes);
    }
    if (settings.nativeReady === true) {
      nativeReadyNonce = randomUUID();
      nativeReadyFile = await privateFile(root, "sly-native-ready-", Buffer.alloc(0));
      nativeReadyRequestFile = await privateFile(root, "sly-native-ready-request-", Buffer.from(JSON.stringify({
        schemaVersion: 1,
        kind: "slybrowser.native-ready-request",
        readyFile: nativeReadyFile,
        nonce: nativeReadyNonce,
      }), "utf8"));
    }
  } catch (error) {
    if (nativeReadyRequestFile) await rm(nativeReadyRequestFile, { force: true });
    if (nativeReadyFile) await rm(nativeReadyFile, { force: true });
    if (humanizeConfigFile) await rm(humanizeConfigFile, { force: true });
    if (driverRuntimeFile) await rm(driverRuntimeFile, { force: true });
    if (runtimeFile) await rm(runtimeFile, { force: true });
    if (driverLicenseFile) await rm(driverLicenseFile, { force: true });
    if (licenseFile) await rm(licenseFile, { force: true });
    await rm(configFile, { force: true });
    throw error;
  }
  if (!licenseFile) throw new ConfigurationError("License handoff creation failed", "license_handoff_failed");
  let cleaned = false;
  return {
    executable: executablePath,
    arguments: [
      `--sly-config-file=${configFile}`,
      `--sly-license-file=${licenseFile}`,
      ...(releaseRoot === undefined ? [] : [`--sly-release-root=${releaseRoot}`]),
      ...(runtimeFile === undefined ? [] : [`--sly-runtime-file=${runtimeFile}`]),
      ...(humanizeConfigFile === undefined ? [] : [`--sly-humanize-config=${humanizeConfigFile}`]),
      ...(nativeReadyRequestFile === undefined ? [] : [`--sly-native-ready-request-file=${nativeReadyRequestFile}`]),
      ...extraArguments,
    ],
    configFile,
    licenseFile,
    ...(releaseRoot === undefined ? {} : { releaseRoot }),
    ...(driverLicenseFile === undefined ? {} : { driverLicenseFile }),
    ...(runtimeFile === undefined ? {} : { runtimeFile }),
    ...(driverRuntimeFile === undefined ? {} : { driverRuntimeFile }),
    ...(humanizeConfigFile === undefined ? {} : { humanizeConfigFile }),
    ...(nativeReadyRequestFile === undefined ? {} : { nativeReadyRequestFile }),
    ...(nativeReadyFile === undefined ? {} : { nativeReadyFile }),
    ...(nativeReadyNonce === undefined ? {} : { nativeReadyNonce }),
    async waitForNativeReady(timeout = 15_000) {
      await waitForNativeReadyFile(nativeReadyFile, nativeReadyNonce, timeout);
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.all([
        rm(licenseFile, { force: true }),
        rm(configFile, { force: true }),
        ...(driverLicenseFile === undefined ? [] : [rm(driverLicenseFile, { force: true })]),
        ...(runtimeFile === undefined ? [] : [rm(runtimeFile, { force: true })]),
        ...(driverRuntimeFile === undefined ? [] : [rm(driverRuntimeFile, { force: true })]),
        ...(humanizeConfigFile === undefined ? [] : [rm(humanizeConfigFile, { force: true })]),
        ...(nativeReadyRequestFile === undefined ? [] : [rm(nativeReadyRequestFile, { force: true })]),
        ...(nativeReadyFile === undefined ? [] : [rm(nativeReadyFile, { force: true })]),
      ]);
    },
  };
}
