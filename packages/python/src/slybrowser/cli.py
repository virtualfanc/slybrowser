"""Small diagnostic CLI; browser installation and launch commands follow later."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .licensed import prepare_latest_authorized_browser
from .webdriver import default_driver_executable


def _trusted_keys(name: str) -> dict[str, bytes]:
    import base64
    import os

    raw = os.environ.get(name)
    if not raw:
        raise ValueError(f"{name} is required")
    document = json.loads(raw)
    if not isinstance(document, dict) or not document:
        raise ValueError(f"{name} must contain at least one key")
    result: dict[str, bytes] = {}
    for key_id, value in document.items():
        if not isinstance(key_id, str) or not isinstance(value, str):
            raise ValueError(f"{name} entries must be base64url strings")
        try:
            key = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        except ValueError as error:
            raise ValueError(f"{name}.{key_id} is invalid") from error
        if len(key) != 32:
            raise ValueError(f"{name}.{key_id} must contain a raw 32-byte Ed25519 public key")
        result[key_id] = key
    return result


def _doctor(browser: str | None, driver: str | None) -> int:
    checks = {
        "sdkVersion": __version__,
        "python": sys.version.split()[0],
        "browser": None,
        "browserExists": False,
        "defaultBackend": "project-webdriver",
        "driver": None,
        "driverExists": False,
    }
    if browser:
        resolved = Path(browser).expanduser().resolve()
        checks["browser"] = str(resolved)
        checks["browserExists"] = resolved.is_file()
        resolved_driver = default_driver_executable(resolved, driver)
        checks["driver"] = str(resolved_driver)
        checks["driverExists"] = resolved_driver.is_file()
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    return 0 if browser is None or checks["browserExists"] and checks["driverExists"] else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="slybrowser")
    parser.add_argument("--version", action="version", version=__version__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    doctor = subparsers.add_parser("doctor", help="print sanitized SDK diagnostics")
    doctor.add_argument("--browser", help="optional browser executable to verify")
    doctor.add_argument("--driver", help="optional project WebDriver executable; defaults beside browser")
    install = subparsers.add_parser("install", help="download and verify the latest authorized Stable browser")
    install.add_argument("--authorization", required=True, help="authorization JSON file")
    install.add_argument("--cache", help="optional cache directory")
    install.add_argument("--version", help="exact browser version to install")
    install.add_argument("--rollback", action="store_true", help="select the newest authorized version at or before --version")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "doctor":
        return _doctor(args.browser, args.driver)
    if args.command == "install":
        if args.rollback and not args.version:
            raise SystemExit("--rollback requires --version VERSION")
        authorized = prepare_latest_authorized_browser(
            args.authorization,
            license_trusted_keys=_trusted_keys("SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON"),
            release_trusted_keys=_trusted_keys("SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON"),
            cache_root=args.cache,
            browser_version=args.version,
            version_policy=("at-or-before" if args.rollback else "exact") if args.version else None,
        )
        try:
            print(json.dumps({
                "plan": authorized.grant.plan,
                "concurrencyLimit": authorized.grant.concurrency_limit,
                "activeSessions": authorized.grant.active_sessions,
                "requestedVersion": authorized.grant.requested_browser_version,
                "selectedVersion": authorized.grant.browser_version,
                "downloadedVersion": authorized.installation.version,
                "launchedVersion": None,
                "versionPolicy": authorized.grant.version_policy,
                "selectionReason": authorized.grant.selection_reason,
                "availableVersions": list(authorized.grant.available_browser_versions),
                "updateRights": dict(authorized.grant.update_rights),
                "platform": authorized.installation.platform,
                "arch": authorized.installation.arch,
                "browser": str(authorized.installation.browser_executable),
                "driver": str(authorized.installation.driver_executable),
                "artifactSha256": authorized.installation.artifact_sha256,
            }, ensure_ascii=False, indent=2))
        finally:
            try:
                authorized.release()
            except Exception:
                pass
        return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
