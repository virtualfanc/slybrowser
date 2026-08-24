from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote

from slybrowser.licensed import launch_authorized
from slybrowser.webdriver import SlyWebDriverService


def data_url(markup: str) -> str:
    return f"data:text/html;charset=utf-8,{quote(markup)}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--license")
    parser.add_argument("--authorization-file")
    parser.add_argument("--cache-root")
    parser.add_argument("--license-key-id")
    parser.add_argument("--license-public-key-hex")
    parser.add_argument("--release-key-id")
    parser.add_argument("--release-public-key-base64url")
    parser.add_argument("--headed", action="store_true")
    options = parser.parse_args()
    if options.authorization_file:
        for name in (
            "cache_root",
            "license_key_id",
            "license_public_key_hex",
            "release_key_id",
            "release_public_key_base64url",
        ):
            if getattr(options, name) is None:
                raise ValueError(f"--{name.replace('_', '-')} is required with --authorization-file")
    elif not options.license:
        raise ValueError("--license is required unless --authorization-file is used")
    started = time.perf_counter()
    handoff = tempfile.TemporaryDirectory(prefix="sly-python-humanize-")
    service = None
    session = None
    try:
        if options.authorization_file:
            session = launch_authorized(
                options.authorization_file,
                license_trusted_keys={options.license_key_id: bytes.fromhex(options.license_public_key_hex)},
                release_trusted_keys={
                    options.release_key_id: base64url_decode(options.release_public_key_base64url)
                },
                cache_root=options.cache_root,
                platform="windows",
                arch="x64",
                update_kernel=False,
                arguments=("--force-device-scale-factor=1.5",),
                headless=not options.headed,
                viewport=(800, 600),
                humanize=True,
                human_preset="careful",
                human_seed=42424,
                native_ready=True,
            )
        else:
            lease = Path(options.license).resolve().read_bytes()
            if not 1 <= len(lease) <= 65_536:
                raise ValueError("Signed test lease must contain between 1 and 65536 bytes")
            browser_license = Path(handoff.name, "browser-license.json")
            driver_license = Path(handoff.name, "driver-license.json")
            browser_license.write_bytes(lease)
            driver_license.write_bytes(lease)
            protect_windows_handoff_file(browser_license)
            protect_windows_handoff_file(driver_license)
            service = SlyWebDriverService.start(options.driver, command_timeout=3, license_file=driver_license)
            session = service.create_session(
                options.browser,
                arguments=(f"--sly-license-file={browser_license}", "--force-device-scale-factor=1.5"),
                headless=not options.headed,
                viewport=(800, 600),
                humanize=True,
                human_preset="careful",
                human_seed=42424,
            )
        session.set_timeouts(script=3_000, page_load=10_000, implicit=0)
        session.get(data_url("""
          <input id="name" style="position:absolute;left:40px;top:40px;width:240px;height:40px" onclick="window.inputClicks=(window.inputClicks||0)+1">
          <button id="target" style="position:absolute;left:420px;top:260px;width:220px;height:90px" onclick="window.clicked=(window.clicked||0)+1">Target</button>
          <iframe id="test-frame" style="position:absolute;left:80px;top:380px;width:500px;height:180px"
            srcdoc="<button id='frame-target' style='position:absolute;left:120px;top:40px;width:180px;height:70px' onclick='window.clicked=(window.clicked||0)+1'>Frame target</button>"></iframe>
        """))

        field = session.find_element("#name")
        field.type("python-humanize")
        target = session.find_element("#target")
        target.click()
        geometry = session.execute_script("""
          const target = document.querySelector('#target');
          const bounding = target.getBoundingClientRect();
          const client = target.getClientRects()[0];
          return {
            dpr: devicePixelRatio,
            bounding: {x: bounding.x, y: bounding.y, width: bounding.width, height: bounding.height},
            client: {x: client.x, y: client.y, width: client.width, height: client.height},
            clicked: window.clicked || 0,
            inputClicks: window.inputClicks || 0,
            typed: document.querySelector('#name').value,
          };
        """)

        frame = session.find_element("#test-frame")
        session.switch_to_frame(frame)
        frame_target = session.find_element("#frame-target")
        frame_target.click()
        frame_clicked = session.execute_script("return window.clicked || 0")
        session.switch_to_parent_frame()
        session.perform_actions([{
            "type": "pointer",
            "id": "python-sdk-pointer",
            "parameters": {"pointerType": "mouse"},
            "actions": [
                {"type": "pointerMove", "duration": 20, "x": 40, "y": 40, "origin": "viewport"},
                {"type": "pointerMove", "duration": 20, "x": 180, "y": 120, "origin": "viewport"},
            ],
        }])

        assert isinstance(geometry, dict)
        consistent = all(abs(geometry["bounding"][name] - geometry["client"][name]) <= 0.01 for name in ("x", "y", "width", "height"))
        checks = {
            "page": True,
            "frame": frame_clicked == 1,
            "elementClick": geometry["clicked"] == 1,
            "elementType": geometry["typed"] == "python-humanize",
            "noPreparatoryClickForTyping": geometry["inputClicks"] == 0,
            "dpi": geometry["dpr"] == 1.5,
            "geometry": consistent,
        }
        score = sum(1 for passed in checks.values() if passed) / len(checks) * 100
        if score != 100:
            raise AssertionError(f"Python SDK Humanize matrix mismatch: {geometry!r}, frame_clicked={frame_clicked!r}")

        report = {
            "schemaVersion": 1,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "PASS",
            "score": score,
            "checks": checks,
            "runtime": {"python": platform.python_version(), "implementation": platform.python_implementation(), "platform": sys.platform},
            "matrix": {"sdk": "python", "headed": options.headed, "page": True, "frame": True, "elementClick": True, "elementType": True, "dpi": 1.5, "commandTimeoutMs": 3_000},
            "geometry": geometry,
            "frameClicked": frame_clicked,
            "durationMs": round((time.perf_counter() - started) * 1000),
        }
        output = Path(options.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"PASS Python SDK Native Humanize ({report['durationMs']} ms)")
        print(f"artifact: {output}")
    finally:
        if session is not None:
            session.close()
        elif service is not None:
            service.close()
        handoff.cleanup()


def protect_windows_handoff_file(path: Path) -> None:
    if os.name != "nt":
        return
    identity = subprocess.check_output(["whoami"], text=True, stderr=subprocess.DEVNULL).strip()
    if not identity:
        raise RuntimeError("Unable to determine current Windows identity for handoff ACL")
    subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(F)"],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def base64url_decode(value: str) -> bytes:
    import base64

    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


if __name__ == "__main__":
    main()
