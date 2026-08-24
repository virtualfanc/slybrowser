"""Verified download, cache, and installation of an authorized browser release."""

from __future__ import annotations

import json
import os
import shutil
import stat
import tempfile
import time
import uuid
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from platformdirs import user_cache_dir

from .errors import ArtifactError
from .manifest import verify_artifact
from .service import LicenseServiceClient, LicensedSessionGrant, RuntimeSessionGrant


@dataclass(frozen=True, slots=True)
class BrowserInstallation:
    version: str
    platform: str
    arch: str
    root: Path
    browser_executable: Path
    driver_executable: Path
    artifact_sha256: str


@dataclass(slots=True)
class BrowserInstallationReference:
    installation: BrowserInstallation
    reference_file: Path
    _released: bool = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self.reference_file.unlink(missing_ok=True)


@dataclass(frozen=True, slots=True)
class BrowserPruneResult:
    removed: list[Path]
    skipped_in_use: list[Path]
    kept: list[Path]


def _file_sha256(path: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


InstallGrant = LicensedSessionGrant | RuntimeSessionGrant


def _current_platform() -> str:
    import platform
    system = platform.system().lower()
    if system.startswith("win"):
        return "windows"
    if system == "darwin":
        return "macos"
    if system == "linux":
        return "linux"
    raise ArtifactError("Unsupported platform", code="platform_unsupported")


def _current_arch() -> str:
    import platform
    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64"}:
        return "x64"
    if machine in {"aarch64", "arm64"}:
        return "arm64"
    raise ArtifactError("Unsupported architecture", code="platform_unsupported")


def _compare_version(left: str, right: str) -> int:
    left_parts = tuple(int(part) for part in left.split("."))
    right_parts = tuple(int(part) for part in right.split("."))
    size = max(len(left_parts), len(right_parts))
    return ((left_parts + (0,) * (size - len(left_parts))) > (right_parts + (0,) * (size - len(right_parts)))) - (
        (left_parts + (0,) * (size - len(left_parts))) < (right_parts + (0,) * (size - len(right_parts)))
    )


def _matches_kernel_major(version: str, kernel_major: int | str) -> bool:
    return kernel_major == "latest" or int(version.split(".")[0]) == kernel_major


def _verify_runtime(root: Path, grant: InstallGrant) -> tuple[Path, Path]:
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


def _assert_downloaded_size(path: Path, expected_size: int) -> None:
    try:
        actual = path.stat().st_size
    except OSError as error:
        raise ArtifactError("Browser artifact download is missing", code="artifact_missing") from error
    if actual > expected_size:
        raise ArtifactError("Browser artifact download exceeds its signed size", code="artifact_size_mismatch")


def _quarantine_path(path: Path) -> None:
    if not path.exists():
        return
    for attempt in range(5):
        target = Path(f"{path}.bad-{os.getpid()}-{time.time_ns()}-{attempt}")
        try:
            path.rename(target)
            return
        except FileNotFoundError:
            return
        except FileExistsError:
            continue
        except OSError as error:
            raise ArtifactError("Unable to quarantine invalid browser cache", code="artifact_cache_failed") from error
    raise ArtifactError("Unable to quarantine invalid browser cache", code="artifact_cache_failed")


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


def _read_installation(root: Path, grant: InstallGrant) -> BrowserInstallation | None:
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


def _read_loose_installation(root: Path, *, platform: str, arch: str, kernel_major: int | str) -> BrowserInstallation | None:
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
        if installation.platform != platform or installation.arch != arch:
            return None
        if not _matches_kernel_major(installation.version, kernel_major):
            return None
        if installation.root.resolve() != root.resolve():
            return None
        browser = installation.browser_executable.resolve()
        driver = installation.driver_executable.resolve()
        browser.relative_to(root.resolve())
        driver.relative_to(root.resolve())
        if browser.parent != driver.parent or not browser.is_file() or not driver.is_file():
            return None
        return BrowserInstallation(
            installation.version,
            installation.platform,
            installation.arch,
            root.resolve(),
            browser,
            driver,
            installation.artifact_sha256,
        )
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _write_current_pointers(cache: Path, installation: BrowserInstallation) -> None:
    current = cache / "stable" / "current"
    current.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": 1,
        "version": installation.version,
        "platform": installation.platform,
        "arch": installation.arch,
        "artifactSha256": installation.artifact_sha256,
        "root": str(installation.root),
        "updatedAt": int(time.time()),
    }
    major = installation.version.split(".")[0]
    for key in ("latest", major):
        (current / f"{installation.platform}-{installation.arch}-{key}.json").write_text(
            json.dumps(payload, indent=2) + "\n",
            "utf-8",
        )


