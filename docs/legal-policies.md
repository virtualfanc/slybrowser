# SlyBrowser legal policy draft

Status: owner-approved minimal policy for a personal/GitHub-channel launch. Keep only the required pricing/checkout visibility, privacy, refund, acceptable-use, support and binary-distribution terms. Do not add a separate pre-checkout consent checkbox, corporate entity, tax page or custom governing-law clause until the project moves beyond the personal/GitHub channel.

Last updated: 2026-08-24

## Commercial rules

- SlyBrowser is initially distributed through the owner's personal/GitHub channel. Public pages should identify SlyBrowser as a project/product and use the configured support/license email addresses instead of publishing extra personal or company details unless the owner later approves them.
- Supported paid plans are Basic, Pro, Max and Ultra. Max and Ultra are fixed catalog SKUs.
- Free is a long-term plan with one concurrent browser process.
- Enterprise, OEM, SaaS, redistribution, white-label and hosted third-party use are not included in normal paid subscriptions. They are assigned only as needed through a separate owner-approved SKU or written authorization.
- Launch targets are Windows x64, Linux x64/Docker and macOS x64/arm64. A platform must still pass signed artifact, manifest/hash, route-integrity and smoke qualification before public download.

## Refunds and cancellation

- SlyBrowser supports full-order refunds only. Partial refunds and order-line refunds are not exposed in the customer or admin flow.
- A completed full refund immediately ends the paid entitlement for that order, shortens `paidThrough` to the refund completion time and closes active runtime sessions on their next heartbeat. The paid key is not converted to Free; separately issued Free licenses remain available.
- Cancellation is separate from refund. Customer cancellation stops the next renewal and keeps the current paid-through period.
- Failed renewal has no grace period. The plan expires according to the existing paid-through timestamp.
- Chargebacks may immediately place the entitlement on hold while the dispute is reviewed. Mandatory consumer/payment-provider rights still apply where required.

## Privacy

SlyBrowser should collect only the data needed for checkout, license delivery, entitlement checks, release download authorization, rate limiting, security logging, support and product feedback.

Allowed data includes checkout email, PayNow correlation IDs, plan/SKU, license ID, order ID, platform, architecture, release artifact hashes, optional privacy-preserving device hash, runtime session state, support messages and delivery status. Payment details are handled by the payment provider and must not be stored directly by SlyBrowser.

The license and billing services must not collect page content, visited URLs, cookies, credentials, local profile data or customer automation payloads.

## Acceptable use

SlyBrowser is intended for authorized QA, monitoring, research, compatibility testing and responsible automation. Users are responsible for the websites, data and accounts they access.

Prohibited use includes unlawful activity, unauthorized access, credential stuffing, brute-force login attempts, fraud, spam, unauthorized account creation, identity theft, malware delivery, bypassing authentication on systems the user does not own or have permission to test, and using SlyBrowser in a way that violates third-party rights or creates material legal/security risk.

## Support responsibility

Support covers SlyBrowser license delivery, SDK startup, browser/WebDriver pairing, release download verification and reproducible product defects. Support does not guarantee success on any particular third-party website, detection stack or account workflow, because those systems can change independently.

Free receives community/best-effort support. Paid plans receive the queue priority described by their SKU. Any SLA, named support hours, custom deployment, offline mode, redistribution or hosted third-party use requires Enterprise/OEM/SaaS terms.

## Minimal checkout terms

For the personal/GitHub-channel launch, do not add a pre-checkout consent checkbox, a policy-version acceptance record, a separate custom governing-law section or a tax section. Keep the legal-policy link visible near pricing/checkout and in license/order emails so users can review privacy, acceptable use, refund/cancellation, support limits and binary-distribution boundaries. Mandatory consumer, payment-provider and platform rules still apply where required.

## Binary distribution and notices

Official browser/WebDriver release packages must be downloaded from authorized SlyBrowser channels and verified by a signed release manifest. The launch binary terms apply only to SlyBrowser-owned proprietary browser/WebDriver material and official service access; they do not replace Chromium or third-party open-source licenses.

Every published browser package must include `BINARY-LICENSE.txt`, `LICENSE-SCOPE.txt`, `THIRD_PARTY_NOTICES.txt` and `CREDITS.html`. These files are generated or copied from the exact release build and are verified by release automation before publishing.

## Reference style

The structure follows the same practical categories used by CloakBrowser's public legal materials: refund/cancellation rules, acceptable-use limits, privacy boundaries, support limits and a separate binary-distribution boundary. SlyBrowser text must remain project-specific and must not copy CloakBrowser wording.
