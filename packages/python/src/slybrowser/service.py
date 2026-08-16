"""Authorized session exchange for signed SlyBrowser releases."""

from __future__ import annotations

import json
import shutil
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

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


@dataclass(slots=True)
class LicensedSessionGrant:
    session_id: str
    session_token: str
    heartbeat_after_seconds: int
    expires_at: int
    plan: str
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


def _fail(code: str, message: str, status: int = 0) -> LicenseServiceError:
    return LicenseServiceError(message, code=code, status=status)


def _version_parts(value: str) -> tuple[int, ...]:
    import re
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


def read_license_authorization(
    path: str | Path,
    *,
    allow_insecure_localhost: bool = False,
) -> LicenseAuthorization:
    raw = Path(path).expanduser().resolve().read_bytes()
    if len(raw) > 64 * 1024:
        raise _fail("authorization_invalid", "Authorization file is too large")
    try:
        return _parse_authorization(json.loads(raw), allow_insecure_localhost=allow_insecure_localhost)
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
            raise _fail(str(remote.get("code") or "artifact_download_failed"), str(remote.get("message") or error), error.code)
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

    def create_session(
        self,
        *,
        platform: str,
        arch: str,
        sdk_version: str = "0.1.0",
        device_hash: str | None = None,
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
            required_features=("browser", "webdriver"),
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
        if plan not in {"free", "launch", "studio", "fleet", "grid"} or not isinstance(concurrency, int) or not isinstance(active, int):
            raise _fail("license_service_invalid_response", "License service plan response is invalid")
        return LicensedSessionGrant(
            session_id, session_token, heartbeat, expires_at, plan, concurrency, active,
            selected_browser_version, returned_requested_version, selected_policy, selection_reason,
            tuple(available_browser_versions), dict(update_rights), dict(lease), claims, manifest, artifact, platform, arch,
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
            required_features=("browser", "webdriver"),
            device_hash=grant.claims.device_hash,
        )
        if claims.session_id != grant.session_id or claims.expires_at != expires_at:
            raise _fail("license_service_invalid_response", "Heartbeat lease does not match the active session")
        grant.lease = dict(lease)
        grant.claims = claims
        grant.expires_at = expires_at

    def release(self, grant: LicensedSessionGrant) -> None:
        self._request(
            "DELETE",
            f"/v1/licenses/sessions/{urllib.parse.quote(grant.session_id)}",
            authorization=f"Session {grant.session_token}",
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
            raise _fail(str(remote.get("code") or "license_service_error"), str(remote.get("message") or f"HTTP {status}"), status)
        if not isinstance(value, dict):
            raise _fail("license_service_invalid_response", "License service returned an invalid object", status)
        return value