def _process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        process_query_limited_information = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def acquire_browser_installation_reference(installation: BrowserInstallation) -> BrowserInstallationReference:
    root = installation.root.resolve()
    refs = root / ".sly-refs"
    refs.mkdir(parents=True, exist_ok=True)
    reference_file = refs / f"{os.getpid()}-{time.time_ns()}-{uuid.uuid4().hex}.json"
    payload = {
        "schemaVersion": 1,
        "processId": os.getpid(),
        "acquiredAt": int(time.time()),
        "version": installation.version,
        "platform": installation.platform,
        "arch": installation.arch,
        "artifactSha256": installation.artifact_sha256,
        "root": str(root),
        "browserExecutable": str(installation.browser_executable.resolve()),
        "driverExecutable": str(installation.driver_executable.resolve()),
    }
    descriptor = os.open(reference_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, (json.dumps(payload, indent=2) + "\n").encode("utf-8"))
    finally:
        os.close(descriptor)
    return BrowserInstallationReference(installation, reference_file)


def active_browser_installation_references(installation: BrowserInstallation) -> list[Path]:
    refs = installation.root.resolve() / ".sly-refs"
    active: list[Path] = []
    try:
        entries = list(refs.iterdir())
    except OSError:
        return active
    for reference_file in entries:
        if not reference_file.is_file() or reference_file.suffix != ".json":
            continue
        try:
            document = json.loads(reference_file.read_text("utf-8"))
            if (
                Path(str(document.get("root", ""))).resolve() != installation.root.resolve()
                or document.get("artifactSha256") != installation.artifact_sha256
            ):
                continue
            pid = int(document.get("processId", 0))
            if _process_is_alive(pid):
                active.append(reference_file)
            else:
                reference_file.unlink(missing_ok=True)
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            reference_file.unlink(missing_ok=True)
    return active


def is_browser_installation_in_use(installation: BrowserInstallation) -> bool:
    return bool(active_browser_installation_references(installation))


def _current_installation_roots(cache: Path) -> set[Path]:
    current = cache / "stable" / "current"
    roots: set[Path] = set()
    try:
        pointers = list(current.iterdir())
    except OSError:
        return roots
    for pointer in pointers:
        if not pointer.is_file() or pointer.suffix != ".json":
            continue
        try:
            document = json.loads(pointer.read_text("utf-8"))
            root = document.get("root")
            if isinstance(root, str):
                roots.add(Path(root).resolve())
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
    return roots


