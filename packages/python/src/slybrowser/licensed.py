"""Install and launch the latest browser allowed by a license authorization file."""

from __future__ import annotations

import platform as host_platform
import asyncio
import inspect
import random
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

from .browser import (
    launch_playwright,
    launch_playwright_async,
    launch_playwright_persistent,
    launch_playwright_persistent_async,
)
from .installer import (
    BrowserInstallation,
    BrowserInstallationReference,
    acquire_browser_installation_reference,
    find_current_browser_installation,
    install_granted_browser,
)
from .errors import ArtifactError, ConfigurationError, LicenseServiceError
from .service import (
    LicenseServiceClient,
    RuntimeSessionGrant,
    read_license_authorization,
)
from .webdriver import SlyWebDriverSession, launch


def _platform() -> str:
    value = host_platform.system().lower()
    if value == "windows":
        return "windows"
    if value == "linux":
        return "linux"
    if value == "darwin":
        return "macos"
    raise RuntimeError(f"Unsupported platform: {value}")


def _arch() -> str:
    value = host_platform.machine().lower()
    if value in {"amd64", "x86_64"}:
        return "x64"
    if value in {"arm64", "aarch64"}:
        return "arm64"
    raise RuntimeError(f"Unsupported architecture: {value}")


def _compare_version(left: str, right: str) -> int:
    left_parts = [int(value) for value in left.split(".")]
    right_parts = [int(value) for value in right.split(".")]
    for index in range(max(len(left_parts), len(right_parts))):
        difference = (left_parts[index] if index < len(left_parts) else 0) - (right_parts[index] if index < len(right_parts) else 0)
        if difference:
            return -1 if difference < 0 else 1
    return 0


