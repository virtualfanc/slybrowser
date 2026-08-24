from __future__ import annotations

import json
import unittest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from slybrowser.canonical import canonical_json, encode_base64url
from slybrowser.errors import LicenseError
from slybrowser.license import LicenseVerifier


NOW = 1_800_000_000


class LicenseVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.private_key = Ed25519PrivateKey.generate()
        self.public_key = self.private_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
        self.verifier = LicenseVerifier({"test-1": self.public_key}, now=lambda: NOW)

    def make_envelope(self, **updates: object) -> dict[str, str]:
        claims = {
            "schemaVersion": 1,
            "licenseId": "lic_test",
            "audience": "slybrowser",
            "issuedAt": NOW - 10,
            "notBefore": NOW - 10,
            "expiresAt": NOW + 300,
            "browserMin": "123.0.0.0",
            "browserMax": "123.9999.9999.9999",
            "planId": "launch",
            "concurrencyLimit": 5,
            "features": ["profiles", "proxy"],
            "sessionId": "session_test",
            "nonce": "nonce_test",
            "deviceHash": "device_test",
        }
        claims.update(updates)
        payload = canonical_json(claims)
        return {
            "algorithm": "Ed25519",
            "keyId": "test-1",
            "payload": encode_base64url(payload),
            "signature": encode_base64url(self.private_key.sign(payload)),
        }

    def test_valid_lease(self) -> None:
        claims = self.verifier.verify(
            self.make_envelope(),
            browser_version="123.0.4567.89",
            required_features=("profiles",),
            device_hash="device_test",
        )
        self.assertEqual(claims.license_id, "lic_test")
        self.assertEqual(claims.plan_id, "launch")
        self.assertEqual(claims.concurrency_limit, 5)
        self.assertEqual(claims.features, ("profiles", "proxy"))

    def test_v2_lease_with_signed_artifact_state(self) -> None:
        artifact = {
            "sha256": "a" * 64,
            "platform": "windows",
            "arch": "x64",
            "archiveFormat": "zip",
            "browserExecutable": "SlyBrowser.exe",
            "driverExecutable": "chromedriver.exe",
            "browserSha256": "b" * 64,
            "driverSha256": "c" * 64,
            "privateModules": [{"path": "SlyBrowser/sly_private_module.dll", "sha256": "d" * 64, "size": 14, "abi": "windows-x64"}],
            "resources": [{"path": "SlyBrowser/resources.pak", "sha256": "e" * 64, "size": 9}],
            "codeSignature": {
                "scheme": "authenticode",
                "subject": "CN=SlyBrowser Test Publisher",
                "certificateSha256": "f" * 64,
                "timestampRequired": True,
            },
        }
        claims = self.verifier.verify(
            self.make_envelope(
                schemaVersion=2,
                browserVersion="123.0.4567.89",
                browserMin="123.0.4567.89",
                browserMax="123.0.4567.89",
                artifactSha256=artifact["sha256"],
                browserSha256=artifact["browserSha256"],
                driverSha256=artifact["driverSha256"],
                artifact=artifact,
                leaseGeneration=NOW + 300,
            ),
            browser_version="123.0.4567.89",
            required_features=("profiles",),
            device_hash="device_test",
        )
        self.assertEqual(claims.schema_version, 2)
        self.assertEqual(claims.browser_version, "123.0.4567.89")
        self.assertEqual(claims.artifact["privateModules"][0]["abi"], "windows-x64")  # type: ignore[index]

    def test_tampered_payload_is_rejected(self) -> None:
        envelope = self.make_envelope()
        payload = json.loads(__import__("base64").urlsafe_b64decode(envelope["payload"] + "=="))
        payload["features"].append("admin")
        envelope["payload"] = encode_base64url(canonical_json(payload))
        with self.assertRaisesRegex(LicenseError, "signature") as raised:
            self.verifier.verify(envelope, browser_version="123.0.4567.89")
        self.assertEqual(raised.exception.code, "license_invalid_signature")

    def test_expired_lease_is_rejected(self) -> None:
        envelope = self.make_envelope(issuedAt=NOW - 400, notBefore=NOW - 400, expiresAt=NOW - 40)
        with self.assertRaises(LicenseError) as raised:
            self.verifier.verify(envelope, browser_version="123.0.4567.89")
        self.assertEqual(raised.exception.code, "license_expired")

    def test_wrong_browser_and_feature_are_rejected(self) -> None:
        with self.assertRaises(LicenseError) as raised:
            self.verifier.verify(self.make_envelope(), browser_version="149.0.0.0")
        self.assertEqual(raised.exception.code, "license_browser_unsupported")
        with self.assertRaises(LicenseError) as raised:
            self.verifier.verify(
                self.make_envelope(),
                browser_version="123.0.0.0",
                required_features=("enterprise",),
            )
        self.assertEqual(raised.exception.code, "license_feature_denied")

    def test_unknown_key_and_algorithm_downgrade_are_rejected(self) -> None:
        unknown = self.make_envelope()
        unknown["keyId"] = "unknown"
        with self.assertRaises(LicenseError) as raised:
            self.verifier.verify(unknown, browser_version="123.0.0.0")
        self.assertEqual(raised.exception.code, "license_key_unknown")
        downgraded = self.make_envelope()
        downgraded["algorithm"] = "HS256"
        with self.assertRaises(LicenseError) as raised:
            self.verifier.verify(downgraded, browser_version="123.0.0.0")
        self.assertEqual(raised.exception.code, "license_algorithm_unsupported")


if __name__ == "__main__":
    unittest.main()
