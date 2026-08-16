from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path
from urllib.parse import quote

from slybrowser.webdriver import SlyWebDriverService


def data_url(markup: str) -> str:
    return f"data:text/html;charset=utf-8,{quote(markup)}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", required=True)
    parser.add_argument("--driver", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--headed", action="store_true")
    options = parser.parse_args()
    started = time.perf_counter()
    service = SlyWebDriverService.start(options.driver, command_timeout=3)
    session = None
    try:
        session = service.create_session(
            options.browser,
            arguments=("--force-device-scale-factor=1.5",),
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
        if not consistent or geometry["dpr"] != 1.5 or geometry["clicked"] != 1 or geometry["inputClicks"] != 0 or geometry["typed"] != "python-humanize" or frame_clicked != 1:
            raise AssertionError(f"Python SDK Humanize matrix mismatch: {geometry!r}, frame_clicked={frame_clicked!r}")

        report = {
            "schemaVersion": 1,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": "PASS",
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
        else:
            service.close()


if __name__ == "__main__":
    main()
