# SlyBrowser for Python

```sh
pip install slybrowser==0.2.0
```

`launch()` accepts the authorization file plus optional `profile`, `launch`, and
`humanize` values. No import command is required. The SDK manages release selection,
verification, download, pairing, and temporary state.

```python
from slybrowser import launch

with launch(
    "account.authorization.json",
    {
        "profile": {"locale": "en-US", "screen": {"width": 1440, "height": 900}},
        "launch": {"headless": True, "profileMode": "ephemeral", "updateKernel": True},
        "humanize": {"enabled": True, "preset": "default"},
    },
) as browser:
    browser.get("https://example.test")
    print(browser.title)
```

The default path uses the matched project WebDriver and never falls back to a system
browser. Install `slybrowser[playwright]` and use `launch_playwright()` only when the
explicit adapter is required. A persistent adapter variant is also available.

Unknown or unsupported options, failed authorization, release verification errors,
and browser/driver mismatches stop the launch. Treat the authorization file as a
credential: do not commit, log, or share it.

See the [complete SDK user API](../../docs/user-api.md) for every field and default.
