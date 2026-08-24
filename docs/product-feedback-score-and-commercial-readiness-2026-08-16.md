# SlyBrowser product feedback, benchmark and commercial-readiness review

Date: 2026-08-16  
Audience: product owner  
Decision status: Cloak-derived requirements await confirmation; no implementation was
started from those requirements.

## Executive summary

Three conclusions are decision-relevant:

1. Public CloakBrowser feedback clusters around consistency, proxy fail-closed safety,
   CDP/persistent-context reliability, exact version delivery and binary trust. Six P0
   requirements are proposed for confirmation; public reports are discovery evidence,
   not automatically proven defects.
2. The website now uses the saved paired 40-entry run: **SlyBrowser score 75.73 versus
   stock Chromium score 72.11** on coverage-adjusted score. The saved browsers use different major
   release lines, so this is directional operational evidence rather than a same-major
   fingerprint or TLS claim.
3. The package contract and much of the entitlement engine exist, but public paid
   launch does not. A transparent launch-gate rubric scores current readiness at
   **54/100**. A manually operated private preview is reasonable; public self-serve
   checkout is not ready.

## Current SlyBrowser versus Chromium evidence

Source: `artifacts/test-results/detection/live-20260815/comparison.json`.

| Metric | SlyBrowser private preview | Stock Chromium / Playwright | Difference |
| --- | ---: | ---: | ---: |
| Coverage-adjusted score | 75.73 | 72.11 | SlyBrowser +3.62 |
| Raw score on completed graded checks | 83.99 | 72.11 | SlyBrowser +11.88 |
| Required coverage | 90.16% | 100.00% | Chromium +9.84 pp |
| Automation-signal category | 100.00 | 60.00 | SlyBrowser +40.00 |
| Bot-detection category | 76.75 | 64.16 | SlyBrowser +12.59 |
| Consistency category | 94.44 | 94.44 | Tie |
| PASS / FAIL / ERROR / EVIDENCE / SKIP | 5 / 4 / 11 / 17 / 3 | 3 / 7 / 11 / 16 / 3 | — |

The website previously displayed 87.22, which belongs to a separate SlyBrowser versus
CloakBrowser WebDriver run. Mixing that value into a Chromium comparison would be
methodologically incorrect. The page now also shows raw score, coverage, outcome counts
and the browser-major caveat so users can interpret the number.

## CloakBrowser feedback converted into requirements

The full evidence map and acceptance boundaries are in
`memory/research/competitor-analysis/2026-08-16-cloakbrowser-issues-reddit-requirements.md`.
The six proposed release blockers are:

| ID | Proposed release-blocking requirement | Why it is prioritized |
| --- | --- | --- |
| CB-P0-01 | Detection-consistency regression matrix | Repeated FPJS, tampering, VM/incognito, GPU and timing-consistency reports show that coherent personas matter more than independent switches. |
| CB-P0-02 | CDP, W3C and persistent-context parity | Public reports span new pages, persistent contexts, window size, click timing and CDP discovery. |
| CB-P0-03 | Proxy fail-closed route integrity | A direct-network fallback can violate the user's explicit security boundary. |
| CB-P0-04 | Exact signed version delivery | The requested, downloaded, entitled and launched browser/driver must be identical and auditable. |
| CB-P0-05 | Humanize compatibility and action coverage | Actionability, page/frame/element parity and supported runtime versions require repeatable tests. |
| CB-P0-06 | Persistent-profile privacy consistency | Persistent storage must work without accidental incognito, VM/font or cross-profile linkage signals. |

P1 proposals cover a declared platform matrix, Geo/locale/timezone alignment, WebAuthn
and dialogs, coherent mobile emulation, entitlement diagnostics, standard remote CDP,
and signed supply-chain evidence. P2 proposals cover first-party agent integrations, a
profile/session manager and per-release public benchmark history.

## Commercial model completion audit

The score below is a release-gate rubric, not a financial KPI or code-coverage metric.
Each category score is multiplied by its stated weight. No revenue, conversion, CAC,
churn, gross-margin or support-cost data is available, so commercial viability is not
being inferred from implementation progress.

