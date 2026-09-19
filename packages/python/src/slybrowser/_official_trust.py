"""Bundled public verification keys. This module is not part of the user API."""

from __future__ import annotations

import base64


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


LICENSE_LEASE_KEYS = {
    "launch-candidate-20260824": _decode("h9ie2nXxsXVKlxjFIz-or1otChHTF8HS94vV_EjY1KM"),
}
RELEASE_MANIFEST_KEYS = {
    "release-launch-candidate-20260824": _decode("SvSlPQKT9oZ4nIVuJXgd2pFOC0QblDph29vKlz6NJZo"),
}
LICENSE_FILE_KEYS = {
    "license-file-private-preview-v1": _decode("wc3DR5wOqazjZF_3n41EF1cMh5d-qGv2wkZHyd0Sj6s"),
}
