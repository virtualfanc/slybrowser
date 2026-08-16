from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from slybrowser.errors import ConfigurationError, WebDriverError
from slybrowser.webdriver import (
    SlyWebDriverSession,
    build_webdriver_session_payload,
    default_driver_executable,
    describe_default_driver,
    resolve_humanize_config,
    validate_webdriver_capabilities,
    cdp_debugger_address,
    fetch_cdp_discovery,
)


class _RecordingService:
    executable = Path("recording-driver.exe").resolve()

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, object]] = []

    def request(self, method: str, path: str, body: object = None) -> object:
        self.calls.append((method, path, body))
        if path.endswith("/execute/sync"):
            return {"x": 10, "y": 20, "width": 120, "height": 30}
        if path.endswith("/execute/async"):
            return "async-result"
        if path.endswith("/log"):
            return []
        if method == "POST" and path.endswith("/webauthn/authenticator"):
            return "authenticator-id"
        if method == "GET" and path.endswith("/credentials"):
            return []
        if method == "POST" and path.endswith("/window/new"):
            return {"handle": "tab-2", "type": "tab"}
        if method == "GET" and path.endswith("/window/handles"):
            return ["tab-1", "tab-2"]
        if method == "DELETE" and path.endswith("/window"):
            return ["tab-1"]
        if method == "GET" and path.endswith("/alert/text"):
            return "confirm text"
        return None