| Gate | Weight | Completion | Weighted points | Evidence present | Blocking gap |
| --- | ---: | ---: | ---: | --- | --- |
| Offer and package contract | 15% | 95% | 14.25 | Free/Launch/Studio/Fleet/Grid prices and 1/5/20/200/2,000 concurrency match contracts, service and website. Free is long-term, Fleet/Grid are self-serve, and the same browser-quality baseline is documented. | Validate willingness-to-pay, support cost and burst behavior under production load. |
| Entitlement and runtime control | 25% | 75% | 18.75 | HMAC-peppered credentials, Ed25519 leases, exact-version selection, transactional reserve/heartbeat/release, downgrade and Grid N/N+1 tests exist. | Current private `args.gn` does not enable production browser or WebDriver enforcement/pairing; production keys/service/revocation drills are absent. |
| Authorized delivery and update | 20% | 60% | 12.00 | Signed-manifest and SHA-256 verification, authorized artifact routes, safe Node/Python install/cache and exact project WebDriver selection exist. | No production-signed release, protected artifact host, clean-machine qualification, production rollback exercise or final .NET validation. |
| Billing and entitlement lifecycle | 20% | 70% | 14.00 | Hosted PayNow test checkout, HMAC/timestamp/store verification, idempotency, activation/renewal/cancel ledger, full-order refund revocation and chargeback hold exist. | Production webhook/live payment evidence, chargeback-closed final policy and production deployment remain. |
| Operations, legal and launch controls | 20% | 35% | 7.00 | Deployment samples, topology, privacy boundary and legal policy draft are documented. | Final operating entity, tax/legal review, production monitoring/backups/key rotation/DR, shared PostgreSQL authority, multi-node load tests and incident process are incomplete. |
| **Total launch-gate readiness** | **100%** | — | **66.00 / 100** | Strong local engineering foundation plus confirmed core commercial rules. | Not ready for public paid launch. |

### What is usable now

- Private preview with manually issued Free/Launch entitlements.
- Single-authority local/staging concurrency validation.
- Node.js and Python authorized download, cache, launch and project-WebDriver flow.
- Test-store checkout-entry and separately deployable webhook receiver testing.

### What is not complete

- Account-bound checkout → verified payment → entitlement issuance/reconciliation.
- Chargeback-closed disputed-payment final policy and live evidence.
- Production browser/WebDriver license and sibling-binary pairing enforcement.
- Production signing, artifact hosting, monitoring, backups, rotation and rollback.
- Multi-node Fleet/Grid concurrency authority and scale evidence.
- Effective binary license, privacy/AUP/refund/tax/support terms and customer portal.

## Recommended release gates

1. **Private preview now:** Free and Launch only; manual account/license linking;
   production claims remain disabled; collect workload and willingness-to-pay evidence.
2. **Self-serve Free/Launch/Studio:** require account-bound checkout, idempotent billing
   reconciliation including refunds/chargebacks, signed production artifact, enforced
   browser+driver leases/pairing, clean-machine update/rollback, legal terms, monitoring
   and backup restore proof.
3. **Fleet/Grid:** additionally require one shared transactional authority such as
   PostgreSQL, N/N+1 and multi-node soak tests, rate/abuse controls, support/SLA ownership
   and margin evidence.

## Decisions requested

1. Confirm whether CB-P0-01 through CB-P0-06 become the next release blockers.
2. Decide whether standard remote CDP/agent compatibility is required for the first
   commercial preview.
3. Choose the launch supply-chain disclosure level: signatures+hashes; plus SBOM and
   provenance; or also the complete publishable Chromium patch inventory.
4. Produce launch-target artifacts and smoke evidence for Windows x64, Linux x64/Docker
   and macOS x64/arm64.
5. Confirm that public checkout remains disabled until Gate 2 is complete.

## Caveats and sources

- GitHub issues and Reddit posts are user-reported discovery signals, not confirmed
  incidence rates or independently reproduced defects.
- The two benchmark browsers use different Chromium majors, which weakens TLS and
  version-sensitive comparison claims.
- Live detection services and network availability change; errors remain visible and
  are not silently scored as successes.
- [CloakBrowser issues](https://github.com/CloakHQ/CloakBrowser/issues)
- [CloakBrowser issue #294](https://github.com/CloakHQ/CloakBrowser/issues/294)
- [CloakBrowser issue #157](https://github.com/CloakHQ/CloakBrowser/issues/157)
- [Reddit CloakBrowser discussion](https://www.reddit.com/r/webscraping/comments/1t9g0kr/is_cloak_browser_good/)
- [Reddit CDP integration feedback](https://www.reddit.com/r/opencode/comments/1uz4d34/whats_the_best_way_to_use_opencode_for_browser/)
