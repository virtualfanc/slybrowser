"""Secure construction and cleanup of SlyBrowser launch handoff files."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping

from .errors import ConfigurationError

FIRST_RELEASE_UNSUPPORTED_FEATURE_CODE = "launch_feature_unsupported"


@dataclass(frozen=True, slots=True)
class LaunchPlan:
    executable: Path
    arguments: tuple[str, ...]
    config_file: Path
    license_file: Path
    driver_license_file: Path | None = None
    runtime_file: Path | None = None
    driver_runtime_file: Path | None = None
    release_root: Path | None = None
    humanize_config_file: Path | None = None
    native_ready_request_file: Path | None = None
    native_ready_file: Path | None = None
    native_ready_nonce: str | None = None


def _raise_unsupported_launch_feature(field: str) -> None:
    raise ConfigurationError(
        f"{field} is not supported in the first SlyBrowser release",
        code=FIRST_RELEASE_UNSUPPORTED_FEATURE_CODE,
    )


def _is_unsupported_webrtc_mode(value: Any) -> bool:
    return value == "proxy" or isinstance(value, Mapping) and value.get("mode") == "replace"


def _assert_fingerprint_profile(options: Mapping[str, Any]) -> None:
    profile = options.get("profile") if isinstance(options.get("profile"), Mapping) else options
    has_mode = "fingerprintMode" in profile
    has_seed = "fingerprintSeed" in profile
    has_schema = "fingerprintSchemaVersion" in profile
    if not (has_mode or has_seed or has_schema):
        return
    mode = profile.get("fingerprintMode", "seeded" if has_seed or has_schema else "explicit")
    if mode not in {"explicit", "seeded"}:
        raise ConfigurationError("profile.fingerprintMode is invalid", code="profile_invalid")
    seed = profile.get("fingerprintSeed")
    if has_seed and (not isinstance(seed, str) or not seed or len(seed) > 128):
        raise ConfigurationError("profile.fingerprintSeed is invalid", code="profile_invalid")
    if has_schema and profile.get("fingerprintSchemaVersion") != 1:
        raise ConfigurationError("profile.fingerprintSchemaVersion is unsupported", code="profile_invalid")
    if mode == "explicit" and (has_seed or has_schema):
        raise ConfigurationError("profile.fingerprintSeed requires seeded fingerprint mode", code="profile_invalid")
    if mode == "seeded" and not (has_seed and has_schema):
        raise ConfigurationError("Seeded fingerprint mode requires seed and schema version", code="profile_invalid")


def _assert_first_release_network_and_geo_boundary(options: Mapping[str, Any]) -> None:
    if "proxy" in options:
        _raise_unsupported_launch_feature("proxy")
    if "proxyAlignment" in options:
        _raise_unsupported_launch_feature("proxyAlignment")
    if "geolocation" in options:
        _raise_unsupported_launch_feature("geolocation")
    if "geo" in options:
        _raise_unsupported_launch_feature("geo")
    if "geoIp" in options or "geoip" in options:
        _raise_unsupported_launch_feature("geoIp")
    if "webrtc" in options and _is_unsupported_webrtc_mode(options["webrtc"]):
        _raise_unsupported_launch_feature("webrtc proxy mode")

    profile = options.get("profile")
    if isinstance(profile, Mapping):
        if "geolocation" in profile:
            _raise_unsupported_launch_feature("profile.geolocation")
        if "geo" in profile:
            _raise_unsupported_launch_feature("profile.geo")
        if "geoIp" in profile or "geoip" in profile:
            _raise_unsupported_launch_feature("profile.geoIp")
        if "webrtc" in profile and _is_unsupported_webrtc_mode(profile["webrtc"]):
            _raise_unsupported_launch_feature("profile.webrtc proxy mode")


def diagnose_network_alignment(options: Mapping[str, Any]) -> dict[str, Any]:
    if "proxy" in options or "proxyAlignment" in options:
        return {
            "configured": True,
            "aligned": False,
            "missing": ["proxy is not supported in the first SlyBrowser release"],
        }
    return {"configured": False, "aligned": True, "missing": []}


def _normalize_network_safety(options: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(options)
    _assert_first_release_network_and_geo_boundary(normalized)
    _assert_fingerprint_profile(normalized)
    return normalized


def _write_private_file(directory: Path, prefix: str, payload: bytes) -> Path:
    descriptor, raw_path = tempfile.mkstemp(prefix=prefix, suffix=".json", dir=directory)
    path = Path(raw_path)
    try:
        if os.name != "nt":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        path.unlink(missing_ok=True)
        raise
    _protect_windows_handoff_file(path)
    return path


def _protect_windows_handoff_file(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        identity = subprocess.check_output(["whoami"], text=True, stderr=subprocess.DEVNULL).strip()
        if not identity:
            raise OSError("empty Windows identity")
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(F)"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as error:
        path.unlink(missing_ok=True)
        raise ConfigurationError("Unable to restrict private handoff ACL", code="handoff_acl_failed") from error


def _is_forbidden_secret_argument(argument: str) -> bool:
    if "=" not in argument:
        return False
    switch_name = argument.split("=", 1)[0].lower()
    return "license" in switch_name or "runtime" in switch_name


def wait_for_native_ready(plan: LaunchPlan, *, timeout: float = 15.0) -> None:
    if plan.native_ready_file is None or plan.native_ready_nonce is None:
        return
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ConfigurationError("native_ready_timeout must be positive", code="config_invalid")
    deadline = time.monotonic() + float(timeout)
    while time.monotonic() < deadline:
        try:
            text = plan.native_ready_file.read_text(encoding="utf-8")
        except FileNotFoundError:
            text = ""
        if text.strip():
            try:
                marker = json.loads(text)
            except ValueError:
                marker = None
            if isinstance(marker, Mapping):
                if (
                    marker.get("schemaVersion") == 1
                    and marker.get("kind") == "slybrowser.native-ready"
                    and marker.get("ready") is True
                    and marker.get("nonce") == plan.native_ready_nonce
                ):
                    return
                raise ConfigurationError("Native-ready marker is invalid", code="native_ready_invalid")
        time.sleep(min(0.05, max(0.001, deadline - time.monotonic())))
    raise ConfigurationError("SlyBrowser did not report native-ready before returning", code="native_ready_timeout")


@contextmanager
def prepare_launch(
    executable: str | Path,
    options: Mapping[str, Any],
    lease: str | bytes | Mapping[str, Any],
    *,
    temp_root: str | Path | None = None,
    extra_arguments: tuple[str, ...] = (),
    include_driver_lease: bool = False,
    runtime_handoff: Mapping[str, Any] | None = None,
    driver_runtime_handoff: Mapping[str, Any] | None = None,
    include_driver_runtime: bool = False,
    allow_runtime_activation_ticket: bool = False,
    release_root: str | Path | None = None,
    humanize_control: Mapping[str, Any] | None = None,
    native_ready: bool = False,
) -> Iterator[LaunchPlan]:
    """Prepare one launch and remove sensitive handoff files on exit."""

    executable_path = Path(executable).resolve()
    if not executable_path.is_file():
        raise ConfigurationError("Browser executable does not exist", code="browser_missing")
    resolved_release_root = Path(release_root).resolve() if release_root is not None else None
    if any(_is_forbidden_secret_argument(argument) for argument in extra_arguments):
        raise ConfigurationError(
            "License and runtime material must not be passed in extra browser arguments",
            code="license_argument_forbidden",
        )
    if not isinstance(options, Mapping):
        raise ConfigurationError("Launch options must be an object", code="config_invalid")
    if any(secret in options for secret in ("licenseKey", "runtimeToken", "bootstrapToken", "activationTicket", "downloadTicket")):
        raise ConfigurationError(
            "License and runtime secrets must never be placed in the browser profile handoff",
            code="profile_secret_forbidden",
        )
    forbidden_runtime_secrets = ["licenseKey", "runtimeToken", "downloadTicket"]
    if not allow_runtime_activation_ticket:
        forbidden_runtime_secrets.append("activationTicket")
    for handoff in (runtime_handoff, driver_runtime_handoff):
        if handoff is not None and any(secret in handoff for secret in forbidden_runtime_secrets):
            raise ConfigurationError(
                "Runtime handoff must not contain long-lived keys, runtime tokens or download tickets",
                code="runtime_handoff_secret_forbidden",
            )

    root = Path(temp_root).resolve() if temp_root else Path(tempfile.gettempdir())
    root.mkdir(parents=True, exist_ok=True)
    normalized_options = _normalize_network_safety(options)
    config_bytes = json.dumps(normalized_options, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(config_bytes) > 1024 * 1024:
        raise ConfigurationError("Launch configuration is too large", code="config_too_large")
    if isinstance(lease, Mapping):
        lease_bytes = json.dumps(lease, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    elif isinstance(lease, str):
        lease_bytes = lease.encode("utf-8")
    else:
        lease_bytes = lease
    if not isinstance(lease_bytes, bytes) or not lease_bytes or len(lease_bytes) > 64 * 1024:
        raise ConfigurationError("License lease is missing or too large", code="license_invalid_envelope")

    config_path = _write_private_file(root, "sly-config-", config_bytes)
    driver_license_path: Path | None = None
    runtime_path: Path | None = None
    driver_runtime_path: Path | None = None
    humanize_config_path: Path | None = None
    native_ready_request_path: Path | None = None
    native_ready_path: Path | None = None
    native_ready_nonce: str | None = None
    try:
        license_path = _write_private_file(root, "sly-license-", lease_bytes)
        if include_driver_lease:
            driver_license_path = _write_private_file(root, "sly-driver-license-", lease_bytes)
        if runtime_handoff is not None:
            runtime_bytes = json.dumps(runtime_handoff, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(runtime_bytes) == 0 or len(runtime_bytes) > 64 * 1024:
                raise ConfigurationError("Runtime handoff file is missing or too large", code="runtime_handoff_invalid")
            runtime_path = _write_private_file(root, "sly-runtime-", runtime_bytes)
        selected_driver_runtime_handoff = driver_runtime_handoff if driver_runtime_handoff is not None else (
            runtime_handoff if include_driver_runtime else None
        )
        if selected_driver_runtime_handoff is not None:
            driver_runtime_bytes = json.dumps(selected_driver_runtime_handoff, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(driver_runtime_bytes) == 0 or len(driver_runtime_bytes) > 64 * 1024:
                raise ConfigurationError("Runtime handoff file is missing or too large", code="runtime_handoff_invalid")
            driver_runtime_path = _write_private_file(root, "sly-driver-runtime-", driver_runtime_bytes)
        if humanize_control is not None:
            humanize_bytes = json.dumps(humanize_control, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(humanize_bytes) > 64 * 1024:
                raise ConfigurationError("Native Humanize control file is too large", code="humanize_config_too_large")
            humanize_config_path = _write_private_file(root, "sly-humanize-", humanize_bytes)
        if native_ready:
            native_ready_nonce = str(uuid.uuid4())
            native_ready_path = _write_private_file(root, "sly-native-ready-", b"")
            native_ready_request_path = _write_private_file(
                root,
                "sly-native-ready-request-",
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "kind": "slybrowser.native-ready-request",
                        "readyFile": str(native_ready_path),
                        "nonce": native_ready_nonce,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )
    except BaseException:
        if native_ready_request_path is not None:
            native_ready_request_path.unlink(missing_ok=True)
        if native_ready_path is not None:
            native_ready_path.unlink(missing_ok=True)
        if "license_path" in locals():
            license_path.unlink(missing_ok=True)
        if driver_license_path is not None:
            driver_license_path.unlink(missing_ok=True)
        if runtime_path is not None:
            runtime_path.unlink(missing_ok=True)
        if driver_runtime_path is not None:
            driver_runtime_path.unlink(missing_ok=True)
        if humanize_config_path is not None:
            humanize_config_path.unlink(missing_ok=True)
        config_path.unlink(missing_ok=True)
        raise
    arguments = (
        f"--sly-config-file={config_path}",
        f"--sly-license-file={license_path}",
        *((f"--sly-release-root={resolved_release_root}",) if resolved_release_root is not None else ()),
        *((f"--sly-runtime-file={runtime_path}",) if runtime_path is not None else ()),
        *((f"--sly-humanize-config={humanize_config_path}",) if humanize_config_path is not None else ()),
        *((f"--sly-native-ready-request-file={native_ready_request_path}",) if native_ready_request_path is not None else ()),
        *extra_arguments,
    )
    plan = LaunchPlan(
        executable_path,
        tuple(arguments),
        config_path,
        license_path,
        driver_license_path,
        runtime_path,
        driver_runtime_path,
        resolved_release_root,
        humanize_config_path,
        native_ready_request_path,
        native_ready_path,
        native_ready_nonce,
    )
    try:
        yield plan
    finally:
        if native_ready_request_path is not None:
            native_ready_request_path.unlink(missing_ok=True)
        if native_ready_path is not None:
            native_ready_path.unlink(missing_ok=True)
        license_path.unlink(missing_ok=True)
        if driver_license_path is not None:
            driver_license_path.unlink(missing_ok=True)
        if runtime_path is not None:
            runtime_path.unlink(missing_ok=True)
        if driver_runtime_path is not None:
            driver_runtime_path.unlink(missing_ok=True)
        if humanize_config_path is not None:
            humanize_config_path.unlink(missing_ok=True)
        config_path.unlink(missing_ok=True)
