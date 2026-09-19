"""Public Python API for SlyBrowser."""

from .api import (
    HumanizeOptions,
    LaunchOptions,
    SlyBrowserOptions,
    SlyBrowserProfile,
    launch,
    launch_playwright,
    launch_playwright_persistent,
)
from .errors import (
    ArtifactError,
    ConfigurationError,
    LicenseError,
    LicenseServiceError,
    LICENSE_SERVICE_ERROR_CODES,
    is_license_service_error_code,
    ManifestError,
    SlyBrowserError,
    WebDriverError,
)
from .webdriver import SlyWebDriverElement, SlyWebDriverSession

__all__ = [
    "ArtifactError",
    "ConfigurationError",
    "HumanizeOptions",
    "LaunchOptions",
    "LicenseError",
    "LicenseServiceError",
    "LICENSE_SERVICE_ERROR_CODES",
    "is_license_service_error_code",
    "ManifestError",
    "SlyBrowserError",
    "SlyBrowserOptions",
    "SlyBrowserProfile",
    "SlyWebDriverElement",
    "SlyWebDriverSession",
    "WebDriverError",
    "launch",
    "launch_playwright",
    "launch_playwright_persistent",
]

__version__ = "0.2.0"