def prune_browser_installations(
    *,
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    kernel_major: int | str | None = None,
    dry_run: bool = False,
) -> BrowserPruneResult:
    cache = Path(cache_root).expanduser().resolve() if cache_root else Path(user_cache_dir("SlyBrowser"))
    selected_platform = platform or _current_platform()
    selected_arch = arch or _current_arch()
    selected_kernel_major: int | str = "latest" if kernel_major is None else kernel_major
    if selected_kernel_major != "latest" and (
        not isinstance(selected_kernel_major, int) or isinstance(selected_kernel_major, bool) or selected_kernel_major <= 0
    ):
        raise ArtifactError("kernel_major must be a positive integer or latest", code="version_policy_invalid")
    stable = cache / "stable"
    current_roots = _current_installation_roots(cache)
    removed: list[Path] = []
    skipped_in_use: list[Path] = []
    kept: list[Path] = []
    try:
        version_dirs = list(stable.iterdir())
    except OSError:
        return BrowserPruneResult(removed, skipped_in_use, kept)
    for version_dir in version_dirs:
        if not version_dir.is_dir() or version_dir.name == "current":
            continue
        try:
            if not _matches_kernel_major(version_dir.name, selected_kernel_major):
                continue
        except ValueError:
            continue
        try:
            identities = list(version_dir.iterdir())
        except OSError:
            continue
        for identity in identities:
            if not identity.is_dir():
                continue
            installation = _read_loose_installation(
                identity,
                platform=selected_platform,
                arch=selected_arch,
                kernel_major=selected_kernel_major,
            )
            if installation is None:
                continue
            if installation.root.resolve() in current_roots:
                kept.append(installation.root)
                continue
            if is_browser_installation_in_use(installation):
                skipped_in_use.append(installation.root)
                continue
            removed.append(installation.root)
            if not dry_run:
                shutil.rmtree(installation.root, ignore_errors=True)
                try:
                    next(version_dir.iterdir())
                except StopIteration:
                    version_dir.rmdir()
                except OSError:
                    pass
    return BrowserPruneResult(
        sorted(removed, key=str),
        sorted(skipped_in_use, key=str),
        sorted(kept, key=str),
    )


def find_current_browser_installation(
    *,
    cache_root: str | Path | None = None,
    platform: str | None = None,
    arch: str | None = None,
    kernel_major: int | str | None = None,
) -> BrowserInstallation | None:
    cache = Path(cache_root).expanduser().resolve() if cache_root else Path(user_cache_dir("SlyBrowser"))
    selected_platform = platform or _current_platform()
    selected_arch = arch or _current_arch()
    selected_kernel_major: int | str = "latest" if kernel_major is None else kernel_major
    if selected_kernel_major != "latest" and (
        not isinstance(selected_kernel_major, int) or isinstance(selected_kernel_major, bool) or selected_kernel_major <= 0
    ):
        raise ArtifactError("kernel_major must be a positive integer or latest", code="version_policy_invalid")
    current = cache / "stable" / "current" / f"{selected_platform}-{selected_arch}-{selected_kernel_major}.json"
    try:
        pointer = json.loads(current.read_text("utf-8"))
        if isinstance(pointer.get("root"), str):
            installation = _read_loose_installation(
                Path(pointer["root"]),
                platform=selected_platform,
                arch=selected_arch,
                kernel_major=selected_kernel_major,
            )
            if installation:
                return installation
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass
    stable = cache / "stable"
    candidates: list[BrowserInstallation] = []
    try:
        for version_dir in stable.iterdir():
            if not version_dir.is_dir() or version_dir.name == "current":
                continue
            try:
                if not _matches_kernel_major(version_dir.name, selected_kernel_major):
                    continue
            except ValueError:
                continue
            for identity in version_dir.iterdir():
                if identity.is_dir():
                    installation = _read_loose_installation(
                        identity,
                        platform=selected_platform,
                        arch=selected_arch,
                        kernel_major=selected_kernel_major,
                    )
                    if installation:
                        candidates.append(installation)
    except OSError:
        return None
    candidates.sort(key=lambda item: tuple(int(part) for part in item.version.split(".")), reverse=True)
    return candidates[0] if candidates else None


def install_granted_browser(
    client: LicenseServiceClient,
    grant: InstallGrant,
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
            _quarantine_path(archive)
            temporary_archive = Path(f"{archive}.{os.getpid()}.{time.time_ns()}.{uuid.uuid4().hex}.part")
            try:
                if isinstance(grant, RuntimeSessionGrant):
                    client.download_runtime_artifact(grant, temporary_archive)
                else:
                    client.download_artifact(grant, temporary_archive)
                _assert_downloaded_size(temporary_archive, grant.artifact.size)
                verify_artifact(temporary_archive, grant.artifact)
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
        _quarantine_path(install_root)
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
        _write_current_pointers(cache, installation)
        return installation
    finally:
        if temporary_directory:
            shutil.rmtree(temporary_directory, ignore_errors=True)
        lock.close()
