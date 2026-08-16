export class SlyBrowserError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ConfigurationError extends SlyBrowserError {}
export class LicenseError extends SlyBrowserError {}
export class LicenseServiceError extends SlyBrowserError {
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message, code);
    this.status = status;
  }
}
export class ManifestError extends SlyBrowserError {}
export class ArtifactError extends SlyBrowserError {}
