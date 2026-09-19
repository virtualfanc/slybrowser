# SDK user API

SlyBrowser 0.2.0 has one launch contract across Node.js, Python, Java, and .NET.
The application supplies an authorization file and may set `profile`, `launch`, and
`humanize` options. No import command is required.

## Installation

| Language | Package |
| --- | --- |
| Node.js | `npm install slybrowser@0.2.0` |
| Python | `pip install slybrowser==0.2.0` |
| Java | `com.slybrowser:slybrowser:0.2.0` |
| .NET | `dotnet add package SlyBrowser --version 0.2.0` |

The SDK packages do not embed Browser binaries. The selected SDK downloads the exact
authorized Browser and matching Sly WebDriver after it validates the authorization
file and signed release metadata.

The SDK selects, verifies, and starts the matching SlyBrowser and Sly WebDriver
release. Runtime locations, verification material, release downloads, temporary
state, and binding detection are managed by the package. A verification or pairing
failure stops the launch.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| authorization file | Yes | Path to the customer authorization file. Treat it as a credential. |
| `profile` | No | Supported browser-profile values. |
| `launch` | No | Process and profile-lifetime behavior. |
| `humanize` | No | Native Sly WebDriver interaction behavior. |

Unknown fields and unsupported values fail before browser startup. Proxy and GEO
configuration are not part of this release.

## Launch fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `headless` | boolean | `true` | Starts the browser without a visible window. |
| `profileMode` | `ephemeral` or `persistent` | `ephemeral` | Selects a clean or retained browser profile. |
| `profileDirectory` | path or null | `null` | Directory used for a persistent profile. |
| `updateKernel` | boolean | `true` | Selects the newest compatible authorized release. |

## Humanize fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Enables native Humanize commands. |
| `preset` | `default` or `careful` | `default` | Selects the timing preset. |
| `seed` | integer or null | `null` | Makes test input repeatable; omit it in normal use. |
| `config` | object | Values below | Overrides individual timing values. |
| `mouseStepsMin` | integer | `10` | Minimum pointer path steps. |
| `mouseStepsMax` | integer | `16` | Maximum pointer path steps. |
| `mouseStepDelayMin` | integer | `7` | Minimum delay between pointer steps in milliseconds. |
| `mouseStepDelayMax` | integer | `18` | Maximum delay between pointer steps in milliseconds. |
| `clickHoldMin` | integer | `45` | Minimum click hold in milliseconds. |
| `clickHoldMax` | integer | `105` | Maximum click hold in milliseconds. |
| `keyDelayMin` | integer | `35` | Minimum delay between keys in milliseconds. |
| `keyDelayMax` | integer | `115` | Maximum delay between keys in milliseconds. |
| `thinkDelayMin` | integer | `120` | Minimum thinking pause in milliseconds. |
| `thinkDelayMax` | integer | `360` | Maximum thinking pause in milliseconds. |

## Profile fields

| Field | Default | Description |
| --- | --- | --- |
| `fingerprintMode` | `explicit` | Uses explicit values or deterministic `seeded` defaults. |
| `fingerprintSeed` | `null` | Seed required by `seeded` mode. |
| `fingerprintSchemaVersion` | `null` | Must be `1` when seeded mode is used. |
| `userAgent` | `null` | User-Agent override. |
| `userAgentFullVersion` | `null` | Full product-version override. |
| `clientHints` | `null` | Ordered browser brand and version entries. |
| `osVersion` | `null` | Platform-version value. |
| `timezone` | `null` | Time-zone string or structured time-zone value. |
| `webrtc` | `default` | Default direct-network WebRTC behavior. |
| `locale` | `null` | Primary locale. |
| `languages` | `null` | Ordered language list; the first item must match `locale`. |
| `screen` | `null` | Screen width and height. |
| `disabledFonts` | `null` | Font families removed from browser selection. |
| `canvasNoise` | `null` | Bounded RGBA canvas values. |
| `webglImageNoise` | `null` | Bounded RGBA WebGL image values. |
| `webgl` | `null` | WebGL vendor and renderer. |
| `webgpu` | `null` | WebGPU vendor and architecture. |
| `audioContext` | `null` | Audio channel and analyzer values. |
| `disabledCipherSuites` | `null` | Disabled TLS cipher suites. |
| `disabledMediaDevices` | `null` | Reserved compatibility field without a runtime effect in this release. |
| `clientRects` | `null` | Bounded geometry values. |
| `speechVoices` | `null` | Speech-synthesis voice records. |
| `cookies` | `null` | Validated initial cookie records. |
| `hardwareConcurrency` | `null` | Reported logical processor count. |
| `deviceMemory` | `null` | Reported device memory. |
| `deviceName` | `null` | Local device name. |
| `macAddress` | `null` | Reserved compatibility field without a runtime effect in this release. |
| `doNotTrack` | `null` | Do Not Track setting. |
| `allowedPorts` | `null` | Explicitly allowed network ports. |
| `gpuEnabled` | `null` | Hardware-acceleration preference. |
| `homepages` | `null` | Validated HTTP(S) startup pages. |

See [Native profile configuration](profile-configuration.md) for validation ranges
and runtime coverage.

## Node.js

```ts
import { launch } from "slybrowser";

await using browser = await launch("account.authorization.json", {
  profile: { locale: "en-US", languages: ["en-US", "en"] },
  launch: { headless: true },
  humanize: { enabled: true, preset: "default" },
});
await browser.get("https://example.test");
```

## Python

```python
from slybrowser import launch

with launch(
    "account.authorization.json",
    {
        "profile": {"locale": "en-US", "languages": ["en-US", "en"]},
        "launch": {"headless": True},
        "humanize": {"enabled": True, "preset": "default"},
    },
) as browser:
    browser.get("https://example.test")
```

## Java

```java
SlyBrowserOptions options = new SlyBrowserOptions();
options.profile = Map.of("locale", "en-US", "languages", List.of("en-US", "en"));
options.humanize.enabled = true;

try (SlyWebDriverSession browser = SlyBrowser.launch(
    Path.of("account.authorization.json"), options)) {
  browser.getDriver().get("https://example.test");
}
```

## .NET

```csharp
SlyBrowserOptions options = new()
{
    Profile = new Dictionary<string, object?>
    {
        ["locale"] = "en-US",
        ["languages"] = new[] { "en-US", "en" },
    },
    Humanize = new HumanizeOptions { Enabled = true },
};

await using SlyWebDriverSession browser =
    await SlyBrowserClient.LaunchAsync("account.authorization.json", options);
browser.Driver.Navigate().GoToUrl("https://example.test");
```

Playwright adapters are available in all four bindings. Node.js also provides a
Puppeteer adapter. The default `launch` entry point always uses the matched project
WebDriver.
