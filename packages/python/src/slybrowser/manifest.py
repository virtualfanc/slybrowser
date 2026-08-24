"""Signed release-manifest and browser-artifact verification."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .canonical import canonical_json, decode_base64url
from .errors import ArtifactError, ManifestError

MAX_MANIFEST_BYTES = 1024 * 1024


def _numeric_version(value: str) -> tuple[int, ...]:
    import re
    if not isinstance(value, str) or not re.fullmatch(r"\d+(?:\.\d+){0,7}", value):
        raise ManifestError("SDK version is invalid", code="sdk_version_invalid")
    return tuple(int(part) for part in value.split("."))


def is_sdk_compatible(value: str, version: str) -> bool:
    import re
    current = _numeric_version(version)
    tokens = value.strip().split()
    if not tokens:
        raise ManifestError("Manifest SDK compatibility is invalid", code="manifest_invalid")
    for token in tokens:
        if token.startswith("^"):
            target = _numeric_version(token[1:])
            major = target[0] if len(target) > 0 else 0
            minor = target[1] if len(target) > 1 else 0
            patch = target[2] if len(target) > 2 else 0
            if major > 0:
                upper = (major + 1, 0, 0)
            elif minor > 0:
                upper = (0, minor + 1, 0)
            else:
                upper = (0, 0, patch + 1)
            length = max(len(current), len(target), len(upper))
            left = current + (0,) * (length - len(current))
            lower = target + (0,) * (length - len(target))
            right = upper + (0,) * (length - len(upper))
            if not (left >= lower and left < right):
                return False
            continue
        match = re.fullmatch(r"(>=|<=|>|<|=)?(\d+(?:\.\d+){0,7})", token)
        if not match:
            raise ManifestError("Manifest SDK compatibility is invalid", code="manifest_invalid")
        target = _numeric_version(match.group(2))
        length = max(len(current), len(target))
        left = current + (0,) * (length - len(current))
        right = target + (0,) * (length - len(target))
        operator = match.group(1) or "="
        if operator == ">=" and not left >= right:
            return False
        if operator == "<=" and not left <= right:
            return False
        if operator == ">" and not left > right:
            return False
        if operator == "<" and not left < right:
            return False
        if operator == "=" and not left == right:
            return False
    return True


@dataclass(frozen=True, slots=True)
class ReleasePrivateModule:
    path: str
    sha256: str
    size: int
    abi: str


@dataclass(frozen=True, slots=True)
class ReleaseResourceFile:
    path: str
    sha256: str
    size: int


@dataclass(frozen=True, slots=True)
class ReleaseCodeSignature:
    scheme: str
    subject: str
    certificateSha256: str
    timestampRequired: bool


@dataclass(frozen=True, slots=True)
class ReleaseArtifact:
    platform: str
    arch: str
    url: str
    sha256: str
    size: int
    archiveFormat: str
    browserExecutable: str
    driverExecutable: str
    browserSha256: str
    driverSha256: str
    privateModules: tuple[ReleasePrivateModule, ...]
    resources: tuple[ReleaseResourceFile, ...]
    codeSignature: ReleaseCodeSignature | None = None


@dataclass(frozen=True, slots=True)
class ReleaseManifest:
    browser_version: str
    sdk_compatibility: str
    status: str
    artifacts: tuple[ReleaseArtifact, ...]
    evidence: Mapping[str, Any] | None
    signing_key_id: str
    raw: Mapping[str, Any]

    def select(self, platform: str, arch: str) -> ReleaseArtifact:
        matches = [item for item in self.artifacts if item.platform == platform and item.arch == arch]
        if len(matches) != 1:
            available = ", ".join(sorted(f"{item.platform}/{item.arch}" for item in self.artifacts))
            raise ManifestError(
                f"No signed artifact supports {platform}/{arch}; available targets: {available}",
                code="artifact_not_found",
            )
        return matches[0]


def verify_release_manifest(
    raw: bytes | str | Mapping[str, Any],
    *,
    trusted_keys: Mapping[str, bytes],
) -> ReleaseManifest:
    document = _read_document(raw)
    signature = document.get("signature")
    if not isinstance(signature, dict) or set(signature) != {"algorithm", "keyId", "value"}:
        raise ManifestError("Manifest signature block is invalid", code="manifest_invalid_signature")
    if signature.get("algorithm") != "ed25519":
        raise ManifestError("Manifest signature algorithm is unsupported", code="manifest_algorithm_unsupported")
    key_id = signature.get("keyId")
    if not isinstance(key_id, str) or key_id not in trusted_keys:
        raise ManifestError("Manifest signing key is unknown", code="manifest_key_unknown")
    public_key = trusted_keys[key_id]
    if len(public_key) != 32:
        raise ManifestError("Manifest public key is invalid", code="manifest_key_invalid")
    try:
        signature_bytes = decode_base64url(signature["value"], max_bytes=64)
    except (KeyError, ValueError) as exc:
        raise ManifestError("Manifest signature encoding is invalid", code="manifest_invalid_signature") from exc
    if len(signature_bytes) != 64:
        raise ManifestError("Manifest signature length is invalid", code="manifest_invalid_signature")

    payload = dict(document)
    del payload["signature"]
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:
        raise ManifestError("Ed25519 support is unavailable", code="manifest_crypto_unavailable") from exc
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature_bytes, canonical_json(payload))
    except InvalidSignature as exc:
        raise ManifestError("Manifest signature is invalid", code="manifest_invalid_signature") from exc

    if document.get("schemaVersion") != 1:
        raise ManifestError("Manifest schema is unsupported", code="manifest_schema_unsupported")
    browser_version = document.get("browserVersion")
    sdk_compatibility = document.get("sdkCompatibility")
    artifacts_document = document.get("artifacts")
    if not isinstance(browser_version, str) or not browser_version:
        raise ManifestError("Manifest browser version is invalid", code="manifest_invalid")
    if not isinstance(sdk_compatibility, str) or not sdk_compatibility:
        raise ManifestError("Manifest SDK compatibility is invalid", code="manifest_invalid")
    status = document.get("status")
    if status not in {"available", "revoked"}:
        raise ManifestError("Manifest release status is invalid", code="manifest_invalid")
    if not isinstance(artifacts_document, list) or not artifacts_document:
        raise ManifestError("Manifest artifacts are invalid", code="manifest_invalid")
    artifacts = tuple(_parse_artifact(item) for item in artifacts_document)
    if len({(item.platform, item.arch) for item in artifacts}) != len(artifacts):
        raise ManifestError("Manifest has duplicate platform artifacts", code="manifest_duplicate_artifact")
    evidence = None if "evidence" not in document else _parse_evidence(document.get("evidence"))
    return ReleaseManifest(browser_version, sdk_compatibility, status, artifacts, evidence, key_id, document)


def _parse_evidence_artifact(value: object, media_type: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"url", "sha256", "size", "mediaType"}:
        raise ManifestError("Release evidence is invalid", code="manifest_evidence_invalid")
    valid = (
        isinstance(value["url"], str) and value["url"].startswith("https://")
        and isinstance(value["sha256"], str) and len(value["sha256"]) == 64
        and all(character in "0123456789abcdef" for character in value["sha256"])
        and isinstance(value["size"], int) and not isinstance(value["size"], bool) and value["size"] > 0
        and value["mediaType"] == media_type
    )
    if not valid:
        raise ManifestError("Release evidence is invalid", code="manifest_evidence_invalid")
    return dict(value)


def _parse_evidence(value: object) -> dict[str, Any]:
    required = {"sbom", "provenance", "chromiumPatchInventory", "sourceBoundary"}
    if not isinstance(value, dict):
        raise ManifestError("Release evidence is missing", code="manifest_evidence_missing")
    if set(value) != required:
        raise ManifestError("Release evidence fields are invalid", code="manifest_evidence_invalid")
    boundary = value["sourceBoundary"]
    if not isinstance(boundary, dict) or boundary != {
        "sdk": "open-source",
        "chromiumPatches": "inventory-and-approved-patches",
        "proprietaryCore": "private",
    }:
        raise ManifestError("Source boundary is invalid", code="manifest_evidence_invalid")
    return {
        "sbom": _parse_evidence_artifact(value["sbom"], "application/vnd.cyclonedx+json"),
        "provenance": _parse_evidence_artifact(value["provenance"], "application/vnd.in-toto+json"),
        "chromiumPatchInventory": _parse_evidence_artifact(
            value["chromiumPatchInventory"],
            "application/vnd.slybrowser.chromium-patch-inventory+json",
        ),
        "sourceBoundary": dict(boundary),
    }


def verify_artifact(path: str | Path, artifact: ReleaseArtifact) -> None:
    artifact_path = Path(path)
    if not artifact_path.is_file():
        raise ArtifactError("Browser artifact is missing", code="artifact_missing")
    stat = artifact_path.stat()
    if stat.st_size != artifact.size:
        raise ArtifactError("Browser artifact size does not match", code="artifact_size_mismatch")
    digest = hashlib.sha256()
    with artifact_path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != artifact.sha256:
        raise ArtifactError("Browser artifact checksum does not match", code="artifact_hash_mismatch")


def _read_document(raw: bytes | str | Mapping[str, Any]) -> dict[str, Any]:
    if isinstance(raw, Mapping):
        return dict(raw)
    value = raw.encode("utf-8") if isinstance(raw, str) else raw
    if not isinstance(value, bytes) or len(value) > MAX_MANIFEST_BYTES:
        raise ManifestError("Manifest exceeds its size limit", code="manifest_too_large")
    try:
        document = json.loads(value)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError("Manifest is not valid JSON", code="manifest_invalid") from exc
    if not isinstance(document, dict):
        raise ManifestError("Manifest must be an object", code="manifest_invalid")
    return document


def _parse_artifact(value: Any) -> ReleaseArtifact:
    if not isinstance(value, dict):
        raise ManifestError("Artifact entry must be an object", code="manifest_invalid")
    required = {
        "platform", "arch", "url", "sha256", "size", "archiveFormat",
        "browserExecutable", "driverExecutable", "browserSha256", "driverSha256",
        "privateModules", "resources",
    }
    allowed = required | {"codeSignature"}
    if not required.issubset(set(value)) or not set(value).issubset(allowed):
        raise ManifestError("Artifact fields are invalid", code="manifest_invalid")
    if value["platform"] not in {"windows", "linux", "macos"}:
        raise ManifestError("Artifact platform is invalid", code="manifest_invalid")
    if value["arch"] not in {"x64", "arm64"}:
        raise ManifestError("Artifact architecture is invalid", code="manifest_invalid")
    if not isinstance(value["url"], str) or not value["url"].startswith("https://"):
        raise ManifestError("Artifact URL must use HTTPS", code="manifest_invalid")
    if (
        not isinstance(value["sha256"], str)
        or len(value["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in value["sha256"])
    ):
        raise ManifestError("Artifact SHA-256 is invalid", code="manifest_invalid")
    if not isinstance(value["size"], int) or isinstance(value["size"], bool) or value["size"] <= 0:
        raise ManifestError("Artifact size is invalid", code="manifest_invalid")
    if value["archiveFormat"] != "zip":
        raise ManifestError("Artifact archive format is invalid", code="manifest_invalid")
    for name in ("browserExecutable", "driverExecutable"):
        if not _safe_relative_path(value[name]):
            raise ManifestError("Artifact runtime path is invalid", code="manifest_invalid")
    for name in ("browserSha256", "driverSha256"):
        if not isinstance(value[name], str) or len(value[name]) != 64 or any(character not in "0123456789abcdef" for character in value[name]):
            raise ManifestError("Artifact runtime hash is invalid", code="manifest_invalid")
    private_modules = _parse_private_modules(value["privateModules"])
    resources = _parse_resources(value["resources"])
    code_signature = _parse_code_signature(value["codeSignature"]) if "codeSignature" in value else None
    return ReleaseArtifact(
        value["platform"],
        value["arch"],
        value["url"],
        value["sha256"],
        value["size"],
        value["archiveFormat"],
        value["browserExecutable"],
        value["driverExecutable"],
        value["browserSha256"],
        value["driverSha256"],
        private_modules,
        resources,
        code_signature,
    )


def _safe_relative_path(value: object) -> bool:
    if not isinstance(value, str) or not value or len(value) > 512:
        return False
    normalized = value.replace("\\", "/")
    return not normalized.startswith("/") and not (len(normalized) >= 2 and normalized[1] == ":") and ".." not in normalized.split("/")


def _hex64(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and not any(character not in "0123456789abcdef" for character in value)


def _parse_private_modules(value: object) -> tuple[ReleasePrivateModule, ...]:
    if not isinstance(value, list) or not value:
        raise ManifestError("Artifact private module metadata is invalid", code="manifest_invalid")
    modules: list[ReleasePrivateModule] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "size", "abi"}:
            raise ManifestError("Artifact private module metadata is invalid", code="manifest_invalid")
        if (
            not _safe_relative_path(item["path"])
            or not _hex64(item["sha256"])
            or not isinstance(item["size"], int)
            or isinstance(item["size"], bool)
            or item["size"] <= 0
            or not isinstance(item["abi"], str)
            or not item["abi"]
            or len(item["abi"]) > 128
        ):
            raise ManifestError("Artifact private module metadata is invalid", code="manifest_invalid")
        modules.append(ReleasePrivateModule(item["path"], item["sha256"], item["size"], item["abi"]))
    return tuple(modules)


def _parse_resources(value: object) -> tuple[ReleaseResourceFile, ...]:
    if not isinstance(value, list) or not value:
        raise ManifestError("Artifact resource metadata is invalid", code="manifest_invalid")
    resources: list[ReleaseResourceFile] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"path", "sha256", "size"}:
            raise ManifestError("Artifact resource metadata is invalid", code="manifest_invalid")
        if (
            not _safe_relative_path(item["path"])
            or not _hex64(item["sha256"])
            or not isinstance(item["size"], int)
            or isinstance(item["size"], bool)
            or item["size"] <= 0
        ):
            raise ManifestError("Artifact resource metadata is invalid", code="manifest_invalid")
        resources.append(ReleaseResourceFile(item["path"], item["sha256"], item["size"]))
    return tuple(resources)


def _parse_code_signature(value: object) -> ReleaseCodeSignature:
    if not isinstance(value, dict) or set(value) != {"scheme", "subject", "certificateSha256", "timestampRequired"}:
        raise ManifestError("Artifact code signature metadata is invalid", code="manifest_invalid")
    if (
        value["scheme"] not in {"authenticode", "apple-developer-id", "x509-code-signing"}
        or not isinstance(value["subject"], str)
        or not value["subject"]
        or len(value["subject"]) > 512
        or not _hex64(value["certificateSha256"])
        or not isinstance(value["timestampRequired"], bool)
    ):
        raise ManifestError("Artifact code signature metadata is invalid", code="manifest_invalid")
    return ReleaseCodeSignature(
        value["scheme"],
        value["subject"],
        value["certificateSha256"],
        value["timestampRequired"],
    )
