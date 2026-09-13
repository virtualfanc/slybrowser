"""Authorized session exchange for signed SlyBrowser releases."""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from .canonical import canonical_json, decode_base64url, encode_base64url
from .errors import LicenseServiceError
from .license import LicenseClaims, LicenseVerifier
from .manifest import ReleaseArtifact, ReleaseManifest, is_sdk_compatible, verify_release_manifest

JsonTransport = Callable[[str, str, Mapping[str, str], bytes | None], tuple[int, bytes]]
ArtifactDownloader = Callable[[str, Mapping[str, str], Path], None]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request: Any, file_pointer: Any, code: int, message: str, headers: Any, new_url: str) -> None:
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


@dataclass(frozen=True, slots=True)
class LicenseAuthorization:
    service_url: str
    license_key: str
    channel: str = "stable"


@dataclass(frozen=True, slots=True)
class LicenseFileReadOptions:
    allow_insecure_localhost: bool = False
    license_file_passphrase: str | None = None
    license_file_trusted_keys: Mapping[str, bytes] | None = None
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",)


@dataclass(frozen=True, slots=True)
class SealedLicenseImportResult:
    output: Path
    service_url: str
    channel: str
    protection: str
    license_key_sha256: str


@dataclass(slots=True)
class LicensedSessionGrant:
    session_id: str
    session_token: str
    heartbeat_after_seconds: int
    expires_at: int
    plan: str
    features: tuple[str, ...]
    concurrency_limit: int
    active_sessions: int
    browser_version: str
    requested_browser_version: str | None
    version_policy: str
    selection_reason: str
    available_browser_versions: tuple[str, ...]
    update_rights: Mapping[str, Any]
    lease: Mapping[str, Any]
    claims: LicenseClaims
    manifest: ReleaseManifest
    artifact: ReleaseArtifact
    platform: str
    arch: str
    requested_kernel_major: int | str | None = None
    selection_mode: str | None = None
    latest_available_version: str | None = None
    update_available: bool | None = None
    update_required: bool | None = None


@dataclass(slots=True)
class LicenseInfo:
    schema_version: int
    channel: str
    license_status: str
    plan: str
    effective_plan: str
    paid_through: int | None
    features: tuple[str, ...]
    concurrency_limit: int
    active_sessions: int
    available_sessions: int
    session_state: Mapping[str, int]
    browser_version: str
    requested_browser_version: str | None
    requested_kernel_major: int | str | None
    version_policy: str
    selection_reason: str
    selection_mode: str | None
    available_browser_versions: tuple[str, ...]
    latest_available_version: str | None
    update_available: bool | None
    update_required: bool | None
    update_rights: Mapping[str, Any]
    stable_error_code: None

    def to_redacted_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "channel": self.channel,
            "licenseStatus": self.license_status,
            "plan": self.plan,
            "effectivePlan": self.effective_plan,
            "paidThrough": self.paid_through,
            "features": list(self.features),
            "concurrencyLimit": self.concurrency_limit,
            "activeSessions": self.active_sessions,
            "availableSessions": self.available_sessions,
            "sessionState": dict(self.session_state),
            "browserVersion": self.browser_version,
            "requestedBrowserVersion": self.requested_browser_version,
            "requestedKernelMajor": self.requested_kernel_major,
            "versionPolicy": self.version_policy,
            "selectionReason": self.selection_reason,
            "selectionMode": self.selection_mode,
            "availableBrowserVersions": list(self.available_browser_versions),
            "latestAvailableVersion": self.latest_available_version,
            "updateAvailable": self.update_available,
            "updateRequired": self.update_required,
            "updateRights": dict(self.update_rights),
            "stableErrorCode": self.stable_error_code,
        }


@dataclass(frozen=True, slots=True)
class RuntimeDownloadTicket:
    token: str
    expires_at: int
    artifact_sha256: str
    artifact_url: str


@dataclass(slots=True)
class RuntimeSessionGrant:
    schema_version: int
    state: str
    startup_id: str
    session_id: str
    bootstrap_token: str
    activation_ticket: str
    driver_activation_ticket: str | None
    heartbeat_after_seconds: int
    expires_at: int
    plan: str
    features: tuple[str, ...]
    concurrency_limit: int
    active_sessions: int
    browser_version: str
    requested_browser_version: str | None
    version_policy: str
    selection_reason: str
    available_browser_versions: tuple[str, ...]
    update_rights: Mapping[str, Any]
    lease: Mapping[str, Any]
    claims: LicenseClaims
    manifest: ReleaseManifest
    artifact: ReleaseArtifact
    platform: str
    arch: str
    automation_backend: str | None
    download_ticket: RuntimeDownloadTicket
    requested_kernel_major: int | str | None = None
    selection_mode: str | None = None
    latest_available_version: str | None = None
    update_available: bool | None = None
    update_required: bool | None = None


@dataclass(slots=True)
class RuntimeHeartbeatGrant:
    schema_version: int
    state: str
    startup_id: str
    session_id: str
    heartbeat_after_seconds: int
    expires_at: int
    plan: str
    features: tuple[str, ...]
    concurrency_limit: int
    active_sessions: int
    browser_version: str
    automation_backend: str | None
    lease: Mapping[str, Any]
    claims: LicenseClaims


@dataclass(slots=True)
class RuntimeActivationGrant(RuntimeHeartbeatGrant):
    runtime_token: str


def _fail(code: str, message: str, status: int = 0, details: dict[str, object] | None = None) -> LicenseServiceError:
    return LicenseServiceError(message, code=code, status=status, details=details)


_SAFE_ERROR_DETAIL_FIELDS = {
    "state",
    "concurrencyLimit",
    "activeSessions",
    "availableSessions",
    "retryAfterSeconds",
    "action",
    "dimension",
}


def _safe_remote_error_code(code: object) -> str:
    return code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{2,96}", code) else "license_service_error"


def _remote_error_message(status: int, code: str) -> str:
    if code == "license_plan_expired":
        return "The SlyBrowser paid plan has expired. Renew the plan before starting SlyBrowser."
    return f"License service request failed with HTTP {status} ({code})"


def _safe_error_details(error: Mapping[str, object] | None) -> dict[str, object]:
    if not error:
        return {}
    details: dict[str, object] = {}
    for key, value in error.items():
        if key in _SAFE_ERROR_DETAIL_FIELDS:
            safe_value = _safe_error_detail_value(key, value)
            if safe_value is not None:
                details[key] = safe_value
        elif key == "actions" and isinstance(value, list):
            actions = [action for action in (_safe_error_action(item) for item in value) if action]
            if actions:
                details["actions"] = actions
    return details


def _safe_error_detail_value(key: str, value: object) -> object | None:
    if key in {"concurrencyLimit", "activeSessions", "availableSessions", "retryAfterSeconds"}:
        return value if isinstance(value, int) and not isinstance(value, bool) else None
    return value if isinstance(value, str) and re.fullmatch(r"[a-z0-9_:-]{1,96}", value) else None


