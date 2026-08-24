# Automation backends implementation backlog

Last updated: 2026-08-25

This backlog implements
[the approved automation backend requirements](automation-backends-requirements.md).
P0 items block a public compatibility claim. Status values are `done`,
`partial`, `todo` and `blocked`.

Current planning note 2026-08-25: the Windows x64 production-like native runtime
handoff WebDriver gate, authorized framework headless/headed matrix, and authorized
Playwright CDP/persistent matrix have passed. Linux/WSL packaging remains deferred
and does not block this backlog.

## P0 — contracts and fail-closed launch

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| AUTO-P0-001 | Extend the launch schema to `project-webdriver`, `playwright` and `puppeteer`, keeping project WebDriver as the default. | done | Contract tests reject unknown backends and the compatibility manifest declares Puppeteer only for Node. |
| AUTO-P0-002 | Add a machine-readable framework compatibility manifest for Node, Python, Java and .NET. | done | `contracts/automation-backends.json` and its schema validate framework lines; browser/kernel versions are disclosed only from saved evidence, not from private source paths. |
| AUTO-P0-003 | Enforce the authorized SlyBrowser executable and reject framework/system browser fallback in every adapter. | done | Node, Python, Java and .NET adapters force the supplied SlyBrowser launch plan, reject executable overrides and validate the installed binding line; unit/compile tests pass. |
| AUTO-P0-004 | Apply license concurrency and requested/selected/downloaded/launched audit to every backend. | done | Node authorized WebDriver, Playwright and Puppeteer launches now reserve/release concurrency and expose `requested → selected → downloaded → launched`; Python authorized WebDriver plus sync/async Playwright launch and persistent launch pass the same audit. Java and .NET authorized latest-release clients verify signed manifest/artifact handling, cache install, version audit, v2 runtime credential flow, download-token cache installation and release-on-close behavior; on 2026-08-22 Node passed 44/44, Python 42/42, Java reported 18 tests total with 1 conditional skip and 0 failures, and .NET Release passed 19/19. |

## P0 — language adapters

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| AUTO-P0-010 | Finish Node.js/TypeScript Playwright launch and persistent-context adapters. | done | Unit tests cover handoff, persistent launch, binding-line validation and native Humanize fail-closed behavior. |
| AUTO-P0-011 | Finish Node.js/TypeScript Puppeteer adapter. | done | Unit tests cover normal/persistent launch, binding-line validation and native Humanize fail-closed behavior. |
| AUTO-P0-012 | Finish Python sync/async Playwright launch and persistent-context adapters. | done | Unit tests cover all four launch functions, binding-line validation and native Humanize fail-closed behavior. |
| AUTO-P0-013 | Implement Java project WebDriver entry point plus Playwright adapter in `packages/java`. | done | Java 11 Maven compilation passed; Maven reported 18 JUnit tests total with 1 conditional integration skip and 0 failures, including runtime handoff secret rejection. The W3C client starts only the explicit project driver and never invokes Selenium Manager. |
| AUTO-P0-014 | Implement .NET project WebDriver entry point plus Playwright adapter. | done | .NET 8 Release compilation and 19 xUnit tests pass, including runtime handoff secret rejection. The W3C client starts the explicit project driver process directly and never invokes Selenium Manager. |
| AUTO-P0-015 | Add high-level backend selectors while preserving WebDriver defaults in all four languages. | done | Node/Python `launch`, Java `SlyBrowser.launch` and .NET `SlyBrowserClient.LaunchAsync` select project WebDriver; Playwright/Puppeteer remain explicitly named adapters. |

