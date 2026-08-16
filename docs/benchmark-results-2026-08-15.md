# SlyBrowser engineering audit — 2026-08-15

This document records current implementation evidence, the live detection run, and the
gap to the local CloakBrowser reference repository. It is an engineering snapshot, not
a release qualification or a guarantee that an unrelated service will accept a
session.

## Executive verdict

SlyBrowser has reached a usable development baseline: the public SDK contracts exist,
Python and Node.js tests pass, the private Chromium build completes, native lease
verification is integrated before the private profile service, and a repeatable
40-entry detection harness produces JSON, screenshots, and comparison reports.

It is not production-ready. All 29 inherited VB parameter groups now cross the public
contract and native parser; 13 stable groups are verified end to end. The largest
remaining blockers are two inherited parser-only fields and
other product features, license enforcement and service work, incomplete full
Chromium tests, third-party license-scan failures, and unverified protected-service
results.

## Build and test evidence

| Item | Evidence | Status |
| --- | --- | --- |
| Browser build | `SlyBrowser.exe` 148.0.7778.179, 4,067,328 bytes | PASS |
| Browser SHA-256 | `83ef4f90248ceaf58876ccd17204d34e9b51669b09c90394a4492832b997b5ed` | Recorded |
| Native core DLL | `chrome.dll`, 281,036,800 bytes, SHA-256 `72ec740cdc1b728c09d3a4ac71ce58a89b2245508deaaea9baff9053a92db061` | Recorded |
| Browser product branding | Product, description, internal name, original filename, executable, UI strings, installer identity, and icon are SlyBrowser | PASS |
| Project WebDriver unit tests | `chromedriver_unittests`: 1062/1062, including SlyBrowser pairing and Humanize | PASS |
| Native license tests | 15/15 in `sly_license_unittests` | PASS |
| Native profile parser tests | 6/6; all 29 groups converted and reparsed by inherited `FingerInfo` | PASS |
| Native profile handoff E2E | All 29 groups configured; 13 stable groups asserted across browser, window, Worker, and network | PASS |
| Browser main integration | `chrome_browser_main.obj` and full browser build | PASS |
| Python SDK | 12/12 tests | PASS |
| Node.js SDK | 14/14 tests plus TypeScript check | PASS |
| Detection scorer and WebDriver harness | 14/14 unit tests | PASS |
| .NET SDK | Source and tests exist; no .NET SDK installed locally | NOT RUN |
| Full Chromium affected tests | `components_unittests`/`browser_tests` not completed | NOT RUN |
| Chromium dependency license scan | Nine metadata/license problem groups | BLOCKED |

The focused C++ JSON evidence is under `artifacts/test-results/cpp`. Detection evidence
is under `artifacts/test-results/detection/live-20260815`; that directory is ignored
because it contains machine fingerprint and network data.

## Detection benchmark result

The run used the same Windows host, network, test definitions, and time window, but not
the same browser major. Stock Chrome was 153 while SlyBrowser was 148, so the score is a
development comparison rather than a controlled parity claim.

| Metric | SlyBrowser 148 | Stock Playwright / Chrome 153 |
| --- | ---: | ---: |
| Coverage-adjusted score | 75.73 | 72.11 |
| Raw score among completed graded checks | 83.99 | 72.11 |
| Required coverage | 90.16% | 100.00% |
| PASS / FAIL / ERROR / EVIDENCE / SKIP | 5 / 4 / 11 / 17 / 3 | 3 / 7 / 11 / 16 / 3 |

SlyBrowser passed the local core-signal probe, local render stability, Sannysoft,
BrowserScan, and Intoli. The core probe recorded `navigator.webdriver=false`, five
plugins, a Chrome object, no `HeadlessChrome` UA token, and no tested common CDP globals.

Current scored failures are:

| Check | Score | Evidence-backed cause |
| --- | ---: | --- |
| Context consistency | 91.7 | Main/iframe language `en-US`; worker language `zh-CN` |
| Incolumitas | 94.4 | `inconsistentWebWorkerNavigatorPropery` and `WEBDRIVER`; behavioral score 0 |
| Device & Browser Info | 75.0 | `isBot=true` and `isAutomatedWithCDP=true` |
| Fingerprint web-scraping demo | 0.0 | Page reported blocked/no content for both tested browsers |

