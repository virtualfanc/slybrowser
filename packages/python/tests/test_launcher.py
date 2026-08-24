from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from slybrowser.errors import ConfigurationError
from slybrowser.launcher import diagnose_network_alignment, prepare_launch, wait_for_native_ready


def assert_private_handoff_file(testcase: unittest.TestCase, path: Path) -> None:
    if os.name == "nt":
        output = subprocess.check_output(["icacls", str(path)], text=True, stderr=subprocess.DEVNULL)
        testcase.assertNotIn("(I)", output)
        testcase.assertNotRegex(output, r"\\(?:Users|Everyone):")
        return
    testcase.assertEqual(path.stat().st_mode & 0o077, 0)


class LauncherTests(unittest.TestCase):
    def test_handoff_files_exist_only_inside_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            secret = "license-secret-must-not-appear-in-arguments"
            runtime_secret = "bootstrap-token-must-not-appear-in-arguments"
            driver_runtime_secret = "driver-bootstrap-token-must-not-appear-in-arguments"
            with prepare_launch(
                executable,
                {"headless": True, "profile": {"locale": "en-US"}},
                {"lease": secret},
                temp_root=directory,
                extra_arguments=("--no-first-run",),
                include_driver_lease=True,
                runtime_handoff={"schemaVersion": 2, "bootstrapToken": runtime_secret},
                driver_runtime_handoff={"schemaVersion": 2, "bootstrapToken": driver_runtime_secret},
            ) as plan:
                self.assertTrue(plan.config_file.is_file())
                self.assertTrue(plan.license_file.is_file())
                self.assertIsNotNone(plan.driver_license_file)
                self.assertTrue(plan.driver_license_file.is_file())  # type: ignore[union-attr]
                self.assertIsNotNone(plan.runtime_file)
                self.assertTrue(plan.runtime_file.is_file())  # type: ignore[union-attr]
                self.assertIsNotNone(plan.driver_runtime_file)
                self.assertTrue(plan.driver_runtime_file.is_file())  # type: ignore[union-attr]
                self.assertNotIn(secret, " ".join(plan.arguments))
                self.assertNotIn(runtime_secret, " ".join(plan.arguments))
                self.assertNotIn(driver_runtime_secret, " ".join(plan.arguments))
                self.assertIn(runtime_secret, plan.runtime_file.read_text(encoding="utf-8"))  # type: ignore[union-attr]
                self.assertIn(driver_runtime_secret, plan.driver_runtime_file.read_text(encoding="utf-8"))  # type: ignore[union-attr]
                self.assertIn("--sly-license-file=", " ".join(plan.arguments))
                self.assertIn("--sly-runtime-file=", " ".join(plan.arguments))
                for handoff_file in (
                    plan.config_file,
                    plan.license_file,
                    plan.driver_license_file,
                    plan.runtime_file,
                    plan.driver_runtime_file,
                ):
                    assert_private_handoff_file(self, handoff_file)  # type: ignore[arg-type]
            self.assertFalse(plan.config_file.exists())
            self.assertFalse(plan.license_file.exists())
            self.assertFalse(plan.driver_license_file.exists())  # type: ignore[union-attr]
            self.assertFalse(plan.runtime_file.exists())  # type: ignore[union-attr]
            self.assertFalse(plan.driver_runtime_file.exists())  # type: ignore[union-attr]

    def test_native_ready_request_is_private_and_waits_for_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with prepare_launch(
                executable,
                {},
                {"lease": "test"},
                temp_root=directory,
                native_ready=True,
            ) as plan:
                self.assertIsNotNone(plan.native_ready_request_file)
                self.assertIsNotNone(plan.native_ready_file)
                self.assertIsNotNone(plan.native_ready_nonce)
                self.assertTrue(any(argument.startswith("--sly-native-ready-request-file=") for argument in plan.arguments))
                assert_private_handoff_file(self, plan.native_ready_request_file)  # type: ignore[arg-type]
                assert_private_handoff_file(self, plan.native_ready_file)  # type: ignore[arg-type]
                request = json.loads(plan.native_ready_request_file.read_text(encoding="utf-8"))  # type: ignore[union-attr]
                self.assertEqual(request["readyFile"], str(plan.native_ready_file))
                plan.native_ready_file.write_text(  # type: ignore[union-attr]
                    json.dumps({
                        "schemaVersion": 1,
                        "kind": "slybrowser.native-ready",
                        "ready": True,
                        "nonce": request["nonce"],
                    }),
                    encoding="utf-8",
                )
                wait_for_native_ready(plan, timeout=0.1)
            self.assertFalse(plan.native_ready_request_file.exists())  # type: ignore[union-attr]
            self.assertFalse(plan.native_ready_file.exists())  # type: ignore[union-attr]

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
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {},
                    {"lease": "test"},
                    extra_arguments=("--sly-runtime-token=secret",),
                ):
                    pass
            self.assertEqual(raised.exception.code, "license_argument_forbidden")

    def test_post_activation_runtime_secrets_are_rejected_from_runtime_handoff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {},
                    {"lease": "test"},
                    temp_root=directory,
                    runtime_handoff={"schemaVersion": 2, "runtimeToken": "must-stay-native"},
                ):
                    pass
            self.assertEqual(raised.exception.code, "runtime_handoff_secret_forbidden")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {},
                    {"lease": "test"},
                    temp_root=directory,
                    runtime_handoff={"schemaVersion": 2, "activationTicket": "activation-secret"},
                ):
                    pass
            self.assertEqual(raised.exception.code, "runtime_handoff_secret_forbidden")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {},
                    {"lease": "test"},
                    temp_root=directory,
                    runtime_handoff={"schemaVersion": 2, "downloadTicket": {"token": "download-secret"}},
                ):
                    pass
            self.assertEqual(raised.exception.code, "runtime_handoff_secret_forbidden")

    def test_runtime_text_in_non_secret_argument_value_is_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            with prepare_launch(
                executable,
                {},
                {"lease": "test"},
                temp_root=directory,
                extra_arguments=("--enable-features=RuntimeCallStats",),
            ) as plan:
                self.assertIn("--enable-features=RuntimeCallStats", plan.arguments)

    def test_release_root_is_passed_as_non_secret_argument(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "SlyBrowser.exe")
            executable.write_bytes(b"test")
            release_root = Path(directory, "release-root")
            with prepare_launch(
                executable,
                {},
                {"lease": "test"},
                temp_root=directory,
                release_root=release_root,
            ) as plan:
                self.assertEqual(plan.release_root, release_root.resolve())
                self.assertIn(f"--sly-release-root={release_root.resolve()}", plan.arguments)

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
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {"runtimeToken": "short-lived-secret"},
                    {"lease": "test"},
                    temp_root=directory,
                ):
                    pass
            self.assertEqual(raised.exception.code, "profile_secret_forbidden")
            with self.assertRaises(ConfigurationError) as raised:
                with prepare_launch(
                    executable,
                    {"activationTicket": "activation-secret"},
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
