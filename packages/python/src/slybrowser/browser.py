"""Framework adapters that launch the native SlyBrowser executable."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .errors import ConfigurationError
from .launcher import prepare_launch


def _launch_arguments(
    launch_options: Mapping[str, Any] | None,
    handoff_arguments: tuple[str, ...],
) -> dict[str, Any]:
    result = dict(launch_options or {})
    if "executable_path" in result or "executablePath" in result:
        raise ConfigurationError(
            "The browser executable must be passed to the SlyBrowser adapter",
            code="executable_option_conflict",
        )
    existing_arguments = result.get("args", [])
    if not isinstance(existing_arguments, (list, tuple)) or any(
        not isinstance(argument, str) for argument in existing_arguments
    ):
        raise ConfigurationError("Playwright args must be a string array", code="config_invalid")
    result["args"] = [*handoff_arguments, *existing_arguments]
    return result


def launch_playwright(
    playwright: Any,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
) -> Any:
    """Launch a non-persistent Playwright browser using an existing Playwright object."""

    with prepare_launch(executable, profile or {}, lease, temp_root=temp_root) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        return playwright.chromium.launch(executable_path=str(plan.executable), **options)


async def launch_playwright_async(
    playwright: Any,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
) -> Any:
    with prepare_launch(executable, profile or {}, lease, temp_root=temp_root) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        return await playwright.chromium.launch(executable_path=str(plan.executable), **options)


def launch_playwright_persistent(
    playwright: Any,
    user_data_dir: str | Path,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
) -> Any:
    with prepare_launch(executable, profile or {}, lease, temp_root=temp_root) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        return playwright.chromium.launch_persistent_context(
            str(Path(user_data_dir).expanduser().resolve()),
            executable_path=str(plan.executable),
            **options,
        )


async def launch_playwright_persistent_async(
    playwright: Any,
    user_data_dir: str | Path,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
) -> Any:
    with prepare_launch(executable, profile or {}, lease, temp_root=temp_root) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        return await playwright.chromium.launch_persistent_context(
            str(Path(user_data_dir).expanduser().resolve()),
            executable_path=str(plan.executable),
            **options,
        )
