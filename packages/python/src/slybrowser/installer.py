"""Verified download, cache, and installation of an authorized browser release."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import time
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from platformdirs import user_cache_dir

from .errors import ArtifactError
from .manifest import verify_artifact
from .service import LicenseServiceClient, LicensedSessionGrant


@dataclass(frozen=True, slots=True)
class BrowserInstallation:
    version: str
    platform: str
    arch: str
    root: Path
    browser_executable: Path
    driver_executable: Path
    artifact_sha256: str


def _file_sha256(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _verify_runtime(root: Path, grant: LicensedSessionGrant) -> tuple[Path, Path]:
    browser = (root / grant.artifact.browserExecutable).resolve()
    driver = (root / grant.artifact.driverExecutable).resolve()
    resolved_root = root.resolve()
    try:
        browser.relative_to(resolved_root)
        driver.relative_to(resolved_root)
    except ValueError as error:
        raise ArtifactError("Installed runtime path escapes its root", code="artifact_layout_invalid") from error
    if browser.parent != driver.parent or not browser.is_file() or not driver.is_file():
        raise ArtifactError("Installed browser and project WebDriver layout is invalid", code="artifact_layout_invalid")
    if _file_sha256(browser) != grant.artifact.browserSha256 or _file_sha256(driver) != grant.artifact.driverSha256:
        raise ArtifactError(
            "Installed browser or project WebDriver hash does not match the signed manifest",
            code="artifact_runtime_hash_mismatch",
        )
    return browser, driver


def _safe_extract(archive: Path, destination: Path, maximum_expanded_bytes: int) -> None:
    with zipfile.ZipFile(archive) as package:
        total = 0
        for item in package.infolist():
            path = Path(item.filename.replace("\\", "/"))
            if path.is_absolute() or ".." in path.parts:
                raise ArtifactError("Browser archive contains an unsafe path", code="artifact_layout_invalid")
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ArtifactError("Browser archive contains a symbolic link", code="artifact_layout_invalid")
            total += item.file_size
            if total > maximum_expanded_bytes:
                raise ArtifactError("Browser archive expands beyond its allowed size", code="artifact_expanded_too_large")
        package.extractall(destination)


class _InstallLock:
    def __init__(self, path: Path, timeout: float) -> None:
        self.path = path
        deadline = time.monotonic() + timeout
        while True:
            try:
                descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(descriptor, str(os.getpid()).encode("ascii"))
                os.close(descriptor)
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise ArtifactError("Timed out waiting for the browser installation lock", code="install_lock_timeout")
                time.sleep(0.1)

    def close(self) -> None:
        self.path.unlink(missing_ok=True)


def _read_installation(root: Path, grant: LicensedSessionGrant) -> BrowserInstallation | None:
    try:
        value = json.loads((root / ".sly-install.json").read_text("utf-8"))
        installation = BrowserInstallation(
            version=value["version"],
            platform=value["platform"],
            arch=value["arch"],
            root=Path(value["root"]),
            browser_executable=Path(value["browser_executable"]),
            driver_executable=Path(value["driver_executable"]),
            artifact_sha256=value["artifact_sha256"],
        )
        if installation.version != grant.browser_version or installation.artifact_sha256 != grant.artifact.sha256:
            return None
        expected_browser = (root / grant.artifact.browserExecutable).resolve()
        expected_driver = (root / grant.artifact.driverExecutable).resolve()
        if installation.root.resolve() != root.resolve() or installation.browser_executable.resolve() != expected_browser or installation.driver_executable.resolve() != expected_driver:
            return None
        _verify_runtime(root, grant)
        return installation
    except (ArtifactError, OSError, KeyError, TypeError, ValueError):
        return None


def install_granted_browser(
    client: LicenseServiceClient,
    grant: LicensedSessionGrant,
    *,
    cache_root: str | Path | None = None,
    lock_timeout: float = 60,
    extractor: Callable[[Path, Path], None] | None = None,
) -> BrowserInstallation:
    cache = Path(cache_root).expanduser().resolve() if cache_root else Path(user_cache_dir("SlyBrowser"))
    identity = f"{grant.platform}-{grant.arch}-{grant.artifact.sha256[:16]}"
    install_root = cache / "stable" / grant.browser_version / identity
    existing = _read_installation(install_root, grant)
    if existing:
        return existing
    install_root.parent.mkdir(parents=True, exist_ok=True)
    lock = _InstallLock(Path(f"{install_root}.lock"), lock_timeout)
    temporary_directory: Path | None = None
    try:
        raced = _read_installation(install_root, grant)
        if raced:
            return raced
        downloads = cache / "downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        archive = downloads / f"{grant.artifact.sha256}.zip"
        try:
            verify_artifact(archive, grant.artifact)
        except ArtifactError:
            temporary_archive = Path(f"{archive}.{os.getpid()}.{time.time_ns()}.download")
            try:
                client.download_artifact(grant, temporary_archive)
                verify_artifact(temporary_archive, grant.artifact)
                archive.unlink(missing_ok=True)
                os.replace(temporary_archive, archive)
            finally:
                temporary_archive.unlink(missing_ok=True)
        verify_artifact(archive, grant.artifact)
        temporary_directory = Path(tempfile.mkdtemp(prefix=".extract-", dir=install_root.parent))
        if extractor:
            extractor(archive, temporary_directory)
        else:
            maximum = min(max(grant.artifact.size * 20, 2 * 1024 * 1024 * 1024), 16 * 1024 * 1024 * 1024)
            _safe_extract(archive, temporary_directory, maximum)
        _verify_runtime(temporary_directory, grant)
        if install_root.exists():
            shutil.rmtree(install_root)
        os.replace(temporary_directory, install_root)
        temporary_directory = None
        installation = BrowserInstallation(
            grant.browser_version,
            grant.platform,
            grant.arch,
            install_root,
            (install_root / grant.artifact.browserExecutable).resolve(),
            (install_root / grant.artifact.driverExecutable).resolve(),
            grant.artifact.sha256,
        )
        marker = {
            **asdict(installation),
            "root": str(installation.root),
            "browser_executable": str(installation.browser_executable),
            "driver_executable": str(installation.driver_executable),
        }
        (install_root / ".sly-install.json").write_text(json.dumps(marker, indent=2) + "\n", "utf-8")
        return installation
    finally:
        if temporary_directory:
            shutil.rmtree(temporary_directory, ignore_errors=True)
        lock.close()
