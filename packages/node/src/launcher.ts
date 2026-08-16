import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { resolve } from "node:path";

import { ConfigurationError } from "./errors.js";

export interface LaunchPlan {
  executable: string;
  arguments: string[];
  configFile: string;
  licenseFile: string;
  driverLicenseFile?: string;
  cleanup(): Promise<void>;
}

export interface NetworkAlignmentDiagnostic {
  configured: boolean;
  aligned: boolean;
  source?: string;
  exitIp?: string;
  missing: string[];
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function alignmentProfile(options: Record<string, unknown>): {
  profile: Record<string, unknown>;
  commit(value: Record<string, unknown>): void;
} {
  if (options.profile === undefined) {
    const profile = { ...options };
    delete profile.proxy;
    delete profile.proxyAlignment;
    return {
      profile,
      commit(value) {
        for (const [name, field] of Object.entries(value)) options[name] = field;
      },
    };
  }
  if (!options.profile || typeof options.profile !== "object" || Array.isArray(options.profile)) {
    throw new ConfigurationError("Profile configuration must be an object", "profile_invalid");
  }
  return {
    profile: { ...(options.profile as Record<string, unknown>) },
    commit(value) { options.profile = value; },
  };
}

function validatedAlignment(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("Proxy alignment evidence must be an object", "proxy_alignment_invalid");
  }
  const evidence = value as Record<string, unknown>;
  const source = evidence.source;
  const exitIp = evidence.exitIp;
  const observedAt = evidence.observedAt;
  const locale = evidence.locale;
  const timezone = evidence.timezone;
  const geolocation = evidence.geolocation as Record<string, unknown> | undefined;
  const languages = evidence.languages;
  if ((source !== "manual" && source !== "proxy-observer") || typeof exitIp !== "string" || isIP(exitIp) === 0 ||
      typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt)) ||
      typeof locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) ||
      typeof timezone !== "string" || !timezone ||
      !geolocation || typeof geolocation.latitude !== "number" || geolocation.latitude < -90 || geolocation.latitude > 90 ||
      typeof geolocation.longitude !== "number" || geolocation.longitude < -180 || geolocation.longitude > 180 ||
      (geolocation.accuracy !== undefined && (typeof geolocation.accuracy !== "number" || geolocation.accuracy < 0)) ||
      (languages !== undefined && (!Array.isArray(languages) || languages.length === 0 ||
        languages.some((item) => typeof item !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item))))) {
    throw new ConfigurationError("Proxy alignment evidence is incomplete or invalid", "proxy_alignment_invalid");
  }
  return evidence;
}

export function diagnoseNetworkAlignment(options: Record<string, unknown>): NetworkAlignmentDiagnostic {
  if (options.proxy === undefined) return { configured: false, aligned: true, missing: [] };
  if (options.proxyAlignment === undefined) {
    return {
      configured: true,
      aligned: false,
      missing: ["proxyAlignment.exitIp", "profile.locale", "profile.timezone", "profile.geolocation"],
    };
  }
  const evidence = validatedAlignment(options.proxyAlignment);
  return {
    configured: true,
    aligned: true,
    source: evidence.source as string,
    exitIp: evidence.exitIp as string,
    missing: [],
  };
}

export function normalizeNetworkSafety(options: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...options };
  if (normalized.proxy === undefined) {
    if (normalized.proxyAlignment !== undefined) {
      throw new ConfigurationError("Proxy alignment evidence requires a configured proxy", "proxy_alignment_without_proxy");
    }
    return normalized;
  }
  if (!normalized.proxy || typeof normalized.proxy !== "object" || Array.isArray(normalized.proxy)) {
    throw new ConfigurationError("Proxy configuration must be an object", "proxy_invalid");
  }
  const proxy = { ...(normalized.proxy as Record<string, unknown>) };
  if (proxy.failClosed === false) {
    throw new ConfigurationError("Configured proxies must fail closed", "proxy_fail_closed_required");
  }
  proxy.failClosed = true;
  normalized.proxy = proxy;

  const target = alignmentProfile(normalized);
  if (target.profile.webrtc === undefined) target.profile.webrtc = "proxy";
  if (normalized.proxyAlignment !== undefined) {
    const evidence = validatedAlignment(normalized.proxyAlignment);
    const alignedFields: Record<string, unknown> = {
      locale: evidence.locale,
      languages: evidence.languages ?? [evidence.locale],
      timezone: evidence.timezone,
      geolocation: { ...(evidence.geolocation as Record<string, unknown>), permission: "allow" },
      webrtc: "proxy",
    };
    for (const [name, value] of Object.entries(alignedFields)) {
      if (target.profile[name] !== undefined && !sameValue(target.profile[name], value)) {
        throw new ConfigurationError(`Proxy alignment conflicts with profile.${name}`, "proxy_alignment_conflict");
      }
      target.profile[name] = value;
    }
  }
  target.commit(target.profile);
  delete normalized.proxyAlignment;
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
  return path;
}

export async function prepareLaunch(
  executable: string,
  options: Record<string, unknown>,
  lease: string | Buffer | Record<string, unknown>,
  settings: {
    tempRoot?: string | undefined;
    extraArguments?: readonly string[] | undefined;
    includeDriverLease?: boolean | undefined;
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
  if (extraArguments.some((argument) => /license[^=]*=/i.test(argument))) {
    throw new ConfigurationError(
      "License material must not be passed in extra browser arguments",
      "license_argument_forbidden",
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, "licenseKey")) {
    throw new ConfigurationError(
      "A long-lived license key must never be placed in the browser profile handoff",
      "profile_secret_forbidden",
    );
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
  try {
    licenseFile = await privateFile(root, "sly-license-", leaseBytes);
    if (settings.includeDriverLease) {
      driverLicenseFile = await privateFile(root, "sly-driver-license-", leaseBytes);
    }
  } catch (error) {
    if (driverLicenseFile) await rm(driverLicenseFile, { force: true });
    if (licenseFile) await rm(licenseFile, { force: true });
    await rm(configFile, { force: true });
    throw error;
  }
  if (!licenseFile) throw new ConfigurationError("License handoff creation failed", "license_handoff_failed");
  let cleaned = false;
  return {
    executable: executablePath,
    arguments: [`--sly-config-file=${configFile}`, `--sly-license-file=${licenseFile}`, ...extraArguments],
    configFile,
    licenseFile,
    ...(driverLicenseFile === undefined ? {} : { driverLicenseFile }),
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.all([
        rm(licenseFile, { force: true }),
        rm(configFile, { force: true }),
        ...(driverLicenseFile === undefined ? [] : [rm(driverLicenseFile, { force: true })]),
      ]);
    },
  };
}