def verify_browser_version_audit(audit: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(audit)
    if result["downloaded"] != result["selected"] or result["launched"] != result["selected"]:
        raise ArtifactError(
            f"Browser version chain mismatch: selected={result['selected']}, downloaded={result['downloaded']}, launched={result['launched']}",
            code="browser_version_chain_mismatch",
        )
    policy = result["policy"]
    requested = result["requested"]
    if (
        policy == "latest" and requested is not None
        or policy == "exact" and requested != result["selected"]
        or policy == "at-or-before" and (requested is None or _compare_version(result["selected"], requested) > 0)
    ):
        raise ArtifactError("Requested and selected browser versions violate the declared policy", code="browser_version_policy_mismatch")
    return result


def _heartbeat_delay_seconds(
    heartbeat_after_seconds: int,
    random_float: Callable[[], float] = random.random,
) -> float:
    base_seconds = max(1.0, float(heartbeat_after_seconds))
    jitter_window_seconds = min(15.0, max(0.0, base_seconds - 1.0))
    sample = max(0.0, min(1.0, float(random_float())))
    return base_seconds - jitter_window_seconds * sample


class _BootstrapHeartbeat:
    def __init__(self, client: LicenseServiceClient, grant: RuntimeSessionGrant) -> None:
        self.client = client
        self.grant = grant
        self.stop_event = threading.Event()
        self.failure: BaseException | None = None
        self.thread = threading.Thread(target=self._run, name="sly-install-license-heartbeat", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=2)

    def _run(self) -> None:
        while not self.stop_event.wait(_heartbeat_delay_seconds(self.grant.heartbeat_after_seconds)):
            try:
                renewal = self.client.bootstrap_heartbeat(self.grant)
                self.grant.expires_at = renewal.expires_at
                self.grant.lease = renewal.lease
                self.grant.claims = renewal.claims
                self.failure = None
            except BaseException as error:
                self.failure = error


@dataclass(slots=True)
class AuthorizedInstallation:
    client: LicenseServiceClient
    grant: RuntimeSessionGrant
    installation: BrowserInstallation
    released: bool = False

    def release(self) -> None:
        if self.released:
            return
        self.released = True
        self.client.release_runtime_session(self.grant)


def _runtime_bootstrap_handoff(
    client: LicenseServiceClient,
    grant: RuntimeSessionGrant,
    existing: Mapping[str, Any] | None = None,
    activation_ticket: str | None = None,
) -> dict[str, Any]:
    return {
        **dict(existing or {}),
        "schemaVersion": 2,
        "serviceUrl": client.authorization.service_url,
        "state": grant.state,
        "startupId": grant.startup_id,
        "sessionId": grant.session_id,
        "bootstrapToken": grant.bootstrap_token,
        "activationTicket": activation_ticket or grant.activation_ticket,
        "heartbeatAfterSeconds": grant.heartbeat_after_seconds,
        "expiresAt": grant.expires_at,
        "plan": grant.plan,
        "features": list(grant.features),
        "concurrencyLimit": grant.concurrency_limit,
        "activeSessions": grant.active_sessions,
        "browserVersion": grant.browser_version,
        **({} if grant.automation_backend is None else {"automationBackend": grant.automation_backend}),
    }


def _driver_runtime_bootstrap_handoff(
    client: LicenseServiceClient,
    grant: RuntimeSessionGrant,
    existing: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    if not grant.driver_activation_ticket:
        raise ConfigurationError(
            "Project WebDriver runtime session is missing a driver activation ticket",
            code="license_service_invalid_response",
        )
    return _runtime_bootstrap_handoff(client, grant, existing, grant.driver_activation_ticket)


def _normalize_framework_browser_version(value: Any) -> str:
    if not isinstance(value, str):
        raise ArtifactError("Framework browser did not report a version", code="browser_version_missing")
    match = re.search(r"(\d+\.\d+\.\d+\.\d+)", value)
    if not match:
        raise ArtifactError(f"Framework browser returned an unsupported version string: {value}", code="browser_version_invalid")
    return match.group(1)


def _framework_runtime_version(runtime: Any) -> str:
    version = getattr(runtime, "version", None)
    if callable(version):
        return _normalize_framework_browser_version(version())
    if isinstance(version, str):
        return _normalize_framework_browser_version(version)
    browser = getattr(runtime, "browser", None)
    if callable(browser):
        browser = browser()
    if browser is not None:
        version = getattr(browser, "version", None)
        if callable(version):
            return _normalize_framework_browser_version(version())
        if isinstance(version, str):
            return _normalize_framework_browser_version(version)
    raise ArtifactError("Framework browser did not expose a version method", code="browser_version_missing")


async def _framework_runtime_version_async(runtime: Any) -> str:
    version = getattr(runtime, "version", None)
    if callable(version):
        result = version()
        if inspect.isawaitable(result):
            result = await result
        return _normalize_framework_browser_version(result)
    if isinstance(version, str):
        return _normalize_framework_browser_version(version)
    browser = getattr(runtime, "browser", None)
    if callable(browser):
        browser = browser()
        if inspect.isawaitable(browser):
            browser = await browser
    if browser is not None:
        version = getattr(browser, "version", None)
        if callable(version):
            result = version()
            if inspect.isawaitable(result):
                result = await result
            return _normalize_framework_browser_version(result)
        if isinstance(version, str):
            return _normalize_framework_browser_version(version)
    raise ArtifactError("Framework browser did not expose a version method", code="browser_version_missing")


def _licensed_runtime_metadata(authorized: AuthorizedInstallation, version_audit: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "sessionId": authorized.grant.session_id,
        "plan": authorized.grant.plan,
        "concurrencyLimit": authorized.grant.concurrency_limit,
        "browserVersion": authorized.grant.browser_version,
        "versionPolicy": authorized.grant.version_policy,
        "selectionReason": authorized.grant.selection_reason,
        "versionAudit": dict(version_audit),
    }


class _LicensedRuntimeProxy:
    def __init__(self, runtime: Any, release: Callable[[], None], license_runtime: Mapping[str, Any]) -> None:
        self._runtime = runtime
        self._release = release
        self.license_runtime = dict(license_runtime)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runtime, name)

    def close(self, *args: Any, **kwargs: Any) -> Any:
        try:
            return self._runtime.close(*args, **kwargs)
        finally:
            self._release()


class _AsyncLicensedRuntimeProxy:
    def __init__(self, runtime: Any, release: Callable[[], None], license_runtime: Mapping[str, Any]) -> None:
        self._runtime = runtime
        self._release = release
        self.license_runtime = dict(license_runtime)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._runtime, name)

    async def close(self, *args: Any, **kwargs: Any) -> Any:
        try:
            result = self._runtime.close(*args, **kwargs)
            if inspect.isawaitable(result):
                return await result
            return result
        finally:
            self._release()


