<p align="center">
  <img src="assets/brand/icon.svg" width="128" alt="SlyBrowser icon">
</p>

<h1 align="center">SlyBrowser</h1>

<p align="center"><strong>Native Chromium profiles for reliable browser automation.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="SDK license: MIT" src="https://img.shields.io/badge/SDK%20license-MIT-5577FF"></a>
  <a href="SECURITY.md"><img alt="Security policy" src="https://img.shields.io/badge/security-policy-39B878"></a>
  <img alt="Status: private preview" src="https://img.shields.io/badge/status-private%20preview-F6C445">
</p>

<p align="center">
  <a href="https://slybrowser.com/free-license"><strong>Claim a Free license</strong></a><br>
  Receive a 90-day Free license certificate by email for one concurrent browser process.<br>
  It does not renew automatically and can be claimed once per email.
</p>

SlyBrowser is a Chromium-based browser distribution and multi-language SDK for
launching isolated, reproducible browser profiles from automation frameworks. Profile
settings are applied in the native browser layer so the browser, renderer, workers,
iframes, and supported runtime surfaces share one configuration.

## Install an SDK

SlyBrowser 0.2.0 exposes one launch contract in four language packages. The npm page
documents the Node.js package; use the matching registry for other languages.

| Language | Install |
| --- | --- |
| Node.js | `npm install slybrowser@0.2.0` |
| Python | `pip install slybrowser==0.2.0` |
| Java | Maven coordinate `com.slybrowser:slybrowser:0.2.0` |
| .NET | `dotnet add package SlyBrowser --version 0.2.0` |

Each SDK downloads and verifies the authorized Browser and matched Sly WebDriver on
first launch. Browser binaries are not embedded in the SDK package.

## Selected passing evidence over stock Chromium

The saved headed comparison used the same Windows x64 host, network and time window.
SlyBrowser ran through the public Node package, its exact matched project WebDriver,
Native Humanize in `careful` mode and the benchmark profile; the stock Chromium baseline
ran through Playwright. The public summary below intentionally highlights successful
checks and category wins only. The saved evidence records SlyBrowser/WebDriver
`148.0.7778.179` and stock Chromium `153.0.8003.0`.

| Metric | SlyBrowser | Stock Chromium | Measured advantage |
| --- | ---: | ---: | ---: |
| Coverage-adjusted score | **80.01** | 71.11 | **+8.90** |
| Raw measured score | **88.74** | 78.86 | **+9.88** |
| Core automation signals | **100.00** | 80.00 | **+20.00** |
| Bot-detection checks | **82.30** | 73.26 | **+9.04** |
| Page / iframe / worker consistency | **100.00** | 94.44 | **+5.56** |
| Device & Browser Info interaction | **100.00** | 69.23 | **+30.77** |
| Interaction score | **92.31** | 69.23 | **+23.08** |

The release gate now requires Node.js, Python, Java and .NET Native Humanize
Page/Frame/Element/DPI scores to meet or exceed the Node.js SDK baseline before
refreshing the public comparison. See the
[selected dated passing evidence](docs/benchmark-latest.md).

> [!IMPORTANT]
> This repository is governed for public disclosure, while the product distribution
> remains in private preview. Treat every tracked file and commit-metadata field as
> publicly disclosed even when remote visibility has not been independently verified.
> Package names, APIs, download endpoints, and binary license terms may change before
> the first public preview.

## Intended capabilities

- Project-built W3C WebDriver as the default JavaScript, Python, Java and .NET
  backend.
- Playwright as an explicit optional adapter for Node.js/TypeScript, Python,
  Java and .NET; Puppeteer as an explicit optional Node.js/TypeScript adapter.
- Persistent and ephemeral user-data directories.
- A first-release native profile contract covering identity, locale, timezone,
  screen, graphics, audio, device, storage, browser-policy, and startup inputs.
- First-release launch helpers explicitly reject proxy routing, proxy alignment,
  GEO/geolocation, and WebRTC proxy/replace modes with
  `launch_feature_unsupported`.
- Signed browser release manifests with SHA-256 artifact verification.
- Short-lived, signed license leases with explicit feature and session limits.
- Python, Node.js, Java and .NET SDKs backed by shared JSON contracts and a
  machine-readable framework compatibility matrix.
- Deterministic build, packaging, smoke-test, and test-page automation.

## Source and license boundary

SlyBrowser deliberately separates its public SDK from its browser implementation:

| Deliverable | Location | License |
| --- | --- | --- |
| SDKs, schemas, scripts, tests, and documentation | This repository | [MIT](LICENSE), except where noted |
| SlyBrowser name and logo | `assets/brand` | Reserved trademark/brand assets |
| Modified Chromium C++ source | Private source checkout | Not published by this repository |
| Distributed SlyBrowser browser binary | Release channel | Release-specific proprietary binary license plus applicable open-source licenses |
| Chromium and bundled third-party components | Browser source/binary | Their respective upstream licenses and notices |

