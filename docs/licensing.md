# License system design

This document covers product enforcement. Legal terms remain in the approved binary
license and cannot be invented by client code.

## Principles

- Never embed a signing private key or master license secret in an SDK or browser.
- Never pass the user's license key as a command-line argument.
- Treat client clocks, local files, environment variables, and IPC input as untrusted.
- Use signed, versioned claims with explicit audience, browser range, features, and time.
- Keep public-key rotation independent from browser upgrades where practical.
- Return stable machine-readable errors without logging keys or full entitlements.

## Entitlement exchange

The SDK reads the generated authorization JSON from an explicit file, sends its random
license key to the configured service over TLS, and receives a short-lived signed lease.
A lease contains no credential that can mint another lease. The authorization file is
never forwarded to the browser or driver.

The implemented service hashes license-key secrets with HMAC-SHA256 and a server-only
pepper, chooses the newest signed compatible Stable release, and atomically reserves
one browser-process session. It enforces Free 1, Launch 5, Studio 20, Fleet 200 and
Grid 2,000. Paid access falls back to Free after `paidThrough`; normal close releases
capacity and abandoned sessions expire after the heartbeat TTL. Deployment and key
management are documented in
[Authorized browser delivery](authorized-release-service.md).

Required claims:

| Claim | Purpose |
| --- | --- |
| `schemaVersion` | Reject incompatible formats |
| `keyId` | Select a trusted public key |
| `licenseId` | Stable non-secret entitlement identifier |
| `audience` | Bind the lease to SlyBrowser |
| `issuedAt`, `notBefore`, `expiresAt` | Bound validity time |
| `browserMin`, `browserMax` | Prevent unsupported builds |
| `features` | Enable only purchased capabilities |
| `sessionId` | Bind a concurrent session lease |
| `deviceHash` | Optional privacy-preserving device binding |
| `nonce` | Prevent replay within a session |

The signed bytes use canonical JSON with UTF-8 encoding. Signature verification uses
Ed25519 from established platform cryptography libraries. Key IDs, algorithms, and
canonicalization versions are allowlisted; unknown values fail closed.

## Browser handoff

Preferred Windows implementation:

1. SDK creates a temporary file with an ACL restricted to the current user.
2. SDK writes the signed lease, flushes it, and passes only the file path using
   `--sly-license-file`.
3. Browser requires an absolute path without parent traversal, rejects links, enforces
   a 64 KiB maximum, opens the file for delete-on-close, reads it once, and deletes it.
4. Browser verifies signature, audience, time, version, and optional device claims.
5. Browser stores only a redacted in-memory entitlement for the process lifetime.

An inherited pipe/handle can replace the file after the first implementation. The
command line must never contain the user's key or full signed lease.

The current implementation covers bounded one-time reads, signature verification, and
claim validation. On Windows it also checks every existing path component for reparse
points, opens the final file exclusively with `FILE_FLAG_OPEN_REPARSE_POINT`, verifies
that its owner matches the process token's user or default owner, and rejects DACLs that
grant sensitive access to broad well-known trustees. A future inherited-handle handoff
can remove the remaining pathname race entirely.

## Private Chromium integration

The private browser component lives at `components/sly_license` in the Chromium
checkout. `ChromeBrowserMainParts::PreEarlyInitialization()` calls the gate before the
private profile/fingerprint service initializes. A rejected lease writes only a stable
code in the form `SLY_LICENSE_ERROR:<code>:<message>` and exits with Chromium's
policy-disallowed result code.

Development builds default to `sly_license_enforcement_enabled=false`, so normal
Chromium development remains possible. If a lease switch is supplied, it is still
verified. Commercial browser builds must explicitly enable enforcement and inject only
the public verification key:

```gn
sly_license_enforcement_enabled = true
sly_license_key_id = "sly-prod-v1"
sly_license_public_key_hex = "<64 lowercase or uppercase hex characters>"
```

The corresponding Ed25519 private key belongs in a protected signing service or an
approved offline signing process. It must never appear in `args.gn`, source code,
scripts, CI variables exposed to builds, browser archives, or this repository.

Current browser error codes include `license_missing`, `license_file_invalid`,
`license_key_not_configured`, `license_invalid_envelope`,
`license_algorithm_unsupported`, `license_key_unknown`,
`license_invalid_signature`, `license_invalid_claims`,
`license_schema_unsupported`, `license_wrong_audience`, `license_invalid_time`,
`license_lifetime_exceeded`, `license_not_yet_valid`, `license_expired`,
`license_browser_unsupported`, `license_feature_denied`, and
`license_device_mismatch`.

## WebDriver handoff and binary pairing

The project-built WebDriver is a separately gated process under the same session
entitlement. The SDK creates a second
restricted one-time lease file for the driver; it never reuses the browser's file path.
The driver consumes and verifies that lease at startup using the same native verifier,
then the browser consumes its own copy during browser startup. Help and version output
remain available without a lease so package diagnostics do not require a session.

Commercial drivers also require the selected SlyBrowser executable to be an exact
sibling with the approved file name and build-time SHA-256. This prevents a copied
driver from controlling stock Chrome or a mismatched browser. Copying the whole matched
runtime is controlled by signed lease expiry, optional device binding, and the license
service's session/concurrency/replay state; local binary checks alone cannot stop byte
copying. Build settings and signing order are defined in
[Native WebDriver Humanize and runtime pairing](webdriver-humanize-and-pairing.md).

## Offline and failure behavior

Offline use is a product decision. If enabled, it must use a separately signed offline
entitlement with a bounded expiry. Network failure must not turn an invalid or revoked
license into an unlimited license. Grace-period duration and revocation limitations
must be disclosed to users.

## Required tests

- valid, missing, malformed, oversized, and truncated lease;
- unknown key ID and algorithm downgrade;
- altered payload and signature;
- not-yet-valid, expired, and excessive-lifetime lease;
- wrong audience, browser version, feature, device, or session;
- replayed nonce and duplicate concurrent session;
- clock rollback and boundary timestamps;
- inaccessible file, permissive ACL, reparse point, and deletion failure;
- logs and crash reports contain no key or full lease.

The focused native suite currently has 15 passing cases covering valid signatures,
signature alteration, malformed/extended/oversized envelopes, unknown keys and
algorithms, expiry and future leases, lifetime policy, audience and device binding,
browser ranges, required features, invalid paths, one-time file consumption, Windows
owner/DACL rejection, and reparse-point paths. The service suite additionally covers
every plan boundary through Grid 2,000, atomic N+1 denial, explicit release, orphan
expiry, paid-plan expiry/downgrade, signed renewal, artifact authorization and invalid
keys. The Node and Python suites cover signed session/manifest exchange, modified
manifests, protected download/cache reuse and runtime-file tamper repair. Inherited-
handle handoff, multi-node database authority and full production key-rotation drills
remain release-hardening work.
