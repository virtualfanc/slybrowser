"""Offline verification for short-lived, server-signed SlyBrowser leases."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .canonical import decode_base64url
from .errors import LicenseError

MAX_ENVELOPE_BYTES = 64 * 1024
MAX_PAYLOAD_BYTES = 32 * 1024
MAX_LEASE_LIFETIME_SECONDS = 24 * 60 * 60
DEFAULT_CLOCK_SKEW_SECONDS = 30


@dataclass(frozen=True, slots=True)
class LicenseClaims:
    schema_version: int
    license_id: str
    audience: str
    issued_at: int
    not_before: int
    expires_at: int
    browser_version: str | None
    browser_min: str
    browser_max: str
    features: tuple[str, ...]
    session_id: str
    nonce: str
    device_hash: str | None = None
    plan_id: str | None = None
    concurrency_limit: int | None = None
    paid_through: int | None = None
    license_status: str | None = None
    artifact_sha256: str | None = None
    browser_sha256: str | None = None
    driver_sha256: str | None = None
    artifact: Mapping[str, Any] | None = None
    lease_generation: int | None = None


def _fail(code: str, message: str) -> LicenseError:
    return LicenseError(message, code=code)


def _parse_version(value: str) -> tuple[int, ...]:
    if not isinstance(value, str) or not value:
        raise _fail("license_invalid_claims", "Browser version is missing")
    try:
        parts = tuple(int(part) for part in value.split("."))
    except ValueError as exc:
        raise _fail("license_invalid_claims", "Browser version is invalid") from exc
    if not parts or len(parts) > 8 or any(part < 0 for part in parts):
        raise _fail("license_invalid_claims", "Browser version is invalid")
    return parts


def _required_string(document: Mapping[str, Any], name: str) -> str:
    value = document.get(name)
    if not isinstance(value, str) or not value or len(value) > 512:
        raise _fail("license_invalid_claims", f"Claim {name} is invalid")
    return value


def _required_int(document: Mapping[str, Any], name: str) -> int:
    value = document.get(name)
    if not isinstance(value, int) or isinstance(value, bool):
        raise _fail("license_invalid_claims", f"Claim {name} is invalid")
    return value


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _artifact_claim(document: Mapping[str, Any], schema_version: int) -> dict[str, Any] | None:
    value = document.get("artifact")
    if value is None:
        if schema_version == 2:
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        return None
    if not isinstance(value, Mapping):
        raise _fail("license_invalid_claims", "Claim artifact is invalid")
    platform = _required_string(value, "platform")
    arch = _required_string(value, "arch")
    archive_format = _required_string(value, "archiveFormat")
    modules = value.get("privateModules")
    resources = value.get("resources")
    if (
        platform not in {"windows", "linux", "macos"}
        or arch not in {"x64", "arm64"}
        or archive_format not in {"7z", "zip"}
        or not isinstance(modules, list)
        or not isinstance(resources, list)
    ):
        raise _fail("license_invalid_claims", "Claim artifact is invalid")

    def module_claim(item: Any) -> dict[str, Any]:
        if not isinstance(item, Mapping):
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        sha256 = _required_string(item, "sha256")
        size = _required_int(item, "size")
        if not _is_sha256(sha256) or size < 0:
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        return {
            "path": _required_string(item, "path"),
            "sha256": sha256,
            "size": size,
            "abi": _required_string(item, "abi"),
        }

    def resource_claim(item: Any) -> dict[str, Any]:
        if not isinstance(item, Mapping):
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        sha256 = _required_string(item, "sha256")
        size = _required_int(item, "size")
        if not _is_sha256(sha256) or size < 0:
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        return {
            "path": _required_string(item, "path"),
            "sha256": sha256,
            "size": size,
        }

    code_signature = None
    if "codeSignature" in value:
        signature = value.get("codeSignature")
        if not isinstance(signature, Mapping):
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        scheme = _required_string(signature, "scheme")
        certificate_sha256 = _required_string(signature, "certificateSha256")
        timestamp_required = signature.get("timestampRequired")
        if (
            scheme not in {"authenticode", "apple-developer-id", "x509-code-signing"}
            or not _is_sha256(certificate_sha256)
            or not isinstance(timestamp_required, bool)
        ):
            raise _fail("license_invalid_claims", "Claim artifact is invalid")
        code_signature = {
            "scheme": scheme,
            "subject": _required_string(signature, "subject"),
            "certificateSha256": certificate_sha256,
            "timestampRequired": timestamp_required,
        }
    sha256 = _required_string(value, "sha256")
    browser_sha256 = _required_string(value, "browserSha256")
    driver_sha256 = _required_string(value, "driverSha256")
    if not _is_sha256(sha256) or not _is_sha256(browser_sha256) or not _is_sha256(driver_sha256):
        raise _fail("license_invalid_claims", "Claim artifact is invalid")
    result = {
        "sha256": sha256,
        "platform": platform,
        "arch": arch,
        "archiveFormat": archive_format,
        "browserExecutable": _required_string(value, "browserExecutable"),
        "driverExecutable": _required_string(value, "driverExecutable"),
        "browserSha256": browser_sha256,
        "driverSha256": driver_sha256,
        "privateModules": tuple(module_claim(item) for item in modules),
        "resources": tuple(resource_claim(item) for item in resources),
    }
    if code_signature is not None:
        result["codeSignature"] = code_signature
    return result


class LicenseVerifier:
    """Verify an Ed25519 envelope and enforce lease claims.

    Trusted keys are raw 32-byte Ed25519 public keys indexed by a non-secret key ID.
    """

    def __init__(
        self,
        trusted_keys: Mapping[str, bytes],
        *,
        now: Callable[[], float] = time.time,
        clock_skew_seconds: int = DEFAULT_CLOCK_SKEW_SECONDS,
        max_lifetime_seconds: int = MAX_LEASE_LIFETIME_SECONDS,
    ) -> None:
        self._trusted_keys = dict(trusted_keys)
        self._now = now
        self._clock_skew = clock_skew_seconds
        self._max_lifetime = max_lifetime_seconds
        if clock_skew_seconds < 0 or max_lifetime_seconds <= 0:
            raise ValueError("invalid verifier time limits")
        if any(len(key) != 32 for key in self._trusted_keys.values()):
            raise ValueError("Ed25519 public keys must contain exactly 32 bytes")

    def verify(
        self,
        envelope: bytes | str | Mapping[str, Any],
        *,
        browser_version: str,
        audience: str = "slybrowser",
        required_features: Iterable[str] = (),
        device_hash: str | None = None,
    ) -> LicenseClaims:
        document = self._read_envelope(envelope)
        if set(document) != {"algorithm", "keyId", "payload", "signature"}:
            raise _fail("license_invalid_envelope", "License envelope fields are invalid")
        if document.get("algorithm") != "Ed25519":
            raise _fail("license_algorithm_unsupported", "License algorithm is not allowed")

        key_id = _required_string(document, "keyId")
        public_key = self._trusted_keys.get(key_id)
        if public_key is None:
            raise _fail("license_key_unknown", "License signing key is not trusted")

        try:
            payload = decode_base64url(document["payload"], max_bytes=MAX_PAYLOAD_BYTES)
            signature = decode_base64url(document["signature"], max_bytes=64)
        except (KeyError, ValueError) as exc:
            raise _fail("license_invalid_envelope", "License encoding is invalid") from exc
        if len(signature) != 64:
            raise _fail("license_invalid_signature", "License signature length is invalid")

        try:
            from cryptography.exceptions import InvalidSignature
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        except ImportError as exc:
            raise _fail("license_crypto_unavailable", "Ed25519 support is unavailable") from exc

        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(signature, payload)
        except InvalidSignature as exc:
            raise _fail("license_invalid_signature", "License signature is invalid") from exc

        try:
            claims_document = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _fail("license_invalid_claims", "License payload is not valid JSON") from exc
        if not isinstance(claims_document, dict):
            raise _fail("license_invalid_claims", "License payload must be an object")
        return self._validate_claims(
            claims_document,
            browser_version=browser_version,
            audience=audience,
            required_features=required_features,
            device_hash=device_hash,
        )

    def _read_envelope(self, value: bytes | str | Mapping[str, Any]) -> dict[str, Any]:
        if isinstance(value, Mapping):
            return dict(value)
        raw = value.encode("utf-8") if isinstance(value, str) else value
        if not isinstance(raw, bytes) or len(raw) > MAX_ENVELOPE_BYTES:
            raise _fail("license_invalid_envelope", "License envelope exceeds its size limit")
        try:
            document = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _fail("license_invalid_envelope", "License envelope is not valid JSON") from exc
        if not isinstance(document, dict):
            raise _fail("license_invalid_envelope", "License envelope must be an object")
        return document

    def _validate_claims(
        self,
        document: Mapping[str, Any],
        *,
        browser_version: str,
        audience: str,
        required_features: Iterable[str],
        device_hash: str | None,
    ) -> LicenseClaims:
        schema_version = _required_int(document, "schemaVersion")
        if schema_version not in {1, 2}:
            raise _fail("license_schema_unsupported", "License schema is not supported")

        claim_audience = _required_string(document, "audience")
        if claim_audience != audience:
            raise _fail("license_wrong_audience", "License audience does not match")

        issued_at = _required_int(document, "issuedAt")
        not_before = _required_int(document, "notBefore")
        expires_at = _required_int(document, "expiresAt")
        if not_before < issued_at or expires_at <= not_before:
            raise _fail("license_invalid_time", "License time range is invalid")
        if expires_at - issued_at > self._max_lifetime:
            raise _fail("license_lifetime_exceeded", "License lifetime exceeds policy")

        now = int(self._now())
        if issued_at > now + self._clock_skew or not_before > now + self._clock_skew:
            raise _fail("license_not_yet_valid", "License is not yet valid")
        if expires_at <= now - self._clock_skew:
            raise _fail("license_expired", "License has expired")

        browser_min = _required_string(document, "browserMin")
        browser_max = _required_string(document, "browserMax")
        claim_browser_version = _required_string(document, "browserVersion") if "browserVersion" in document else None
        if schema_version == 2 and claim_browser_version != browser_version:
            raise _fail("license_browser_unsupported", "Browser version is outside the license range")
        current_version = _parse_version(browser_version)
        if not (_parse_version(browser_min) <= current_version <= _parse_version(browser_max)):
            raise _fail("license_browser_unsupported", "Browser version is outside the license range")

        plan_id = _required_string(document, "planId") if document.get("planId") is not None else None
        concurrency_limit = _required_int(document, "concurrencyLimit") if "concurrencyLimit" in document else None
        if concurrency_limit is not None and concurrency_limit < 1:
            raise _fail("license_invalid_claims", "Claim concurrencyLimit is invalid")
        paid_through = None if document.get("paidThrough") is None else _required_int(document, "paidThrough")
        if paid_through is not None and paid_through < 0:
            raise _fail("license_invalid_claims", "Claim paidThrough is invalid")
        license_status = _required_string(document, "licenseStatus") if "licenseStatus" in document else None
        if license_status is not None and license_status not in {"active", "hold", "revoked"}:
            raise _fail("license_invalid_claims", "Claim licenseStatus is invalid")
        artifact_sha256 = _required_string(document, "artifactSha256") if "artifactSha256" in document else None
        if artifact_sha256 is not None and not _is_sha256(artifact_sha256):
            raise _fail("license_invalid_claims", "Claim artifactSha256 is invalid")
        browser_sha256 = _required_string(document, "browserSha256") if "browserSha256" in document else None
        if browser_sha256 is not None and not _is_sha256(browser_sha256):
            raise _fail("license_invalid_claims", "Claim browserSha256 is invalid")
        driver_sha256 = _required_string(document, "driverSha256") if "driverSha256" in document else None
        if driver_sha256 is not None and not _is_sha256(driver_sha256):
            raise _fail("license_invalid_claims", "Claim driverSha256 is invalid")
        lease_generation = _required_int(document, "leaseGeneration") if "leaseGeneration" in document else None
        if lease_generation is not None and lease_generation < 1:
            raise _fail("license_invalid_claims", "Claim leaseGeneration is invalid")
        artifact = _artifact_claim(document, schema_version)
        if artifact is not None and (
            artifact["sha256"] != artifact_sha256
            or artifact["browserSha256"] != browser_sha256
            or artifact["driverSha256"] != driver_sha256
        ):
            raise _fail("license_invalid_claims", "Claim artifact does not match flat hashes")

        features_value = document.get("features")
        if (
            not isinstance(features_value, list)
            or any(not isinstance(item, str) or not item or len(item) > 128 for item in features_value)
            or len(set(features_value)) != len(features_value)
        ):
            raise _fail("license_invalid_claims", "License features are invalid")
        feature_set = set(features_value)
        missing_features = sorted(set(required_features) - feature_set)
        if missing_features:
            raise _fail("license_feature_denied", f"License does not grant: {', '.join(missing_features)}")

        claim_device_hash = document.get("deviceHash")
        if claim_device_hash is not None and (
            not isinstance(claim_device_hash, str) or not claim_device_hash
        ):
            raise _fail("license_invalid_claims", "License device hash is invalid")
        if device_hash is not None and claim_device_hash != device_hash:
            raise _fail("license_device_mismatch", "License device binding does not match")

        return LicenseClaims(
            schema_version=schema_version,
            license_id=_required_string(document, "licenseId"),
            audience=claim_audience,
            issued_at=issued_at,
            not_before=not_before,
            expires_at=expires_at,
            browser_version=claim_browser_version,
            browser_min=browser_min,
            browser_max=browser_max,
            plan_id=plan_id,
            concurrency_limit=concurrency_limit,
            features=tuple(features_value),
            session_id=_required_string(document, "sessionId"),
            nonce=_required_string(document, "nonce"),
            device_hash=claim_device_hash,
            paid_through=paid_through,
            license_status=license_status,
            artifact_sha256=artifact_sha256,
            browser_sha256=browser_sha256,
            driver_sha256=driver_sha256,
            artifact=artifact,
            lease_generation=lease_generation,
        )