def _attach_framework_license(
    runtime: Any,
    authorized: AuthorizedInstallation,
    version_audit: Mapping[str, Any],
    reference: BrowserInstallationReference,
) -> Any:
    if not callable(getattr(runtime, "close", None)):
        raise ArtifactError("Framework runtime does not expose a close method for license release", code="framework_runtime_close_missing")
    metadata = _licensed_runtime_metadata(authorized, version_audit)
    original_close = runtime.close
    released = False

    def release() -> None:
        nonlocal released
        if released:
            return
        released = True
        try:
            authorized.release()
        except Exception:
            pass
        reference.release()

    def close_with_release(*args: Any, **kwargs: Any) -> Any:
        try:
            return original_close(*args, **kwargs)
        finally:
            release()

    try:
        runtime.license_runtime = metadata
        runtime.close = close_with_release
        return runtime
    except (AttributeError, TypeError):
        return _LicensedRuntimeProxy(runtime, release, metadata)


def _attach_framework_license_async(
    runtime: Any,
    authorized: AuthorizedInstallation,
    version_audit: Mapping[str, Any],
    reference: BrowserInstallationReference,
) -> Any:
    if not callable(getattr(runtime, "close", None)):
        raise ArtifactError("Framework runtime does not expose a close method for license release", code="framework_runtime_close_missing")
    metadata = _licensed_runtime_metadata(authorized, version_audit)
    original_close = runtime.close
    released = False

    def release() -> None:
        nonlocal released
        if released:
            return
        released = True
        try:
            authorized.release()
        except Exception:
            pass
        reference.release()

    async def close_with_release(*args: Any, **kwargs: Any) -> Any:
        try:
            result = original_close(*args, **kwargs)
            if inspect.isawaitable(result):
                return await result
            return result
        finally:
            release()

    try:
        runtime.license_runtime = metadata
        runtime.close = close_with_release
        return runtime
    except (AttributeError, TypeError):
        return _AsyncLicensedRuntimeProxy(runtime, release, metadata)


def _finalize_framework_runtime(runtime: Any, authorized: AuthorizedInstallation) -> Any:
    reference: BrowserInstallationReference | None = None
    try:
        if not callable(getattr(runtime, "close", None)):
            raise ArtifactError("Framework runtime does not expose a close method for license release", code="framework_runtime_close_missing")
        version_audit = verify_browser_version_audit({
            "requested": authorized.grant.requested_browser_version,
            "selected": authorized.grant.browser_version,
            "downloaded": authorized.installation.version,
            "launched": _framework_runtime_version(runtime),
            "policy": authorized.grant.version_policy,
            "selectionReason": authorized.grant.selection_reason,
        })
        reference = acquire_browser_installation_reference(authorized.installation)
        return _attach_framework_license(runtime, authorized, version_audit, reference)
    except BaseException:
        if reference is not None:
            reference.release()
        try:
            if callable(getattr(runtime, "close", None)):
                runtime.close()
        finally:
            try:
                authorized.release()
            except Exception:
                pass
        raise


async def _finalize_framework_runtime_async(runtime: Any, authorized: AuthorizedInstallation) -> Any:
    reference: BrowserInstallationReference | None = None
    try:
        if not callable(getattr(runtime, "close", None)):
            raise ArtifactError("Framework runtime does not expose a close method for license release", code="framework_runtime_close_missing")
        version_audit = verify_browser_version_audit({
            "requested": authorized.grant.requested_browser_version,
            "selected": authorized.grant.browser_version,
            "downloaded": authorized.installation.version,
            "launched": await _framework_runtime_version_async(runtime),
            "policy": authorized.grant.version_policy,
            "selectionReason": authorized.grant.selection_reason,
        })
        reference = acquire_browser_installation_reference(authorized.installation)
        return _attach_framework_license_async(runtime, authorized, version_audit, reference)
    except BaseException:
        if reference is not None:
            reference.release()
        try:
            if callable(getattr(runtime, "close", None)):
                result = runtime.close()
                if inspect.isawaitable(result):
                    await result
        finally:
            try:
                authorized.release()
            except Exception:
                pass
        raise


