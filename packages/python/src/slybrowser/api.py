"""Small user-facing SlyBrowser launch API."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, Mapping, TypedDict

from ._official_trust import LICENSE_FILE_KEYS, LICENSE_LEASE_KEYS, RELEASE_MANIFEST_KEYS
from .errors import ConfigurationError
from .licensed import launch_latest, launch_latest_playwright, launch_latest_playwright_persistent
from .webdriver import SlyWebDriverSession


class SlyBrowserProfile(TypedDict, total=False):
    fingerprintMode: Literal["explicit", "seeded"]
    fingerprintSeed: str
    fingerprintSchemaVersion: Literal[1]
    userAgent: str
    userAgentFullVersion: str
    clientHints: list[dict[str, str]]
    osVersion: str
    locale: str
    languages: list[str]
    timezone: str | dict[str, str]
    screen: dict[str, int]
    webrtc: Literal["default"]
    disabledFonts: list[str]
    canvasNoise: dict[str, int]
    webglImageNoise: dict[str, int]
    webgl: dict[str, str]
    webgpu: dict[str, str]
    audioContext: dict[str, float]
    disabledCipherSuites: list[str]
    disabledMediaDevices: list[str]
    clientRects: dict[str, float]
    speechVoices: list[dict[str, Any]]
    cookies: list[dict[str, Any]]
    hardwareConcurrency: int
    deviceMemory: int
    deviceName: str
    macAddress: str
    doNotTrack: bool
    allowedPorts: list[int]
    gpuEnabled: bool
    homepages: list[str]


class LaunchOptions(TypedDict, total=False):
    headless: bool
    profileMode: Literal["ephemeral", "persistent"]
    profileDirectory: str
    updateKernel: bool


class HumanizeOptions(TypedDict, total=False):
    enabled: bool
    preset: Literal["default", "careful"]
    seed: int
    config: Mapping[str, int | float]


class SlyBrowserOptions(TypedDict, total=False):
    profile: SlyBrowserProfile
    launch: LaunchOptions
    humanize: HumanizeOptions


_OPTION_FIELDS = frozenset(("profile", "launch", "humanize"))
_LAUNCH_FIELDS = frozenset(("headless", "profileMode", "profileDirectory", "updateKernel"))
_HUMANIZE_FIELDS = frozenset(("enabled", "preset", "seed", "config"))


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ConfigurationError(f"{label} must be an object", code="launch_options_invalid")
    return value


def _reject_unknown_fields(value: Mapping[str, Any], allowed: frozenset[str], label: str) -> None:
    unknown = next((field for field in value if field not in allowed), None)
    if unknown is not None:
        raise ConfigurationError(f"Unknown {label} field: {unknown}", code="launch_options_invalid")


def _options(options: SlyBrowserOptions | None) -> dict[str, Any]:
    selected = _mapping(options or {}, "options")
    _reject_unknown_fields(selected, _OPTION_FIELDS, "options")
    if "profile" in selected:
        _mapping(selected["profile"], "profile")
    launch_options = _mapping(selected.get("launch", {}), "launch")
    humanize = _mapping(selected.get("humanize", {}), "humanize")
    _reject_unknown_fields(launch_options, _LAUNCH_FIELDS, "launch")
    _reject_unknown_fields(humanize, _HUMANIZE_FIELDS, "humanize")
    if launch_options.get("profileMode") not in (None, "ephemeral", "persistent"):
        raise ConfigurationError(
            "launch.profileMode must be ephemeral or persistent",
            code="launch_options_invalid",
        )
    if humanize.get("preset") not in (None, "default", "careful"):
        raise ConfigurationError(
            "humanize.preset must be default or careful",
            code="humanize_preset_invalid",
        )
    if "config" in humanize:
        _mapping(humanize["config"], "humanize.config")
    result: dict[str, Any] = {
        "license_trusted_keys": LICENSE_LEASE_KEYS,
        "release_trusted_keys": RELEASE_MANIFEST_KEYS,
        "license_file_trusted_keys": LICENSE_FILE_KEYS,
    }
    if "profile" in selected:
        result["profile"] = selected["profile"]
    mappings = (
        (launch_options, "headless", "headless"),
        (launch_options, "profileMode", "profile_mode"),
        (launch_options, "profileDirectory", "profile_dir"),
        (launch_options, "updateKernel", "update_kernel"),
        (humanize, "enabled", "humanize"),
        (humanize, "preset", "human_preset"),
        (humanize, "seed", "human_seed"),
        (humanize, "config", "human_config"),
    )
    for source, public_name, internal_name in mappings:
        if public_name in source:
            result[internal_name] = source[public_name]
    return result


def launch(
    authorization_file: str | Path,
    options: SlyBrowserOptions | None = None,
) -> SlyWebDriverSession:
    """Launch SlyBrowser using the authorization file and user options."""
    return launch_latest(authorization_file, **_options(options))


def launch_playwright(
    playwright: Any,
    authorization_file: str | Path,
    options: SlyBrowserOptions | None = None,
) -> Any:
    """Launch through the installed Playwright binding; its version is detected."""
    return launch_latest_playwright(playwright, authorization_file, **_options(options))


def launch_playwright_persistent(
    playwright: Any,
    user_data_directory: str | Path,
    authorization_file: str | Path,
    options: SlyBrowserOptions | None = None,
) -> Any:
    return launch_latest_playwright_persistent(
        playwright,
        user_data_directory,
        authorization_file,
        **_options(options),
    )
