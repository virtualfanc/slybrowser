"""Framework adapters that launch the native SlyBrowser executable."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .automation import require_playwright_humanize_support, resolve_playwright_version
from .errors import ConfigurationError
from .launcher import LaunchPlan, prepare_launch, wait_for_native_ready
from .webdriver import _release_root_from_lease, resolve_humanize_config


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


def _camel_humanize_config(config: object) -> dict[str, int]:
    return {
        "mouseStepsMin": config.mouse_steps_min,
        "mouseStepsMax": config.mouse_steps_max,
        "mouseStepDelayMin": config.mouse_step_delay_min,
        "mouseStepDelayMax": config.mouse_step_delay_max,
        "clickHoldMin": config.click_hold_min,
        "clickHoldMax": config.click_hold_max,
        "keyDelayMin": config.key_delay_min,
        "keyDelayMax": config.key_delay_max,
        "thinkDelayMin": config.think_delay_min,
        "thinkDelayMax": config.think_delay_max,
    }


def _native_humanize_control(
    *,
    humanize: bool,
    human_preset: str,
    human_config: Mapping[str, int | float] | None,
    human_seed: int | None,
) -> dict[str, Any] | None:
    if not humanize:
        return None
    if human_seed is not None and (not isinstance(human_seed, int) or human_seed < 0):
        raise ConfigurationError("Native Humanize seed must be a non-negative integer", code="humanize_seed_invalid")
    return {
        "schemaVersion": 1,
        "kind": "slybrowser.native-humanize-control",
        "backend": "playwright",
        "humanize": {
            "enabled": True,
            "version": 1,
            "preset": human_preset,
            "config": _camel_humanize_config(resolve_humanize_config(human_preset, human_config)),
            **({} if human_seed is None else {"seed": human_seed}),
        },
    }


def _validate_native_ready(native_ready: bool, native_ready_timeout: float) -> None:
    if native_ready and (not isinstance(native_ready_timeout, (int, float)) or native_ready_timeout <= 0):
        raise ConfigurationError("native_ready_timeout must be positive", code="config_invalid")


def _close_runtime(runtime: Any) -> None:
    close = getattr(runtime, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


async def _close_runtime_async(runtime: Any) -> None:
    import inspect

    close = getattr(runtime, "close", None)
    if callable(close):
        try:
            result = close()
            if inspect.isawaitable(result):
                await result
        except Exception:
            pass


def _wait_if_requested(plan: LaunchPlan, native_ready: bool, native_ready_timeout: float) -> None:
    if native_ready:
        wait_for_native_ready(plan, timeout=native_ready_timeout)


def launch_playwright(
    playwright: Any,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
    human_preset: str = "default",
    human_config: Mapping[str, int | float] | None = None,
    human_seed: int | None = None,
    runtime_handoff: Mapping[str, Any] | None = None,
    allow_runtime_activation_ticket: bool = False,
    release_root: str | Path | None = None,
    native_ready: bool = False,
    native_ready_timeout: float = 15.0,
) -> Any:
    """Launch a non-persistent Playwright browser using an existing Playwright object."""

    resolve_playwright_version(framework_version)
    require_playwright_humanize_support(humanize)
    _validate_native_ready(native_ready, native_ready_timeout)
    with prepare_launch(
        executable,
        profile or {},
        lease,
        temp_root=temp_root,
        runtime_handoff=runtime_handoff,
        allow_runtime_activation_ticket=allow_runtime_activation_ticket,
        release_root=Path(release_root).expanduser().resolve() if release_root is not None else _release_root_from_lease(executable, lease),
        native_ready=native_ready,
        humanize_control=_native_humanize_control(
            humanize=humanize,
            human_preset=human_preset,
            human_config=human_config,
            human_seed=human_seed,
        ),
    ) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        runtime = playwright.chromium.launch(executable_path=str(plan.executable), **options)
        try:
            _wait_if_requested(plan, native_ready, native_ready_timeout)
            return runtime
        except BaseException:
            _close_runtime(runtime)
            raise


async def launch_playwright_async(
    playwright: Any,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
    human_preset: str = "default",
    human_config: Mapping[str, int | float] | None = None,
    human_seed: int | None = None,
    runtime_handoff: Mapping[str, Any] | None = None,
    allow_runtime_activation_ticket: bool = False,
    release_root: str | Path | None = None,
    native_ready: bool = False,
    native_ready_timeout: float = 15.0,
) -> Any:
    resolve_playwright_version(framework_version)
    require_playwright_humanize_support(humanize)
    _validate_native_ready(native_ready, native_ready_timeout)
    with prepare_launch(
        executable,
        profile or {},
        lease,
        temp_root=temp_root,
        runtime_handoff=runtime_handoff,
        allow_runtime_activation_ticket=allow_runtime_activation_ticket,
        release_root=Path(release_root).expanduser().resolve() if release_root is not None else _release_root_from_lease(executable, lease),
        native_ready=native_ready,
        humanize_control=_native_humanize_control(
            humanize=humanize,
            human_preset=human_preset,
            human_config=human_config,
            human_seed=human_seed,
        ),
    ) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        runtime = await playwright.chromium.launch(executable_path=str(plan.executable), **options)
        try:
            _wait_if_requested(plan, native_ready, native_ready_timeout)
            return runtime
        except BaseException:
            await _close_runtime_async(runtime)
            raise


def launch_playwright_persistent(
    playwright: Any,
    user_data_dir: str | Path,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
    human_preset: str = "default",
    human_config: Mapping[str, int | float] | None = None,
    human_seed: int | None = None,
    runtime_handoff: Mapping[str, Any] | None = None,
    allow_runtime_activation_ticket: bool = False,
    release_root: str | Path | None = None,
    native_ready: bool = False,
    native_ready_timeout: float = 15.0,
) -> Any:
    resolve_playwright_version(framework_version)
    require_playwright_humanize_support(humanize)
    _validate_native_ready(native_ready, native_ready_timeout)
    with prepare_launch(
        executable,
        profile or {},
        lease,
        temp_root=temp_root,
        runtime_handoff=runtime_handoff,
        allow_runtime_activation_ticket=allow_runtime_activation_ticket,
        release_root=Path(release_root).expanduser().resolve() if release_root is not None else _release_root_from_lease(executable, lease),
        native_ready=native_ready,
        humanize_control=_native_humanize_control(
            humanize=humanize,
            human_preset=human_preset,
            human_config=human_config,
            human_seed=human_seed,
        ),
    ) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        runtime = playwright.chromium.launch_persistent_context(
            str(Path(user_data_dir).expanduser().resolve()),
            executable_path=str(plan.executable),
            **options,
        )
        try:
            _wait_if_requested(plan, native_ready, native_ready_timeout)
            return runtime
        except BaseException:
            _close_runtime(runtime)
            raise


async def launch_playwright_persistent_async(
    playwright: Any,
    user_data_dir: str | Path,
    executable: str | Path,
    lease: str | bytes | Mapping[str, Any],
    *,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
    human_preset: str = "default",
    human_config: Mapping[str, int | float] | None = None,
    human_seed: int | None = None,
    runtime_handoff: Mapping[str, Any] | None = None,
    allow_runtime_activation_ticket: bool = False,
    release_root: str | Path | None = None,
    native_ready: bool = False,
    native_ready_timeout: float = 15.0,
) -> Any:
    resolve_playwright_version(framework_version)
    require_playwright_humanize_support(humanize)
    _validate_native_ready(native_ready, native_ready_timeout)
    with prepare_launch(
        executable,
        profile or {},
        lease,
        temp_root=temp_root,
        runtime_handoff=runtime_handoff,
        allow_runtime_activation_ticket=allow_runtime_activation_ticket,
        release_root=Path(release_root).expanduser().resolve() if release_root is not None else _release_root_from_lease(executable, lease),
        native_ready=native_ready,
        humanize_control=_native_humanize_control(
            humanize=humanize,
            human_preset=human_preset,
            human_config=human_config,
            human_seed=human_seed,
        ),
    ) as plan:
        options = _launch_arguments(launch_options, plan.arguments)
        runtime = await playwright.chromium.launch_persistent_context(
            str(Path(user_data_dir).expanduser().resolve()),
            executable_path=str(plan.executable),
            **options,
        )
        try:
            _wait_if_requested(plan, native_ready, native_ready_timeout)
            return runtime
        except BaseException:
            await _close_runtime_async(runtime)
            raise
