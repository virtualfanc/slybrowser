import type { LicenseServiceClientOptions } from "./service.js";

const decode = (value: string): Uint8Array => Buffer.from(value, "base64url");

const LICENSE_LEASE_KEYS = Object.freeze({
  "launch-candidate-20260824": decode("h9ie2nXxsXVKlxjFIz-or1otChHTF8HS94vV_EjY1KM"),
});

const RELEASE_MANIFEST_KEYS = Object.freeze({
  "release-launch-candidate-20260824": decode("SvSlPQKT9oZ4nIVuJXgd2pFOC0QblDph29vKlz6NJZo"),
});

export const LICENSE_FILE_KEYS = Object.freeze({
  "license-file-private-preview-v1": decode("wc3DR5wOqazjZF_3n41EF1cMh5d-qGv2wkZHyd0Sj6s"),
});

export function officialTrust(): LicenseServiceClientOptions {
  return {
    licenseTrustedKeys: LICENSE_LEASE_KEYS,
    releaseTrustedKeys: RELEASE_MANIFEST_KEYS,
    licenseFileTrustedKeys: LICENSE_FILE_KEYS,
  };
}