The context-consistency row above belongs to the original 40-entry run. After the
native profile handoff and `ua-language` mapping were fixed, a targeted rerun recorded
100/100 for both `local-core-signals` and `local-context-consistency`: window, iframe,
and Dedicated Worker all reported `fr-FR`; the request header was
`fr-FR,fr;q=0.9`, and the profile file was consumed and deleted. The final-build
evidence is under `artifacts/test-results/detection/profile-e2e-final-20260815` and
`artifacts/test-results/cpp/native-profile-final-20260815.json`. This targeted evidence
does not replace or recalculate the saved full-run score.

The SlyBrowser reCAPTCHA page returned no parseable score, so it is correctly retained
as `EVIDENCE`, not converted into a zero. The stock run returned 0.9 on that occasion.
This demonstrates why a historical marketing value cannot replace a same-run result.

Official Turnstile dummy keys produced the expected dummy tokens and are evidence-only.
The owner-controlled Turnstile non-interactive, Turnstile managed, and ShieldSquare
tests were skipped because no authorized endpoint URLs were configured. Eleven
BrowserLeaks pages returned `net::ERR_CONNECTION_CLOSED` for both browsers; those are
runner/network errors without numeric scores and are not treated as detection failures.

TLS evidence shared the HTTP/2/Akamai hash
`52d84b11737d980aef856699f885ca86`, while JA3, JA4, and Peetprint differed. Because the
browser majors differ, this cannot establish either TLS parity or a SlyBrowser defect.

### Project WebDriver validation

The open-source W3C runner was previously validated against the matching project
browser and `chromedriver.exe`, both reporting `148.0.7778.179`. That live evidence
predates the final SlyBrowser branding rebuild; rerun the live benchmark before using
its recorded binary hashes as release evidence.

| Metric | Self-built W3C WebDriver run |
| --- | ---: |
| Test definitions entered | 40/40 |
| Coverage-adjusted score | 78.37 |
| Raw score among completed graded checks | 86.92 |
| Required coverage | 90.16% |
| PASS / FAIL / ERROR / EVIDENCE / SKIP | 6 / 3 / 12 / 16 / 3 |

The local core, context-consistency, and render-stability checks all scored 100.
BrowserScan and Intoli also scored 100; Incolumitas scored 97.2 and Device & Browser
Info scored 85.7. Eleven errors were the same `ERR_CONNECTION_CLOSED` condition across
BrowserLeaks pages, and Whoer exceeded the configured 20-second navigation timeout.
These are coverage losses, not invented bot-detection failures.

### Full WebDriver-to-WebDriver comparison

A later sequential run used the same 40 definitions through each product's own bundled
WebDriver. SlyBrowser 148 used project defaults. The installed keyless CloakBrowser 146
used all binary fingerprint behavior available to that build: seed 42424, Windows
persona, GPU allowance, locale/timezone binary flags, and its wrapper's two documented
switch exclusions. No Cloak entitlement was configured, so current 150/Pro-only
features were not present.

| Metric | SlyBrowser 148 | CloakBrowser 146 |
| --- | ---: | ---: |
| Coverage-adjusted score | 87.22 | 66.73 |
| Raw completed score | 87.22 | 74.01 |
| Coverage | 100.00% | 90.16% |
| Common completed graded checks | 86.92 | 74.01 |
| PASS / FAIL / ERROR / EVIDENCE / SKIP | 7 / 3 / 12 / 15 / 3 | 4 / 5 / 12 / 16 / 3 |

On the common completed checks, SlyBrowser led by 12.91 points. BrowserScan contributed
10.91 points of that difference (Normal/100 versus Robot/0), and the local core probe
contributed 2.91 points because Cloak's bundled WebDriver injected seven `cdc_` globals.
Cloak recovered 0.91 points on Device & Browser Info (92.9 versus 85.7). Both tied on
context/render consistency, Sannysoft, Incolumitas, Fingerprint scraping, and Intoli.
Sly's final reCAPTCHA page returned 0.9; Cloak returned 0.9 in one full repetition and
no parseable value in the final repetition, so the fair common-check score excludes it.