def _safe_error_action(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    action: dict[str, str] = {}
    action_type = value.get("type")
    if isinstance(action_type, str) and re.fullmatch(r"[a-z0-9_:-]{1,96}", action_type):
        action["type"] = action_type
    url = value.get("url")
    if isinstance(url, str) and url.startswith("https://slybrowser.com/"):
        action["url"] = url
    return action


def _version_parts(value: str) -> tuple[int, ...]:
    if not re.fullmatch(r"\d+(?:\.\d+){0,7}", value):
        raise _fail("browser_version_invalid", f"Browser version is invalid: {value}")
    return tuple(int(part) for part in value.split("."))


def _compare_version(left: str, right: str) -> int:
    a = _version_parts(left)
    b = _version_parts(right)
    size = max(len(a), len(b))
    padded_a = a + (0,) * (size - len(a))
    padded_b = b + (0,) * (size - len(b))
    return (padded_a > padded_b) - (padded_a < padded_b)


def _normalize_kernel_major(value: int | str | None) -> int | str:
    if value is None or value == "latest":
        return "latest"
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    raise _fail("version_policy_invalid", "kernel_major must be a positive integer or latest")


def _new_startup_id() -> str:
    return f"st_{uuid.uuid4().hex}"


_MISSING = object()


def _required_lease_features(automation_backend: str | None = None) -> tuple[str, ...]:
    base = ("browser", "release-download", "webdriver")
    if automation_backend == "playwright":
        return (*base, "playwright")
    if automation_backend == "puppeteer":
        return (*base, "puppeteer")
    return base


def _parse_response_features(value: object, fallback: tuple[str, ...]) -> tuple[str, ...]:
    source = fallback if value is _MISSING else value
    if (
        not isinstance(source, list | tuple)
        or any(not isinstance(item, str) or not item or len(item) > 128 for item in source)
        or len(set(source)) != len(source)
    ):
        raise _fail("license_service_invalid_response", "License service features response is invalid")
    return tuple(source)


def _parse_requested_kernel_major(value: object) -> int | str | None:
    if value is _MISSING:
        return None
    if value == "latest":
        return "latest"
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    raise _fail("license_service_invalid_response", "License service requested-kernel response is invalid")


def _parse_selection_mode(value: object) -> str | None:
    if value is _MISSING:
        return None
    if value in {"latest", "latest-in-major", "cached-approved", "exact", "rollback"}:
        return str(value)
    raise _fail("license_service_invalid_response", "License service selection-mode response is invalid")


def _parse_optional_version(value: object, field: str) -> str | None:
    if value is _MISSING:
        return None
    if isinstance(value, str):
        _version_parts(value)
        return value
    raise _fail("license_service_invalid_response", f"License service {field} response is invalid")


def _parse_optional_bool(value: object, field: str) -> bool | None:
    if value is _MISSING:
        return None
    if isinstance(value, bool):
        return value
    raise _fail("license_service_invalid_response", f"License service {field} response is invalid")


def _same_string_set(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    return len(left) == len(right) and all(item in right for item in left)


def _assert_claims_match_plan(claims: LicenseClaims, plan: str, concurrency_limit: int, features: tuple[str, ...]) -> None:
    if claims.plan_id is not None and claims.plan_id != plan:
        raise _fail("license_service_invalid_response", "Signed lease plan does not match the service response")
    if claims.concurrency_limit is not None and claims.concurrency_limit != concurrency_limit:
        raise _fail("license_service_invalid_response", "Signed lease concurrency does not match the service response")
    if not _same_string_set(claims.features, features):
        raise _fail("license_service_invalid_response", "Signed lease features do not match the service response")


def _parse_authorization(value: object, *, allow_insecure_localhost: bool = False) -> LicenseAuthorization:
    if not isinstance(value, Mapping) or set(value) != {"schemaVersion", "serviceUrl", "licenseKey", "channel"}:
        raise _fail("authorization_invalid", "Authorization file fields are invalid")
    if value.get("schemaVersion") != 1 or value.get("channel") != "stable":
        raise _fail("authorization_invalid", "Authorization file version or channel is invalid")
    service_url = value.get("serviceUrl")
    license_key = value.get("licenseKey")
    if not isinstance(service_url, str) or not isinstance(license_key, str):
        raise _fail("authorization_invalid", "Authorization service URL or key is invalid")
    import re
    if not re.fullmatch(r"sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}", license_key):
        raise _fail("authorization_invalid", "Authorization key format is invalid")
    parsed = urllib.parse.urlparse(service_url)
    local = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if parsed.scheme != "https" and not (allow_insecure_localhost and local and parsed.scheme == "http"):
        raise _fail("authorization_invalid", "Authorization service URL must use HTTPS")
    if not parsed.netloc or parsed.params or parsed.query or parsed.fragment:
        raise _fail("authorization_invalid", "Authorization service URL is invalid")
    return LicenseAuthorization(service_url.rstrip("/"), license_key)


_LICENSE_FILE_TOP_LEVEL_FIELDS = {
    "schemaVersion",
    "type",
    "audience",
    "serviceUrl",
    "licenseId",
    "channel",
    "issuedAt",
    "expiresAt",
    "fileId",
    "encryption",
    "ciphertext",
    "tag",
    "signature",
}
_LICENSE_FILE_SECRET_FIELDS = {
    "schemaVersion",
    "type",
    "audience",
    "licenseId",
    "fileId",
    "serviceUrl",
    "channel",
    "licenseKey",
    "secretVersion",
    "createdAt",
    "expiresAt",
    "nonce",
    "scope",
}


def _normalize_service_url(value: str, *, allow_insecure_localhost: bool = False) -> str:
    parsed = urllib.parse.urlparse(value)
    local = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    if parsed.scheme != "https" and not (allow_insecure_localhost and local and parsed.scheme == "http"):
        raise _fail("authorization_invalid", "Authorization service URL must use HTTPS")
    if not parsed.netloc or parsed.params or parsed.query or parsed.fragment:
        raise _fail("authorization_invalid", "Authorization service URL is invalid")
    return value.rstrip("/")


def _required_text(document: Mapping[str, Any], name: str, maximum: int = 2048) -> str:
    value = document.get(name)
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(char) < 32 for char in value):
        raise _fail("authorization_invalid", f"License file {name} is invalid")
    return value


def _required_int(document: Mapping[str, Any], name: str) -> int:
    value = document.get(name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise _fail("authorization_invalid", f"License file {name} is invalid")
    return value


def _required_object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _fail("authorization_invalid", "License file fields are invalid")
    return value


def _parse_timestamp(value: str) -> float:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError as exc:
        raise _fail("authorization_invalid", "License file timestamp is invalid") from exc


def _public_license_file_header(document: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": document.get("schemaVersion"),
        "type": document.get("type"),
        "audience": document.get("audience"),
        "serviceUrl": document.get("serviceUrl"),
        "licenseId": document.get("licenseId"),
        "channel": document.get("channel"),
        "issuedAt": document.get("issuedAt"),
        "expiresAt": document.get("expiresAt"),
        "fileId": document.get("fileId"),
        "encryption": document.get("encryption"),
    }


def _signed_license_file_body(document: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **_public_license_file_header(document),
        "ciphertext": document.get("ciphertext"),
        "tag": document.get("tag"),
    }


def _parse_encrypted_license_file(value: object, options: LicenseFileReadOptions) -> LicenseAuthorization:
    document = _required_object(value)
    if (
        set(document) != _LICENSE_FILE_TOP_LEVEL_FIELDS
        or document.get("schemaVersion") != 2
        or document.get("type") != "slybrowser-license"
        or document.get("audience") != "slybrowser-license-file"
        or document.get("channel") != "stable"
    ):
        raise _fail("authorization_invalid", "License file fields are invalid")
    service_url = _normalize_service_url(
        _required_text(document, "serviceUrl"),
        allow_insecure_localhost=options.allow_insecure_localhost,
    )
    trusted_service_urls = tuple(
        _normalize_service_url(url, allow_insecure_localhost=options.allow_insecure_localhost)
        for url in options.trusted_service_urls
    )
    if service_url not in trusted_service_urls:
        raise _fail("license_file_untrusted_origin", "License file service URL is not trusted", 403)
    document = {**dict(document), "serviceUrl": service_url}
    license_id = _required_text(document, "licenseId", 64)
    import re
    if not re.fullmatch(r"[0-9a-f-]{36}", license_id):
        raise _fail("authorization_invalid", "License file identity fields are invalid")
    issued_at = _parse_timestamp(_required_text(document, "issuedAt", 64))
    expires_at = _parse_timestamp(_required_text(document, "expiresAt", 64))
    if expires_at <= issued_at:
        raise _fail("authorization_invalid", "License file identity fields are invalid")
    if expires_at <= time.time():
        raise _fail("license_file_expired", "License file has expired", 401)
    encryption = _required_object(document.get("encryption"))
    kdf = _required_object(encryption.get("kdf"))
    signature = _required_object(document.get("signature"))
    kdf_name = _required_text(kdf, "name", 64)
    kdf_purpose = _required_text(kdf, "purpose", 64)
    expected_scope = (
        kdf_purpose
        if (
            (kdf_name == "sly-test-scrypt-v1" and kdf_purpose == "test-private-preview")
            or (kdf_name == "sly-portable-scrypt-v1" and kdf_purpose == "portable-passphrase")
        )
        else None
    )
    if (
        _required_text(encryption, "algorithm", 64) != "AES-256-GCM"
        or _required_text(encryption, "aad", 128) != "slybrowser-license-v2-public-header"
        or expected_scope is None
        or _required_int(kdf, "cost") != 16_384
        or _required_int(kdf, "blockSize") != 8
        or _required_int(kdf, "parallelization") != 1
        or _required_int(kdf, "keyLength") != 32
        or _required_text(signature, "algorithm", 64) != "Ed25519"
    ):
        raise _fail("authorization_invalid", "License file algorithms are invalid")
    key_id = _required_text(signature, "keyId", 64)
    public_key = (options.license_file_trusted_keys or {}).get(key_id)
    if public_key is None:
        raise _fail("license_file_key_unknown", "License file signing key is not trusted", 403)
    if len(public_key) != 32:
        raise _fail("license_file_key_invalid", "License file signing key is invalid", 403)
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:
        raise _fail("license_crypto_unavailable", "Ed25519 support is unavailable") from exc
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(
            decode_base64url(_required_text(signature, "signature", 256), max_bytes=64),
            canonical_json(_signed_license_file_body(document)),
        )
    except (InvalidSignature, ValueError) as exc:
        raise _fail("license_file_signature_invalid", "License file signature is invalid", 401) from exc
    passphrase = options.license_file_passphrase
    if not isinstance(passphrase, str) or len(passphrase) < 12:
        raise _fail("license_file_locked", "License file passphrase is missing or too short", 401)
    try:
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        salt = decode_base64url(_required_text(kdf, "salt", 64), max_bytes=16)
        nonce = decode_base64url(_required_text(encryption, "nonce", 64), max_bytes=12)
        tag = decode_base64url(_required_text(document, "tag", 64), max_bytes=16)
        ciphertext = decode_base64url(_required_text(document, "ciphertext", 64 * 1024), max_bytes=64 * 1024)
        if len(salt) != 16 or len(nonce) != 12 or len(tag) != 16:
            raise ValueError("invalid encryption parameter length")
        key = hashlib.scrypt(
            passphrase.encode("utf-8"),
            salt=salt,
            n=16_384,
            r=8,
            p=1,
            dklen=32,
            maxmem=64 * 1024 * 1024,
        )
        payload = json.loads(AESGCM(key).decrypt(
            nonce,
            ciphertext + tag,
            canonical_json(_public_license_file_header(document)),
        ))
    except (InvalidTag, ValueError, json.JSONDecodeError) as exc:
        raise _fail("license_file_locked", "License file cannot be decrypted", 401) from exc
    payload = _required_object(payload)
    if set(payload) != _LICENSE_FILE_SECRET_FIELDS:
        raise _fail("license_file_payload_invalid", "License file payload contains unsupported claims")
    license_key = _required_text(payload, "licenseKey", 256)
    if (
        payload.get("schemaVersion") != 2
        or payload.get("type") != "slybrowser-license-secret"
        or payload.get("audience") != document.get("audience")
        or payload.get("licenseId") != license_id
        or payload.get("fileId") != document.get("fileId")
        or _normalize_service_url(_required_text(payload, "serviceUrl"), allow_insecure_localhost=options.allow_insecure_localhost) != service_url
        or payload.get("channel") != "stable"
        or payload.get("secretVersion") != 1
        or payload.get("expiresAt") != document.get("expiresAt")
        or payload.get("scope") != expected_scope
        or not re.fullmatch(r"sly_live_[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}", license_key)
        or not license_key.startswith(f"sly_live_{license_id}.")
    ):
        raise _fail("license_file_payload_invalid", "License file payload does not match its public header")
    return LicenseAuthorization(service_url, license_key)


_SEALED_LICENSE_TOP_LEVEL_FIELDS = {
    "schemaVersion",
    "type",
    "audience",
    "serviceUrl",
    "channel",
    "sealedAt",
    "licenseKeySha256",
    "protection",
    "ciphertext",
}


def _license_key_sha256(license_key: str) -> str:
    return hashlib.sha256(license_key.encode("utf-8")).hexdigest()


def _sealed_license_entropy(document: Mapping[str, Any]) -> bytes:
    return "\0".join((
        "slybrowser-sealed-license-v1",
        _required_text(document, "serviceUrl"),
        _required_text(document, "channel", 16),
        _required_text(document, "licenseKeySha256", 64),
    )).encode("utf-8")


def _assert_trusted_authorization_origin(service_url: str, options: LicenseFileReadOptions) -> None:
    trusted_service_urls = tuple(
        _normalize_service_url(url, allow_insecure_localhost=options.allow_insecure_localhost)
        for url in options.trusted_service_urls
    )
    if service_url not in trusted_service_urls:
        raise _fail("license_file_untrusted_origin", "License file service URL is not trusted", 403)


def _windows_dpapi(operation: str, data: bytes, entropy: bytes) -> bytes:
    if sys.platform != "win32":
        raise _fail("sealed_license_unsupported", "Windows DPAPI sealed license files are only supported on Windows", 400)
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError as exc:
        raise _fail("sealed_license_unsupported", "Windows DPAPI is unavailable", 400) from exc

    class DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
        ]

    def blob(value: bytes) -> tuple[DataBlob, Any]:
        buffer = ctypes.create_string_buffer(value)
        return DataBlob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer

    input_blob, input_buffer = blob(data)
    entropy_blob, entropy_buffer = blob(entropy)
    output_blob = DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    if operation == "protect":
        ok = crypt32.CryptProtectData(
            ctypes.byref(input_blob),
            None,
            ctypes.byref(entropy_blob),
            None,
            None,
            0,
            ctypes.byref(output_blob),
        )
    elif operation == "unprotect":
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(input_blob),
            None,
            ctypes.byref(entropy_blob),
            None,
            None,
            0,
            ctypes.byref(output_blob),
        )
    else:
        raise _fail("sealed_license_unsupported", "Unsupported sealed license operation", 400)
    _ = (input_buffer, entropy_buffer)
    if not ok:
        code = "sealed_license_locked" if operation == "unprotect" else "sealed_license_invalid"
        raise _fail(code, "Sealed license file cannot be decrypted on this Windows user or machine", 401)
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        if output_blob.pbData:
            kernel32.LocalFree(output_blob.pbData)


