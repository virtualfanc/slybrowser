"""Secure construction and cleanup of SlyBrowser launch handoff files."""

from __future__ import annotations

import json
import os
import tempfile
import ipaddress
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
    return path


@contextmanager
def prepare_launch(
    executable: str | Path,
    options: Mapping[str, Any],
    lease: str | bytes | Mapping[str, Any],
    *,
    temp_root: str | Path | None = None,
    extra_arguments: tuple[str, ...] = (),
    include_driver_lease: bool = False,
) -> Iterator[LaunchPlan]:
    """Prepare one launch and remove sensitive handoff files on exit."""

    executable_path = Path(executable).resolve()
    if not executable_path.is_file():
        raise ConfigurationError("Browser executable does not exist", code="browser_missing")
    if any("license" in argument.lower() and "=" in argument for argument in extra_arguments):
        raise ConfigurationError(
            "License material must not be passed in extra browser arguments",
            code="license_argument_forbidden",
        )
    if not isinstance(options, Mapping):
        raise ConfigurationError("Launch options must be an object", code="config_invalid")
    if "licenseKey" in options:
        raise ConfigurationError(
            "A long-lived license key must never be placed in the browser profile handoff",
            code="profile_secret_forbidden",
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
    try:
        license_path = _write_private_file(root, "sly-license-", lease_bytes)
        if include_driver_lease:
            driver_license_path = _write_private_file(root, "sly-driver-license-", lease_bytes)
    except BaseException:
        if "license_path" in locals():
            license_path.unlink(missing_ok=True)
        if driver_license_path is not None:
            driver_license_path.unlink(missing_ok=True)
        config_path.unlink(missing_ok=True)
        raise
    arguments = (
        f"--sly-config-file={config_path}",
        f"--sly-license-file={license_path}",
        *extra_arguments,
    )
    plan = LaunchPlan(executable_path, tuple(arguments), config_path, license_path, driver_license_path)
    try:
        yield plan
    finally:
        license_path.unlink(missing_ok=True)
        if driver_license_path is not None:
            driver_license_path.unlink(missing_ok=True)
        config_path.unlink(missing_ok=True)
