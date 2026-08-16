# Roadmap

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
- [ ] Compile and test .NET with an installed .NET SDK.
- [ ] Implement deterministic packaging and release-validation scripts.
- [x] Add Python, Node.js, launch-contract, license, and scoring tests.
- [x] Make the project-built WebDriver the Python and Node.js default and move its
  Humanize click/typing implementation into the native driver.
- [x] Map all 29 inherited VB parameter groups through the public contract and native parser, with 13 stable groups verified end to end.
- [~] Add end-to-end SDK-to-private-browser configuration tests (development-browser handoff added; signed production lease path remains).

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
- [x] Add service expiry, downgrade, concurrency and cache-corruption tests.
- [ ] Add native runtime-renewal, clock-rollback and separately designed offline tests.

## Phase 4 — Full verification

- [x] Build the private Chromium checkout in the current development configuration.
- [x] Run the focused 15-case native license test target.
- [x] Run all 1,062 project WebDriver unit tests, including native Humanize and runtime
  pairing rejection cases.
- [x] Run the 6-case all-parameter native profile target and browser/window/Worker/network handoff E2E test.
- [ ] Run the full affected `components_unittests` and `browser_tests` targets.
- [x] Run the 40-entry public/local detection suite against stock and SlyBrowser builds.
- [ ] Repeat against the same Chromium major and an available CloakBrowser binary.
- [ ] Run owner-controlled reCAPTCHA, Turnstile, and ShieldSquare verification endpoints.
- [ ] Resolve Chromium third-party metadata/license scan failures.
- [ ] Produce a machine-readable and human-readable release qualification report.
