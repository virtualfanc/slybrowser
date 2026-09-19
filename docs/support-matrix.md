# Supported platforms and runtimes

SlyBrowser publishes a finite support boundary. SDK portability does not imply that a
native browser binary exists for the same operating system.

## Browser and project WebDriver

| Target | Status | Qualification boundary |
| --- | --- | --- |
| Windows x64 | Private-preview supported | Clean local build, native profile handoff, project WebDriver, persistent/ephemeral profile and stock-browser API parity tests |
| Windows arm64 | Package-capable, catalog-gated | Build matrix and SDK architecture selection are wired; public download still requires signed artifact and clean-machine qualification |
| Linux x64 | Launch target | Requires signed Linux x64 browser/WebDriver artifact, clean-machine smoke and Docker qualification before public download |
| Linux arm64 | Package-capable, catalog-gated | Build matrix and SDK architecture selection are wired; public download still requires signed artifact and clean-machine or container qualification |
| macOS x64/arm64 | Launch target | Requires signed macOS artifacts, Gatekeeper/quarantine handling, profile smoke and framework adapter qualification before public download |
| Docker image | Launch target | Backed by the signed Linux x64 artifact and blocked until container DNS and runtime smoke passes |

The first public release does not support proxy routing or GEO/geolocation.
SDKs and release tests must reject those options instead of implying a partially
working direct-network fallback.

The release service selects only an artifact that exactly matches the requested
platform and architecture. 32-bit x86 architectures are unsupported; a missing tuple fails with
`release_version_unavailable`; the SDK never substitutes a different platform,
architecture, browser version, system Chrome installation or driver from `PATH`.
Current public scripts may specify an exact browser version or kernel major; the
service still enforces the plan-scoped release window for that account.

## Public SDK runtime matrix

| SDK | Tested runtime matrix | Status |
| --- | --- | --- |
| Node.js | 20, 22 and 24 on Windows, Ubuntu and macOS | CI contract support |
| Python | 3.10, 3.12 and 3.14 on Windows, Ubuntu and macOS | CI contract support |
| Java | 11, 17 and 21 on Windows, Ubuntu and macOS | Local Java 11 tests pass; signed browser score matrix is parameterized and skipped without a lease |
| .NET | 8, 9 and 10 SDKs on Windows, Ubuntu and macOS | Local .NET 8 tests pass; signed browser score matrix is parameterized and gated by lease |

Playwright is declared for all four SDKs. Puppeteer is declared only for
Node.js/TypeScript because the upstream project is a JavaScript API. The exact
framework binding lines are maintained in
[`contracts/automation-backends.json`](../contracts/automation-backends.json).
Java and .NET use pinned Selenium W3C client bindings for the default project
WebDriver API, but they start only the caller-supplied project driver and never invoke
Selenium Manager, a driver from `PATH`, or a downloaded fallback.

The cross-platform jobs validate contracts, manifests, license handling, release
selection, WebDriver payloads and pure SDK behavior. Browser-dependent acceptance must
run on each declared launch target before that target appears in the public release
catalog. The Native Humanize SDK score gate treats Node.js as the baseline and requires
Python, Java and .NET to meet or exceed that score before refreshed public runtime
results are published.

## Adding a platform

A platform becomes supported only after all of the following are available for that
exact tuple:

1. A signed browser and matching project-WebDriver artifact.
2. Clean-machine install, launch, update and explicit rollback tests.
3. Native profile, persistent/ephemeral and browser API smoke
   tests.
4. Release signatures, hashes, SBOM, provenance and public patch inventory.
5. A CI job or recorded release qualification artifact for the target.

Until those gates pass, documentation and the release catalog must continue to return
an explicit unsupported diagnostic rather than implying Chromium-wide portability.
