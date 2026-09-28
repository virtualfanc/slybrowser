"""Automation backend selection and framework binding compatibility."""

from __future__ import annotations

from importlib import metadata
from typing import Literal, TypedDict

from .errors import ConfigurationError

AutomationBackend = Literal["project-webdriver", "playwright"]


class AutomationCapability(TypedDict, total=False):
    backend: AutomationBackend
    language: Literal["python"]
    framework_version: str
    native_humanize: bool
    persistent_context: bool


_SUPPORTED_PLAYWRIGHT_LINES = frozenset({"1.62"})


def validate_playwright_version(version: str) -> str:
    parts = version.split("+", 1)[0].split("-", 1)[0].split(".")
    if len(parts) < 2 or not all(part.isdigit() for part in parts):
        raise ConfigurationError(
            f"Invalid Playwright version: {version}",
            code="framework_version_invalid",
        )
    line = ".".join(parts[:2])
    if line not in _SUPPORTED_PLAYWRIGHT_LINES:
        supported = ", ".join(sorted(_SUPPORTED_PLAYWRIGHT_LINES))
        raise ConfigurationError(
            f"Unsupported Playwright version {version}; supported lines: {supported}",
            code="framework_version_unsupported",
        )
    return version


def resolve_playwright_version(explicit: str | None = None) -> str:
    if explicit is not None:
        return validate_playwright_version(explicit)
    try:
        return validate_playwright_version(metadata.version("playwright"))
    except metadata.PackageNotFoundError as error:
        raise ConfigurationError(
            "Unable to determine the installed Playwright package version; "
            "pass framework_version explicitly",
            code="framework_version_missing",
        ) from error


def require_playwright_humanize_support(requested: bool) -> None:
    _ = requested


def automation_capability(
    backend: AutomationBackend = "project-webdriver",
    *,
    framework_version: str | None = None,
) -> AutomationCapability:
    if backend == "project-webdriver":
        if framework_version is not None:
            raise ConfigurationError(
                "Project WebDriver does not accept framework_version",
                code="framework_version_forbidden",
            )
        return {
            "backend": backend,
            "language": "python",
            "native_humanize": True,
            "persistent_context": True,
        }
    if backend != "playwright":
        raise ConfigurationError(
            f"Unsupported Python automation backend: {backend}",
            code="automation_backend_unsupported",
        )
    return {
        "backend": backend,
        "language": "python",
        "framework_version": resolve_playwright_version(framework_version),
        "native_humanize": True,
        "persistent_context": True,
    }