def prepare_latest_authorized_browser(
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    kernel_major: int | str | None = None,
    update_kernel: bool | None = True,
    browser_version: str | None = None,
    version_policy: str | None = None,
    automation_backend: str | None = "project-webdriver",
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
) -> AuthorizedInstallation:
    authorization = read_license_authorization(
        authorization_file,
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
    )
    client = LicenseServiceClient(
        authorization,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        transport=transport,
        artifact_downloader=artifact_downloader,
        allow_insecure_localhost=allow_insecure_localhost,
    )
    local_candidate = (
        find_current_browser_installation(
            cache_root=cache_root,
            platform=platform,
            arch=arch,
            kernel_major=kernel_major,
        )
        if update_kernel is False and browser_version is None and version_policy is None
        else None
    )
    try:
        grant = client.create_runtime_session(
            platform=platform or _platform(),
            arch=arch or _arch(),
            automation_backend=automation_backend,
            device_hash=device_hash,
            kernel_major=kernel_major,
            update_kernel=update_kernel,
            browser_version=local_candidate.version if local_candidate else browser_version,
            version_policy="exact" if local_candidate else version_policy,
        )
    except LicenseServiceError as error:
        if local_candidate and error.code == "release_version_unavailable":
            raise LicenseServiceError(
                "The current local browser release was withdrawn; update is required before continuing",
                code="kernel_update_required",
                status=409,
            ) from error
        raise
    heartbeat = _BootstrapHeartbeat(client, grant)
    heartbeat.start()
    try:
        installation = install_granted_browser(
            client,
            grant,
            cache_root=cache_root,
            extractor=extractor,
        )
        if heartbeat.failure and grant.expires_at <= int(time.time()) + 30:
            raise heartbeat.failure
        return AuthorizedInstallation(client, grant, installation)
    except BaseException:
        try:
            client.release_runtime_session(grant)
        except Exception:
            pass
        raise
    finally:
        heartbeat.stop()


def install_latest(
    authorization_file: str | Path,
    **options: Any,
) -> BrowserInstallation:
    authorized = prepare_latest_authorized_browser(authorization_file, **options)
    try:
        return authorized.installation
    finally:
        try:
            authorized.release()
        except Exception:
            pass


def launch_latest(
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    kernel_major: int | str | None = None,
    update_kernel: bool | None = True,
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
    **webdriver_options: Any,
) -> SlyWebDriverSession:
    authorized = prepare_latest_authorized_browser(
        authorization_file,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        cache_root=cache_root,
        platform=platform,
        arch=arch,
        device_hash=device_hash,
        kernel_major=kernel_major,
        update_kernel=update_kernel,
        browser_version=browser_version,
        version_policy=version_policy,
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
        transport=transport,
        artifact_downloader=artifact_downloader,
        extractor=extractor,
        automation_backend="project-webdriver",
    )
    reference: BrowserInstallationReference | None = None
    heartbeat = _BootstrapHeartbeat(authorized.client, authorized.grant)
    try:
        webdriver_options.pop("driver_executable", None)
        supplied_runtime_handoff = webdriver_options.pop("runtime_handoff", None)
        supplied_driver_runtime_handoff = webdriver_options.pop("driver_runtime_handoff", None)
        heartbeat.start()
        reference = acquire_browser_installation_reference(authorized.installation)
        browser = launch(
            authorized.installation.browser_executable,
            authorized.grant.lease,
            driver_executable=authorized.installation.driver_executable,
            runtime_handoff=_runtime_bootstrap_handoff(authorized.client, authorized.grant, supplied_runtime_handoff),
            driver_runtime_handoff=_driver_runtime_bootstrap_handoff(
                authorized.client,
                authorized.grant,
                supplied_driver_runtime_handoff,
            ),
            allow_runtime_activation_ticket=True,
            **webdriver_options,
        )
        try:
            version_audit = verify_browser_version_audit({
                "requested": authorized.grant.requested_browser_version,
                "selected": authorized.grant.browser_version,
                "downloaded": authorized.installation.version,
                "launched": browser.versions.browser_version,
                "policy": authorized.grant.version_policy,
                "selectionReason": authorized.grant.selection_reason,
            })
        except BaseException:
            browser.close()
            raise
        heartbeat.stop()
        browser.license_runtime = {
            "sessionId": authorized.grant.session_id,
            "plan": authorized.grant.plan,
            "concurrencyLimit": authorized.grant.concurrency_limit,
            "browserVersion": authorized.grant.browser_version,
            "versionPolicy": authorized.grant.version_policy,
            "selectionReason": authorized.grant.selection_reason,
            "versionAudit": version_audit,
        }
        released = False

        def release_runtime_reference() -> None:
            nonlocal released
            if released:
                return
            released = True
            try:
                authorized.release()
            except Exception:
                pass
            if reference is not None:
                reference.release()

        browser.add_close_callback(release_runtime_reference)
        return browser
    except BaseException:
        heartbeat.stop()
        if reference is not None:
            reference.release()
        try:
            authorized.release()
        except Exception:
            pass
        raise


