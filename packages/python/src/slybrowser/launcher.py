"""Secure construction and cleanup of SlyBrowser launch handoff files."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import ipaddress
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator, Mapping

from .errors import ConfigurationError


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


def _validated_alignment(value: object) -> dict[str, Any]:
    import datetime
    import re

    if not isinstance(value, Mapping):
        raise ConfigurationError("Proxy alignment evidence must be an object", code="proxy_alignment_invalid")
    evidence = dict(value)
    try:
        ipaddress.ip_address(evidence.get("exitIp"))
        datetime.datetime.fromisoformat(str(evidence.get("observedAt")).replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise ConfigurationError("Proxy alignment evidence is incomplete or invalid", code="proxy_alignment_invalid") from error
    locale_pattern = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
    geolocation = evidence.get("geolocation")
    languages = evidence.get("languages")
    valid = (
        evidence.get("source") in {"manual", "proxy-observer"}
        and isinstance(evidence.get("locale"), str) and locale_pattern.fullmatch(evidence["locale"])
        and isinstance(evidence.get("timezone"), str) and bool(evidence["timezone"])
        and isinstance(geolocation, Mapping)
        and isinstance(geolocation.get("latitude"), (int, float)) and -90 <= geolocation["latitude"] <= 90
        and isinstance(geolocation.get("longitude"), (int, float)) and -180 <= geolocation["longitude"] <= 180
        and (geolocation.get("accuracy") is None or isinstance(geolocation.get("accuracy"), (int, float)) and geolocation["accuracy"] >= 0)
        and (languages is None or isinstance(languages, list) and bool(languages)
             and all(isinstance(item, str) and locale_pattern.fullmatch(item) for item in languages))
    )
    if not valid:
        raise ConfigurationError("Proxy alignment evidence is incomplete or invalid", code="proxy_alignment_invalid")
    return evidence


def diagnose_network_alignment(options: Mapping[str, Any]) -> dict[str, Any]:
    if "proxy" not in options:
        return {"configured": False, "aligned": True, "missing": []}
    if "proxyAlignment" not in options:
        return {
            "configured": True,
            "aligned": False,
            "missing": ["proxyAlignment.exitIp", "profile.locale", "profile.timezone", "profile.geolocation"],
        }
    evidence = _validated_alignment(options["proxyAlignment"])
    return {
        "configured": True,
        "aligned": True,
        "source": evidence["source"],
        "exitIp": evidence["exitIp"],
        "missing": [],
    }


def _normalize_network_safety(options: Mapping[str, Any]) -> dict[str, Any]:
    normalized = dict(options)
    if "proxy" not in normalized:
        if "proxyAlignment" in normalized:
            raise ConfigurationError("Proxy alignment evidence requires a configured proxy", code="proxy_alignment_without_proxy")
        return normalized
    proxy_value = normalized["proxy"]
    if not isinstance(proxy_value, Mapping):
        raise ConfigurationError("Proxy configuration must be an object", code="proxy_invalid")
    proxy = dict(proxy_value)
    if proxy.get("failClosed") is False:
        raise ConfigurationError("Configured proxies must fail closed", code="proxy_fail_closed_required")
    proxy["failClosed"] = True
    normalized["proxy"] = proxy

    nested_profile = "profile" in normalized
    profile_value = normalized.get("profile") if nested_profile else normalized
    if nested_profile:
        if not isinstance(profile_value, Mapping):
            raise ConfigurationError("Profile configuration must be an object", code="profile_invalid")
        profile = dict(profile_value)
    else:
        profile = {name: field for name, field in normalized.items() if name not in {"proxy", "proxyAlignment"}}
    profile.setdefault("webrtc", "proxy")
    if "proxyAlignment" in normalized:
        evidence = _validated_alignment(normalized["proxyAlignment"])
        aligned_fields = {
            "locale": evidence["locale"],
            "languages": evidence.get("languages", [evidence["locale"]]),
            "timezone": evidence["timezone"],
            "geolocation": {**evidence["geolocation"], "permission": "allow"},
            "webrtc": "proxy",
        }
        for name, value in aligned_fields.items():
            if name in profile and profile[name] != value:
                raise ConfigurationError(f"Proxy alignment conflicts with profile.{name}", code="proxy_alignment_conflict")
            profile[name] = value
    if nested_profile:
        normalized["profile"] = profile
    else:
        normalized.update(profile)
    normalized.pop("proxyAlignment", None)
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
