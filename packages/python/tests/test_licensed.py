from __future__ import annotations

import hashlib
import io
import json
import base64
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from typing import Any, Mapping

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from slybrowser.canonical import canonical_json
from slybrowser.cli import _kernel_major, _license_service_error_output, build_parser
from slybrowser.errors import LicenseServiceError, ManifestError
from slybrowser.installer import (
    acquire_browser_installation_reference,
    find_current_browser_installation,
    install_granted_browser,
    is_browser_installation_in_use,
    prune_browser_installations,
)
from slybrowser.licensed import (
    _heartbeat_delay_seconds,
    install_authorized,
    install_latest,
    launch_authorized,
    launch_authorized_playwright,
    launch_latest,
    launch_latest_playwright,
    launch_latest_playwright_async,
    launch_latest_playwright_persistent,
    launch_latest_playwright_persistent_async,
    prepare_authorized_browser,
    prepare_latest_authorized_browser,
    verify_browser_version_audit,
)
from slybrowser.service import (
    LicenseAuthorization,
    LicenseServiceClient,
    import_license_file_to_sealed_authorization,
    read_license_authorization,
)


def _public(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _deterministic_bytes(label: str, length: int) -> bytes:
    chunks = []
    index = 0
    while len(b"".join(chunks)) < length:
        chunks.append(hashlib.sha256(f"{label}:{index}".encode()).digest())
        index += 1
    return b"".join(chunks)[:length]


def _corrupt_base64url(value: str) -> str:
    return ("B" if value.startswith("A") else "A") + value[1:]


def _v2_license_document(
    signing_key: Ed25519PrivateKey,
    *,
    audience: str = "slybrowser-license-file",
    issued_at: str = "2033-05-18T03:33:20.000Z",
    expires_at: str = "2034-05-18T03:33:20.000Z",
    file_id: str = "lf_test_python_reader",
    passphrase: str = "test-passphrase-only",
    kdf_name: str = "sly-test-scrypt-v1",
    kdf_purpose: str = "test-private-preview",
    scope: str = "test-private-preview",
    secret_overrides: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    salt = _deterministic_bytes("python-license-file-salt", 16)
    nonce = _deterministic_bytes("python-license-file-nonce", 12)
    document: dict[str, Any] = {
        "schemaVersion": 2,
        "type": "slybrowser-license",
        "audience": audience,
        "serviceUrl": "https://api.slybrowser.test",
        "licenseId": "00000000-0000-4000-8000-000000000002",
        "channel": "stable",
        "issuedAt": issued_at,
        "expiresAt": expires_at,
        "fileId": file_id,
        "encryption": {
            "algorithm": "AES-256-GCM",
            "kdf": {
                "name": kdf_name,
                "purpose": kdf_purpose,
                "salt": _b64url(salt),
                "cost": 16384,
                "blockSize": 8,
                "parallelization": 1,
                "keyLength": 32,
            },
            "nonce": _b64url(nonce),
            "aad": "slybrowser-license-v2-public-header",
        },
        "ciphertext": "",
        "tag": "",
        "signature": {
            "algorithm": "Ed25519",
            "keyId": "license-file-test-v1",
            "signature": "",
        },
    }
    secret = {
        "schemaVersion": 2,
        "type": "slybrowser-license-secret",
        "audience": document["audience"],
        "licenseId": document["licenseId"],
        "fileId": document["fileId"],
        "serviceUrl": document["serviceUrl"],
        "channel": "stable",
        "licenseKey": f"sly_live_{document['licenseId']}.{'x' * 43}",
        "secretVersion": 1,
        "createdAt": document["issuedAt"],
        "expiresAt": document["expiresAt"],
        "nonce": "python-payload-nonce",
        "scope": scope,
        **(secret_overrides or {}),
    }
    public_header = {
        "schemaVersion": document["schemaVersion"],
        "type": document["type"],
        "audience": document["audience"],
        "serviceUrl": document["serviceUrl"],
        "licenseId": document["licenseId"],
        "channel": document["channel"],
        "issuedAt": document["issuedAt"],
        "expiresAt": document["expiresAt"],
        "fileId": document["fileId"],
        "encryption": document["encryption"],
    }
    key = hashlib.scrypt(
        passphrase.encode("utf-8"),
        salt=salt,
        n=16384,
        r=8,
        p=1,
        dklen=32,
        maxmem=64 * 1024 * 1024,
    )
    encrypted = AESGCM(key).encrypt(nonce, canonical_json(secret), canonical_json(public_header))
    document["ciphertext"] = _b64url(encrypted[:-16])
    document["tag"] = _b64url(encrypted[-16:])
    signed_body = {**public_header, "ciphertext": document["ciphertext"], "tag": document["tag"]}
    document["signature"]["signature"] = _b64url(signing_key.sign(canonical_json(signed_body)))
    return document


class Fixture:
    def __init__(
        self,
        *,
        tamper_manifest: bool = False,
        session_error: bool = False,
        session_error_code: str = "session_limit",
        session_error_status: int = 409,
        heartbeat_after_seconds: int = 60,
    ) -> None:
        self.lease_key = Ed25519PrivateKey.generate()
        self.release_key = Ed25519PrivateKey.generate()
        self.now = int(time.time())
        self.session_id = "00000000-0000-4000-8000-000000000001"
        self.session_token = "session-token"
        self.bootstrap_token = "bootstrap-token"
        self.activation_ticket = "activation-ticket"
        self.driver_activation_ticket = "driver-activation-ticket"
        self.runtime_token = "runtime-token"
        self.download_ticket_token = "download-token"
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
            package.writestr("SlyBrowser.exe", b"browser")
            package.writestr("chromedriver.exe", b"driver")
        self.artifact = archive.getvalue()
        sha256 = hashlib.sha256(self.artifact).hexdigest()
        claims = {
            "schemaVersion": 1,
            "licenseId": "00000000-0000-4000-8000-000000000002",
            "audience": "slybrowser",
            "issuedAt": self.now,
            "notBefore": self.now,
            "expiresAt": self.now + 600,
            "browserMin": "150.0.8000.1",
            "browserMax": "150.0.8000.1",
            "planId": "launch",
            "concurrencyLimit": 5,
            "features": ["browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright", "puppeteer"],
            "sessionId": self.session_id,
            "nonce": "test-nonce",
        }
        payload = json.dumps(claims, separators=(",", ":")).encode()
        self.lease = {
            "algorithm": "Ed25519",
            "keyId": "lease-test",
            "payload": _base64url(payload),
            "signature": _base64url(self.lease_key.sign(payload)),
        }
        unsigned = {
            "schemaVersion": 1,
            "browserVersion": "150.0.8000.1",
            "sdkCompatibility": ">=0.1.0 <1.0.0",
            "status": "available",
            "publishedAt": "2026-08-16T00:00:00Z",
            "artifacts": [{
                "platform": "windows",
                "arch": "x64",
                "url": f"https://api.slybrowser.test/v1/releases/artifacts/{sha256}.zip",
                "sha256": sha256,
                "size": len(self.artifact),
                "archiveFormat": "zip",
                "browserExecutable": "SlyBrowser.exe",
                "driverExecutable": "chromedriver.exe",
                "browserSha256": hashlib.sha256(b"browser").hexdigest(),
                "driverSha256": hashlib.sha256(b"driver").hexdigest(),
                "privateModules": [{
                    "path": "SlyBrowser/sly_private_module.dll",
                    "sha256": hashlib.sha256(b"private-module").hexdigest(),
                    "size": len(b"private-module"),
                    "abi": "windows-x64",
                }],
                "resources": [{
                    "path": "SlyBrowser/resources.pak",
                    "sha256": hashlib.sha256(b"resources").hexdigest(),
                    "size": len(b"resources"),
                }],
                "codeSignature": {
                    "scheme": "authenticode",
                    "subject": "CN=SlyBrowser Test Publisher",
                    "certificateSha256": "3" * 64,
                    "timestampRequired": True,
                },
            }],
            "evidence": {
                "sbom": {"url": "https://api.slybrowser.test/evidence/sbom.json", "sha256": "0" * 64, "size": 1, "mediaType": "application/vnd.cyclonedx+json"},
                "provenance": {"url": "https://api.slybrowser.test/evidence/provenance.json", "sha256": "1" * 64, "size": 1, "mediaType": "application/vnd.in-toto+json"},
                "chromiumPatchInventory": {"url": "https://api.slybrowser.test/evidence/patches.json", "sha256": "2" * 64, "size": 1, "mediaType": "application/vnd.slybrowser.chromium-patch-inventory+json"},
                "sourceBoundary": {"sdk": "open-source", "chromiumPatches": "inventory-and-approved-patches", "proprietaryCore": "private"},
            },
        }
        self.manifest = {
            **unsigned,
            "signature": {
                "algorithm": "ed25519",
                "keyId": "release-test",
                "value": _base64url(self.release_key.sign(canonical_json(unsigned))),
            },
        }
        if tamper_manifest:
            self.manifest["browserVersion"] = "151.0.0.0"
        self.session_error = session_error
        self.session_error_code = session_error_code
        self.session_error_status = session_error_status
        self.heartbeat_after_seconds = heartbeat_after_seconds
        self.downloads = 0
        self.releases = 0
        self.bootstrap_heartbeats = 0
        self.runtime_startup_id = "st_pythonv2runtime001"
        self.session_requests: list[dict[str, Any]] = []
        self.runtime_session_requests: list[dict[str, Any]] = []
        self.authorization = LicenseAuthorization(
            "https://api.slybrowser.test",
            f"sly_live_00000000-0000-4000-8000-000000000002.{('x' * 43)}",
        )

    def session_limit_error(self) -> dict[str, Any]:
        return {
            "code": self.session_error_code,
            "message": "Limit reached for runtime-token buyer@example.com paynow-secret",
            "concurrencyLimit": 5,
            "activeSessions": 5,
            "availableSessions": 0,
            "runtimeToken": self.runtime_token,
            "downloadTicket": self.download_ticket_token,
            "email": "buyer@example.com",
            "payNowId": "paynow-secret",
            "actions": [
                {
                    "type": "close_session",
                    "api": "DELETE /v2/runtime/sessions/{sessionId}",
                    "authorization": f"Runtime {self.runtime_token}",
                },
                {"type": "upgrade_plan", "url": "https://slybrowser.com/#pricing"},
            ],
        }

    def transport(self, method: str, url: str, _headers: dict[str, str], _body: bytes | None):
        if url.endswith("/v2/licenses/info") and method == "POST":
            request = json.loads(_body or b"{}")
            policy = request.get("versionPolicy", "latest")
            requested = request.get("browserVersion")
            return 200, json.dumps({
                "schemaVersion": 1,
                "channel": "stable",
                "licenseStatus": "active",
                "plan": "launch",
                "effectivePlan": "launch",
                "paidThrough": self.now + 86400,
                "features": ["browser", "release-download", "webdriver", "fingerprint", "humanize", "playwright", "puppeteer"],
                "concurrencyLimit": 5,
                "activeSessions": 0,
                "availableSessions": 5,
                "sessionState": {
                    "activeBrowserProcesses": 0,
                    "limit": 5,
                    "available": 5,
                },
                "browserVersion": "150.0.8000.1",
                **({"requestedBrowserVersion": requested} if requested is not None else {}),
                "requestedKernelMajor": request.get("kernelMajor", "latest"),
                "versionPolicy": policy,
                "selectionReason": (
                    "rollback" if policy == "at-or-before" and requested != "150.0.8000.1"
                    else "exact" if policy == "at-or-before"
                    else policy
                ),
                "selectionMode": "latest-in-major",
                "availableBrowserVersions": ["150.0.8000.1"],
                "latestAvailableVersion": "150.0.8000.1",
                "updateAvailable": False,
                "updateRequired": False,
                "updateRights": {"status": "active", "channel": "stable", "updatesThrough": self.now + 86400, "exactVersion": True, "rollback": True},
                "stableErrorCode": None,
            }).encode()
        if url.endswith("/v1/licenses/sessions") and method == "POST":
            if self.session_error:
                return self.session_error_status, json.dumps({"error": self.session_limit_error()}).encode()
            request = json.loads(_body or b"{}")
            self.session_requests.append(dict(request))
            policy = request.get("versionPolicy", "latest")
            requested = request.get("browserVersion")
            return 201, json.dumps({
                "schemaVersion": 1,
                "sessionId": self.session_id,
                "sessionToken": self.session_token,
                "heartbeatAfterSeconds": self.heartbeat_after_seconds,
                "expiresAt": self.now + 600,
                "plan": "launch",
                "concurrencyLimit": 5,
                "activeSessions": 1,
                "browserVersion": "150.0.8000.1",
                **({"requestedBrowserVersion": requested} if requested is not None else {}),
                "versionPolicy": policy,
                "selectionReason": (
                    "rollback" if policy == "at-or-before" and requested != "150.0.8000.1"
                    else "exact" if policy == "at-or-before"
                    else policy
                ),
                "availableBrowserVersions": ["150.0.8000.1"],
                "updateRights": {"status": "active", "channel": "stable", "updatesThrough": self.now + 86400, "exactVersion": True, "rollback": True},
                "lease": self.lease,
                "manifest": self.manifest,
            }).encode()
        if url.endswith("/v2/runtime/sessions") and method == "POST":
            if self.session_error:
                return self.session_error_status, json.dumps({"error": self.session_limit_error()}).encode()
            request = json.loads(_body or b"{}")
            self.runtime_session_requests.append(dict(request))
            self.runtime_startup_id = request.get("startupId") or self.runtime_startup_id
            policy = request.get("versionPolicy", "latest")
            requested = request.get("browserVersion")
            return 201, json.dumps({
                "schemaVersion": 2,
                "state": "reserved",
                "startupId": request.get("startupId"),
                "sessionId": self.session_id,
                "bootstrapToken": self.bootstrap_token,
                "activationTicket": self.activation_ticket,
                **({"driverActivationTicket": self.driver_activation_ticket} if request.get("automationBackend") == "project-webdriver" else {}),
                "heartbeatAfterSeconds": self.heartbeat_after_seconds,
                "expiresAt": self.now + 600,
                "plan": "launch",
                "concurrencyLimit": 5,
                "activeSessions": 1,
                "browserVersion": "150.0.8000.1",
                **({"requestedBrowserVersion": requested} if requested is not None else {}),
                "versionPolicy": policy,
                "selectionReason": (
                    "rollback" if policy == "at-or-before" and requested != "150.0.8000.1"
                    else "exact" if policy == "at-or-before"
                    else policy
                ),
                "availableBrowserVersions": ["150.0.8000.1"],
                "updateRights": {"status": "active", "channel": "stable", "updatesThrough": self.now + 86400, "exactVersion": True, "rollback": True},
                "lease": self.lease,
                "manifest": self.manifest,
                "downloadTicket": {
                    "token": self.download_ticket_token,
                    "expiresAt": self.now + 600,
                    "artifactSha256": hashlib.sha256(self.artifact).hexdigest(),
                    "artifactUrl": f"https://api.slybrowser.test/v1/releases/artifacts/{hashlib.sha256(self.artifact).hexdigest()}.zip",
                },
            }).encode()
        if url.endswith(f"/v2/runtime/sessions/{self.session_id}/bootstrap-heartbeat") and method == "POST":
            self.bootstrap_heartbeats += 1
            assert _headers["Authorization"] == f"Bootstrap {self.bootstrap_token}"
            return 200, json.dumps({
                "schemaVersion": 2,
                "state": "reserved",
                "startupId": self.runtime_startup_id,
                "sessionId": self.session_id,
                "heartbeatAfterSeconds": self.heartbeat_after_seconds,
                "expiresAt": self.now + 600,
                "plan": "launch",
                "concurrencyLimit": 5,
                "activeSessions": 1,
                "lease": self.lease,
            }).encode()
        if url.endswith(f"/v2/runtime/sessions/{self.session_id}/activate") and method == "POST":
            assert _headers["Authorization"] == f"Activation {self.activation_ticket}"
            return 200, json.dumps({
                "schemaVersion": 2,
                "state": "active",
                "startupId": self.runtime_startup_id,
                "sessionId": self.session_id,
                "runtimeToken": self.runtime_token,
                "heartbeatAfterSeconds": self.heartbeat_after_seconds,
                "expiresAt": self.now + 600,
                "plan": "launch",
                "concurrencyLimit": 5,
                "activeSessions": 1,
                "lease": self.lease,
            }).encode()
        if url.endswith(f"/v2/runtime/sessions/{self.session_id}/heartbeat") and method == "POST":
            assert _headers["Authorization"] == f"Runtime {self.runtime_token}"
            return 200, json.dumps({
                "schemaVersion": 2,
                "state": "active",
                "startupId": self.runtime_startup_id,
                "sessionId": self.session_id,
                "heartbeatAfterSeconds": self.heartbeat_after_seconds,
                "expiresAt": self.now + 600,
                "plan": "launch",
                "concurrencyLimit": 5,
                "activeSessions": 1,
                "lease": self.lease,
            }).encode()
        if url.endswith(f"/v2/runtime/sessions/{self.session_id}/close") and method == "POST":
            assert _headers["Authorization"] == f"Runtime {self.runtime_token}"
            return 200, json.dumps({
                "schemaVersion": 2,
                "state": "closing",
                "startupId": self.runtime_startup_id,
                "sessionId": self.session_id,
                "heartbeatAfterSeconds": self.heartbeat_after_seconds,
                "expiresAt": self.now + 600,
                "plan": "launch",
                "concurrencyLimit": 5,
                "activeSessions": 1,
                "lease": self.lease,
            }).encode()
        if method == "DELETE":
            self.releases += 1
            return 204, b""
        raise AssertionError(f"Unexpected request: {method} {url}")

    def download(self, _url: str, headers: dict[str, str], destination: Path) -> None:
        self.downloads += 1
        if "/v2/runtime/artifacts/" in _url:
            assert headers["Authorization"] == f"Download {self.download_ticket_token}"
        else:
            assert headers["Authorization"] == f"Session {self.session_token}"
        destination.write_bytes(self.artifact)

    def client(self) -> LicenseServiceClient:
        return LicenseServiceClient(
            self.authorization,
            license_trusted_keys={"lease-test": _public(self.lease_key)},
            release_trusted_keys={"release-test": _public(self.release_key)},
            transport=self.transport,
            artifact_downloader=self.download,
        )

    def write_authorization(self, directory: str | Path) -> Path:
        path = Path(directory, "account.authorization.json")
        path.write_text(json.dumps({
            "schemaVersion": 1,
            "serviceUrl": self.authorization.service_url,
            "licenseKey": self.authorization.license_key,
            "channel": self.authorization.channel,
        }), encoding="utf-8")
        return path


class FakeRuntime:
    def __init__(self, version: str = "150.0.8000.1") -> None:
        self._version = version
        self.close_count = 0
        self.context_count = 0

    def version(self) -> str:
        return self._version

    def new_context(self) -> "FakeContext":
        self.context_count += 1
        return FakeContext(self)

    def close(self) -> None:
        self.close_count += 1


class FakePage:
    def __init__(self) -> None:
        self.close_count = 0

    def close(self) -> None:
        self.close_count += 1


class FakeContext:
    def __init__(self, browser: FakeRuntime) -> None:
        self._browser = browser
        self.close_count = 0
        self.page_count = 0

    def browser(self) -> FakeRuntime:
        return self._browser

    def new_page(self) -> FakePage:
        self.page_count += 1
        return FakePage()

    def close(self) -> None:
        self.close_count += 1


class FakeFrameworkChromium:
    def __init__(self, runtime: Any) -> None:
        self.runtime = runtime
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def launch(self, *args: Any, **kwargs: Any) -> Any:
        self._assert_sly_launch(kwargs)
        self.calls.append(("launch", args, kwargs))
        return self.runtime

    def launch_persistent_context(self, *args: Any, **kwargs: Any) -> Any:
        self._assert_sly_launch(kwargs)
        self.calls.append(("persistent", args, kwargs))
        return self.runtime

    @staticmethod
    def _assert_sly_launch(kwargs: Mapping[str, Any]) -> None:
        executable = Path(str(kwargs["executable_path"]))
        assert executable.name == "SlyBrowser.exe"
        arguments = kwargs["args"]
        assert isinstance(arguments, list)
        assert any(str(item).startswith("--sly-config-file=") for item in arguments)
        assert any(str(item).startswith("--sly-license-file=") for item in arguments)


class FakeFrameworkPlaywright:
    def __init__(self, runtime: Any) -> None:
        self.chromium = FakeFrameworkChromium(runtime)


class FakeAsyncRuntime:
    def __init__(self, version: str = "150.0.8000.1") -> None:
        self._version = version
        self.close_count = 0

    async def version(self) -> str:
        return self._version

    async def close(self) -> None:
        self.close_count += 1


class FakeAsyncContext:
    def __init__(self, browser: FakeAsyncRuntime) -> None:
        self._browser = browser
        self.close_count = 0

    async def browser(self) -> FakeAsyncRuntime:
        return self._browser

    async def close(self) -> None:
        self.close_count += 1


class FakeAsyncFrameworkChromium:
    def __init__(self, runtime: Any) -> None:
        self.runtime = runtime
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    async def launch(self, *args: Any, **kwargs: Any) -> Any:
        FakeFrameworkChromium._assert_sly_launch(kwargs)
        self.calls.append(("launch", args, kwargs))
        return self.runtime

    async def launch_persistent_context(self, *args: Any, **kwargs: Any) -> Any:
        FakeFrameworkChromium._assert_sly_launch(kwargs)
        self.calls.append(("persistent", args, kwargs))
        return self.runtime


class FakeAsyncFrameworkPlaywright:
    def __init__(self, runtime: Any) -> None:
        self.chromium = FakeAsyncFrameworkChromium(runtime)


def _base64url(value: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class LicensedReleaseTests(unittest.TestCase):
    def test_exports_stable_authorized_aliases(self) -> None:
        self.assertTrue(callable(prepare_authorized_browser))
        self.assertTrue(callable(prepare_latest_authorized_browser))
        self.assertTrue(callable(install_authorized))
        self.assertTrue(callable(install_latest))
        self.assertTrue(callable(launch_authorized))
        self.assertTrue(callable(launch_latest))
        self.assertTrue(callable(launch_authorized_playwright))
        self.assertTrue(callable(launch_latest_playwright))

    def test_cli_kernel_update_controls_default_closed(self) -> None:
        parser = build_parser()
        args = parser.parse_args(["install", "--authorization", "account.json"])
        self.assertFalse(args.update_kernel)
        self.assertIsNone(args.kernel_major)
        args = parser.parse_args(["install", "--authorization", "account.json", "--kernel-major", "150"])
        self.assertEqual(args.kernel_major, 150)
        self.assertFalse(args.update_kernel)
        args = parser.parse_args(["install", "--authorization", "account.json", "--kernel-major", "latest", "--update-kernel"])
        self.assertEqual(args.kernel_major, "latest")
        self.assertTrue(args.update_kernel)
        with self.assertRaises(SystemExit):
            parser.parse_args(["install", "--authorization", "account.json", "--kernel-major", "150.0.8000.1"])
        with self.assertRaises(Exception):
            _kernel_major("0")

    def test_cli_license_service_errors_are_stable_and_redacted(self) -> None:
        error = LicenseServiceError(
            "download-token bootstrap-token runtime-token license@example.com",
            code="session_limit",
            status=409,
            details={
                "runtimeToken": "runtime-token",
                "downloadTicket": "download-token",
                "email": "license@example.com",
                "payNowOrderId": "700000000000000411",
            },
        )
        serialized = json.dumps(_license_service_error_output(error))
        self.assertIn("session_limit", serialized)
        self.assertIn("409", serialized)
        self.assertNotIn("runtime-token", serialized)
        self.assertNotIn("download-token", serialized)
        self.assertNotIn("bootstrap-token", serialized)
        self.assertNotIn("license@example.com", serialized)
        self.assertNotIn("700000000000000411", serialized)

    def test_reads_redacted_online_license_info_without_creating_session(self) -> None:
        fixture = Fixture()
        info = LicenseServiceClient(
            fixture.authorization,
            license_trusted_keys={"lease-test": _public(fixture.lease_key)},
            release_trusted_keys={"release-test": _public(fixture.release_key)},
            transport=fixture.transport,
        ).license_info(
            platform="windows",
            arch="x64",
            kernel_major=150,
            update_kernel=False,
        )
        self.assertEqual(info.schema_version, 1)
        self.assertEqual(info.plan, "launch")
        self.assertEqual(info.effective_plan, "launch")
        self.assertEqual(info.concurrency_limit, 5)
        self.assertEqual(info.active_sessions, 0)
        self.assertEqual(info.available_sessions, 5)
        self.assertEqual(info.requested_kernel_major, 150)
        self.assertEqual(info.selection_mode, "latest-in-major")
        self.assertIsNone(info.stable_error_code)
        self.assertIn("playwright", info.features)
        self.assertEqual(fixture.session_requests, [])
        self.assertEqual(fixture.runtime_session_requests, [])
        serialized = json.dumps(info.to_redacted_dict())
        self.assertNotIn("sly_live_", serialized)
        self.assertNotIn("session-token", serialized)
        self.assertNotIn("download-token", serialized)
        self.assertNotIn("bootstrap-token", serialized)

    def test_authorized_default_keeps_updates_closed_while_latest_updates(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            authorized_fixture = Fixture()
            authorized_file = authorized_fixture.write_authorization(root)
            authorized_cache = Path(root) / "authorized-cache"
            authorized = prepare_authorized_browser(
                authorized_file,
                license_trusted_keys={"lease-test": _public(authorized_fixture.lease_key)},
                release_trusted_keys={"release-test": _public(authorized_fixture.release_key)},
                cache_root=authorized_cache,
                platform="windows",
                arch="x64",
                kernel_major=150,
                transport=authorized_fixture.transport,
                artifact_downloader=authorized_fixture.download,
            )
            authorized.release()
            self.assertEqual(authorized_fixture.session_requests, [])
            self.assertEqual(authorized_fixture.runtime_session_requests[0]["automationBackend"], "project-webdriver")
            self.assertEqual(authorized_fixture.runtime_session_requests[0]["kernelMajor"], 150)
            self.assertIs(authorized_fixture.runtime_session_requests[0]["updateKernel"], False)
            cached = prepare_authorized_browser(
                authorized_file,
                license_trusted_keys={"lease-test": _public(authorized_fixture.lease_key)},
                release_trusted_keys={"release-test": _public(authorized_fixture.release_key)},
                cache_root=authorized_cache,
                platform="windows",
                arch="x64",
                kernel_major=150,
                transport=authorized_fixture.transport,
                artifact_downloader=authorized_fixture.download,
            )
            cached.release()
            self.assertEqual(authorized_fixture.runtime_session_requests[1]["automationBackend"], "project-webdriver")
            self.assertEqual(authorized_fixture.runtime_session_requests[1]["kernelMajor"], 150)
            self.assertIs(authorized_fixture.runtime_session_requests[1]["updateKernel"], False)
            self.assertEqual(authorized_fixture.runtime_session_requests[1]["browserVersion"], "150.0.8000.1")
            self.assertEqual(authorized_fixture.runtime_session_requests[1]["versionPolicy"], "exact")
            withdrawn_fixture = Fixture(
                session_error=True,
                session_error_code="release_version_unavailable",
                session_error_status=404,
            )
            with self.assertRaises(LicenseServiceError) as withdrawn:
                prepare_authorized_browser(
                    authorized_file,
                    license_trusted_keys={"lease-test": _public(withdrawn_fixture.lease_key)},
                    release_trusted_keys={"release-test": _public(withdrawn_fixture.release_key)},
                    cache_root=authorized_cache,
                    platform="windows",
                    arch="x64",
                    kernel_major=150,
                    transport=withdrawn_fixture.transport,
                    artifact_downloader=withdrawn_fixture.download,
                )
            self.assertEqual(withdrawn.exception.code, "kernel_update_required")
            self.assertEqual(withdrawn.exception.status, 409)

            latest_fixture = Fixture()
            latest = prepare_latest_authorized_browser(
                latest_fixture.write_authorization(root),
                license_trusted_keys={"lease-test": _public(latest_fixture.lease_key)},
                release_trusted_keys={"release-test": _public(latest_fixture.release_key)},
                cache_root=Path(root) / "latest-cache",
                platform="windows",
                arch="x64",
                kernel_major=150,
                transport=latest_fixture.transport,
                artifact_downloader=latest_fixture.download,
            )
            latest.release()
            self.assertEqual(latest_fixture.session_requests, [])
            self.assertEqual(latest_fixture.runtime_session_requests[0]["automationBackend"], "project-webdriver")
            self.assertEqual(latest_fixture.runtime_session_requests[0]["kernelMajor"], 150)
            self.assertIs(latest_fixture.runtime_session_requests[0]["updateKernel"], True)

    def test_heartbeat_delay_uses_negative_jitter(self) -> None:
        self.assertEqual(_heartbeat_delay_seconds(300, lambda: 0), 300)
        self.assertEqual(_heartbeat_delay_seconds(300, lambda: 1), 285)
        self.assertEqual(_heartbeat_delay_seconds(300, lambda: 0.5), 292.5)
        self.assertEqual(_heartbeat_delay_seconds(5, lambda: 1), 1)

    def test_authorized_downloads_use_bootstrap_heartbeat(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            fixture = Fixture(heartbeat_after_seconds=1)
            authorization_file = fixture.write_authorization(root)

            def slow_download(url: str, headers: dict[str, str], destination: Path) -> None:
                time.sleep(1.1)
                fixture.download(url, headers, destination)

            authorized = prepare_authorized_browser(
                authorization_file,
                license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                release_trusted_keys={"release-test": _public(fixture.release_key)},
                cache_root=Path(root) / "cache",
                platform="windows",
                arch="x64",
                transport=fixture.transport,
                artifact_downloader=slow_download,
            )
            authorized.release()
            self.assertEqual(fixture.session_requests, [])
            self.assertGreaterEqual(fixture.bootstrap_heartbeats, 1)
            self.assertEqual(fixture.downloads, 1)
            self.assertEqual(fixture.releases, 1)

    def test_reads_v2_license_file_and_fails_closed_on_tampering(self) -> None:
        signing_key = Ed25519PrivateKey.generate()
        with tempfile.TemporaryDirectory() as root:
            license_file = Path(root) / "account.slybrowser-license.json"
            document = _v2_license_document(signing_key)
            license_file.write_text(json.dumps(document), encoding="utf-8")
            trust = {
                "license_file_passphrase": "test-passphrase-only",
                "license_file_trusted_keys": {"license-file-test-v1": _public(signing_key)},
                "trusted_service_urls": ("https://api.slybrowser.test",),
            }
            authorization = read_license_authorization(license_file, **trust)
            self.assertEqual(authorization.service_url, "https://api.slybrowser.test")
            self.assertEqual(authorization.license_key, f"sly_live_{document['licenseId']}.{'x' * 43}")
            self.assertNotIn("sly_live_", license_file.read_text(encoding="utf-8"))

            portable_document = _v2_license_document(
                signing_key,
                file_id="lf_portable_python_reader",
                passphrase="portable-passphrase-only",
                kdf_name="sly-portable-scrypt-v1",
                kdf_purpose="portable-passphrase",
                scope="portable-passphrase",
            )
            license_file.write_text(json.dumps(portable_document), encoding="utf-8")
            portable_authorization = read_license_authorization(
                license_file,
                **{**trust, "license_file_passphrase": "portable-passphrase-only"},
            )
            self.assertEqual(portable_authorization.service_url, "https://api.slybrowser.test")
            self.assertEqual(portable_authorization.license_key, f"sly_live_{portable_document['licenseId']}.{'x' * 43}")

            license_file.write_text(json.dumps({**document, "serviceUrl": "https://evil.example"}), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "service URL is not trusted"):
                read_license_authorization(license_file, **trust)

            license_file.write_text(json.dumps({**document, "ciphertext": _corrupt_base64url(document["ciphertext"])}), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "signature is invalid"):
                read_license_authorization(license_file, **trust)

            license_file.write_text(json.dumps({
                **document,
                "signature": {
                    **document["signature"],
                    "signature": _corrupt_base64url(document["signature"]["signature"]),
                },
            }), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "signature is invalid"):
                read_license_authorization(license_file, **trust)

            license_file.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "cannot be decrypted"):
                read_license_authorization(license_file, **{**trust, "license_file_passphrase": "wrong-passphrase"})
            with self.assertRaisesRegex(LicenseServiceError, "signing key is not trusted"):
                read_license_authorization(license_file, **{**trust, "license_file_trusted_keys": {}})

            license_file.write_text(json.dumps(_v2_license_document(signing_key, audience="other-product")), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "fields are invalid"):
                read_license_authorization(license_file, **trust)

            license_file.write_text(json.dumps(_v2_license_document(
                signing_key,
                issued_at="2020-01-01T00:00:00.000Z",
                expires_at="2020-01-02T00:00:00.000Z",
                file_id="lf_test_python_expired",
            )), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "has expired"):
                read_license_authorization(license_file, **trust)

            license_file.write_text(json.dumps(_v2_license_document(
                signing_key,
                file_id="lf_test_python_plan_claim",
                secret_overrides={"plan": "grid"},
            )), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "unsupported claims"):
                read_license_authorization(license_file, **trust)

    @unittest.skipUnless(sys.platform == "win32", "Windows DPAPI sealed license import requires Windows")
    def test_imports_v2_license_file_into_windows_dpapi_sealed_authorization(self) -> None:
        signing_key = Ed25519PrivateKey.generate()
        with tempfile.TemporaryDirectory() as root:
            license_file = Path(root) / "account.slybrowser-license.json"
            sealed_file = Path(root) / "account.slybrowser-sealed-license.json"
            document = _v2_license_document(
                signing_key,
                file_id="lf_portable_python_import",
                passphrase="portable-passphrase-only",
                kdf_name="sly-portable-scrypt-v1",
                kdf_purpose="portable-passphrase",
                scope="portable-passphrase",
            )
            license_file.write_text(json.dumps(document), encoding="utf-8")
            trust = {
                "license_file_passphrase": "portable-passphrase-only",
                "license_file_trusted_keys": {"license-file-test-v1": _public(signing_key)},
                "trusted_service_urls": ("https://api.slybrowser.test",),
            }
            result = import_license_file_to_sealed_authorization(license_file, sealed_file, **trust)
            self.assertEqual(result.output, sealed_file.resolve())
            self.assertEqual(result.service_url, "https://api.slybrowser.test")
            self.assertEqual(result.channel, "stable")
            self.assertEqual(result.protection, "windows-dpapi-current-user")
            serialized = sealed_file.read_text(encoding="utf-8")
            self.assertNotIn("sly_live_", serialized)
            self.assertNotIn("portable-passphrase-only", serialized)
            authorization = read_license_authorization(
                sealed_file,
                trusted_service_urls=("https://api.slybrowser.test",),
            )
            self.assertEqual(authorization.service_url, "https://api.slybrowser.test")
            self.assertEqual(authorization.license_key, f"sly_live_{document['licenseId']}.{'x' * 43}")
            with self.assertRaises(FileExistsError):
                import_license_file_to_sealed_authorization(license_file, sealed_file, **trust)
            tampered = json.loads(serialized)
            tampered["licenseKeySha256"] = "0" * 64
            tampered_file = Path(root) / "account.tampered-sealed-license.json"
            tampered_file.write_text(json.dumps(tampered), encoding="utf-8")
            with self.assertRaisesRegex(LicenseServiceError, "cannot be decrypted"):
                read_license_authorization(tampered_file, trusted_service_urls=("https://api.slybrowser.test",))

    def test_verifies_downloads_extracts_and_reuses_cache(self) -> None:
        fixture = Fixture()
        client = fixture.client()
        grant = client.create_session(platform="windows", arch="x64")
        self.assertEqual(grant.plan, "launch")
        self.assertEqual(grant.concurrency_limit, 5)
        with tempfile.TemporaryDirectory() as directory:
            first = install_granted_browser(client, grant, cache_root=directory)
            second = install_granted_browser(client, grant, cache_root=directory)
            self.assertEqual(first, second)
            self.assertEqual(first.browser_executable.read_bytes(), b"browser")
            self.assertEqual(first.driver_executable.read_bytes(), b"driver")
            self.assertEqual(fixture.downloads, 1)
            first.driver_executable.write_bytes(b"tampered")
            repaired = install_granted_browser(client, grant, cache_root=directory)
            self.assertEqual(repaired.driver_executable.read_bytes(), b"driver")
            self.assertEqual(fixture.downloads, 1)

            repaired.browser_executable.write_bytes(b"tampered-again")
            (Path(directory) / "downloads" / f"{grant.artifact.sha256}.zip").write_bytes(b"corrupt-archive")
            repaired_after_archive_damage = install_granted_browser(client, grant, cache_root=directory)
            self.assertEqual(repaired_after_archive_damage.browser_executable.read_bytes(), b"browser")
            self.assertEqual(fixture.downloads, 2)
            self.assertTrue(any(".bad-" in item.name for item in (Path(directory) / "downloads").iterdir()))
            self.assertTrue(any(".bad-" in item.name for item in (Path(directory) / "stable" / grant.browser_version).iterdir()))

            def fake_installation(version: str, identity: str, prefix: str) -> Any:
                root = Path(directory) / "stable" / version / identity
                root.mkdir(parents=True)
                browser = root / "SlyBrowser.exe"
                driver = root / "chromedriver.exe"
                browser.write_text("old-browser", encoding="utf-8")
                driver.write_text("old-driver", encoding="utf-8")
                marker = {
                    "version": version,
                    "platform": "windows",
                    "arch": "x64",
                    "root": str(root),
                    "browser_executable": str(browser),
                    "driver_executable": str(driver),
                    "artifact_sha256": prefix * 64,
                }
                (root / ".sly-install.json").write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
                return find_current_browser_installation(cache_root=directory, platform="windows", arch="x64", kernel_major=int(version.split(".")[0]))

            unused = fake_installation("149.0.0.1", "windows-x64-aaaaaaaaaaaaaaaa", "a")
            in_use = fake_installation("149.0.0.2", "windows-x64-bbbbbbbbbbbbbbbb", "b")
            self.assertIsNotNone(unused)
            self.assertIsNotNone(in_use)
            reference = acquire_browser_installation_reference(in_use)  # type: ignore[arg-type]
            pruned = prune_browser_installations(cache_root=directory, platform="windows", arch="x64")
            self.assertEqual(pruned.removed, [unused.root])  # type: ignore[union-attr]
            self.assertEqual(pruned.skipped_in_use, [in_use.root])  # type: ignore[union-attr]
            self.assertIn(repaired_after_archive_damage.root, pruned.kept)
            self.assertFalse(unused.root.exists())  # type: ignore[union-attr]
            self.assertTrue(in_use.root.exists())  # type: ignore[union-attr]
            reference.release()
            second_prune = prune_browser_installations(cache_root=directory, platform="windows", arch="x64")
            self.assertEqual(second_prune.removed, [in_use.root])  # type: ignore[union-attr]

    def test_uses_v2_runtime_credentials_for_activation_download_and_release(self) -> None:
        fixture = Fixture()
        client = fixture.client()
        grant = client.create_runtime_session(
            platform="windows",
            arch="x64",
            automation_backend="playwright",
            startup_id="st_pythonv2runtime001",
        )
        self.assertEqual(grant.schema_version, 2)
        self.assertEqual(grant.state, "reserved")
        self.assertEqual(grant.bootstrap_token, "bootstrap-token")
        self.assertEqual(grant.activation_ticket, "activation-ticket")
        self.assertEqual(grant.download_ticket.token, "download-token")
        self.assertEqual(grant.browser_version, "150.0.8000.1")

        bootstrap_heartbeat = client.bootstrap_heartbeat(grant)
        self.assertEqual(bootstrap_heartbeat.state, "reserved")
        with tempfile.TemporaryDirectory() as directory:
            installation = install_granted_browser(client, grant, cache_root=directory)
            self.assertEqual(installation.version, "150.0.8000.1")
            self.assertEqual(installation.browser_executable.read_bytes(), b"browser")
            self.assertEqual(installation.driver_executable.read_bytes(), b"driver")

        active = client.activate_runtime_session(grant)
        self.assertEqual(active.state, "active")
        self.assertEqual(active.runtime_token, "runtime-token")
        heartbeat = client.runtime_heartbeat(active)
        self.assertEqual(heartbeat.state, "active")
        closing = client.close_runtime_session(active)
        self.assertEqual(closing.state, "closing")
        client.release_runtime_session(active)
        self.assertEqual(fixture.releases, 1)
        self.assertEqual(fixture.downloads, 1)

        reserved_fixture = Fixture()
        reserved_grant = reserved_fixture.client().create_runtime_session(
            platform="windows",
            arch="x64",
            startup_id="st_pythonv2runtime001",
        )
        reserved_fixture.client().release_runtime_session(reserved_grant)
        self.assertEqual(reserved_fixture.releases, 1)

    def test_rejects_manifest_changed_after_signing(self) -> None:
        client = Fixture(tamper_manifest=True).client()
        with self.assertRaises(ManifestError) as raised:
            client.create_session(platform="windows", arch="x64")
        self.assertEqual(raised.exception.code, "manifest_invalid_signature")

    def test_preserves_session_limit_error(self) -> None:
        client = Fixture(session_error=True).client()
        with self.assertRaises(LicenseServiceError) as raised:
            client.create_session(platform="windows", arch="x64")
        self.assertEqual(raised.exception.code, "session_limit")
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(raised.exception.details["concurrencyLimit"], 5)
        self.assertEqual(raised.exception.details["activeSessions"], 5)
        self.assertEqual(raised.exception.details["availableSessions"], 0)
        actions = raised.exception.details["actions"]
        self.assertIsInstance(actions, list)
        self.assertEqual({action["type"] for action in actions}, {"close_session", "upgrade_plan"})
        self.assertNotIn("api", actions[0])
        self.assertNotIn("authorization", actions[0])
        rendered = f"{raised.exception} {raised.exception.details}"
        self.assertNotIn("runtime-token", rendered)
        self.assertNotIn("download-token", rendered)
        self.assertNotIn("buyer@example.com", rendered)
        self.assertNotIn("paynow-secret", rendered)

    def test_exact_version_and_explicit_rollback_are_reported(self) -> None:
        exact = Fixture().client().create_session(
            platform="windows",
            arch="x64",
            browser_version="150.0.8000.1",
        )
        self.assertEqual(exact.version_policy, "exact")
        self.assertEqual(exact.selection_reason, "exact")
        self.assertEqual(exact.requested_browser_version, "150.0.8000.1")

        rollback = Fixture().client().create_session(
            platform="windows",
            arch="x64",
            browser_version="151.0.0.0",
            version_policy="at-or-before",
        )
        self.assertEqual(rollback.browser_version, "150.0.8000.1")
        self.assertEqual(rollback.selection_reason, "rollback")
        self.assertEqual(
            verify_browser_version_audit({
                "requested": "151.0.0.0",
                "selected": "150.0.8000.1",
                "downloaded": "150.0.8000.1",
                "launched": "150.0.8000.1",
                "policy": "at-or-before",
                "selectionReason": "rollback",
            })["launched"],
            "150.0.8000.1",
        )
        with self.assertRaisesRegex(Exception, "version chain mismatch"):
            verify_browser_version_audit({
                "requested": "150.0.8000.1",
                "selected": "150.0.8000.1",
                "downloaded": "150.0.8000.1",
                "launched": "151.0.0.0",
                "policy": "exact",
                "selectionReason": "exact",
            })

    def test_authorized_playwright_launches_with_version_audit_and_release(self) -> None:
        fixture = Fixture()
        with tempfile.TemporaryDirectory() as directory:
            authorization = fixture.write_authorization(directory)
            runtime = FakeRuntime()
            playwright = FakeFrameworkPlaywright(runtime)
            browser = launch_latest_playwright(
                playwright,
                authorization,
                license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                release_trusted_keys={"release-test": _public(fixture.release_key)},
                transport=fixture.transport,
                artifact_downloader=fixture.download,
                cache_root=directory,
                platform="windows",
                arch="x64",
                framework_version="1.62.0",
                launch_options={"args": ["--no-first-run"]},
            )
            self.assertEqual(browser.license_runtime["versionAudit"]["launched"], "150.0.8000.1")
            reservations_before_context = len(fixture.runtime_session_requests)
            child_context = browser.new_context()
            page = child_context.new_page()
            page.close()
            child_context.close()
            self.assertEqual(runtime.context_count, 1)
            self.assertEqual(child_context.page_count, 1)
            self.assertEqual(len(fixture.runtime_session_requests), reservations_before_context)
            installation = find_current_browser_installation(cache_root=directory, platform="windows", arch="x64")
            self.assertIsNotNone(installation)
            self.assertTrue(is_browser_installation_in_use(installation))  # type: ignore[arg-type]
            self.assertEqual(fixture.releases, 0)
            browser.close()
            self.assertEqual(runtime.close_count, 1)
            self.assertEqual(fixture.releases, 1)
            self.assertFalse(is_browser_installation_in_use(installation))  # type: ignore[arg-type]

            context = FakeContext(FakeRuntime())
            persistent = launch_latest_playwright_persistent(
                FakeFrameworkPlaywright(context),
                Path(directory, "profile"),
                authorization,
                license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                release_trusted_keys={"release-test": _public(fixture.release_key)},
                transport=fixture.transport,
                artifact_downloader=fixture.download,
                cache_root=directory,
                platform="windows",
                arch="x64",
                framework_version="1.62.0",
            )
            self.assertEqual(persistent.license_runtime["versionAudit"]["launched"], "150.0.8000.1")
            persistent_installation = find_current_browser_installation(cache_root=directory, platform="windows", arch="x64")
            self.assertIsNotNone(persistent_installation)
            self.assertTrue(is_browser_installation_in_use(persistent_installation))  # type: ignore[arg-type]
            persistent.close()
            self.assertEqual(context.close_count, 1)
            self.assertEqual(fixture.releases, 2)
            self.assertEqual(fixture.downloads, 1)
            self.assertFalse(is_browser_installation_in_use(persistent_installation))  # type: ignore[arg-type]

    def test_authorized_playwright_rejects_mismatched_runtime_version(self) -> None:
        fixture = Fixture()
        with tempfile.TemporaryDirectory() as directory:
            authorization = fixture.write_authorization(directory)
            runtime = FakeRuntime("151.0.0.0")
            with self.assertRaisesRegex(Exception, "version chain mismatch") as raised:
                launch_latest_playwright(
                    FakeFrameworkPlaywright(runtime),
                    authorization,
                    license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                    release_trusted_keys={"release-test": _public(fixture.release_key)},
                    transport=fixture.transport,
                    artifact_downloader=fixture.download,
                    cache_root=directory,
                    platform="windows",
                    arch="x64",
                    framework_version="1.62.0",
                )
            self.assertEqual(raised.exception.code, "browser_version_chain_mismatch")
            self.assertEqual(runtime.close_count, 1)
            self.assertEqual(fixture.releases, 1)


class LicensedAsyncReleaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_authorized_playwright_async_launches_with_version_audit_and_release(self) -> None:
        fixture = Fixture()
        with tempfile.TemporaryDirectory() as directory:
            authorization = fixture.write_authorization(directory)
            runtime = FakeAsyncRuntime()
            browser = await launch_latest_playwright_async(
                FakeAsyncFrameworkPlaywright(runtime),
                authorization,
                license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                release_trusted_keys={"release-test": _public(fixture.release_key)},
                transport=fixture.transport,
                artifact_downloader=fixture.download,
                cache_root=directory,
                platform="windows",
                arch="x64",
                framework_version="1.62.0",
            )
            self.assertEqual(browser.license_runtime["versionAudit"]["launched"], "150.0.8000.1")
            installation = find_current_browser_installation(cache_root=directory, platform="windows", arch="x64")
            self.assertIsNotNone(installation)
            self.assertTrue(is_browser_installation_in_use(installation))  # type: ignore[arg-type]
            await browser.close()
            self.assertEqual(runtime.close_count, 1)
            self.assertEqual(fixture.releases, 1)
            self.assertFalse(is_browser_installation_in_use(installation))  # type: ignore[arg-type]

            context = FakeAsyncContext(FakeAsyncRuntime())
            persistent = await launch_latest_playwright_persistent_async(
                FakeAsyncFrameworkPlaywright(context),
                Path(directory, "profile"),
                authorization,
                license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                release_trusted_keys={"release-test": _public(fixture.release_key)},
                transport=fixture.transport,
                artifact_downloader=fixture.download,
                cache_root=directory,
                platform="windows",
                arch="x64",
                framework_version="1.62.0",
            )
            self.assertEqual(persistent.license_runtime["versionAudit"]["launched"], "150.0.8000.1")
            await persistent.close()
            self.assertEqual(context.close_count, 1)
            self.assertEqual(fixture.releases, 2)
            self.assertEqual(fixture.downloads, 1)

    async def test_authorized_playwright_async_rejects_mismatched_runtime_version(self) -> None:
        fixture = Fixture()
        with tempfile.TemporaryDirectory() as directory:
            authorization = fixture.write_authorization(directory)
            runtime = FakeAsyncRuntime("151.0.0.0")
            with self.assertRaisesRegex(Exception, "version chain mismatch") as raised:
                await launch_latest_playwright_async(
                    FakeAsyncFrameworkPlaywright(runtime),
                    authorization,
                    license_trusted_keys={"lease-test": _public(fixture.lease_key)},
                    release_trusted_keys={"release-test": _public(fixture.release_key)},
                    transport=fixture.transport,
                    artifact_downloader=fixture.download,
                    cache_root=directory,
                    platform="windows",
                    arch="x64",
                    framework_version="1.62.0",
                )
            self.assertEqual(raised.exception.code, "browser_version_chain_mismatch")
            self.assertEqual(runtime.close_count, 1)
            self.assertEqual(fixture.releases, 1)


if __name__ == "__main__":
    unittest.main()
