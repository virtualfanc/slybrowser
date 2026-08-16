"""Stable SDK error types and machine-readable error codes."""


class SlyBrowserError(RuntimeError):
    """Base class for expected SlyBrowser failures."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


class ConfigurationError(SlyBrowserError):
    pass


class ManifestError(SlyBrowserError):
    pass


class ArtifactError(SlyBrowserError):
    pass


class LicenseError(SlyBrowserError):
    pass


class LicenseServiceError(SlyBrowserError):
    def __init__(self, message: str, *, code: str, status: int = 0) -> None:
        super().__init__(message, code=code)
        self.status = status


class WebDriverError(SlyBrowserError):
    def __init__(
        self,
        message: str,
        *,
        code: str,
        command: str | None = None,
        status: int | None = None,
        payload: object | None = None,
    ) -> None:
        super().__init__(message, code=code)
        self.command = command
        self.status = status
        self.payload = payload
