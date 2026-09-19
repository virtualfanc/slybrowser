from __future__ import annotations

import argparse
import base64
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright
from slybrowser import launch_playwright


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorization-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    started = time.monotonic()
    with sync_playwright() as playwright:
        browser = launch_playwright(
            playwright,
            args.authorization_file,
            {
                "launch": {"headless": not args.headed},
                "humanize": {"enabled": True, "preset": "careful", "seed": 52525},
            },
        )
        try:
            page = browser.new_page()
            page.goto(data_url("<title>sly-python-playwright-ok</title><button id='target'>Target</button>"))
            title = page.title()
            signals = page.evaluate("""() => ({
              webdriver: navigator.webdriver,
              userAgent: navigator.userAgent,
              chromeType: typeof window.chrome,
              dpr: devicePixelRatio,
            })""")
            if title != "sly-python-playwright-ok":
                raise RuntimeError(f"unexpected title {title}")
            if signals.get("webdriver") is True:
                raise RuntimeError("navigator.webdriver is true")
            if signals.get("chromeType") != "object":
                raise RuntimeError(f"window.chrome type is {signals.get('chromeType')}")
            report = {
                "schemaVersion": 1,
                "generatedAt": iso_now(),
                "status": "PASS",
                "language": "python",
                "backend": "playwright",
                "headed": args.headed,
                "browserVersion": browser.license_runtime["browserVersion"],
                "versionAudit": browser.license_runtime["versionAudit"],
                "signals": signals,
                "durationMs": int((time.monotonic() - started) * 1000),
            }
            output = Path(args.output).resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        finally:
            browser.close()
    return 0


def data_url(markup: str) -> str:
    return "data:text/html;charset=utf-8;base64," + base64.b64encode(markup.encode("utf-8")).decode("ascii")


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


if __name__ == "__main__":
    raise SystemExit(main())