## Script coverage for the requested services

| Requested claim/check | Harness implementation | Current verification |
| --- | --- | --- |
| reCAPTCHA v3 | `recaptcha-v3` adapter parses a 0.0–1.0 score | Sly score unavailable; evidence only |
| Turnstile non-interactive | Authorized configurable-verdict entry | Endpoint not configured |
| Turnstile managed | Authorized configurable-verdict entry | Endpoint not configured |
| ShieldSquare | Authorized configurable-verdict entry | Endpoint not configured |
| Fingerprint bot detection | Fingerprint web-scraping adapter | Both runs blocked |
| BrowserScan | Machine-readable BrowserScan adapter | Sly PASS 100 |
| Incolumitas | Named checks plus behavioral evidence | Sly FAIL 94.4 |
| Device & Browser Info | Named boolean bot flags | Sly FAIL 75 |
| `navigator.webdriver`, plugins, Chrome object, UA, CDP globals | Local deterministic core probe | Sly PASS 100 |
| TLS/HTTP2 | Peet JSON fingerprints and same-major parity rule | Evidence; majors differ |

The entry points are:

- `scripts/browser/Test-DetectionPages.ps1` for live/local collection;
- `scripts/browser/Test-DetectionPagesWebDriver.ps1` for the same definitions through the explicitly selected project `chromedriver.exe`;
- `scripts/browser/Compare-DetectionResults.ps1` for saved-run comparison;
- `scripts/browser/Rescore-DetectionResults.ps1` for methodology-only recalculation;
- `tests/detection/sites.json` for the 40 test definitions;
- `tests/detection/run.mjs` and `run-webdriver.mjs` for Playwright and W3C WebDriver collection;
- `tests/detection/score.mjs` and `compare.mjs` for shared scoring and reporting.

The harness does not solve CAPTCHAs or target unapproved production services. Protected
service checks require an endpoint owned by or explicitly authorized for the tester.

## CloakBrowser reference comparison

The local CloakBrowser repository exposes an MIT SDK around a proprietary browser
binary. Its public README claims 71 source-level patches and the detection values cited
in the project brief. The checkout does not distribute that binary, but a locally
cached CloakBrowser Free 146 build was available for an additional 12-entry run.
Against the identical saved definitions, SlyBrowser 148 through its project WebDriver
scored 79.34 and CloakBrowser Free 146 scored 78.85, both at 100% coverage. The +0.49
SlyBrowser difference came from Incolumitas (97.2 versus 94.4); both scored 100 on the
local core probe and BrowserScan, 85.7 on Device & Browser Info, and 0 on the
Fingerprint scraping demo. Because browser majors and automation transports differ,
this is directional evidence, not a same-major competitive claim. It must not be mixed
with the separate 40-entry score above.

