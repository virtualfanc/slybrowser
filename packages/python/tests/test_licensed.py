from __future__ import annotations

import hashlib
import io
import json
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from slybrowser.canonical import canonical_json
from slybrowser.errors import LicenseServiceError, ManifestError
from slybrowser.installer import install_granted_browser
from slybrowser.licensed import verify_browser_version_audit
from slybrowser.service import LicenseAuthorization, LicenseServiceClient


def _public(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


class Fixture:
    def __init__(self, *, tamper_manifest: bool = False, session_error: bool = False) -> None:
        self.lease_key = Ed25519PrivateKey.generate()
        self.release_key = Ed25519PrivateKey.generate()
        self.now = int(time.time())
        self.session_id = "00000000-0000-4000-8000-000000000001"
        self.session_token = "session-token"
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
            "features": ["browser", "fingerprint", "humanize", "webdriver"],
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
        self.downloads = 0

    def transport(self, method: str, url: str, _headers: dict[str, str], _body: bytes | None):
        if url.endswith("/v1/licenses/sessions") and method == "POST":
            if self.session_error:
                return 409, json.dumps({"error": {"code": "session_limit", "message": "Limit reached"}}).encode()
            request = json.loads(_body or b"{}")
            policy = request.get("versionPolicy", "latest")
            requested = request.get("browserVersion")
            return 201, json.dumps({
                "schemaVersion": 1,
                "sessionId": self.session_id,
                "sessionToken": self.session_token,
                "heartbeatAfterSeconds": 60,
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
        if method == "DELETE":
            return 204, b""
        raise AssertionError(f"Unexpected request: {method} {url}")

    def download(self, _url: str, headers: dict[str, str], destination: Path) -> None:
        self.downloads += 1
        assert headers["Authorization"] == f"Session {self.session_token}"
        destination.write_bytes(self.artifact)

    def client(self) -> LicenseServiceClient:
        return LicenseServiceClient(
            LicenseAuthorization(
                "https://api.slybrowser.test",
                f"sly_live_00000000-0000-4000-8000-000000000002.{('x' * 43)}",
            ),
            license_trusted_keys={"lease-test": _public(self.lease_key)},
            release_trusted_keys={"release-test": _public(self.release_key)},
            transport=self.transport,
            artifact_downloader=self.download,
        )


def _base64url(value: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class LicensedReleaseTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
