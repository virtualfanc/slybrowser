"""Install and launch the latest browser allowed by a license authorization file."""

from __future__ import annotations

import platform as host_platform
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .installer import BrowserInstallation, install_granted_browser
from .errors import ArtifactError
from .service import (
    LicenseServiceClient,
    LicensedSessionGrant,
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


class _InstallHeartbeat:
    def __init__(self, client: LicenseServiceClient, grant: LicensedSessionGrant) -> None:
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
        while not self.stop_event.wait(self.grant.heartbeat_after_seconds):
            try:
                self.client.heartbeat(self.grant)
                self.failure = None
            except BaseException as error:
                self.failure = error


class _RuntimeHeartbeat(_InstallHeartbeat):
    def __init__(self, client: LicenseServiceClient, grant: LicensedSessionGrant, browser: SlyWebDriverSession) -> None:
        super().__init__(client, grant)
        self.browser = browser
        self.released = False

    def stop_and_release(self) -> None:
        if self.released:
            return
        self.released = True
        self.stop()
        try:
            self.client.release(self.grant)
        except Exception:
            pass

    def _run(self) -> None:
        while not self.stop_event.wait(self.grant.heartbeat_after_seconds):
            try:
                self.client.heartbeat(self.grant)
                self.failure = None
            except BaseException as error:
                self.failure = error
                if self.grant.expires_at <= int(time.time()) + 30:
                    self.browser.close()
                    return


@dataclass(slots=True)
class AuthorizedInstallation:
    client: LicenseServiceClient
    grant: LicensedSessionGrant
    installation: BrowserInstallation
    released: bool = False

    def release(self) -> None:
        if self.released:
            return
        self.released = True
        self.client.release(self.grant)


def prepare_latest_authorized_browser(
    authorization_file: str | Path,
    *,
    license_trusted_keys: Mapping[str, bytes],
    release_trusted_keys: Mapping[str, bytes],
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    device_hash: str | None = None,
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
    transport: Any = None,
    artifact_downloader: Any = None,
    extractor: Any = None,
) -> AuthorizedInstallation:
    authorization = read_license_authorization(
        authorization_file,
        allow_insecure_localhost=allow_insecure_localhost,
    )
    client = LicenseServiceClient(
        authorization,
        license_trusted_keys=license_trusted_keys,
        release_trusted_keys=release_trusted_keys,
        transport=transport,
        artifact_downloader=artifact_downloader,
        allow_insecure_localhost=allow_insecure_localhost,
    )
    grant = client.create_session(
        platform=platform or _platform(),
        arch=arch or _arch(),
        device_hash=device_hash,
        browser_version=browser_version,
        version_policy=version_policy,
    )
    heartbeat = _InstallHeartbeat(client, grant)
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
            client.release(grant)
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
    browser_version: str | None = None,
    version_policy: str | None = None,
    allow_insecure_localhost: bool = False,
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
        browser_version=browser_version,
        version_policy=version_policy,
        allow_insecure_localhost=allow_insecure_localhost,
        transport=transport,
        artifact_downloader=artifact_downloader,
        extractor=extractor,
    )
    try:
        webdriver_options.pop("driver_executable", None)
        browser = launch(
            authorized.installation.browser_executable,
            authorized.grant.lease,
            driver_executable=authorized.installation.driver_executable,
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
        browser.license_runtime = {
            "sessionId": authorized.grant.session_id,
            "plan": authorized.grant.plan,
            "concurrencyLimit": authorized.grant.concurrency_limit,
            "browserVersion": authorized.grant.browser_version,
            "versionPolicy": authorized.grant.version_policy,
            "selectionReason": authorized.grant.selection_reason,
            "versionAudit": version_audit,
        }
        controller = _RuntimeHeartbeat(authorized.client, authorized.grant, browser)
        browser.add_close_callback(controller.stop_and_release)
        controller.start()
        return browser
    except BaseException:
        try:
            authorized.release()
        except Exception:
            pass
        raise