## P0 — CDP consistency and Humanize

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| AUTO-P0-020 | Audit and correct inspector serialization side effects without disabling normal console/CDP behavior. | done | V8 `error-prepare-stack-trace-side-effect` and upstream `console-methods` inspector tests both pass; the private patch archive no longer disables `console.debug`. |
| AUTO-P0-021 | Add local CDP probes for page, popup, iframe, Worker and persistent context. | done | `playwright-cdp-consistency.mjs` covers the local stock comparison using raw `Runtime.consoleAPICalled` events. `Test-AuthorizedPlaywrightCdpConsistency.ps1` now covers the current authorization path: authorization file, signed release download/cache, runtime handoff, Playwright normal context and persistent context. On 2026-08-25, headless and headed both passed with raw CDP protocol functional, 0 `Error.prepareStackTrace` side effects, webdriver hidden, no automation globals, no headless UA leak, `window.chrome` present, popup/iframe/Worker/ServiceWorker covered and persistent profile restored. Evidence: `E:\multilogin\artifacts\framework-current\20260825-000807\authorized-playwright-cdp-final\authorized-playwright-cdp-20260825-003205\authorized-playwright-cdp.json`. |
| AUTO-P0-022 | Add Playwright and Puppeteer modes to the strongest comparison runner. | done | The runner records a four-way Sly/stock × Playwright/Puppeteer matrix, creates distinct signed handoffs per Sly process and records actual binding versions; a stock local-page smoke passed on both transports. |
| AUTO-P0-023 | Expose one private native Humanize control plane usable by WebDriver, Playwright and Puppeteer. | done | Node/Python/Java/.NET framework adapters pass `humanize` through a short-lived `--sly-humanize-config` native-control handoff; the private browser DevTools Input path reads the same control file for CDP key/mouse timing, and WebDriver continues to use `sly:options.humanize`. On 2026-08-24, the production-like authorized WebDriver Native Humanize matrix passed all four SDKs with score parity. On 2026-08-25, the authorized framework matrix passed Node Playwright, Node Puppeteer, Python Playwright, Java Playwright and .NET Playwright in both headless and headed modes with native Humanize enabled. Evidence: `E:\multilogin\artifacts\detection-current\20260824-231211\sdk-humanize-current\native-humanize-score-parity-20260824-234431.json`, `E:\multilogin\artifacts\framework-current\20260825-000807\framework-matrix-headless-final\authorized-framework-matrix-20260825-002521\authorized-framework-matrix.json`, and `E:\multilogin\artifacts\framework-current\20260825-000807\framework-matrix-headed-final\authorized-framework-matrix-20260825-002823\authorized-framework-matrix.json`. |
| AUTO-P0-024 | Fail closed when native Humanize is requested on a backend that does not advertise it. | done | SDKs no longer install a language-local Humanize substitute; framework adapters only pass native-control handoff files, while unsupported browser builds remain a native capability-gate failure. |
| AUTO-P0-025 | Cover Humanize Page/Frame/Element, DPI, viewport, timeout and seeded trace matrices. | done | Node/Python runtime direction tests and Java/.NET native capability-mapping tests pass; four-language score parity gate is implemented. On 2026-08-24, the production-like authorized WebDriver Native Humanize matrix passed all four SDKs with score parity and covered Page, Frame, element click/type and DPI behavior. On 2026-08-25, the authorized framework matrix passed headless/headed Playwright/Puppeteer launch with deterministic Humanize settings and DPI launch flags across supported languages/backends. Deeper long-duration behavioral trace tuning remains post-launch hardening, not a launch-required compatibility gate. |
| AUTO-P0-026 | Add four-language Native Humanize score parity gating. | done | `Test-NativeHumanizeSdkMatrix.ps1` and the strongest comparison script now collect Node, Python, Java and .NET reports, then fail if any non-Node SDK scores below Node; synthetic pass/fail parity checks pass. |

## P0 — CI and documentation

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| AUTO-P0-030 | Extend CI for Node, Python, Java and .NET supported runtime versions. | done | The workflow now declares Node 20/22/24, Python 3.10/3.12/3.14, Java 11/17/21 and .NET 8/9/10 across three operating systems. |
| AUTO-P0-031 | Add compiled-browser integration jobs for WebDriver, Playwright and Puppeteer. | done | Local runners now cover WebDriver, Playwright, Puppeteer, CDP persistent-context probes and four-language SDK score parity. `Test-AuthorizedFrameworkMatrix.ps1` passed 10/10 production-like framework cases on 2026-08-25: Node Playwright, Node Puppeteer, Python Playwright, Java Playwright and .NET Playwright in both headless and headed modes. `Test-AuthorizedPlaywrightCdpConsistency.ps1` passed headless and headed CDP/persistent probes. Native watchdog network activation/heartbeat/release ownership is covered by the 2026-08-24 production-like watchdog matrix. Full `components_unittests`/`browser_tests` and affected Chromium component fixes remain post-launch hardening rather than this launch-required framework gate. |
| AUTO-P0-032 | Update root/package documentation with backend selection examples and fail-closed guarantees. | done | Root and all four SDK documents describe Playwright; Node also documents Puppeteer and the native Humanize capability gate. |
| AUTO-P0-033 | Update website compatibility claims only after the release gate passes. | done | Framework compatibility claims can now cite saved production-like evidence for WebDriver, Playwright and Node Puppeteer. Current release qualification may use the accepted latest stock baseline; public score-delta superiority claims still require same-major evidence or an explicit cross-major limitation. |

## P1 — follow-up hardening

| ID | Work item | Status | Acceptance evidence |
| --- | --- | --- | --- |
| AUTO-P1-001 | Add reconnect and authenticated remote endpoint coverage. | todo | Reconnect does not change profile or expose a direct unauthenticated endpoint. |
| AUTO-P1-002 | Add framework upgrade qualification automation. | todo | Dependency update opens a compatibility report and cannot widen supported ranges without tests. |
| AUTO-P1-003 | Add SBOM/provenance entries for every language package and optional framework dependency. | todo | Release artifacts identify exact SDK and framework binding inputs. |
| AUTO-P1-004 | Add dated SlyBrowser/Cloak/stock comparison after identical best-mode configurations are reproducible. | blocked | Requires live access, captured configuration and evidence review. |

## Implementation order

1. Preserve completed AUTO-P0-001 through AUTO-P0-004 and AUTO-P0-010 through
   AUTO-P0-015 unless contract or SDK code changes invalidate their evidence.
2. Preserve the completed P0 compatibility gates with the saved 2026-08-24 and
   2026-08-25 production-like evidence; rerun the same scripts after every release
   bundle or automation dependency update.
3. Keep public score-delta/competitor win-loss claims blocked until same-major stock
   Chromium evidence exists, unless the page clearly labels the value as cross-major
   informational evidence.
4. Schedule P1 reconnect, upgrade qualification, provenance and competitor comparison
   work after the P0 compatibility claim is evidence-backed.
