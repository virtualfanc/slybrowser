from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path

from slybrowser.browser import (
    launch_playwright,
    launch_playwright_async,
    launch_playwright_persistent,
)


class FakeChromium:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []

    def launch(self, *args: object, **kwargs: object) -> object:
        self._assert_handoff_exists(kwargs)
        self.calls.append(("launch", args, kwargs))
        return {"browser": "sync"}

    async def launch_async(self, *args: object, **kwargs: object) -> object:
        self._assert_handoff_exists(kwargs)
        self.calls.append(("launch", args, kwargs))
        return {"browser": "async"}

    def launch_persistent_context(self, *args: object, **kwargs: object) -> object:
        self._assert_handoff_exists(kwargs)
        self.calls.append(("persistent", args, kwargs))
        return {"context": "sync"}

    @staticmethod
    def _assert_handoff_exists(kwargs: dict[str, object]) -> None:
        arguments = kwargs["args"]
        assert isinstance(arguments, list)
        paths = [item.split("=", 1)[1] for item in arguments if item.startswith("--sly-")]
        assert len(paths) in {2, 3}
        assert all(Path(path).is_file() for path in paths)

    @staticmethod
    def _write_native_ready(kwargs: dict[str, object]) -> None:
        arguments = kwargs["args"]
        assert isinstance(arguments, list)
        request_paths = [item.split("=", 1)[1] for item in arguments if item.startswith("--sly-native-ready-request-file=")]
        assert len(request_paths) == 1
        request = json.loads(Path(request_paths[0]).read_text(encoding="utf-8"))
        Path(request["readyFile"]).write_text(
            json.dumps({
                "schemaVersion": 1,
                "kind": "slybrowser.native-ready",
                "ready": True,
                "nonce": request["nonce"],
            }),
            encoding="utf-8",
        )


class AsyncChromium(FakeChromium):
    async def launch(self, *args: object, **kwargs: object) -> object:
        return await self.launch_async(*args, **kwargs)


class FakePlaywright:
    def __init__(self, chromium: FakeChromium | None = None) -> None:
        self.chromium = chromium or FakeChromium()