def _parse_sealed_license_file(value: object, options: LicenseFileReadOptions) -> LicenseAuthorization:
    document = _required_object(value)
    if (
        set(document) != _SEALED_LICENSE_TOP_LEVEL_FIELDS
        or document.get("schemaVersion") != 3
        or document.get("type") != "slybrowser-sealed-authorization"
        or document.get("audience") != "slybrowser"
    ):
        raise _fail("sealed_license_invalid", "Sealed license file fields are invalid")
    service_url = _normalize_service_url(
        _required_text(document, "serviceUrl"),
        allow_insecure_localhost=options.allow_insecure_localhost,
    )
    _assert_trusted_authorization_origin(service_url, options)
    document = {**dict(document), "serviceUrl": service_url}
    if _required_text(document, "channel", 16) != "stable":
        raise _fail("sealed_license_invalid", "Sealed license channel is invalid")
    if not isinstance(_parse_timestamp(_required_text(document, "sealedAt", 64)), float):
        raise _fail("sealed_license_invalid", "Sealed license timestamp is invalid")
    import re
    fingerprint = _required_text(document, "licenseKeySha256", 64)
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise _fail("sealed_license_invalid", "Sealed license fingerprint is invalid")
    protection = _required_object(document.get("protection"))
    if (
        set(protection) != {"provider", "scope"}
        or protection.get("provider") != "windows-dpapi"
        or protection.get("scope") != "current-user"
    ):
        raise _fail("sealed_license_unsupported", "Sealed license protection is not supported", 400)
    try:
        ciphertext = decode_base64url(_required_text(document, "ciphertext", 64 * 1024), max_bytes=64 * 1024)
        payload = json.loads(_windows_dpapi("unprotect", ciphertext, _sealed_license_entropy(document)))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise _fail("sealed_license_locked", "Sealed license file cannot be decrypted on this Windows user or machine", 401) from exc
    authorization = _parse_authorization(payload, allow_insecure_localhost=options.allow_insecure_localhost)
    if (
        authorization.service_url != service_url
        or authorization.channel != "stable"
        or _license_key_sha256(authorization.license_key) != fingerprint
    ):
        raise _fail("sealed_license_mismatch", "Sealed license payload does not match its public header", 400)
    return authorization


