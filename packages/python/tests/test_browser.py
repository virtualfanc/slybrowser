from __future__ import annotations

import asyncio
import tempfile
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
        assert len(paths) == 2
        assert all(Path(path).is_file() for path in paths)


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
                )
            )
            self.assertEqual(result, {"browser": "async"})
            self.assertFalse(any(Path(directory).glob("sly-*.json")))


if __name__ == "__main__":
    unittest.main()