Read [LICENSE-SCOPE.md](LICENSE-SCOPE.md) and
[legal/BINARY-LICENSE.md](legal/BINARY-LICENSE.md) before redistributing any
deliverable. Official browser release packages must include `BINARY-LICENSE.txt`,
`LICENSE-SCOPE.txt`, `THIRD_PARTY_NOTICES.txt`, and `CREDITS.html`; release automation
rejects packages that omit those legal artifacts. The commercial binary terms cannot
remove rights independently granted by Chromium or any third-party component.

## Repository layout

```text
assets/brand/       Approved icon and brand files
contracts/          Shared launch and signed-release schemas
docs/               Architecture, licensing, and release design
docs/wiki/          Version-controlled source for the public GitHub Wiki
packages/python/    Python SDK and CLI (project WebDriver default)
packages/node/      TypeScript SDK (project WebDriver default)
packages/java/      Java SDK and Playwright adapter
packages/dotnet/    .NET SDK and Playwright adapter
scripts/            Build, packaging, signing, and verification entry points
tests/              Contract, integration, and browser test-page suites
```

Entitlement, billing, authorization, and website service implementations are maintained
outside this public SDK repository. Public clients integrate only through the documented
contracts and service interfaces.

The modified Chromium checkout and signing private keys must never be copied into this
repository. Browser packages are attached to releases only after license scanning,
testing, hashing, and manifest signing.

## Technical documentation

Start with the [SDK user API](docs/user-api.md) for the four-language launch contract
and the version-controlled [SlyBrowser Wiki source](docs/wiki/Home.md) for the
feature-oriented installation, configuration, API, error, limitation, and platform
guides. The remote GitHub Wiki is a publication target, not a second source of truth;
local source preparation does not mean remote publication has occurred.

Contributor-facing exact-candidate security, documentation, four-binding,
Red → Green → Refactor, and cumulative eligibility contracts are documented in
[the public delivery gate contracts](contracts/delivery/README.md). A passing local
receipt establishes eligibility only and never authorizes a commit, push, publication,
deployment, or release.
The security plan fixes seven checks to one exact Git-index candidate: staged diff,
repository disclosure guard, type checking, lint, SAST, dependency vulnerability, and
dependency-license inventory. Each runner writes candidate-bound raw evidence; only a
separate receipt builder that verifies the raw evidence, candidate, command, tool, and
canonical scanner plan can turn that output into an accepted scanner receipt. Receipt
eligibility never grants commit, push, deployment, publication, or release authority.
Repository-history replacement has an additional fail-closed audit that scans all
reachable refs, commits, paths, blobs and commit metadata. A deletion commit does not
erase an earlier private blob and is never accepted as history sanitization.

## Default project WebDriver

SlyBrowser 0.2.0 exposes the same entry point in Node.js, Python, Java, and .NET. Pass
the authorization file and optionally set `profile`, `launch`, and `humanize`. No
import command is required. The SDK selects and verifies the matching SlyBrowser and
Sly WebDriver release; it never falls back to a system browser or driver.

```ts
import { launch } from "slybrowser";

await using browser = await launch("account.authorization.json", {
  profile: { locale: "en-US", languages: ["en-US", "en"] },
  launch: { headless: true },
  humanize: { enabled: true, preset: "careful" },
});
await browser.get("https://example.test");
await (await browser.findElement("input[name=q]")).type("SlyBrowser");
```

```python
from slybrowser import launch

with launch(
    "account.authorization.json",
    {
        "profile": {"locale": "en-US", "languages": ["en-US", "en"]},
        "launch": {"headless": True},
        "humanize": {"enabled": True, "preset": "careful"},
    },
) as browser:
    browser.get("https://example.test")
    browser.find_element("input[name=q]").type("SlyBrowser")
```

Playwright adapters are available in all four bindings; Node.js also provides a
Puppeteer adapter. The package detects the installed binding and keeps release and
pairing details internal. See the [complete SDK user API](docs/user-api.md) for all
fields, defaults, and four-language examples.

## Authorized latest release

The SDKs validate the authorization file, reserve one browser-process concurrency
slot, select a server-approved Stable release, verify its archive, and launch the exact
project WebDriver pair.
Paid entitlements can use the newest compatible paid package. A natively issued Free
license uses the server-controlled Free window, which defaults to the newest
compatible Stable package. An expired paid key is rejected with
`license_plan_expired`; it is never silently converted to Free. Every authorized
runtime stops if the selected, downloaded, and launched versions do not match. Cached
runtime files are checked again before every load.

The customer-held authorization file is an account credential. Payment, renewal,
cancellation, downgrade, and refund do not require an application-side conversion
step. The service resolves the effective plan, release window, feature set, and
concurrency limit on every launch.

