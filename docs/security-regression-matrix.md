# SlyBrowser security regression matrix

This document is the public-safe index for anti-abuse, feature-gate and plan-concurrency security
checks. It defines stable local and release responsibilities; candidate results belong in
the private Evidence index. Do not include exploit
recipes, live credentials, raw tokens, customer identifiers, bypass procedures, or
private browser internals in this file.

## Required coverage

| Area | Local gate | Release gate |
| --- | --- | --- |
| SDK bypass and system fallback | `packages/node/tests/licensed.test.ts`, `packages/python/tests/test_licensed.py`, `tests/release/signed-private-browser-license-only.mjs` | Run `tests/release/native-runtime-watchdog-matrix.mjs` on the exact signed candidate. |
| Frontend plan tamper | Private authorization-service `frontend-plan-tamper` case accepts only canonical `plan_id`. | Repeat against the authorized production checkout boundary. |
| Release manifest tamper | `packages/node/tests/licensed.test.ts` and `tests/release/release-tools.test.mjs` reject modified or revoked manifests. | Verify immutable artifact URL, hash and signature before availability. |
| Binary hash tamper | Node/Python installer and release-tool tests reject or repair changed Browser/Driver/archive bytes. | Run against the exact signed artifacts at the consumer boundary. |
| Direct WebDriver run | Signed private-browser tests reject missing lease or native handoff. | Repeat against the exact signed Driver. |
| copied installation directory | SDK cache tests cover byte repair; the native binary gate covers sibling pairing, module identity and runtime handoff. | Exercise copied Browser, Driver, profile and runtime-token cases on production-like binaries. |
| Old lease replay | Private authorization-service `old-lease-replay` case rejects mismatched sessions. | Exercise native process-copy and IPC replay cases. |
| Activation ticket replay | Private authorization-service `activation-ticket-replay` case enforces one-time use. | Repeat through Browser and Driver startup. |
| Clock rollback | Private authorization-service `clock-rollback` case preserves monotonic lease generation. | Exercise native watchdog time skew. |
| Plan feature and concurrency gating | Private `plan-concurrency-boundary` case enforces plan features, downgrade and concurrency. | Verify native rejection of stale/revoked feature bits and bounded exit. |
| production-like build normal path | `tests/release/native-runtime-watchdog-matrix.mjs` covers activate, heartbeat, authorized automation and clean release. | Repeat on the final signed candidate and store candidate-bound Evidence. |
| production-like build bypass path | The watchdog matrix requires stable redacted fail-closed errors. | Include missing/tampered/expired license, HTTP refusal, unpaired Browser/Driver, revoked session and transient 5xx lease-expiry behavior. |

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
category names both its local responsibility and its exact-candidate release gate.
