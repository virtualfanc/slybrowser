# SlyBrowser business model customization — 2026-08-16

Status: the owner-selected package matrix is now the product contract. The entitlement,
download and concurrency implementation exists and is tested locally. Public checkout
still requires approved binary terms, a deployed TLS service, protected production
keys, signed browser artifacts and a verified payment webhook.

## Product decision

SlyBrowser is an open-core native Chromium automation runtime with its own matched W3C
WebDriver. SDKs, contracts, tests and operational scripts are MIT-licensed; modified
Chromium C++ and distributed browser binaries remain private/proprietary subject to the
binary terms and upstream third-party licenses.

All five plans receive the same browser, project WebDriver, Humanize implementation,
supported profile contract and security updates. Plans meter peak browser-process
concurrency, not profiles, tabs, browsing hours or deliberately weaker browser quality.

## Approved package matrix

| Plan | Promotional monthly price | Concurrency | Price per concurrency/month | Primary use |
| --- | ---: | ---: | ---: | --- |
| Free | $0 | 1 | $0 | Evaluation, development and small internal workflows |
| Launch | $19 | 5 | $3.80 | Independent developers and focused automation |
| Studio | $49 | 20 | $2.45 | Product, QA and data teams |
| Fleet | $199 | 200 | about $1.00 | Production browser operations |
| Grid | $499 | 2,000 | about $0.25 | High-scale distributed automation |

One browser operating-system process consumes one concurrent session. Tabs and browser
contexts inside that process do not. Local profile directories remain unlimited and
customer-owned. Local browser hours are not metered because customers fund compute.
OEM/SaaS redistribution, white-label, hosted service and third-party embedding rights
are not implicitly included and require a separate agreement.

## Shared features and differentiation

Every plan includes:

- the newest compatible verified Stable Chromium release;
- its exact hash-matched Sly WebDriver;
- Node.js and Python SDKs, with .NET source remaining preview-quality;
- native Humanize behavior and supported profile controls;
- signed release manifests, per-file SHA-256 validation and cache repair; and
- persistent profiles plus explicit Playwright/Puppeteer adapters.

Commercial differentiation may cover concurrency, organization/admin controls, release
channels, support response, rollout assistance and operational visibility. Security
fixes and native consistency must not be withheld from Free.

## Implemented commercial controls

The repository now contains:

- an authorization generator that creates a random 256-bit credential and writes an
  exclusive private JSON file;
- an HMAC-peppered credential store that never stores the plaintext secret;
- exact Free/Launch/Studio/Fleet/Grid plan definitions;
- transactional concurrency reservation, heartbeat, release, orphan expiry, hold,
  revocation, paid-through fallback and downgrade enforcement;
- short-lived Ed25519 session leases for the exact browser version;
- selection of the latest compatible signed Stable manifest;
- session-authorized, same-origin, no-redirect artifact delivery;
- safe ZIP install and a verified cache in Node.js and Python;
- signed hashes for archive, browser and project WebDriver, checked before every load;
- automatic use of the downloaded project WebDriver as the SDK default; and
- tests at every N/N+1 plan boundary, including Grid 2,000/2,001.

The implementation and deployment commands are in
[Authorized browser delivery](authorized-release-service.md).

## Cancellation, renewal and failure policy

A cancellation keeps paid capacity until the paid-through timestamp, then falls back to
Free at one process. Local profiles are not deleted. If the service cannot be reached,
an already issued lease remains valid only through its signed expiry; new processes do
not receive unbounded grace. A normal close releases capacity immediately and a crash
is reclaimed after the session TTL.

The payment service is not an entitlement authority. Verified, idempotent PayNow
activation/renewal/cancellation/refund/chargeback webhooks must update the license
service. Browser redirects alone must never grant a plan. See
[PayNow integration](paynow-integration.md).

## Privacy and security boundary

License operations may retain account/license ID, plan, platform, architecture, browser
version, redacted device/install identity, active session timestamps and operational
errors. They must not collect URLs, page content, cookies, credentials or profile
configuration.

Public SDK source cannot provide copy-proof DRM. It cannot forge a valid Ed25519 lease
or reserve above the server limit, but a modified client can refuse cooperative close.
Signed lease expiry and server TTL bound that behavior. Strong adversarial enforcement
requires a private native browser/driver renewal watchdog; this is release hardening,
not a claim that local binaries can never be copied.

## Production gates

Before enabling public checkout:

1. approve the binary license, privacy terms, acceptable-use terms, refund policy,
   taxes, trademark language and support ownership;
2. deploy one authoritative TLS license service with protected lease key, release key,
   HMAC pepper, admin token, backup and monitoring;
3. publish a signed Windows browser/WebDriver ZIP through the protected artifact route
   and qualify a clean-machine install/update/rollback;
4. connect verified PayNow webhooks and reconcile billing state to entitlements;
5. load-test simultaneous N/N+1 reservation and heartbeat behavior at intended scale;
6. use PostgreSQL or another shared transactional authority before multiple service
   nodes—independent SQLite replicas are forbidden; and
7. complete production key-rotation, revocation, disaster-recovery and incident drills.

Free and Launch can be staged first, but the configured limits and prices must stay
identical across website, checkout, account UI, authorization service and documentation.
Fleet and Grid should not be publicly promised until the production topology has passed
multi-node capacity and artifact-delivery load tests.
