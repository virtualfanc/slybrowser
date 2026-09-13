# Native profile configuration

SlyBrowser SDKs pass one-time JSON files to the private Chromium build through
`--sly-config-file`. The browser validates and deletes the file before creating a
profile. Unknown fields, invalid types, unsafe ranges, mixed flat/nested profiles,
and long-lived license keys fail closed.

The canonical public contract is
[`contracts/launch-options.schema.json`](../contracts/launch-options.schema.json).
The first public release intentionally excludes proxy routing and GEO/geolocation
support. Python and Node high-level launch helpers may pass the supported profile
fields directly; low-level and .NET callers may use the complete launch-options
object with the fields below nested under `profile`.

`profile.locale` and `profile.timezone` remain ordinary browser-profile settings.
They are not a GEO/IP routing feature in the first release.

## Complete example

The maintained all-parameter example is
[`tests/fixtures/launch/valid-full.json`](../tests/fixtures/launch/valid-full.json).
It is validated by the shared AJV contract suite and by the native conversion tests.
Use placeholder credentials only in source-controlled fixtures.

## Parameter map

| Public field | Legacy profile field | Native behavior |
| --- | --- | --- |
| `profile.fingerprintMode` | — | Selects `explicit` (the default) or deterministic `seeded` profile defaults |
| `profile.fingerprintSeed` | — | Supplies the 1–128 character seed required by `seeded` mode |
| `profile.fingerprintSchemaVersion` | — | Pins seeded derivation to schema version `1`; unsupported versions fail closed |
| `profile.userAgent` | `ua` | Overrides window, Worker, and request User-Agent values |
| `profile.userAgentFullVersion` | `ua-full-version` | Overrides the Chromium full product version used by version metadata |
| `profile.clientHints` | `sec-ch-ua` | Supplies ordered brand/version entries to UA Client Hints |
| `profile.osVersion` | `os` | Supplies the platform version used by UA metadata |
| `profile.timezone` | `time-zone` | Accepts a zone string or `{zone, utc, locale}` and applies it below JavaScript |
| `profile.webrtc` | `webrtc` | Only `default` is supported in the first release; proxy and replace modes are reserved for future work |
| `profile.locale`, `profile.languages` | `ua-language` | Sets `navigator.language(s)`, Workers, renderer preferences, and `Accept-Language` consistently |
| `profile.screen` | `screen` | Overrides width and height from 320×240 through 16384×16384 |
| `profile.disabledFonts` | `fonts` | Filters configured font families in Blink font selection |
| `profile.canvasNoise` | `canvas` | Supplies bounded RGBA seed values for deterministic canvas processing |
| `profile.webglImageNoise` | `webgl-img` | Supplies bounded RGBA seed values for deterministic WebGL image processing |
| `profile.webgl` | `webgl` | Overrides unmasked WebGL vendor and renderer |
| `profile.webgpu` | `webgpu` | Overrides WebGPU adapter vendor and architecture metadata |
| `profile.audioContext` | `audio-context` | Supplies channel/analyzer seeds to the native audio profile path |
| `profile.disabledCipherSuites` | `ssl` | Writes Chromium's disabled cipher-suite preference |
| `profile.disabledMediaDevices` | `media` | Accepted and parsed for legacy-profile compatibility; the inherited source has no runtime consumer yet |
| `profile.clientRects` | `client-rects` | Applies bounded width/height deltas in Element, Range, and SVG geometry |
| `profile.speechVoices` | `speech_voices` | Replaces the speech-synthesis voice list |
| `profile.cookies` | `cookie` | Installs validated cookie records during profile initialization |
| `profile.hardwareConcurrency` | `cpu` | Overrides `navigator.hardwareConcurrency` in windows and Workers |
| `profile.deviceMemory` | `memory` | Overrides `navigator.deviceMemory`; inherited Blink behavior caps the exposed value at 8 GiB |
| `profile.deviceName` | `device-name` | Overrides the local sync device name |
| `profile.macAddress` | `mac` | Accepted and parsed for legacy-profile compatibility; the inherited source has no runtime consumer yet |
| `profile.doNotTrack` | `dnt` | Sets the DNT preference, JavaScript value, and request header |
| `profile.allowedPorts` | `port-scan` | Writes the explicitly allowed network-port preference |
| `profile.gpuEnabled` | `gpu` | Sets the hardware-acceleration preference |
| `profile.homepages` | `homepage` | Supplies one or more validated HTTP(S) startup pages |

`disabledMediaDevices` and `macAddress` are the only two legacy profile fields without a runtime
read site in the inherited Chromium source. They are mapped so existing profile data
round-trips without loss, but they must not be described as active spoofing controls.

## Compatibility and validation

- A flat document containing profile fields remains accepted for existing Python and
  Node launch helpers. Do not mix flat fields with a nested `profile` object.
- `seeded` mode requires both `fingerprintSeed` and `fingerprintSchemaVersion: 1`.
  Explicit profile fields take precedence over seeded defaults. `explicit` mode rejects
  seed fields instead of silently ignoring them.
- `locale`, when combined with `languages`, must equal `languages[0]`.
- `proxy`, `proxyAlignment`, `profile.geolocation`, flat `geolocation`, and
  WebRTC proxy/replace modes are not supported by the first release and fail
  closed with `launch_feature_unsupported`.
- `deviceScaleFactor` is not a legacy profile parameter and is intentionally not in the
  contract.
- Complete WebRTC shutdown is not implemented by the inherited legacy profile modes;
  `webrtc: "disabled"` is rejected instead of being silently mapped to another mode.
- Noise, geometry, port, coordinate, list-size, string-size, URL, and MAC-address
  values have explicit bounds in both JSON Schema and native validation.

Errors use `profile_invalid`, `profile_invalid_json`,
`profile_secret_forbidden`, or `profile_internal`. A long-lived license key never
crosses this boundary: the SDK exchanges it for a short-lived signed lease and sends
that lease through a separate one-time file.

## Verification

The focused native suite keeps broader legacy parser checks private for compatibility
tracking. The first-release public contract exposes the supported subset. The local browser E2E
fixture configures 27 groups and currently asserts 13 stable runtime groups:
User-Agent, full version, Client Hints, locale/languages, timezone, screen, WebGL,
WebGPU, Client Rects, disabled fonts, CPU, memory, and DNT. The single regression
matrix covers Page, same-origin Iframe, Worker, GPU and direct-network headers.
Other groups require component-specific or environment-dependent tests; successful
parsing alone is not reported as runtime effectiveness.
