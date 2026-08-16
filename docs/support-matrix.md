# Supported platforms and runtimes

SlyBrowser publishes a finite support boundary. SDK portability does not imply that a
native browser binary exists for the same operating system.

## Browser and project WebDriver

| Target | Status | Qualification boundary |
| --- | --- | --- |
| Windows x64 | Private-preview supported | Clean local build, native profile handoff, project WebDriver, persistent/ephemeral profile, proxy fail-closed and stock-browser API parity tests |
| Windows arm64 | Unsupported | No signed browser/WebDriver artifact is published |
| Linux x64/arm64 | Unsupported browser target | SDK contract tests run on Linux; no native browser/WebDriver artifact is published |
| macOS x64/arm64 | Unsupported browser target | SDK contract tests run on macOS; no native browser/WebDriver artifact is published |
| Docker image | Unsupported | No first-party container image or container smoke qualification is published |

The release service selects only an artifact that exactly matches the requested
platform and architecture. A missing tuple fails with
`release_version_unavailable`; the SDK never substitutes a different platform,
architecture, browser version, system Chrome installation or driver from `PATH`.

## Public SDK runtime matrix

| SDK | Tested runtime matrix | Status |
| --- | --- | --- |
| Node.js | 20, 22 and 24 on Windows, Ubuntu and macOS | CI contract support |
| Python | 3.10, 3.12 and 3.14 on Windows, Ubuntu and macOS | CI contract support |
| .NET | Source and unit-test project present | Not yet support-qualified because a local/CI SDK run is still required |

The cross-platform jobs validate contracts, manifests, license handling, release
selection, WebDriver payloads and pure SDK behavior. Browser-dependent acceptance is
run only on the declared Windows x64 browser target.

## Adding a platform

A platform becomes supported only after all of the following are available for that
exact tuple:

1. A signed browser and matching project-WebDriver artifact.
2. Clean-machine install, launch, update and explicit rollback tests.
3. Native profile, persistent/ephemeral, proxy route-integrity and browser API smoke
   tests.
4. Release signatures, hashes, SBOM, provenance and public patch inventory.
5. A CI job or recorded release qualification artifact for the target.

Until those gates pass, documentation and the release catalog must continue to return
an explicit unsupported diagnostic rather than implying Chromium-wide portability.
