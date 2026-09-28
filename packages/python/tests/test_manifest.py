from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from slybrowser.canonical import canonical_json, encode_base64url
from slybrowser.errors import ArtifactError, ManifestError
from slybrowser.manifest import is_sdk_compatible, verify_artifact, verify_release_manifest


class ManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.private_key = Ed25519PrivateKey.generate()
        self.public_key = self.private_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )

    def make_manifest(self, artifact_bytes: bytes = b"browser", archive_format: str = "zip") -> dict[str, object]:
        payload: dict[str, object] = {
            "schemaVersion": 1,
            "browserVersion": "123.0.4567.89",
            "sdkCompatibility": ">=0.1.0 <0.2.0",
            "status": "available",
            "artifacts": [
                {
                    "platform": "windows",
                    "arch": "x64",
                    "url": "https://api.slybrowser.com/v1/releases/artifacts/test.zip",
                    "sha256": hashlib.sha256(artifact_bytes).hexdigest(),
                    "size": len(artifact_bytes),
                    "archiveFormat": archive_format,
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
                }
            ],
            "evidence": {
                "sbom": {
                    "url": "https://api.slybrowser.com/v1/releases/evidence/test.sbom.json",
                    "sha256": "0" * 64, "size": 1,
                    "mediaType": "application/vnd.cyclonedx+json",
                },
                "provenance": {
                    "url": "https://api.slybrowser.com/v1/releases/evidence/test.provenance.json",
                    "sha256": "1" * 64, "size": 1,
                    "mediaType": "application/vnd.in-toto+json",
                },
                "chromiumPatchInventory": {
                    "url": "https://api.slybrowser.com/v1/releases/evidence/test.patches.json",
                    "sha256": "2" * 64, "size": 1,
                    "mediaType": "application/vnd.slybrowser.chromium-patch-inventory+json",
                },
                "sourceBoundary": {
                    "sdk": "open-source",
                    "chromiumPatches": "inventory-and-approved-patches",
                    "proprietaryCore": "private",
                },
            },
        }
        payload["signature"] = {
            "algorithm": "ed25519",
            "keyId": "release-test",
            "value": encode_base64url(self.private_key.sign(canonical_json(payload))),
        }
        return payload

    def test_manifest_and_artifact(self) -> None:
        content = b"browser"
        manifest = verify_release_manifest(
            self.make_manifest(content),
            trusted_keys={"release-test": self.public_key},
        )
        artifact = manifest.select("windows", "x64")
        self.assertEqual(manifest.status, "available")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "browser.zip")
            path.write_bytes(content)
            verify_artifact(path, artifact)

    def test_current_7z_release_archive_contract(self) -> None:
        manifest = verify_release_manifest(
            self.make_manifest(archive_format="7z"),
            trusted_keys={"release-test": self.public_key},
        )
        self.assertEqual(manifest.select("windows", "x64").archiveFormat, "7z")

    def test_tampered_manifest_and_artifact_are_rejected(self) -> None:
        document = self.make_manifest()
        document["browserVersion"] = "999.0.0.0"
        with self.assertRaises(ManifestError) as raised:
            verify_release_manifest(document, trusted_keys={"release-test": self.public_key})
        self.assertEqual(raised.exception.code, "manifest_invalid_signature")

        manifest = verify_release_manifest(
            self.make_manifest(),
            trusted_keys={"release-test": self.public_key},
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "browser.zip")
            path.write_bytes(b"tampered")
            with self.assertRaises(ArtifactError):
                verify_artifact(path, manifest.select("windows", "x64"))

    def test_signed_manifest_without_optional_supply_chain_evidence_is_accepted(self) -> None:
        document = self.make_manifest()
        document.pop("evidence")
        document.pop("signature")
        document["signature"] = {
            "algorithm": "ed25519",
            "keyId": "release-test",
            "value": encode_base64url(self.private_key.sign(canonical_json(document))),
        }
        manifest = verify_release_manifest(document, trusted_keys={"release-test": self.public_key})
        self.assertIsNone(manifest.evidence)
        self.assertEqual(manifest.status, "available")

    def test_caret_sdk_compatibility_ranges(self) -> None:
        self.assertTrue(is_sdk_compatible("^0.1.0", "0.1.0"))
        self.assertTrue(is_sdk_compatible("^0.1.0", "0.1.9"))
        self.assertFalse(is_sdk_compatible("^0.1.0", "0.2.0"))
        self.assertTrue(is_sdk_compatible("^1.2.3", "1.9.0"))
        self.assertFalse(is_sdk_compatible("^1.2.3", "2.0.0"))


if __name__ == "__main__":
    unittest.main()
