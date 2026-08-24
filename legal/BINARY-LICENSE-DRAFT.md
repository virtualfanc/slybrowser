# SlyBrowser Binary License — archived working draft

The launch-ready binary distribution terms are now maintained in
[`BINARY-LICENSE.md`](BINARY-LICENSE.md). Keep this draft only as historical planning
context for future legal review.

> **DRAFT — NOT EFFECTIVE AND NOT FOR DISTRIBUTION.** This document is a product and
> engineering checklist, not approved legal terms. It must be reviewed and completed
> by the owner and qualified counsel before any browser binary is released.

Proposed version: `0.1-draft`  
Licensor: `[LEGAL ENTITY REQUIRED]`  
Effective date: `[DATE REQUIRED]`  
Governing law and forum: `[JURISDICTION REQUIRED]`

## 1. Scope

The final license should apply only to SlyBrowser-owned proprietary material in an
official compiled browser distribution and to the contractual right to access official
download/update services. SDK source in the public repository remains under MIT.

Chromium and all bundled third-party components remain governed by their respective
licenses. Nothing in the final SlyBrowser license may narrow rights granted directly by
those licenses.

## 2. Commercial grant to decide

Before release, choose and state one unambiguous grant:

- personal and internal commercial use;
- evaluation-only use;
- per-user, per-device, or per-concurrent-session use;
- hosted automation and customer-facing browser-as-a-service rights;
- redistribution, OEM, embedding, and white-label rights.

Pricing pages must not silently redefine the legal grant. Plan limits and license
version must be recorded in the signed entitlement returned to the client.

## 3. License keys and entitlements

The final terms should state that access credentials are assigned to one customer and
may not be published, sold, or used to bypass agreed limits. Revocation, suspension,
refund, renewal, offline-use, and grace-period rules must be explicit.

The product must disclose the operational data used for validation, retention period,
and whether device binding or concurrent-session monitoring is enabled.

## 4. Restrictions on proprietary material

Potential restrictions include unauthorized redistribution, resale, removal of product
notices, and attempts to bypass SlyBrowser's license service. Any reverse-engineering
restriction must include exceptions required by applicable law and must not claim to
override open-source licenses for upstream components.

## 5. Acceptable use

The final terms should prohibit unlawful access, credential attacks, fraud, and use on
systems without authorization. They should not make vague claims that ordinary privacy,
testing, accessibility, research, or automation activity is inherently prohibited.

## 6. Privacy, warranty, and liability

The licensor must approve:

- exact license-validation telemetry and retention;
- warranty and support commitments;
- limitation of liability and any mandatory consumer-law exceptions;
- termination behavior and export/sanctions requirements, if applicable;
- notice method for material term or price changes.

## 7. Release gate

No binary may be published under this draft. Release automation must reject a license
whose status is not `approved`, whose version is missing from the signed manifest, or
whose required third-party notices are absent.