class BrowserAdapterTests(unittest.TestCase):
    def test_sync_and_persistent_launch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            playwright = FakePlaywright()
            result = launch_playwright(
                playwright,
                executable,
                {"lease": "secret"},
                profile={"locale": "en-US"},
                launch_options={"headless": True, "args": ["--no-first-run"]},
                temp_root=directory,
                framework_version="1.62.0",
            )
            self.assertEqual(result, {"browser": "sync"})
            call = playwright.chromium.calls[-1]
            self.assertEqual(call[2]["headless"], True)
            self.assertEqual(call[2]["args"][-1], "--no-first-run")
            self.assertFalse(any(Path(directory).glob("sly-*.json")))

            result = launch_playwright_persistent(
                playwright,
                Path(directory, "profile"),
                executable,
                {"lease": "secret"},
                temp_root=directory,
                framework_version="1.62.0",
            )
            self.assertEqual(result, {"context": "sync"})
            self.assertEqual(playwright.chromium.calls[-1][0], "persistent")

    def test_async_launch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            playwright = FakePlaywright(AsyncChromium())
            result = asyncio.run(
                launch_playwright_async(
                    playwright,
                    executable,
                    {"lease": "secret"},
                    temp_root=directory,
                    framework_version="1.62.0",
                )
            )
            self.assertEqual(result, {"browser": "async"})
            self.assertFalse(any(Path(directory).glob("sly-*.json")))

    def test_runtime_handoff_reaches_playwright_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            playwright = FakePlaywright()
            result = launch_playwright(
                playwright,
                executable,
                {"lease": "secret"},
                temp_root=directory,
                framework_version="1.62.0",
                runtime_handoff={
                    "schemaVersion": 2,
                    "serviceUrl": "https://api.slybrowser.com",
                    "state": "reserved",
                    "startupId": "st_abcdefghijklmnop",
                    "sessionId": "session-test",
                    "bootstrapToken": "bootstrap_token_abcdefghijklmnopqrstuvwxyz",
                    "heartbeatAfterSeconds": 300,
                    "expiresAt": 2000000300,
                    "browserVersion": "150.0.0.0",
                    "plan": "basic",
                    "concurrencyLimit": 5,
                    "activeSessions": 1,
                    "automationBackend": "playwright",
                },
            )
            self.assertEqual(result, {"browser": "sync"})
            arguments = playwright.chromium.calls[-1][2]["args"]
            self.assertIsInstance(arguments, list)
            self.assertTrue(any(str(argument).startswith("--sly-runtime-file=") for argument in arguments))
            self.assertFalse(any(Path(directory).glob("sly-*.json")))

    def test_version_rejection_and_native_humanize_control_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            playwright = FakePlaywright()
            with self.assertRaisesRegex(Exception, "Unsupported Playwright version") as version_error:
                launch_playwright(
                    playwright,
                    executable,
                    {"lease": "secret"},
                    temp_root=directory,
                    framework_version="1.61.0",
                )
            self.assertEqual(version_error.exception.code, "framework_version_unsupported")
            result = launch_playwright(
                playwright,
                executable,
                {"lease": "secret"},
                temp_root=directory,
                framework_version="1.62.0",
                humanize=True,
                human_preset="careful",
                human_seed=42424,
            )
            self.assertEqual(result, {"browser": "sync"})
            arguments = playwright.chromium.calls[-1][2]["args"]
            self.assertIsInstance(arguments, list)
            self.assertTrue(any(str(argument).startswith("--sly-humanize-config=") for argument in arguments))
            self.assertFalse(any(Path(directory).glob("sly-*.json")))

    def test_native_ready_is_observed_before_returning(self) -> None:
        events: list[str] = []

        class NativeReadyChromium(FakeChromium):
            def launch(self, *args: object, **kwargs: object) -> object:
                self._assert_handoff_exists(kwargs)
                self.calls.append(("launch", args, kwargs))
                events.append("launch-returned")
                threading.Timer(0.025, lambda: (self._write_native_ready(kwargs), events.append("native-ready"))).start()
                return {"browser": "sync"}

        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            playwright = FakePlaywright(NativeReadyChromium())
            result = launch_playwright(
                playwright,
                executable,
                {"lease": "secret"},
                temp_root=directory,
                framework_version="1.62.0",
                native_ready=True,
                native_ready_timeout=1,
            )
            events.append("adapter-returned")
            self.assertEqual(result, {"browser": "sync"})
            self.assertEqual(events, ["launch-returned", "native-ready", "adapter-returned"])
            self.assertFalse(any(Path(directory).glob("sly-*.json")))

    def test_native_ready_timeout_closes_runtime(self) -> None:
        class ClosableRuntime:
            closed = False

            def close(self) -> None:
                self.closed = True

        class NeverReadyChromium(FakeChromium):
            runtime = ClosableRuntime()

            def launch(self, *args: object, **kwargs: object) -> object:
                self._assert_handoff_exists(kwargs)
                self.calls.append(("launch", args, kwargs))
                return self.runtime

        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory, "browser.exe")
            executable.write_bytes(b"test")
            chromium = NeverReadyChromium()
            playwright = FakePlaywright(chromium)
            with self.assertRaisesRegex(Exception, "native-ready") as raised:
                launch_playwright(
                    playwright,
                    executable,
                    {"lease": "secret"},
                    temp_root=directory,
                    framework_version="1.62.0",
                    native_ready=True,
                    native_ready_timeout=0.02,
                )
            self.assertEqual(raised.exception.code, "native_ready_timeout")
            self.assertTrue(chromium.runtime.closed)


if __name__ == "__main__":
    unittest.main()
