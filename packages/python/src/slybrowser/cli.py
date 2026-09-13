"""Small diagnostic CLI; browser installation and launch commands follow later."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .errors import LicenseServiceError
from .licensed import prepare_latest_authorized_browser
from .service import LicenseServiceClient, import_license_file_to_sealed_authorization, read_license_authorization
from .webdriver import default_driver_executable


def _trusted_keys(name: str) -> dict[str, bytes]:
    import base64

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


def _optional_trusted_keys(name: str) -> dict[str, bytes] | None:
    return _trusted_keys(name) if os.environ.get(name) else None


def _current_platform() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("linux"):
        return "linux"
    raise ValueError(f"Unsupported platform: {sys.platform}")


def _current_arch() -> str:
    import platform

    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64"}:
        return "x64"
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    raise ValueError(f"Unsupported architecture: {machine}")


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


def _kernel_major(value: str | None) -> int | str | None:
    if value is None:
        return None
    if value == "latest":
        return "latest"
    if value.isdigit() and not value.startswith("0"):
        return int(value)
    raise argparse.ArgumentTypeError("--kernel-major must be a positive integer or latest")


def _license_service_error_output(error: LicenseServiceError) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "status": "error",
        "stableErrorCode": error.code,
        "httpStatus": error.status or None,
    }


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
    install.add_argument("--kernel-major", type=_kernel_major, help="major version to stay within, or latest")
    install.add_argument("--update-kernel", action="store_true", help="actively update to the newest authorized version in range")
    install.add_argument("--version", help="exact browser version to install")
    install.add_argument("--rollback", action="store_true", help="select the newest authorized version at or before --version")
    license_parser = subparsers.add_parser("license", help="manage local SlyBrowser license files")
    license_subparsers = license_parser.add_subparsers(dest="license_command", required=True)
    license_import = license_subparsers.add_parser("import", help="import a paid license file into Windows DPAPI sealed local storage")
    license_import.add_argument("--input", required=True, help="encrypted v2 SlyBrowser license file from billing email")
    license_import.add_argument("--output", required=True, help="sealed authorization file to create")
    license_import.add_argument("--passphrase", required=True, help="license file passphrase")
    license_import.add_argument("--trusted-service-url", action="append", dest="trusted_service_urls", help="trusted license service origin")
    license_info = license_subparsers.add_parser("info", help="print redacted online license diagnostics")
    license_info.add_argument("--authorization", required=True, help="authorization, encrypted license or sealed license file")
    license_info.add_argument("--passphrase", help="license file passphrase, when reading encrypted email attachments")
    license_info.add_argument("--trusted-service-url", action="append", dest="trusted_service_urls", help="trusted license service origin")
    license_info.add_argument("--kernel-major", type=_kernel_major, help="major version to stay within, or latest")
    license_info.add_argument("--update-kernel", action="store_true", help="check for the newest authorized version in range")
    license_info.add_argument("--version", help="exact browser version to inspect")
    license_info.add_argument("--rollback", action="store_true", help="select the newest authorized version at or before --version")
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
            kernel_major=args.kernel_major,
            update_kernel=args.update_kernel,
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
                "requestedKernelMajor": authorized.grant.requested_kernel_major,
                "selectionMode": authorized.grant.selection_mode,
                "availableVersions": list(authorized.grant.available_browser_versions),
                "latestAvailableVersion": authorized.grant.latest_available_version,
                "updateAvailable": authorized.grant.update_available,
                "updateRequired": authorized.grant.update_required,
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
    if args.command == "license":
        if args.license_command == "info":
            if args.rollback and not args.version:
                raise SystemExit("--rollback requires --version VERSION")
            try:
                authorization = read_license_authorization(
                    args.authorization,
                    license_file_passphrase=args.passphrase,
                    license_file_trusted_keys=_optional_trusted_keys("SLYBROWSER_LICENSE_FILE_PUBLIC_KEYS_JSON"),
                    trusted_service_urls=tuple(args.trusted_service_urls or ("https://api.slybrowser.com",)),
                )
                info = LicenseServiceClient(
                    authorization,
                    license_trusted_keys=_trusted_keys("SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON"),
                    release_trusted_keys=_trusted_keys("SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON"),
                ).license_info(
                    platform=_current_platform(),
                    arch=_current_arch(),
                    kernel_major=args.kernel_major,
                    update_kernel=args.update_kernel,
                    browser_version=args.version,
                    version_policy=("at-or-before" if args.rollback else "exact") if args.version else None,
                )
                print(json.dumps(info.to_redacted_dict(), ensure_ascii=False, indent=2))
                return 0
            except LicenseServiceError as error:
                print(json.dumps(_license_service_error_output(error), ensure_ascii=False, indent=2))
                return 1
        if args.license_command == "import":
            result = import_license_file_to_sealed_authorization(
                args.input,
                args.output,
                license_file_passphrase=args.passphrase,
                license_file_trusted_keys=_trusted_keys("SLYBROWSER_LICENSE_FILE_PUBLIC_KEYS_JSON"),
                trusted_service_urls=tuple(args.trusted_service_urls or ("https://api.slybrowser.com",)),
            )
            print(json.dumps({
                "output": str(result.output),
                "serviceUrl": result.service_url,
                "channel": result.channel,
                "protection": result.protection,
                "licenseKeySha256": result.license_key_sha256,
            }, ensure_ascii=False, indent=2))
            return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
