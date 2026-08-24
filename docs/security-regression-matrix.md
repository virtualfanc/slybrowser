# SlyBrowser security regression matrix

Last updated: 2026-08-24

This document is the public-safe index for anti-abuse and paid-feature security
checks. It records what is covered by repository automation and what still needs
native binary or production-like release qualification. Do not include exploit
recipes, live credentials, raw tokens, customer identifiers, bypass procedures, or
private browser internals in this file.

## Current coverage

| Area | Local gate | Evidence | Release gate | Status |
| --- | --- | --- | --- | --- |
| SDK bypass and system fallback | Node/Python exact-version and no-silent-fallback tests; signed private-browser harness rejects unpaired system browsers. | `packages/node/tests/licensed.test.ts`, `packages/python/tests/test_licensed.py`, `tests/release/signed-private-browser-license-only.mjs`, `tests/release/native-runtime-watchdog-matrix.mjs` | Re-run the native runtime watchdog matrix on the final release candidate before publishing. | Covered by production-like local binary matrix. |
| Frontend plan tamper | Checkout intent ignores user-supplied price/URL fields and only accepts canonical `plan_id`. | `packages/license-service/tests/paynow.test.ts` | Re-run after live PayNow field samples are confirmed. | Covered locally. |
| Release manifest tamper | Signed manifest verification rejects modified manifest state and revoked manifests. | `packages/node/tests/licensed.test.ts`, `tests/release/release-tools.test.mjs` | Verify immutable artifact URL, hash, and signature before marking a build available. | Covered locally. |
| Binary hash tamper | SDK installers repair or quarantine changed browser/driver bytes and corrupt archives; release verifier rejects unsafe symbol leakage. | `packages/node/tests/licensed.test.ts`, `packages/python/tests/test_licensed.py`, `tests/release/release-tools.test.mjs` | Run against signed production-like artifacts. | Covered locally. |
| Direct WebDriver run | Harness contains fail-closed cases for starting the project WebDriver without its own signed lease or without native runtime handoff. | `tests/release/signed-private-browser-license-only.mjs`, `tests/release/native-runtime-watchdog-matrix.mjs` | Re-run against the final signed driver before publishing. | Covered by production-like local binary matrix. |
| copied installation directory | SDK-level cache repair exists, but copied installation directory behavior is a native binary gate because it depends on sibling pairing, private module identity, and runtime handoff. | `tests/release/signed-private-browser-license-only.mjs` plus native tests when available | Run copied-browser, copied-driver, copied-profile, and copied-runtime-token cases against production-like binaries. | Native pending. |
| Old lease replay | Runtime reservation binds startup/device inputs and rejects replayed/mismatched sessions. | `packages/license-service/tests/service.test.ts` | Add native process-copy and IPC replay tests. | Covered locally; native replay still pending. |
| Activation ticket replay | Activation ticket is one-time and cannot be reused after activation. | `packages/license-service/tests/service.test.ts` | Run same condition through browser/WebDriver startup. | Covered locally. |
| Clock rollback | Lease generation remains monotonic when service time moves backwards. | `packages/license-service/tests/service.test.ts` | Add native watchdog time-skew tests. | Covered locally. |
| Paid feature escalation | Free plan cannot reserve paid automation backends; downgraded paid sessions lose download and heartbeat authorization. | `packages/license-service/tests/service.test.ts` | Verify the native layer stops new paid work and exits boundedly after downgrade. | Covered locally; native enforcement pending. |
| production-like build normal path | Normal path must start, activate, heartbeat, use authorized automation, release cleanly, and release its runtime session on shutdown. | `tests/release/native-runtime-watchdog-matrix.mjs`; latest local evidence under `artifacts/test-results/native-watchdog/` | Re-run on the final signed release candidate before publishing. | Covered by production-like local binary matrix. |
| production-like build bypass path | Bypass path must fail closed with stable redacted error codes. | `tests/release/native-runtime-watchdog-matrix.mjs`; latest local evidence under `artifacts/test-results/native-watchdog/` | Must include missing license, HTTP refusal, tampered license, expired lease, unpaired browser/driver, revoked session, and transient 5xx lease-expiry behavior. Copied-directory and local-admin red-team cases are post-launch hardening. | Covered by production-like local binary matrix for launch-required cases. |

## Redacted report template

Each release qualification report should include:

- date and operator;
- build channel, platform, architecture, artifact hash, browser hash, driver hash,
  private module hash, and release manifest key ID;
- test source and command used;
- normal path result;
- bypass path result grouped by stable error code;
- whether logs, crash output, and reports were checked for secret redaction;
- remaining risk and explicit release decision.

Do not include:

- license keys, runtime tokens, activation tickets, download tickets, payment IDs,
  raw customer emails, full request bodies, secrets, private signing material, or
  step-by-step bypass recipes;
- public disclosure of private kernel internals or private patch details;
- claims from live detection, payment, CDN, or production services unless the raw
  dated evidence has been saved in the authorized private evidence location.

## CI guard

`tests/release/security-regression-matrix.test.mjs` verifies that every required
category in this matrix has evidence and that native/production-only cases remain
explicitly marked pending until the real binary or production-like gates are run.
