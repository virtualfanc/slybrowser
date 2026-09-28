from __future__ import annotations

import unittest

from slybrowser.automation import automation_capability, validate_playwright_version
from slybrowser.errors import ConfigurationError


class AutomationPolicyTests(unittest.TestCase):
    def test_project_webdriver_is_default(self) -> None:
        self.assertEqual(
            automation_capability(),
            {
                "backend": "project-webdriver",
                "language": "python",
                "native_humanize": True,
                "persistent_context": True,
            },
        )

    def test_only_validated_playwright_line_is_accepted(self) -> None:
        self.assertEqual(validate_playwright_version("1.62.0"), "1.62.0")
        with self.assertRaises(ConfigurationError) as error:
            validate_playwright_version("1.63.0")
        self.assertEqual(error.exception.code, "framework_version_unsupported")

    def test_playwright_advertises_native_humanize_control_plane(self) -> None:
        self.assertEqual(
            automation_capability("playwright", framework_version="1.62.0"),
            {
                "backend": "playwright",
                "language": "python",
                "framework_version": "1.62.0",
                "native_humanize": True,
                "persistent_context": True,
            },
        )


if __name__ == "__main__":
    unittest.main()
