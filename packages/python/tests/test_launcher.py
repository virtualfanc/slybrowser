from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from slybrowser.errors import ConfigurationError
from slybrowser.launcher import diagnose_network_alignment, prepare_launch


class LauncherTests(unittest.TestCase):
    def test_handoff_files_exist_only_inside_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            secret = "license-secret-must-not-appear-in-arguments"
            with prepare_launch(
                executable,
                {"headless": True, "profile": {"locale": "en-US"}},
                {"lease": secret},
                temp_root=directory,
                extra_arguments=("--no-first-run",),
                include_driver_lease=True,
            ) as plan:
                self.assertTrue(plan.config_file.is_file())
                self.assertTrue(plan.license_file.is_file())
                self.assertIsNotNone(plan.driver_license_file)
                self.assertTrue(plan.driver_license_file.is_file())  # type: ignore[union-attr]
                self.assertNotIn(secret, " ".join(plan.arguments))
                self.assertIn("--sly-license-file=", " ".join(plan.arguments))
            self.assertFalse(plan.config_file.exists())
            self.assertFalse(plan.license_file.exists())
            self.assertFalse(plan.driver_license_file.exists())  # type: ignore[union-attr]

    def test_license_material_in_extra_argument_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {},
                    {"lease": "test"},
                    extra_arguments=("--license-key=secret",),
                ):
                    pass
            self.assertEqual(raised.exception.code, "license_argument_forbidden")

    def test_license_key_in_profile_handoff_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {"licenseKey": "long-lived-secret"},
                    {"lease": "test"},
                    temp_root=directory,
                ):
                    pass
            self.assertEqual(raised.exception.code, "profile_secret_forbidden")

    def test_proxy_is_fail_closed_and_webrtc_aligned_by_default(self) -> None:
        import json
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with prepare_launch(
                executable,
                {"proxy": {"server": "socks5://127.0.0.1:65534"}},
                {"lease": "test"},
                temp_root=directory,
            ) as plan:
                config = json.loads(plan.config_file.read_text(encoding="utf-8"))
                self.assertTrue(config["proxy"]["failClosed"])
                self.assertEqual(config["webrtc"], "proxy")

            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {"proxy": {"server": "http://127.0.0.1:8080", "failClosed": False}},
                    {"lease": "test"},
                    temp_root=directory,
                ):
                    pass
            self.assertEqual(raised.exception.code, "proxy_fail_closed_required")

    def test_proxy_alignment_applies_one_profile_and_rejects_conflicts(self) -> None:
        import json
        evidence = {
            "source": "proxy-observer",
            "exitIp": "203.0.113.10",
            "observedAt": "2026-08-16T12:00:00Z",
            "locale": "fr-FR",
            "languages": ["fr-FR", "fr"],
            "timezone": "Europe/Paris",
            "geolocation": {"latitude": 48.8566, "longitude": 2.3522, "accuracy": 25},
        }
        options = {"proxy": {"server": "http://127.0.0.1:8080"}, "proxyAlignment": evidence}
        self.assertEqual(diagnose_network_alignment(options)["exitIp"], "203.0.113.10")
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with prepare_launch(executable, options, {"lease": "test"}, temp_root=directory) as plan:
                config = json.loads(plan.config_file.read_text(encoding="utf-8"))
                self.assertNotIn("proxyAlignment", config)
                self.assertEqual(config["locale"], "fr-FR")
                self.assertEqual(config["timezone"], "Europe/Paris")
                self.assertEqual(config["geolocation"]["permission"], "allow")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {**options, "profile": {"locale": "en-US"}},
                    {"lease": "test"},
                    temp_root=directory,
                ):
                    pass
            self.assertEqual(raised.exception.code, "proxy_alignment_conflict")
        self.assertIn(
            "profile.geolocation",
            diagnose_network_alignment({"proxy": {"server": "http://127.0.0.1:8080"}})["missing"],
        )


if __name__ == "__main__":
    unittest.main()