def import_license_file_to_sealed_authorization(
    input_path: str | Path,
    output_path: str | Path,
    *,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
) -> SealedLicenseImportResult:
    raw = Path(input_path).expanduser().resolve().read_bytes()
    if len(raw) > 64 * 1024:
        raise _fail("authorization_invalid", "Authorization file is too large")
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("authorization_invalid", "Authorization file is not valid JSON") from error
    if not isinstance(parsed, Mapping) or parsed.get("schemaVersion") != 2:
        raise _fail("license_file_invalid", "Only encrypted v2 SlyBrowser license files can be imported", 400)
    options = LicenseFileReadOptions(
        allow_insecure_localhost=allow_insecure_localhost,
        license_file_passphrase=license_file_passphrase,
        license_file_trusted_keys=license_file_trusted_keys,
        trusted_service_urls=trusted_service_urls,
    )
    authorization = _parse_encrypted_license_file(parsed, options)
    _assert_trusted_authorization_origin(authorization.service_url, options)
    fingerprint = _license_key_sha256(authorization.license_key)
    sealed_at = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    document: dict[str, Any] = {
        "schemaVersion": 3,
        "type": "slybrowser-sealed-authorization",
        "audience": "slybrowser",
        "serviceUrl": authorization.service_url,
        "channel": authorization.channel,
        "sealedAt": sealed_at,
        "licenseKeySha256": fingerprint,
        "protection": {
            "provider": "windows-dpapi",
            "scope": "current-user",
        },
        "ciphertext": "",
    }
    document["ciphertext"] = encode_base64url(_windows_dpapi(
        "protect",
        json.dumps({
            "schemaVersion": 1,
            "serviceUrl": authorization.service_url,
            "licenseKey": authorization.license_key,
            "channel": authorization.channel,
        }, separators=(",", ":"), sort_keys=True).encode("utf-8"),
        _sealed_license_entropy(document),
    ))
    destination = Path(output_path).expanduser().resolve()
    with destination.open("x", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    try:
        os.chmod(destination, 0o600)
    except OSError:
        pass
    return SealedLicenseImportResult(
        output=destination,
        service_url=authorization.service_url,
        channel="stable",
        protection="windows-dpapi-current-user",
        license_key_sha256=fingerprint,
    )


def read_license_authorization(
    path: str | Path,
    *,
    allow_insecure_localhost: bool = False,
    license_file_passphrase: str | None = None,
    license_file_trusted_keys: Mapping[str, bytes] | None = None,
    trusted_service_urls: tuple[str, ...] = ("https://api.slybrowser.com",),
) -> LicenseAuthorization:
    raw = Path(path).expanduser().resolve().read_bytes()
    if len(raw) > 64 * 1024:
        raise _fail("authorization_invalid", "Authorization file is too large")
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, Mapping) and parsed.get("schemaVersion") == 2:
            return _parse_encrypted_license_file(
                parsed,
                LicenseFileReadOptions(
                    allow_insecure_localhost=allow_insecure_localhost,
                    license_file_passphrase=license_file_passphrase,
                    license_file_trusted_keys=license_file_trusted_keys,
                    trusted_service_urls=trusted_service_urls,
                ),
            )
        if isinstance(parsed, Mapping) and parsed.get("schemaVersion") == 3:
            return _parse_sealed_license_file(
                parsed,
                LicenseFileReadOptions(
                    allow_insecure_localhost=allow_insecure_localhost,
                    trusted_service_urls=trusted_service_urls,
                ),
            )
        return _parse_authorization(parsed, allow_insecure_localhost=allow_insecure_localhost)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _fail("authorization_invalid", "Authorization file is not valid JSON") from error


def _default_transport(method: str, url: str, headers: Mapping[str, str], body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def _default_artifact_downloader(url: str, headers: Mapping[str, str], destination: Path) -> None:
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with _NO_REDIRECT_OPENER.open(request, timeout=120) as response, destination.open("xb") as output:
            if response.status != 200:
                raise _fail("artifact_download_failed", f"Artifact download failed with HTTP {response.status}", response.status)
            shutil.copyfileobj(response, output, length=1024 * 1024)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read())
            remote = payload.get("error", {})
            details = dict(remote)
            details.pop("code", None)
            details.pop("message", None)
            raise _fail(str(remote.get("code") or "artifact_download_failed"), str(remote.get("message") or error), error.code, details)
        except (ValueError, AttributeError) as parse_error:
            raise _fail("artifact_download_failed", f"Artifact download failed with HTTP {error.code}", error.code) from parse_error