def launch_latest_playwright(
    playwright: Any,
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    kernel_major: int | str | None = None,
    update_kernel: bool | None = True,
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
) -> Any:
    authorized = prepare_latest_authorized_browser(
        authorization_file,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        cache_root=cache_root,
        platform=platform,
        arch=arch,
        device_hash=device_hash,
        kernel_major=kernel_major,
        update_kernel=update_kernel,
        browser_version=browser_version,
        version_policy=version_policy,
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
        transport=transport,
        artifact_downloader=artifact_downloader,
        extractor=extractor,
        automation_backend="playwright",
    )
    heartbeat = _BootstrapHeartbeat(authorized.client, authorized.grant)
    try:
        heartbeat.start()
        runtime = launch_playwright(
            playwright,
            authorized.installation.browser_executable,
            authorized.grant.lease,
            profile=profile,
            launch_options=launch_options,
            temp_root=temp_root,
            framework_version=framework_version,
            humanize=humanize,
            runtime_handoff=_runtime_bootstrap_handoff(authorized.client, authorized.grant),
            allow_runtime_activation_ticket=True,
        )
        heartbeat.stop()
        return _finalize_framework_runtime(runtime, authorized)
    except BaseException:
        heartbeat.stop()
        try:
            authorized.release()
        except Exception:
            pass
        raise


def launch_latest_playwright_persistent(
    playwright: Any,
    user_data_dir: str | Path,
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    kernel_major: int | str | None = None,
    update_kernel: bool | None = True,
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
) -> Any:
    authorized = prepare_latest_authorized_browser(
        authorization_file,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        cache_root=cache_root,
        platform=platform,
        arch=arch,
        device_hash=device_hash,
        kernel_major=kernel_major,
        update_kernel=update_kernel,
        browser_version=browser_version,
        version_policy=version_policy,
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
        transport=transport,
        artifact_downloader=artifact_downloader,
        extractor=extractor,
        automation_backend="playwright",
    )
    heartbeat = _BootstrapHeartbeat(authorized.client, authorized.grant)
    try:
        heartbeat.start()
        runtime = launch_playwright_persistent(
            playwright,
            user_data_dir,
            authorized.installation.browser_executable,
            authorized.grant.lease,
            profile=profile,
            launch_options=launch_options,
            temp_root=temp_root,
            framework_version=framework_version,
            humanize=humanize,
            runtime_handoff=_runtime_bootstrap_handoff(authorized.client, authorized.grant),
            allow_runtime_activation_ticket=True,
        )
        heartbeat.stop()
        return _finalize_framework_runtime(runtime, authorized)
    except BaseException:
        heartbeat.stop()
        try:
            authorized.release()
        except Exception:
            pass
        raise


