from __future__ import annotations

import pytest

from slybrowser.errors import ArtifactError
from slybrowser.installer import _inspect_7z_listing


def test_7z_preflight_rejects_unsafe_and_oversized_entries() -> None:
    listing = "\n".join(
        [
            "7-Zip listing",
            "----------",
            "Path = SlyBrowser",
            "Size = 8",
            "Attributes = A",
            "",
            "Path = ../outside",
            "Size = 1",
            "Attributes = A",
            "",
        ]
    )

    with pytest.raises(ArtifactError, match="unsafe path") as unsafe:
        _inspect_7z_listing(listing, 8)
    assert unsafe.value.code == "artifact_layout_invalid"

    with pytest.raises(ArtifactError, match="allowed size") as oversized:
        _inspect_7z_listing(listing.replace("../outside", "chromedriver"), 8)
    assert oversized.value.code == "artifact_expanded_too_large"