class LicenseServiceClient:
    def __init__(
        self,
        authorization: LicenseAuthorization,
        *,
        license_trusted_keys: Mapping[str, bytes],
        release_trusted_keys: Mapping[str, bytes],
        transport: JsonTransport | None = None,
        artifact_downloader: ArtifactDownloader | None = None,
        allow_insecure_localhost: bool = False,
    ) -> None:
        self.authorization = _parse_authorization(
            {
                "schemaVersion": 1,
                "serviceUrl": authorization.service_url,
                "licenseKey": authorization.license_key,
                "channel": authorization.channel,
            },
            allow_insecure_localhost=allow_insecure_localhost,
        )
        self._license_verifier = LicenseVerifier(license_trusted_keys)
        self._release_trusted_keys = dict(release_trusted_keys)
        self._transport = transport or _default_transport
        self._artifact_downloader = artifact_downloader or _default_artifact_downloader

    def license_info(
        self,
        *,
        platform: str,
        arch: str,
        sdk_version: str = "0.1.0",
        device_hash: str | None = None,
        kernel_major: int | str | None = None,
        update_kernel: bool | None = None,
        browser_version: str | None = None,
        version_policy: str | None = None,
    ) -> LicenseInfo:
        requested_version = browser_version
        selected_policy = version_policy or ("latest" if browser_version is None else "exact")
        if selected_policy not in {"latest", "exact", "at-or-before"}:
            raise _fail("version_policy_invalid", f"Unsupported browser version policy: {selected_policy}")
        if selected_policy == "latest" and browser_version is not None:
            raise _fail("version_policy_invalid", "Latest selection cannot include a requested browser version")
        if selected_policy != "latest" and browser_version is None:
            raise _fail("version_policy_invalid", f"{selected_policy} selection requires a browser version")
        if browser_version is not None:
            _version_parts(browser_version)
        normalized_kernel_major = _normalize_kernel_major(kernel_major)
        if not isinstance(update_kernel if update_kernel is not None else False, bool):
            raise _fail("version_policy_invalid", "update_kernel must be a boolean")
        if (
            browser_version is not None
            and normalized_kernel_major != "latest"
            and int(browser_version.split(".")[0]) != normalized_kernel_major
        ):
            raise _fail("version_policy_invalid", "browser_version does not match kernel_major")
        value = self._request(
            "POST",
            "/v2/licenses/info",
            authorization=f"License {self.authorization.license_key}",
            body={
                "platform": platform,
                "arch": arch,
                "channel": self.authorization.channel,
                "sdkVersion": sdk_version,
                **({"deviceHash": device_hash} if device_hash is not None else {}),
                "kernelMajor": normalized_kernel_major,
                "updateKernel": False if update_kernel is None else update_kernel,
                "versionPolicy": selected_policy,
                **({"browserVersion": browser_version} if browser_version is not None else {}),
            },
        )
        plans = {"free", "basic", "pro", "max", "ultra"}
        status = value.get("licenseStatus")
        plan = value.get("plan")
        effective_plan = value.get("effectivePlan")
        paid_through = value.get("paidThrough")
        concurrency = value.get("concurrencyLimit")
        active = value.get("activeSessions")
        available = value.get("availableSessions")
        selected_browser_version = value.get("browserVersion")
        returned_policy = value.get("versionPolicy")
        selection_reason = value.get("selectionReason")
        returned_requested_version = value.get("requestedBrowserVersion")
        available_browser_versions = value.get("availableBrowserVersions")
        update_rights = value.get("updateRights")
        session_state = value.get("sessionState")
        requested_kernel_major = _parse_requested_kernel_major(value.get("requestedKernelMajor", _MISSING))
        selection_mode = _parse_selection_mode(value.get("selectionMode", _MISSING))
        latest_available_version = _parse_optional_version(value.get("latestAvailableVersion", _MISSING), "latest-available-version")
        update_available = _parse_optional_bool(value.get("updateAvailable", _MISSING), "update-available")
        update_required = _parse_optional_bool(value.get("updateRequired", _MISSING), "update-required")
        if (
            value.get("schemaVersion") != 1
            or value.get("channel") != "stable"
            or status not in {"active", "hold", "revoked"}
            or plan not in plans
            or effective_plan not in plans
            or (paid_through is not None and (not isinstance(paid_through, int) or isinstance(paid_through, bool)))
            or not isinstance(concurrency, int)
            or isinstance(concurrency, bool)
            or not isinstance(active, int)
            or isinstance(active, bool)
            or not isinstance(available, int)
            or isinstance(available, bool)
            or not isinstance(selected_browser_version, str)
            or returned_policy != selected_policy
            or selection_reason not in {"latest", "exact", "rollback"}
            or returned_requested_version != requested_version
            or not isinstance(available_browser_versions, list)
            or not all(isinstance(item, str) and _version_parts(item) for item in available_browser_versions)
            or not isinstance(update_rights, Mapping)
            or update_rights.get("status") != "active"
            or update_rights.get("channel") != "stable"
            or update_rights.get("exactVersion") is not True
            or update_rights.get("rollback") is not True
            or value.get("stableErrorCode") is not None
            or not isinstance(session_state, Mapping)
            or session_state.get("activeBrowserProcesses") != active
            or session_state.get("limit") != concurrency
            or session_state.get("available") != available
        ):
            raise _fail("license_service_invalid_response", "License service info response is invalid")
        features = _parse_response_features(value.get("features", _MISSING), ())
        return LicenseInfo(
            1,
            "stable",
            str(status),
            str(plan),
            str(effective_plan),
            paid_through,
            features,
            concurrency,
            active,
            available,
            dict(session_state),
            selected_browser_version,
            returned_requested_version if isinstance(returned_requested_version, str) else None,
            requested_kernel_major,
            selected_policy,
            str(selection_reason),
            selection_mode,
            tuple(available_browser_versions),
            latest_available_version,
            update_available,
            update_required,
            dict(update_rights),
            None,
        )

    def create_session(
        self,
        *,
        platform: str,
        arch: str,
        sdk_version: str = "0.1.0",
        device_hash: str | None = None,
        kernel_major: int | str | None = None,
        update_kernel: bool | None = None,
        browser_version: str | None = None,
        version_policy: str | None = None,
    ) -> LicensedSessionGrant:
        requested_version = browser_version
        selected_policy = version_policy or ("latest" if browser_version is None else "exact")
        if selected_policy not in {"latest", "exact", "at-or-before"}:
            raise _fail("version_policy_invalid", f"Unsupported browser version policy: {selected_policy}")
        if selected_policy == "latest" and browser_version is not None:
            raise _fail("version_policy_invalid", "Latest selection cannot include a requested browser version")
        if selected_policy != "latest" and browser_version is None:
            raise _fail("version_policy_invalid", f"{selected_policy} selection requires a browser version")
        if browser_version is not None:
            _version_parts(browser_version)
        normalized_kernel_major = _normalize_kernel_major(kernel_major)
        if not isinstance(update_kernel if update_kernel is not None else False, bool):
            raise _fail("version_policy_invalid", "update_kernel must be a boolean")
        if (
            browser_version is not None
            and normalized_kernel_major != "latest"
            and int(browser_version.split(".")[0]) != normalized_kernel_major
        ):
            raise _fail("version_policy_invalid", "browser_version does not match kernel_major")
        value = self._request(
            "POST",
            "/v1/licenses/sessions",
            authorization=f"License {self.authorization.license_key}",
            body={
                "platform": platform,
                "arch": arch,
                "channel": self.authorization.channel,
                "sdkVersion": sdk_version,
                **({"deviceHash": device_hash} if device_hash is not None else {}),
                "kernelMajor": normalized_kernel_major,
                "updateKernel": False if update_kernel is None else update_kernel,
                "versionPolicy": selected_policy,
                **({"browserVersion": browser_version} if browser_version is not None else {}),
            },
        )
        session_id = value.get("sessionId")
        session_token = value.get("sessionToken")
        selected_browser_version = value.get("browserVersion")
        expires_at = value.get("expiresAt")
        heartbeat = value.get("heartbeatAfterSeconds")
        if not isinstance(session_id, str) or not isinstance(session_token, str) or not isinstance(selected_browser_version, str):
            raise _fail("license_service_invalid_response", "License service session response is invalid")
        if not isinstance(expires_at, int) or isinstance(expires_at, bool) or not isinstance(heartbeat, int):
            raise _fail("license_service_invalid_response", "License service session times are invalid")
        returned_policy = value.get("versionPolicy")
        selection_reason = value.get("selectionReason")
        returned_requested_version = value.get("requestedBrowserVersion")
        available_browser_versions = value.get("availableBrowserVersions")
        update_rights = value.get("updateRights")
        requested_kernel_major = _parse_requested_kernel_major(value.get("requestedKernelMajor", _MISSING))
        selection_mode = _parse_selection_mode(value.get("selectionMode", _MISSING))
        latest_available_version = _parse_optional_version(value.get("latestAvailableVersion", _MISSING), "latest-available-version")
        update_available = _parse_optional_bool(value.get("updateAvailable", _MISSING), "update-available")
        update_required = _parse_optional_bool(value.get("updateRequired", _MISSING), "update-required")
        if returned_policy != selected_policy or not isinstance(selection_reason, str) or selection_reason not in {"latest", "exact", "rollback"}:
            raise _fail("license_service_invalid_response", "License service version-selection response is invalid")
        if returned_requested_version != requested_version:
            raise _fail("license_service_invalid_response", "License service requested-version response is invalid")
        if not isinstance(available_browser_versions, list) or not all(
            isinstance(item, str) and _version_parts(item) for item in available_browser_versions
        ):
            raise _fail("license_service_invalid_response", "License service available-version response is invalid")
        if (
            not isinstance(update_rights, Mapping)
            or update_rights.get("status") != "active"
            or update_rights.get("channel") != "stable"
            or (update_rights.get("updatesThrough") is not None and (
                not isinstance(update_rights.get("updatesThrough"), int)
                or isinstance(update_rights.get("updatesThrough"), bool)
            ))
            or update_rights.get("exactVersion") is not True
            or update_rights.get("rollback") is not True
        ):
            raise _fail("license_service_invalid_response", "License service update-rights response is invalid")
        if selected_policy == "exact" and selected_browser_version != requested_version:
            raise _fail("release_version_mismatch", f"Requested browser {requested_version} but service selected {selected_browser_version}")
        if selected_policy == "at-or-before" and _compare_version(selected_browser_version, str(requested_version)) > 0:
            raise _fail("release_version_mismatch", "Rollback selection is newer than the requested browser version")
        lease = value.get("lease")
        if not isinstance(lease, Mapping):
            raise _fail("license_service_invalid_response", "License service lease is invalid")
        claims = self._license_verifier.verify(
            lease,
            browser_version=selected_browser_version,
            required_features=_required_lease_features(),
            device_hash=device_hash,
        )
        if claims.session_id != session_id or claims.expires_at != expires_at:
            raise _fail("license_service_invalid_response", "Signed lease does not match the allocated session")
        manifest = verify_release_manifest(value.get("manifest"), trusted_keys=self._release_trusted_keys)
        if manifest.browser_version != selected_browser_version:
            raise _fail("license_service_invalid_response", "Release manifest does not match the signed lease")
        if not is_sdk_compatible(manifest.sdk_compatibility, sdk_version):
            raise _fail("sdk_version_unsupported", f"Browser {selected_browser_version} does not support SDK {sdk_version}")
        artifact = manifest.select(platform, arch)
        artifact_origin = urllib.parse.urlparse(artifact.url)
        service_origin = urllib.parse.urlparse(self.authorization.service_url)
        if (artifact_origin.scheme, artifact_origin.netloc) != (service_origin.scheme, service_origin.netloc):
            raise _fail("artifact_origin_invalid", "Authorized artifacts must use the license service origin")
        plan = value.get("plan")
        concurrency = value.get("concurrencyLimit")
        active = value.get("activeSessions")
        if (
            plan not in {"free", "basic", "pro", "max", "ultra"}
            or not isinstance(concurrency, int)
            or isinstance(concurrency, bool)
            or not isinstance(active, int)
            or isinstance(active, bool)
        ):
            raise _fail("license_service_invalid_response", "License service plan response is invalid")
        features = _parse_response_features(value.get("features", _MISSING), claims.features)
        _assert_claims_match_plan(claims, str(plan), concurrency, features)
        return LicensedSessionGrant(
            session_id, session_token, heartbeat, expires_at, plan, features, concurrency, active,
            selected_browser_version, returned_requested_version, selected_policy, selection_reason,
            tuple(available_browser_versions), dict(update_rights), dict(lease), claims, manifest, artifact, platform, arch,
            requested_kernel_major=requested_kernel_major,
            selection_mode=selection_mode,
            latest_available_version=latest_available_version,
            update_available=update_available,
            update_required=update_required,
        )

    def create_runtime_session(
        self,
        *,
        platform: str,
        arch: str,
        startup_id: str | None = None,
        automation_backend: str | None = None,
        sdk_version: str = "0.1.0",
        device_hash: str | None = None,
        kernel_major: int | str | None = None,
        update_kernel: bool | None = None,
        browser_version: str | None = None,
        version_policy: str | None = None,
    ) -> RuntimeSessionGrant:
        selected_startup_id = startup_id or _new_startup_id()
        import re
        if not re.fullmatch(r"st_[A-Za-z0-9_-]{16,120}", selected_startup_id):
            raise _fail("startup_id_invalid", "Runtime startup ID is invalid")
        if automation_backend is not None and automation_backend not in {"project-webdriver", "playwright", "puppeteer"}:
            raise _fail("automation_backend_invalid", "Runtime automation backend is invalid")
        requested_version = browser_version
        selected_policy = version_policy or ("latest" if browser_version is None else "exact")
        if selected_policy not in {"latest", "exact", "at-or-before"}:
            raise _fail("version_policy_invalid", f"Unsupported browser version policy: {selected_policy}")
        if selected_policy == "latest" and browser_version is not None:
            raise _fail("version_policy_invalid", "Latest selection cannot include a requested browser version")
        if selected_policy != "latest" and browser_version is None:
            raise _fail("version_policy_invalid", f"{selected_policy} selection requires a browser version")
        if browser_version is not None:
            _version_parts(browser_version)
        normalized_kernel_major = _normalize_kernel_major(kernel_major)
        if not isinstance(update_kernel if update_kernel is not None else False, bool):
            raise _fail("version_policy_invalid", "update_kernel must be a boolean")
        if (
            browser_version is not None
            and normalized_kernel_major != "latest"
            and int(browser_version.split(".")[0]) != normalized_kernel_major
        ):
            raise _fail("version_policy_invalid", "browser_version does not match kernel_major")
        value = self._request(
            "POST",
            "/v2/runtime/sessions",
            authorization=f"License {self.authorization.license_key}",
            body={
                "startupId": selected_startup_id,
                "platform": platform,
                "arch": arch,
                "channel": self.authorization.channel,
                "sdkVersion": sdk_version,
                **({"automationBackend": automation_backend} if automation_backend is not None else {}),
                **({"deviceHash": device_hash} if device_hash is not None else {}),
                "kernelMajor": normalized_kernel_major,
                "updateKernel": False if update_kernel is None else update_kernel,
                "versionPolicy": selected_policy,
                **({"browserVersion": browser_version} if browser_version is not None else {}),
            },
        )
        if value.get("schemaVersion") != 2 or value.get("startupId") != selected_startup_id or value.get("state") not in {"reserved", "active", "closing"}:
            raise _fail("license_service_invalid_response", "Runtime session response is invalid")
        session_id = value.get("sessionId")
        bootstrap_token = value.get("bootstrapToken")
        activation_ticket = value.get("activationTicket")
        driver_activation_ticket = value.get("driverActivationTicket")
        selected_browser_version = value.get("browserVersion")
        expires_at = value.get("expiresAt")
        heartbeat = value.get("heartbeatAfterSeconds")
        if (
            not isinstance(session_id, str)
            or not isinstance(bootstrap_token, str)
            or not isinstance(activation_ticket, str)
            or not activation_ticket
            or not isinstance(selected_browser_version, str)
        ):
            raise _fail("license_service_invalid_response", "Runtime session response is invalid")
        if driver_activation_ticket is not None and (not isinstance(driver_activation_ticket, str) or not driver_activation_ticket):
            raise _fail("license_service_invalid_response", "Runtime driver activation ticket is invalid")
        if automation_backend == "project-webdriver" and driver_activation_ticket is None:
            raise _fail("license_service_invalid_response", "Project WebDriver runtime session is missing a driver activation ticket")
        if not isinstance(expires_at, int) or isinstance(expires_at, bool) or not isinstance(heartbeat, int):
            raise _fail("license_service_invalid_response", "Runtime session times are invalid")
        returned_policy = value.get("versionPolicy")
        selection_reason = value.get("selectionReason")
        returned_requested_version = value.get("requestedBrowserVersion")
        available_browser_versions = value.get("availableBrowserVersions")
        update_rights = value.get("updateRights")
        requested_kernel_major = _parse_requested_kernel_major(value.get("requestedKernelMajor", _MISSING))
        selection_mode = _parse_selection_mode(value.get("selectionMode", _MISSING))
        latest_available_version = _parse_optional_version(value.get("latestAvailableVersion", _MISSING), "latest-available-version")
        update_available = _parse_optional_bool(value.get("updateAvailable", _MISSING), "update-available")
        update_required = _parse_optional_bool(value.get("updateRequired", _MISSING), "update-required")
        if returned_policy != selected_policy or not isinstance(selection_reason, str) or selection_reason not in {"latest", "exact", "rollback"}:
            raise _fail("license_service_invalid_response", "Runtime version-selection response is invalid")
        if returned_requested_version != requested_version:
            raise _fail("license_service_invalid_response", "Runtime requested-version response is invalid")
        if not isinstance(available_browser_versions, list) or not all(
            isinstance(item, str) and _version_parts(item) for item in available_browser_versions
        ):
            raise _fail("license_service_invalid_response", "Runtime available-version response is invalid")
        if (
            not isinstance(update_rights, Mapping)
            or update_rights.get("status") != "active"
            or update_rights.get("channel") != "stable"
            or (update_rights.get("updatesThrough") is not None and (
                not isinstance(update_rights.get("updatesThrough"), int)
                or isinstance(update_rights.get("updatesThrough"), bool)
            ))
            or update_rights.get("exactVersion") is not True
            or update_rights.get("rollback") is not True
        ):
            raise _fail("license_service_invalid_response", "Runtime update-rights response is invalid")
        if selected_policy == "exact" and selected_browser_version != requested_version:
            raise _fail("release_version_mismatch", f"Requested browser {requested_version} but service selected {selected_browser_version}")
        if selected_policy == "at-or-before" and _compare_version(selected_browser_version, str(requested_version)) > 0:
            raise _fail("release_version_mismatch", "Rollback selection is newer than the requested browser version")
        lease = value.get("lease")
        if not isinstance(lease, Mapping):
            raise _fail("license_service_invalid_response", "Runtime lease is invalid")
        claims = self._license_verifier.verify(
            lease,
            browser_version=selected_browser_version,
            required_features=_required_lease_features(automation_backend),
            device_hash=device_hash,
        )
        if claims.session_id != session_id or claims.expires_at != expires_at:
            raise _fail("license_service_invalid_response", "Runtime lease does not match the allocated session")
        manifest = verify_release_manifest(value.get("manifest"), trusted_keys=self._release_trusted_keys)
        if manifest.browser_version != selected_browser_version:
            raise _fail("license_service_invalid_response", "Release manifest does not match the runtime lease")
        if not is_sdk_compatible(manifest.sdk_compatibility, sdk_version):
            raise _fail("sdk_version_unsupported", f"Browser {selected_browser_version} does not support SDK {sdk_version}")
        artifact = manifest.select(platform, arch)
        artifact_origin = urllib.parse.urlparse(artifact.url)
        service_origin = urllib.parse.urlparse(self.authorization.service_url)
        if (artifact_origin.scheme, artifact_origin.netloc) != (service_origin.scheme, service_origin.netloc):
            raise _fail("artifact_origin_invalid", "Authorized artifacts must use the license service origin")
        ticket = value.get("downloadTicket")
        if not isinstance(ticket, Mapping):
            raise _fail("license_service_invalid_response", "Runtime download ticket response is invalid")
        artifact_url = ticket.get("artifactUrl")
        artifact_sha256 = ticket.get("artifactSha256")
        ticket_token = ticket.get("token")
        ticket_expires_at = ticket.get("expiresAt")
        ticket_origin = urllib.parse.urlparse(str(artifact_url))
        if (
            not isinstance(ticket_token, str)
            or not ticket_token
            or not isinstance(ticket_expires_at, int)
            or isinstance(ticket_expires_at, bool)
            or ticket_expires_at != expires_at
            or artifact_sha256 != artifact.sha256
            or not isinstance(artifact_url, str)
            or (ticket_origin.scheme, ticket_origin.netloc) != (service_origin.scheme, service_origin.netloc)
        ):
            raise _fail("license_service_invalid_response", "Runtime download ticket response is invalid")
        plan = value.get("plan")
        concurrency = value.get("concurrencyLimit")
        active = value.get("activeSessions")
        if (
            plan not in {"free", "basic", "pro", "max", "ultra"}
            or not isinstance(concurrency, int)
            or isinstance(concurrency, bool)
            or not isinstance(active, int)
            or isinstance(active, bool)
        ):
            raise _fail("license_service_invalid_response", "Runtime plan response is invalid")
        features = _parse_response_features(value.get("features", _MISSING), claims.features)
        _assert_claims_match_plan(claims, str(plan), concurrency, features)
        return RuntimeSessionGrant(
            2, str(value.get("state")), selected_startup_id, session_id, bootstrap_token, activation_ticket,
            driver_activation_ticket, heartbeat, expires_at,
            str(plan), features, concurrency, active, selected_browser_version, returned_requested_version, selected_policy,
            selection_reason, tuple(available_browser_versions), dict(update_rights), dict(lease), claims, manifest,
            artifact, platform, arch, automation_backend,
            RuntimeDownloadTicket(ticket_token, ticket_expires_at, str(artifact_sha256), artifact_url),
            requested_kernel_major=requested_kernel_major,
            selection_mode=selection_mode,
            latest_available_version=latest_available_version,
            update_available=update_available,
            update_required=update_required,
        )

    def heartbeat(self, grant: LicensedSessionGrant) -> None:
        value = self._request(
            "POST",
            f"/v1/licenses/sessions/{urllib.parse.quote(grant.session_id)}/heartbeat",
            authorization=f"Session {grant.session_token}",
            body={},
        )
        lease = value.get("lease")
        expires_at = value.get("expiresAt")
        if not isinstance(lease, Mapping) or not isinstance(expires_at, int):
            raise _fail("license_service_invalid_response", "Heartbeat response is invalid")
        claims = self._license_verifier.verify(
            lease,
            browser_version=grant.browser_version,
            required_features=_required_lease_features(),
            device_hash=grant.claims.device_hash,
        )
        if claims.session_id != grant.session_id or claims.expires_at != expires_at:
            raise _fail("license_service_invalid_response", "Heartbeat lease does not match the active session")
        plan = value.get("plan")
        concurrency = value.get("concurrencyLimit")
        active = value.get("activeSessions")
        if (
            plan not in {"free", "basic", "pro", "max", "ultra"}
            or not isinstance(concurrency, int)
            or isinstance(concurrency, bool)
            or not isinstance(active, int)
            or isinstance(active, bool)
        ):
            raise _fail("license_service_invalid_response", "Heartbeat plan response is invalid")
        features = _parse_response_features(value.get("features", _MISSING), claims.features)
        _assert_claims_match_plan(claims, str(plan), concurrency, features)
        grant.lease = dict(lease)
        grant.claims = claims
        grant.expires_at = expires_at
        grant.plan = str(plan)
        grant.features = features
        grant.concurrency_limit = concurrency
        grant.active_sessions = active

    def bootstrap_heartbeat(self, grant: RuntimeSessionGrant) -> RuntimeHeartbeatGrant:
        value = self._request(
            "POST",
            f"/v2/runtime/sessions/{urllib.parse.quote(grant.session_id)}/bootstrap-heartbeat",
            authorization=f"Bootstrap {grant.bootstrap_token}",
        )
        return self._runtime_heartbeat_grant(value, grant)

    def activate_runtime_session(self, grant: RuntimeSessionGrant) -> RuntimeActivationGrant:
        value = self._request(
            "POST",
            f"/v2/runtime/sessions/{urllib.parse.quote(grant.session_id)}/activate",
            authorization=f"Activation {grant.activation_ticket}",
        )
        heartbeat = self._runtime_heartbeat_grant(value, grant)
        runtime_token = value.get("runtimeToken")
        if heartbeat.state != "active" or not isinstance(runtime_token, str) or not runtime_token:
            raise _fail("license_service_invalid_response", "Runtime activation response is invalid")
        return RuntimeActivationGrant(
            heartbeat.schema_version,
            heartbeat.state,
            heartbeat.startup_id,
            heartbeat.session_id,
            heartbeat.heartbeat_after_seconds,
            heartbeat.expires_at,
            heartbeat.plan,
            heartbeat.features,
            heartbeat.concurrency_limit,
            heartbeat.active_sessions,
            heartbeat.browser_version,
            heartbeat.automation_backend,
            heartbeat.lease,
            heartbeat.claims,
            runtime_token,
        )

    def runtime_heartbeat(self, grant: RuntimeActivationGrant) -> RuntimeHeartbeatGrant:
        value = self._request(
            "POST",
            f"/v2/runtime/sessions/{urllib.parse.quote(grant.session_id)}/heartbeat",
            authorization=f"Runtime {grant.runtime_token}",
        )
        return self._runtime_heartbeat_grant(value, grant)

    def close_runtime_session(self, grant: RuntimeActivationGrant) -> RuntimeHeartbeatGrant:
        value = self._request(
            "POST",
            f"/v2/runtime/sessions/{urllib.parse.quote(grant.session_id)}/close",
            authorization=f"Runtime {grant.runtime_token}",
        )
        return self._runtime_heartbeat_grant(value, grant)

    def release(self, grant: LicensedSessionGrant) -> None:
        self._request(
            "DELETE",
            f"/v1/licenses/sessions/{urllib.parse.quote(grant.session_id)}",
            authorization=f"Session {grant.session_token}",
        )

    def release_runtime_session(self, grant: RuntimeSessionGrant | RuntimeActivationGrant) -> None:
        if isinstance(grant, RuntimeActivationGrant):
            authorization = f"Runtime {grant.runtime_token}"
        else:
            authorization = f"Bootstrap {grant.bootstrap_token}"
        self._request(
            "DELETE",
            f"/v2/runtime/sessions/{urllib.parse.quote(grant.session_id)}",
            authorization=authorization,
        )

    def download_artifact(self, grant: LicensedSessionGrant, destination: str | Path) -> None:
        parsed_service = urllib.parse.urlparse(self.authorization.service_url)
        parsed_artifact = urllib.parse.urlparse(grant.artifact.url)
        if (parsed_artifact.scheme, parsed_artifact.netloc) != (parsed_service.scheme, parsed_service.netloc):
            raise _fail("artifact_origin_invalid", "Authorized artifacts must use the license service origin")
        self._artifact_downloader(
            grant.artifact.url,
            {"Authorization": f"Session {grant.session_token}"},
            Path(destination),
        )

    def download_runtime_artifact(self, grant: RuntimeSessionGrant, destination: str | Path) -> None:
        parsed_service = urllib.parse.urlparse(self.authorization.service_url)
        parsed_artifact = urllib.parse.urlparse(grant.download_ticket.artifact_url)
        if (parsed_artifact.scheme, parsed_artifact.netloc) != (parsed_service.scheme, parsed_service.netloc):
            raise _fail("artifact_origin_invalid", "Authorized runtime artifacts must use the license service origin")
        path = parsed_artifact.path
        if path.startswith("/v1/releases/artifacts/"):
            path = path.replace("/v1/releases/artifacts/", "/v2/runtime/artifacts/", 1)
        if not path.startswith("/v2/runtime/artifacts/"):
            raise _fail("license_service_invalid_response", "Runtime artifact URL is invalid")
        runtime_url = urllib.parse.urlunparse((
            parsed_artifact.scheme,
            parsed_artifact.netloc,
            path,
            "",
            "",
            "",
        ))
        self._artifact_downloader(
            runtime_url,
            {"Authorization": f"Download {grant.download_ticket.token}"},
            Path(destination),
        )

    def _runtime_heartbeat_grant(
        self,
        value: Mapping[str, Any],
        grant: RuntimeSessionGrant | RuntimeActivationGrant,
    ) -> RuntimeHeartbeatGrant:
        if (
            value.get("schemaVersion") != 2
            or value.get("startupId") != grant.startup_id
            or value.get("sessionId") != grant.session_id
            or value.get("state") not in {"reserved", "active", "closing"}
        ):
            raise _fail("license_service_invalid_response", "Runtime heartbeat response is invalid")
        expires_at = value.get("expiresAt")
        heartbeat = value.get("heartbeatAfterSeconds")
        if not isinstance(expires_at, int) or isinstance(expires_at, bool) or not isinstance(heartbeat, int):
            raise _fail("license_service_invalid_response", "Runtime heartbeat times are invalid")
        lease = value.get("lease")
        if not isinstance(lease, Mapping):
            raise _fail("license_service_invalid_response", "Runtime heartbeat lease is invalid")
        claims = self._license_verifier.verify(
            lease,
            browser_version=grant.browser_version,
            required_features=_required_lease_features(grant.automation_backend),
            device_hash=grant.claims.device_hash,
        )
        if claims.session_id != grant.session_id or claims.expires_at != expires_at:
            raise _fail("license_service_invalid_response", "Runtime heartbeat lease does not match the active session")
        plan = value.get("plan")
        concurrency = value.get("concurrencyLimit")
        active = value.get("activeSessions")
        if (
            plan not in {"free", "basic", "pro", "max", "ultra"}
            or not isinstance(concurrency, int)
            or isinstance(concurrency, bool)
            or not isinstance(active, int)
            or isinstance(active, bool)
        ):
            raise _fail("license_service_invalid_response", "Runtime heartbeat plan response is invalid")
        features = _parse_response_features(value.get("features", _MISSING), claims.features)
        _assert_claims_match_plan(claims, str(plan), concurrency, features)
        return RuntimeHeartbeatGrant(
            2, str(value.get("state")), grant.startup_id, grant.session_id, heartbeat, expires_at,
            str(plan), features, concurrency, active, grant.browser_version, grant.automation_backend, dict(lease), claims,
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        authorization: str,
        body: object | None = None,
    ) -> dict[str, Any]:
        raw = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        status, response = self._transport(
            method,
            f"{self.authorization.service_url}{path}",
            {
                "Authorization": authorization,
                **({"Content-Type": "application/json"} if raw is not None else {}),
            },
            raw,
        )
        if status == 204:
            return {}
        try:
            value = json.loads(response)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise _fail("license_service_invalid_response", "License service returned invalid JSON", status) from error
        if status < 200 or status >= 300:
            remote = value.get("error", {}) if isinstance(value, dict) else {}
            code = _safe_remote_error_code(remote.get("code") if isinstance(remote, dict) else None)
            raise _fail(
                code,
                _remote_error_message(status, code),
                status,
                _safe_error_details(remote if isinstance(remote, dict) else None),
            )
        if not isinstance(value, dict):
            raise _fail("license_service_invalid_response", "License service returned an invalid object", status)
        return value