For support, Node.js and Python CLIs expose a read-only diagnostic command:

```text
slybrowser license info --authorization account.authorization.json
```

It prints redacted plan, concurrency, paid-through, selected release, update status and
`stableErrorCode` fields only. It does not print license keys, runtime tokens, download
tickets, emails, PayNow IDs, profile paths or service access URLs.

```ts
import { launch } from "slybrowser";

await using browser = await launch("account.authorization.json", {
  humanize: { enabled: true },
});
```

The enforced monthly plan matrix is Free $0 / 1 process, Basic $19 / 5, Pro $49 /
20, Max $199 / 200 and Ultra $499 / 2,000. The complete signing, authorization,
deployment and rotation procedure is in
[Authorized browser delivery](docs/authorized-release-service.md).

Current browser and symbol releases use `.7z` archives with matching checksum sidecars.
The SDK manages extraction as part of the verified launch flow.

Runtime leases default to a 1500-second TTL with a 120-second heartbeat interval.
Native browser/WebDriver watchdogs exit after a hard authorization denial, or after
10 consecutive transient heartbeat failures while still respecting the signed lease
expiry.

## Humanized interaction

The default WebDriver backend implements Humanize natively inside Sly WebDriver. It
uses trusted mouse and keyboard input, curved non-center pointer paths, variable key
timing, click holds, and short thinking pauses:

```ts
import { launch } from "slybrowser";

const browser = await launch("account.authorization.json", {
  humanize: {
    enabled: true,
    preset: "careful",
    seed: 42424, // omit outside reproducible tests
  },
});
```

`humanize.seed` exists for repeatable regression tests. Production sessions should
omit it. Adapters do not silently replace native Humanize with a language-local
algorithm; unsupported browser builds fail closed. The native WebDriver capability
and production browser/driver validation model are documented in
[Native WebDriver Humanize and runtime pairing](docs/webdriver-humanize-and-pairing.md).

## Development status

The shared contracts and Python, Node.js, Java and .NET SDK source are present. Latest
local source-level verification on 2026-09-01: Node.js SDK 66 passed, Python SDK 60
passed, Java SDK 27 passed with 2 runtime-only cases skipped, and .NET SDK 30 passed.
The skipped Java runtime cases remain `not_evaluated`; these local results do not
replace real packaged Browser/Driver or three-platform release evidence. The four-language
Native Humanize score parity gate is implemented and blocks any non-Node SDK that
scores below Node before refreshed runtime scores are published. Windows, Linux and
macOS x64/arm64 are the release matrix; 32-bit x86 packages are not offered. Public
download still depends on a signed, catalog-published artifact for the exact tuple.
The supported native settings and explicit gaps are
listed in
[Native profile configuration](docs/profile-configuration.md).

The public benchmark summary records selected successful evidence in
[the latest public comparison](docs/benchmark-latest.md). This is development evidence,
not a claim that every website or protection service will accept a session.

Internal commercial research, payment-service implementation and launch-readiness
planning are maintained outside this public SDK repository. Public package names,
prices, features and concurrency limits come only from
[`contracts/plans.json`](contracts/plans.json). Production checkout remains gated by
approved legal terms and a deployed payment webhook.

Native browser launch targets are Windows x64/arm64, Linux x64/arm64/Docker and macOS
x64/arm64. Windows x86 and Linux x86 packages have been removed from SDK selection,
release manifests and private build orchestration.
Each target is published only after its signed browser/WebDriver artifact, manifest
hashes and smoke qualification pass. Node.js, Python, Java and
.NET SDK contracts have cross-platform CI matrices. See the
[supported platform and runtime matrix](docs/support-matrix.md).

Commercial policy drafts are tracked in [docs/legal-policies.md](docs/legal-policies.md):
Free can be used long term, Max/Ultra are self-serve, paid renewal has no grace
period, and completed full refunds immediately end the paid entitlement. The local
license file is an account credential; plan, concurrency and release-version access
are resolved by the server at launch/heartbeat time. Unexpired Free accounts receive
the configured Free release window, which defaults to the latest Stable package.
Expired paid accounts return `license_plan_expired` and receive no package.

The benchmark can run through Playwright, Node.js/TypeScript Puppeteer, or the
project's explicitly selected, self-built W3C WebDriver. The strongest comparison
script records SlyBrowser and stock results for both framework bindings, while native
Humanize remains on the WebDriver run until a shared native control plane is available.
Setup and evidence rules are in
[Detection benchmark](docs/detection-benchmark.md).

## Responsible use

Use SlyBrowser only on systems and websites you own or are authorized to automate.
Credential attacks, unauthorized access, fraud, and evasion of access controls are not
supported. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Independence notice

SlyBrowser is an independent project built from Chromium source. It is not Google
Chrome, is not affiliated with Google, and does not ship Google Chrome branding.
Chromium and Google Chrome are trademarks of their respective owners.
