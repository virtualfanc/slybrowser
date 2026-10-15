"""Modeled archive regressions for the signed macOS application layout."""

import hashlib
import io
from pathlib import Path
from types import SimpleNamespace
import zipfile

import pytest

from slybrowser.errors import ArtifactError
from slybrowser.installer import find_current_browser_installation, install_granted_browser


BROWSER = "SlyBrowser/SlyBrowser.app/Contents/MacOS/SlyBrowser"
DRIVER = "SlyBrowser/chromedriver"


def artifact_client(platform="macos", browser=BROWSER, driver=DRIVER, browser_bytes=b"browser"):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as package:
        package.writestr(browser, browser_bytes)
        package.writestr(driver, b"driver")
    archive = stream.getvalue()
    artifact = SimpleNamespace(
        sha256=hashlib.sha256(archive).hexdigest(), size=len(archive), archiveFormat="zip",
        browserExecutable=browser, driverExecutable=driver,
        browserSha256=hashlib.sha256(b"browser").hexdigest(),
        driverSha256=hashlib.sha256(b"driver").hexdigest(),
    )
    grant = SimpleNamespace(platform=platform, arch="arm64", browser_version="148.0.7778.179", artifact=artifact)
    client = SimpleNamespace(download_artifact=lambda _grant, destination: destination.write_bytes(archive))
    return client, grant


def test_installs_discovers_and_repairs_macos_app_bundle(tmp_path: Path):
    client, grant = artifact_client()
    installed = install_granted_browser(client, grant, cache_root=tmp_path)
    assert installed.browser_executable.read_bytes() == b"browser"
    assert find_current_browser_installation(cache_root=tmp_path, platform="macos", arch="arm64") == installed
    assert install_granted_browser(client, grant, cache_root=tmp_path) == installed
    installed.driver_executable.write_bytes(b"tampered")
    repaired = install_granted_browser(client, grant, cache_root=tmp_path)
    assert repaired.driver_executable.read_bytes() == b"driver"


@pytest.mark.parametrize("platform,browser,driver", [
    ("linux", BROWSER, DRIVER),
    ("macos", "SlyBrowser/Other.app/Contents/MacOS/SlyBrowser", DRIVER),
    ("macos", BROWSER, "SlyBrowser/otherdriver"),
])
def test_rejects_other_separated_layouts(tmp_path: Path, platform, browser, driver):
    client, grant = artifact_client(platform, browser, driver)
    with pytest.raises(ArtifactError) as result:
        install_granted_browser(client, grant, cache_root=tmp_path)
    assert result.value.code == "artifact_layout_invalid"


def test_macos_bundle_keeps_signed_executable_hash_check(tmp_path: Path):
    client, grant = artifact_client(browser_bytes=b"tampered")
    with pytest.raises(ArtifactError) as result:
        install_granted_browser(client, grant, cache_root=tmp_path)
    assert result.value.code == "artifact_runtime_hash_mismatch"
