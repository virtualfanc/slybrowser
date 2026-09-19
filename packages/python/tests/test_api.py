from __future__ import annotations

import unittest
from unittest.mock import patch

from slybrowser.api import _options, launch
from slybrowser.errors import ConfigurationError


class PublicApiTests(unittest.TestCase):
    def test_maps_only_user_owned_options_and_official_trust(self) -> None:
        mapped = _options({
            "profile": {"locale": "en-US"},
            "launch": {
                "headless": False,
                "profileMode": "persistent",
                "profileDirectory": "profile",
                "updateKernel": False,
            },
            "humanize": {
                "enabled": True,
                "preset": "careful",
                "seed": 42,
                "config": {"keyDelayMin": 40},
            },
        })
        self.assertEqual(mapped["profile"], {"locale": "en-US"})
        self.assertEqual(mapped["profile_mode"], "persistent")
        self.assertEqual(mapped["profile_dir"], "profile")
        self.assertEqual(mapped["human_preset"], "careful")
        self.assertIn("license_trusted_keys", mapped)
        self.assertIn("release_trusted_keys", mapped)
        self.assertIn("license_file_trusted_keys", mapped)

    def test_rejects_unknown_and_unsupported_options_before_launch(self) -> None:
        with self.assertRaises(ConfigurationError) as unknown:
            _options({"extra": True})  # type: ignore[typeddict-unknown-key]
        self.assertEqual(unknown.exception.code, "launch_options_invalid")
        with self.assertRaises(ConfigurationError) as preset:
            _options({"humanize": {"preset": "fast"}})  # type: ignore[typeddict-item]
        self.assertEqual(preset.exception.code, "humanize_preset_invalid")

    def test_launch_forwards_the_authorization_file_to_the_internal_runtime(self) -> None:
        with patch("slybrowser.api.launch_latest", return_value=object()) as internal:
            launch("account.authorization.json")
        self.assertEqual(internal.call_args.args, ("account.authorization.json",))
        self.assertIn("license_file_trusted_keys", internal.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