async def launch_latest_playwright_async(
    playwright: Any,
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    kernel_major: int | str | None = None,
    update_kernel: bool | None = True,
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
) -> Any:
    authorized = prepare_latest_authorized_browser(
        authorization_file,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        cache_root=cache_root,
        platform=platform,
        arch=arch,
        device_hash=device_hash,
        kernel_major=kernel_major,
        update_kernel=update_kernel,
        browser_version=browser_version,
        version_policy=version_policy,
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
        transport=transport,
        artifact_downloader=artifact_downloader,
        extractor=extractor,
        automation_backend="playwright",
    )
    heartbeat = _BootstrapHeartbeat(authorized.client, authorized.grant)
    try:
        heartbeat.start()
        runtime = await launch_playwright_async(
            playwright,
            authorized.installation.browser_executable,
            authorized.grant.lease,
            profile=profile,
            launch_options=launch_options,
            temp_root=temp_root,
            framework_version=framework_version,
            humanize=humanize,
            runtime_handoff=_runtime_bootstrap_handoff(authorized.client, authorized.grant),
            allow_runtime_activation_ticket=True,
        )
        heartbeat.stop()
        return await _finalize_framework_runtime_async(runtime, authorized)
    except BaseException:
        heartbeat.stop()
        try:
            authorized.release()
        except Exception:
            pass
        raise


async def launch_latest_playwright_persistent_async(
    playwright: Any,
    user_data_dir: str | Path,
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    kernel_major: int | str | None = None,
    update_kernel: bool | None = True,
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
    profile: Mapping[str, Any] | None = None,
    launch_options: Mapping[str, Any] | None = None,
    temp_root: str | Path | None = None,
    framework_version: str | None = None,
    humanize: bool = False,
) -> Any:
    authorized = prepare_latest_authorized_browser(
        authorization_file,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        cache_root=cache_root,
        platform=platform,
        arch=arch,
        device_hash=device_hash,
        kernel_major=kernel_major,
        update_kernel=update_kernel,
        browser_version=browser_version,
        version_policy=version_policy,
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
        transport=transport,
        artifact_downloader=artifact_downloader,
        extractor=extractor,
        automation_backend="playwright",
    )
    heartbeat = _BootstrapHeartbeat(authorized.client, authorized.grant)
    try:
        heartbeat.start()
        runtime = await launch_playwright_persistent_async(
            playwright,
            user_data_dir,
            authorized.installation.browser_executable,
            authorized.grant.lease,
            profile=profile,
            launch_options=launch_options,
            temp_root=temp_root,
            framework_version=framework_version,
            humanize=humanize,
            runtime_handoff=_runtime_bootstrap_handoff(authorized.client, authorized.grant),
            allow_runtime_activation_ticket=True,
        )
        heartbeat.stop()
        return await _finalize_framework_runtime_async(runtime, authorized)
    except BaseException:
        heartbeat.stop()
        try:
            authorized.release()
        except Exception:
            pass
        raise


def prepare_authorized_browser(
    authorization_file: str | Path,
    **options: Any,
) -> AuthorizedInstallation:
    options.setdefault("update_kernel", False)
    return prepare_latest_authorized_browser(authorization_file, **options)


def install_authorized(
    authorization_file: str | Path,
    **options: Any,
) -> BrowserInstallation:
    options.setdefault("update_kernel", False)
    return install_latest(authorization_file, **options)


def launch_authorized(
    authorization_file: str | Path,
    **options: Any,
) -> SlyWebDriverSession:
    options.setdefault("update_kernel", False)
    return launch_latest(authorization_file, **options)


def launch_authorized_playwright(
    playwright: Any,
    authorization_file: str | Path,
    **options: Any,
) -> Any:
    options.setdefault("update_kernel", False)
    return launch_latest_playwright(playwright, authorization_file, **options)


def launch_authorized_playwright_persistent(
    playwright: Any,
    user_data_dir: str | Path,
    authorization_file: str | Path,
    **options: Any,
) -> Any:
    options.setdefault("update_kernel", False)
    return launch_latest_playwright_persistent(playwright, user_data_dir, authorization_file, **options)


async def launch_authorized_playwright_async(
    playwright: Any,
    authorization_file: str | Path,
    **options: Any,
) -> Any:
    options.setdefault("update_kernel", False)
    return await launch_latest_playwright_async(playwright, authorization_file, **options)


async def launch_authorized_playwright_persistent_async(
    playwright: Any,
    user_data_dir: str | Path,
    authorization_file: str | Path,
    **options: Any,
) -> Any:
    options.setdefault("update_kernel", False)
    return await launch_latest_playwright_persistent_async(playwright, user_data_dir, authorization_file, **options)