| Capability | CloakBrowser reference | SlyBrowser now | Gap |
| --- | --- | --- | --- |
| Python launch API | Sync, async, context, persistent context | Project WebDriver is the sync/context-manager default; Playwright sync, async, and persistent adapters remain explicit | Async WebDriver wrapper remains optional |
| Node launch API | Playwright and Puppeteer | Project WebDriver is the default; Playwright and Puppeteer remain explicit adapters | Core present |
| .NET client | Community client and CLI | Source and tests, not compiled locally | Validation |
| Native signal patches | Publicly claims 71 patch groups | Existing private build passes core probe | Inventory/parity unproven |
| Profile configuration | Proxy, locale, timezone, viewport, GeoIP, WebRTC, storage and more | All 29 VB groups mapped; 13 stable groups E2E verified | `media` and `mac` remain inherited parser-only fields; component-specific E2E remains |
| Human interaction layer | Mouse curves, typing, scroll, actionability | WebDriver trusted curved pointer/click and per-character typing implemented; framework adapters also support Humanize | Broader actionability and scrolling parity remains |
| Persistent profiles/extensions | Implemented | Persistent launch exists; extension workflow absent | Medium |
| Binary delivery | Auto-download, cache, update, signed checksums | Signed manifest/artifact verification only | Large |
| CLI | Install/info/update/cache/login/logout | Doctor reports the default project-WebDriver backend, resolved driver path, and browser/driver availability | Install/update/cache/login remain |
| License flow | Key validation, tiers, session/error handling | Strong lease verifier and gate; no service/enforcement | Large |
| Docker and platform packaging | Dockerfile and multi-platform workflow | Not implemented | Large |
| Widevine support | Sideload/fetch and hint seeding | Not implemented | Optional |
| Font/GeoIP diagnostics | Implemented | Not implemented | Medium |
| Detection evidence | Public claims/screenshots and tests | Reproducible 40-entry JSON/screenshot harness | Sly auditability advantage |
| Source boundary | MIT SDK, proprietary binary | MIT SDK/scripts/docs, private C++, separate binary terms | Equivalent model |

## License implementation status

The private component verifies Ed25519 envelopes, allowlisted key IDs/algorithm,
audience, time bounds and maximum lifetime, browser range, required features, optional
device binding, file size/path rules, Windows owner/DACL/reparse-point policy, and
one-time consumption. It is called before the private profile/fingerprint service.
Signing private keys are not present in the SDK, scripts, Chromium source, or build
arguments.

Production blockers remain:

- `sly_license_enforcement_enabled` is false and no production public key is injected;
- no license service, protected signer, rotation, revocation, or concurrent-session
  authority is deployed;
- a future inherited-handle handoff is still preferred to eliminate the remaining
  pathname race;
- replay, clock rollback, server revocation/concurrency, and offline-policy tests remain;
- commercial binary terms are still a draft pending legal entity, jurisdiction, and
  product terms.

## Release blockers and ordered work

### P0 — make the current product internally coherent

1. Harden native profile runtime coverage. `--sly-config-file` now securely consumes
   and maps all 29 inherited VB groups, including encoded proxy credentials/bypass and
   a browser-process geolocation override; add runtime consumers for inherited
   parser-only `media`/`mac` only if a real product requirement exists, and extend
   component-specific E2E coverage. Device scale and complete WebRTC shutdown are not
   inherited VB capabilities and are intentionally rejected.
2. Keep release packaging and smoke tests aligned with the verified
   `SlyBrowser.exe` product resources and embedded SlyBrowser icon.
3. Worker language inheritance is fixed in the targeted E2E run; fix the remaining
   Incolumitas/CDP findings and repeat the complete 40-entry run.
4. Build a same-major stock baseline before making TLS or score comparison claims.

### P0 — release and legal gates

5. Resolve the Chromium scanner findings for Catapult, Cookie Editor, Crashpad zlib,
   Dawn GN, DevTools Chromium, Perfetto Chromium/pprof, Rust, and SwiftShader Marl from
   authoritative upstream metadata. Do not fabricate notices.
6. Finalize the binary license; deploy protected signing/lease infrastructure; enable
   production enforcement; complete Windows handoff hardening.
7. Complete the affected Chromium unit/browser targets and validate .NET on a machine
   with the SDK installed.

### P1 — comparable service evidence

8. Add owner-controlled server verification for reCAPTCHA v3 and authorized Turnstile
   and ShieldSquare fixtures, then repeat from clean profiles under one browser major.
9. Add a real CloakBrowser binary target only after the owner supplies or authorizes
   one; never import README claims as measured scores.
10. Diagnose BrowserLeaks connectivity separately from detection scoring.

### P1/P2 — close product-experience gaps

11. Implement signed binary download/cache/update/rollback and fuller CLI diagnostics.
12. Add native GeoIP/proxy/WebRTC end-to-end tests, extension workflow, font checks,
    Docker packaging, and then the optional human-interaction and Widevine layers.

Until the P0 items are complete, release notes should say “development build” and link
to captured evidence rather than claim that all detection sites pass.