class DefaultWebDriverTests(unittest.TestCase):
    def test_resolves_explicit_environment_and_sibling_driver(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            browser = Path(directory, "SlyBrowser.exe").resolve()
            sibling = browser.parent / ("chromedriver.exe" if os.name == "nt" else "chromedriver")
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("SLYBROWSER_WEBDRIVER_PATH", None)
                self.assertEqual(default_driver_executable(browser), sibling)
                configured = Path(directory, "configured-driver.exe")
                os.environ["SLYBROWSER_WEBDRIVER_PATH"] = str(configured)
                self.assertEqual(default_driver_executable(browser), configured.resolve())
                explicit = Path(directory, "explicit-driver.exe")
                self.assertEqual(default_driver_executable(browser, explicit), explicit.resolve())
                self.assertEqual(describe_default_driver(browser)["backend"], "project-webdriver")

    def test_session_payload_uses_exact_browser_and_secure_handoff(self) -> None:
        payload = build_webdriver_session_payload(
            "D:/build/SlyBrowser.exe",
            handoff_arguments=(
                "--sly-config-file=D:/temp/config.json",
                "--sly-license-file=D:/temp/lease.json",
            ),
            arguments=("--lang=en-US",),
            headless=False,
            profile_dir="D:/profiles/test",
            humanize=True,
            human_preset="careful",
            human_seed=42424,
        )
        options = payload["capabilities"]["alwaysMatch"]["goog:chromeOptions"]
        sly_options = payload["capabilities"]["alwaysMatch"]["sly:options"]
        self.assertEqual(
            sly_options["humanize"],
            {"enabled": True, "preset": "careful", "seed": 42424},
        )
        self.assertEqual(options["binary"], str(Path("D:/build/SlyBrowser.exe").resolve()))
        self.assertIn("--sly-license-file=D:/temp/lease.json", options["args"])
        self.assertIn("--lang=en-US", options["args"])
        self.assertNotIn("--headless=new", options["args"])
        self.assertEqual(
            options["excludeSwitches"],
            ["enable-automation", "enable-unsafe-swiftshader"],
        )

    def test_persistent_and_ephemeral_profile_semantics_are_explicit(self) -> None:
        with self.assertRaises(ConfigurationError) as persistent:
            build_webdriver_session_payload("SlyBrowser.exe", profile_mode="persistent")
        self.assertEqual(persistent.exception.code, "persistent_profile_dir_required")
        with self.assertRaises(ConfigurationError) as ephemeral:
            build_webdriver_session_payload(
                "SlyBrowser.exe",
                profile_mode="ephemeral",
                profile_dir="profile-that-must-not-persist",
            )
        self.assertEqual(ephemeral.exception.code, "ephemeral_profile_dir_forbidden")

    def test_version_match_is_mandatory(self) -> None:
        versions = validate_webdriver_capabilities({
            "browserVersion": "148.0.7778.179",
            "chrome": {"chromedriverVersion": "148.0.7778.179 (abcdef)"},
        })
        self.assertEqual(versions.browser_major, 148)
        with self.assertRaisesRegex(WebDriverError, "different major versions"):
            validate_webdriver_capabilities({
                "browserVersion": "148.0.7778.179",
                "chrome": {"chromedriverVersion": "149.0.1.0"},
            })

    def test_standard_cdp_discovery_is_loopback_only(self) -> None:
        import io

        capabilities = {"goog:chromeOptions": {"debuggerAddress": "127.0.0.1:9222"}}
        self.assertEqual(cdp_debugger_address(capabilities), "127.0.0.1:9222")

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                self.close()

        discovery = fetch_cdp_discovery(
            capabilities,
            opener=lambda _url: Response(b'{"Browser":"SlyBrowser/148"}'),
        )
        self.assertEqual(discovery["Browser"], "SlyBrowser/148")
        with self.assertRaisesRegex(WebDriverError, "loopback"):
            cdp_debugger_address({"goog:chromeOptions": {"debuggerAddress": "192.0.2.10:9222"}})

    def test_mobile_persona_is_one_chromedriver_emulation_contract(self) -> None:
        persona = {
            "userAgent": "Mozilla/5.0 Mobile SlyBrowser/148",
            "deviceMetrics": {"width": 390, "height": 844, "pixelRatio": 3, "mobile": True, "touch": True},
            "clientHints": {"platform": "Android", "mobile": True, "platformVersion": "15.0.0"},
        }
        payload = build_webdriver_session_payload("D:/build/SlyBrowser.exe", mobile_persona=persona)
        options = payload["capabilities"]["alwaysMatch"]["goog:chromeOptions"]
        self.assertEqual(options["mobileEmulation"], persona)
        self.assertIn("--window-size=390,844", options["args"])

    def test_webauthn_uses_standard_webdriver_endpoints(self) -> None:
        service = _RecordingService()
        session = SlyWebDriverSession(
            service,  # type: ignore[arg-type]
            "session-id",
            {
                "browserVersion": "148.0.7778.179",
                "chrome": {"chromedriverVersion": "148.0.7778.179 (abcdef)"},
            },
            "SlyBrowser.exe",
        )
        authenticator_id = session.add_virtual_authenticator()
        self.assertEqual(authenticator_id, "authenticator-id")
        self.assertEqual(session.virtual_credentials(authenticator_id), [])
        session.remove_virtual_authenticator(authenticator_id)
        self.assertTrue(any(
            method == "DELETE" and path == "/session/session-id/webauthn/authenticator/authenticator-id"
            for method, path, _body in service.calls
        ))

    def test_window_frame_and_dialog_use_w3c_endpoints(self) -> None:
        service = _RecordingService()
        session = SlyWebDriverSession(
            service,  # type: ignore[arg-type]
            "session-id",
            {"browserVersion": "148.0.7778.179", "chrome": {"chromedriverVersion": "148.0.7778.179"}},
            "SlyBrowser.exe",
        )
        self.assertEqual(session.new_window(), {"handle": "tab-2", "type": "tab"})
        session.switch_to_window("tab-2")
        session.switch_to_frame(None)
        session.switch_to_parent_frame()
        self.assertEqual(session.alert_text(), "confirm text")
        session.dismiss_alert()
        self.assertEqual(session.close_window(), ["tab-1"])
        endpoints = {(method, path) for method, path, _body in service.calls}
        self.assertIn(("POST", "/session/session-id/window/new"), endpoints)
        self.assertIn(("POST", "/session/session-id/frame/parent"), endpoints)
        self.assertIn(("POST", "/session/session-id/alert/dismiss"), endpoints)

    def test_async_script_and_browser_logs_use_standard_endpoints(self) -> None:
        service = _RecordingService()
        session = SlyWebDriverSession(
            service,  # type: ignore[arg-type]
            "session-id",
            {"browserVersion": "148.0.7778.179", "chrome": {"chromedriverVersion": "148.0.7778.179"}},
            "SlyBrowser.exe",
        )
        self.assertEqual(session.execute_async_script("arguments[arguments.length - 1]('ok')"), "async-result")
        self.assertEqual(session.browser_logs(), [])
        self.assertIn(("POST", "/session/session-id/execute/async", {
            "script": "arguments[arguments.length - 1]('ok')", "args": [],
        }), service.calls)
        self.assertIn(("POST", "/session/session-id/log", {"type": "browser"}), service.calls)

    def test_humanize_config_accepts_shared_camel_case_contract(self) -> None:
        config = resolve_humanize_config("careful", {"keyDelayMin": 70})
        self.assertEqual(config.key_delay_min, 70)
        self.assertGreaterEqual(config.mouse_steps_min, 6)
        with self.assertRaises(ConfigurationError):
            resolve_humanize_config("fastest")

    def test_humanize_is_delegated_to_project_webdriver(self) -> None:
        service = _RecordingService()
        session = SlyWebDriverSession(
            service,  # type: ignore[arg-type]
            "session-id",
            {
                "browserVersion": "148.0.7778.179",
                "chrome": {"chromedriverVersion": "148.0.7778.179 (abcdef)"},
                "sly:features": {
                    "humanize": {"enabled": True, "version": 1, "preset": "careful"}
                },
            },
            "D:/build/SlyBrowser.exe",
            humanize=True,
            human_config={
                "mouseStepsMin": 6,
                "mouseStepsMax": 6,
                "mouseStepDelayMin": 0,
                "mouseStepDelayMax": 0,
                "clickHoldMin": 0,
                "clickHoldMax": 0,
                "thinkDelayMin": 0,
                "thinkDelayMax": 0,
            },
            human_seed=148,
        )

        session.click_element("button-id")
        session.type_into_element("input-id", "abc", clear=False)

        self.assertIn(("POST", "/session/session-id/element/button-id/click", {}), service.calls)
        self.assertIn(
            ("POST", "/session/session-id/element/input-id/value", {"text": "abc", "value": ["a", "b", "c"]}),
            service.calls,
        )
        self.assertNotIn(("POST", "/session/session-id/element/input-id/click", {}), service.calls)
        self.assertFalse(any(call[1].endswith("/actions") for call in service.calls))

    def test_humanize_fails_closed_when_driver_does_not_advertise_it(self) -> None:
        with self.assertRaises(WebDriverError) as raised:
            SlyWebDriverSession(
                _RecordingService(),  # type: ignore[arg-type]
                "session-id",
                {
                    "browserVersion": "148.0.7778.179",
                    "chrome": {"chromedriverVersion": "148.0.7778.179 (abcdef)"},
                },
                "D:/build/SlyBrowser.exe",
                humanize=True,
            )
        self.assertEqual(raised.exception.code, "humanize_not_supported")


if __name__ == "__main__":
    unittest.main()
