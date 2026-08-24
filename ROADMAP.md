# Roadmap

Last updated: 2026-08-22

Current execution order:

1. Finish basic product capability and automation evidence.
2. Finish license development with local/test license files before payment is involved.
3. Connect payment and commercialization to the same license system.
4. Run security checks, full regression/benchmark testing and launch readiness.

Linux/WSL packaging is deferred for the current batch and is not a blocker for the
license, payment or security workstreams.

## Phase 1 — Brand and repository

- [x] Confirm SlyBrowser name and icon.
- [x] Establish Python, Node.js, and .NET package layout.
- [x] Define shared launch and signed-release manifest schemas.
- [x] Document source, binary, third-party, and trademark license boundaries.

## Phase 2 — SDK and automation

- [x] Implement browser discovery and signed-manifest/artifact verification.
- [x] Implement authorized newest-compatible binary download, verified cache and
  automatic cache repair.
- [x] Add exact version pinning and explicit at-or-before rollback selection in the
  public SDK API and CLI.
- [x] Implement Python Playwright launch adapters.
- [x] Implement Node.js Playwright and Puppeteer launch adapters.
- [x] Add .NET launch-plan and lease-verification source.
- [x] Compile and test .NET with an installed .NET SDK.
  Evidence: 2026-08-22 `dotnet test packages/dotnet/tests/SlyBrowser.Tests/SlyBrowser.Tests.csproj --configuration Release`
  passed 19/19 on .NET SDK 8.0.424, including v2 runtime credential flow, runtime
  handoff-file coverage and fail-closed runtime secret rejection.
- [x] Implement deterministic packaging and release-validation scripts.
  Evidence: 2026-08-22 `node --test tests/release/*.test.mjs` verified unsigned
  manifest generation, Ed25519 signing, SBOM/provenance/patch inventory evidence, and
  release-bundle qualification.
- [x] Add Python, Node.js, launch-contract, license, and scoring tests.
- [x] Make the project-built WebDriver the Python and Node.js default and move its
  Humanize click/typing implementation into the native driver.
- [x] Map all 29 legacy profile parameter groups through the public contract and native parser, with 13 stable groups verified end to end.
- [~] Add end-to-end SDK-to-private-browser configuration tests (development-browser handoff added; full signed framework matrix remains).
  Current focus 2026-08-22: signed private-browser license-only evidence is now
  available; continue closing the headed/headless WebDriver, Playwright and Puppeteer
  evidence without depending on Linux/WSL packaging.
  Progress: signed test leases can now be generated from an external Ed25519 test
  private key, scripts and all four SDK handoff paths harden Windows ACLs fail-closed,
  all four SDKs expose the v2 runtime session/download/activation credential flow,
  their installers can use v2 runtime grants for download-token cache installation,
  all four launchers can write protected `--sly-runtime-file` handoffs without exposing
  tokens in command arguments, Java Maven reported 18 tests total with 1 conditional
  integration skip and 0 failures, .NET Release passed 19/19, and Node/Python local
  SDK validation remains green. A local enforcement-enabled private browser/WebDriver
  license-only matrix passed 8/8 via
  `scripts/browser/Test-SignedPrivateBrowserLicenseOnly.ps1`.

## Phase 3 — Browser license enforcement

- [ ] Finalize the commercial binary license with the project owner and counsel.
- [x] Implement Ed25519 signed short-lived lease validation in each SDK and Chromium.
- [x] Integrate browser-side verification without embedding private keys.
- [x] Gate the project WebDriver with a separate one-time lease copy and bind production
  drivers to the exact sibling browser name and SHA-256.
- [x] Add 15 focused native validity, signature, claim, version, feature, device, ACL, and file tests.
- [x] Implement and test the single-authority license service, authorization generation,
  protected artifact route, revocation state and all five concurrency limits.
- [ ] Deploy the service and protected signing keys; complete a production key-rotation drill.
- [ ] Enable enforcement in a production build and migrate the Windows handoff to inherited handles.
  Progress: local signed-test builds now have a repeatable public-key configuration
  path via generated GN metadata. A local enforcement-enabled private build now passes
  signed license-only browser/WebDriver startup checks, but production signing,
  inherited-handle/pipe handoff and production key deployment remain open.
- [x] Add service expiry, downgrade, concurrency and cache-corruption tests.
- [ ] Add native runtime-renewal, clock-rollback and separately designed offline tests.
  Next license focus 2026-08-22: kernel-side watchdog, paid-feature anti-tamper and
  license-only Node/Python/Java/.NET integration with test-issued license files.
  Watchdog design note: service-side release with Bootstrap authorization and the
  Node/Python/Java/.NET v2 runtime clients plus protected SDK runtime handoff files are
  implemented. Native C++ now consumes a one-time `--sly-runtime-file`, rejects secret
  or unknown runtime fields, binds session/version to the signed lease and deletes the
  handoff after read. Native activation/heartbeat grant verification now checks
  service response schema, startup/session binding, runtime-token placement and renewed
  lease signatures. Native `RuntimeWatchdog` now stores the runtime service URL and
  bootstrap token in browser/WebDriver native state, builds Bootstrap activation
  requests, accepts verified runtime tokens only from activation responses, and builds
  Runtime heartbeat/close/release requests; the remaining implementation step is native
  network activation plus browser/WebDriver-owned heartbeat/exit behavior.

## Phase 4 — Full verification

- [x] Build the private Chromium checkout in the current development configuration.
- [x] Run the focused native license test target.
  Evidence: 2026-08-22 `sly_license_unittests.exe` now passes 30/30 after adding
  runtime handoff, activation/heartbeat grant verification and native
  `RuntimeWatchdog` request/state coverage.
- [x] Run all 1,063 project WebDriver unit tests, including native Humanize and runtime
  pairing rejection cases.
  Evidence: 2026-08-22 `chromedriver_unittests.exe` passed 1,063/1,063; native
  Humanize runtime smoke passed 11 scenarios.
- [x] Run the 6-case all-parameter native profile target and browser/window/Worker/network handoff E2E test.
- [x] Run the Playwright CDP page/popup/iframe/Worker/persistent-context matrix
  against the rebuilt Windows development browser and stock Chrome.
  Evidence: 2026-08-22
  `artifacts/test-results/compatibility/playwright-cdp-consistency-20260822-162602.json`
  passed; SlyBrowser recorded 0 `Error.prepareStackTrace` accesses on all checked
  surfaces while stock Chrome recorded 1 on each checked surface.
- [x] Run the signed private-browser license-only browser/WebDriver matrix.
  Evidence: 2026-08-22
  `artifacts/test-results/license-only/signed-private-browser-20260822-092858`
  passed 8/8 cases: valid signed browser launch, missing/tampered browser lease
  fail-closed, missing WebDriver lease fail-closed, dual browser/WebDriver lease
  launch, missing browser lease fail-closed, unpaired system browser rejection and
  native runtime handoff startup.
- [ ] Run the full affected `components_unittests` and `browser_tests` targets.
- [x] Run the 40-entry public/local detection suite against stock and SlyBrowser builds.
- [ ] Repeat against the same Chromium major and an available CloakBrowser binary.
- [ ] Run owner-controlled reCAPTCHA, Turnstile, and ShieldSquare verification endpoints.
- [ ] Resolve Chromium third-party metadata/license scan failures.
- [ ] Produce a machine-readable and human-readable release qualification report.
