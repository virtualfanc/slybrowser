"""Public Python API for SlyBrowser."""

from .errors import (
    ArtifactError,
    ConfigurationError,
    LicenseError,
    LicenseServiceError,
    ManifestError,
    SlyBrowserError,
    WebDriverError,
)
from .browser import (
    launch_playwright,
    launch_playwright_async,
    launch_playwright_persistent,
    launch_playwright_persistent_async,
)
from .launcher import LaunchPlan, prepare_launch
from .webdriver import (
    HumanizeConfig,
    SlyWebDriverElement,
    SlyWebDriverService,
    SlyWebDriverSession,
    WebDriverVersions,
    launch,
    launch_webdriver,
)
from .license import LicenseClaims, LicenseVerifier
from .manifest import ReleaseManifest, verify_release_manifest
from .installer import BrowserInstallation, install_granted_browser
from .licensed import install_latest, launch_latest, prepare_latest_authorized_browser
from .service import LicenseAuthorization, LicenseServiceClient, LicensedSessionGrant, read_license_authorization

__all__ = [
    "ArtifactError",
    "ConfigurationError",
    "LaunchPlan",
    "LicenseClaims",
    "LicenseError",
    "LicenseServiceError",
    "LicenseVerifier",
    "ManifestError",
    "ReleaseManifest",
    "SlyBrowserError",
    "WebDriverError",
    "HumanizeConfig",
    "SlyWebDriverElement",
    "SlyWebDriverService",
    "SlyWebDriverSession",
    "WebDriverVersions",
    "launch",
    "launch_webdriver",
    "launch_playwright",
    "launch_playwright_async",
    "launch_playwright_persistent",
    "launch_playwright_persistent_async",
    "prepare_launch",
    "verify_release_manifest",
    "BrowserInstallation",
    "LicenseAuthorization",
    "LicenseServiceClient",
    "LicensedSessionGrant",
    "install_granted_browser",
    "install_latest",
    "launch_latest",
    "prepare_latest_authorized_browser",
    "read_license_authorization",
]

__version__ = "0.1.0"
