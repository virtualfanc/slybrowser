# SlyBrowser license file scheme

Last updated: 2026-09-28

This document freezes the license-file contract that payment, authorization
delivery, SDK launch, signed downloads and native runtime enforcement must share.
The encrypted v2 test-file issuer/readers and v2 runtime-session protocol are
implemented in the license-service and SDKs. Production payment delivery and the
private native watchdog remain separate launch tasks.

## 1. Terms

- **License file**: the long-lived customer credential stored by the user. It is
  delivered after first activation and is used only by SDKs and CLIs to request
  server-side sessions.
- **License key**: the customer secret encrypted inside the license file. The
  server stores only an HMAC hash of the secret plus entitlement state.
- **Entitlement**: the authoritative server record for plan, status,
  paid-through time, device policy, feature gates and concurrency.
- **Runtime session**: a short-lived server reservation that consumes
  concurrency for one browser process.
- **Runtime lease**: an Ed25519-signed short-lived envelope bound to one runtime
  session, selected browser release and granted feature set.
- **Download ticket**: a short-lived authorization for exactly one signed
  release artifact selected by the runtime session.

The license file proves possession of a credential. It does not by itself prove
that a paid plan is current, that concurrency is available, or that a copied
browser binary may run granted features.

## 2. Core decision

SlyBrowser uses an encrypted and authenticated license file plus online
entitlement checks:

This keeps payment, renewal, refund, chargeback and plan changes server-side.
Checkout creation, checkout return URLs and pending payment state never create or
expose a paid license file. Renewal extends the entitlement; it does not require
issuing a new license file.

## 3. License file v2 encrypted container

Recommended filename:

```text
slybrowser-license.json
```

Canonical JSON shape:

```json
{
  "schemaVersion": 2,
  "type": "slybrowser-license",
  "audience": "slybrowser-license-file",
  "serviceUrl": "https://api.slybrowser.com",
  "licenseId": "00000000-0000-0000-0000-000000000000",
  "channel": "stable",
  "issuedAt": "2026-08-20T00:00:00Z",
  "expiresAt": "2027-08-20T00:00:00Z",
  "fileId": "lf_<random-public-id>",
  "encryption": {
    "algorithm": "AES-256-GCM",
    "kdf": {
      "name": "argon2id",
      "salt": "<base64url>",
      "memoryKiB": 65536,
      "iterations": 3,
      "parallelism": 1
    },
    "nonce": "<base64url-96-bit>",
    "aad": "slybrowser-license-v2-public-header"
  },
  "ciphertext": "<base64url>",
  "tag": "<base64url-128-bit>",
  "signature": {
    "algorithm": "Ed25519",
    "keyId": "license-file-prod-v1",
    "signature": "<base64url>"
  }
}
```

The signature is over RFC 8785-style canonical JSON of every top-level field
except `signature`. The AES-GCM additional authenticated data is the same
canonical public header without `ciphertext`, `tag` or `signature`. SDKs must
reject tampering before sending `licenseKey` to a network origin.

### Encrypted payload

The decrypted payload is also canonical JSON:

```json
{
  "schemaVersion": 2,
  "type": "slybrowser-license-secret",
  "audience": "slybrowser-license-file",
  "licenseId": "00000000-0000-0000-0000-000000000000",
  "fileId": "lf_<random-public-id>",
  "serviceUrl": "https://api.slybrowser.com",
  "channel": "stable",
  "licenseKey": "sly_live_00000000-0000-0000-0000-000000000000.<secret>",
  "secretVersion": 1,
  "createdAt": "2026-08-20T00:00:00Z",
  "expiresAt": "2027-08-20T00:00:00Z",
  "nonce": "<base64url>"
}
```

The service must verify that decrypted `audience`, `licenseId`, `fileId`,
`serviceUrl`, `channel` and `expiresAt` exactly match the public header. A
payload copied into another public header, a public header edited around a valid
ciphertext, or a payload that adds plan/feature/concurrency claims must fail.

### Online resolution

The four SDKs have no local decrypt-key, passphrase, KMS or machine-sealed
authorization import. The file's encryption metadata remains signed public
data; only the service interprets it and decrypts the secret. If the service
rejects the file or cannot resolve its key, the SDK fails closed with the
service's stable error code. A valid signature does not grant entitlement by
itself.

### Verification order

SDKs and CLIs must follow this order:

1. enforce file size limit and parse JSON;
2. validate top-level field set and trusted `serviceUrl`;
3. verify Ed25519 signature over the encrypted container;
4. submit the intact signed file to `POST /v1/license-files/authorization` at
   that same trusted origin;
5. require a successful response whose service origin and license identity
   match the signed file;
6. use the returned authorization only for the subsequent online request.

Any failure uses a stable error code and logs only non-secret identifiers such as
`licenseId`, `fileId`, `keyId` and a redacted reason.

### Redacted license diagnostics

The authorization service exposes a read-only `POST /v2/licenses/info` endpoint for
support tooling. It authenticates with the same `Authorization: License ...` header
but does not reserve a runtime session, issue a download ticket or return a lease.
Node.js and Python CLIs wrap it as:

```text
slybrowser license info --authorization account.slybrowser-license.json
```

### Required validation

- `schemaVersion` must be `2`.
- `type` must be `slybrowser-license`.
- `audience` must be `slybrowser-license-file`; runtime leases use a different
  audience and must not be accepted as license files.
- `serviceUrl` must be HTTPS and must match the SDK's trusted origin allowlist.
  The default allowlist is `https://api.slybrowser.com`; localhost or enterprise
  origins require an explicit developer/admin override.
- `channel` is `stable` for public launch.
- `issuedAt` must be a valid UTC timestamp.
- `expiresAt` is license-file rotation expiry, not paid-through authority. An
  expired file fails closed and must be reissued by the service for an active
  entitlement.
- `fileId` is public and non-secret; it exists only for support/audit
  correlation.
- `encryption.algorithm` must be `AES-256-GCM` for v2.
- `encryption.kdf.name` must be a supported signed format identifier. The SDK
  validates its shape but does not derive a decrypt key.
- `ciphertext`, `tag`, `nonce` and KDF salt must be valid unpadded base64url.
- `signature.keyId` must be trusted and the Ed25519 signature must verify.
- Unknown fields fail closed unless the schema explicitly adds them later.

### Fields intentionally excluded

The file must not contain:

Plan, paid-through, concurrency, features, release selection and download rights
come from server state and signed runtime responses.

## 4. Backward compatibility

Current v1 authorization files contain:

```json
{
  "schemaVersion": 1,
  "serviceUrl": "https://api.slybrowser.com",
  "licenseKey": "sly_live_<license-id>.<secret>",
  "channel": "stable"
}
```

SDKs may continue reading v1 during private preview, but v1 is a plaintext
credential format and must not be generated for paid public launch. V2 encrypted
containers are the default file generated after paid checkout. A v1 file must
still obey trusted-origin checks before the SDK sends the key to the network.

Migration policy:

- v1 accepted only in private preview and internal tests;
- encrypted/authenticated v2 generated for all paid public launch files, Free
  claim files, resend/reissue files and admin-issued portable files;
- compact `schemaVersion: 1` customer wrappers are legacy-read only and must not
  be generated for new customer attachments, Free claim files, resend/reissue
  files or admin-issued portable files;
- v1 deprecation date announced after v2 SDKs are published in every supported
  language;
- a support CLI can reissue v2 for an existing active entitlement without
  changing paid-through state.

## 5. Runtime session request

After online file authorization, the SDK sends:

```http
POST /v2/runtime/sessions
Authorization: License <licenseKey>
Content-Type: application/json
```

```json
{
  "startupId": "<random-idempotency-id>",
  "platform": "windows",
  "arch": "x64",
  "channel": "stable",
  "sdk": {
    "language": "node",
    "version": "0.1.0",
    "automationBackend": "project-webdriver"
  },
  "requestedBrowserVersion": null,
  "versionPolicy": "latest",
  "deviceHash": "<optional-privacy-preserving-hash>"
}
```

The service:

1. authenticates the license key by HMAC hash;
2. loads the current entitlement;
3. checks status, paid-through, device policy and plan;
4. selects the requested release according to the signed release catalog;
5. atomically reserves one browser runtime session under the plan concurrency
   limit;
6. returns a bootstrap token, browser activation ticket, signed runtime lease,
   signed release manifest and short-lived download ticket. When the selected
   automation backend is the project WebDriver, the service also returns a
   `driverActivationTicket` for the paired driver child process; it belongs to
   the same browser runtime session and does not consume another concurrency
   slot.

Repeated requests with the same `startupId` for the same license return the same
active reservation until it expires or is released.

## 6. Runtime lease v2 claims

The runtime lease is signed by the online lease key and is the only object that
unlocks paid runtime capabilities.

Required claims:

```json
{
  "schemaVersion": 2,
  "audience": "slybrowser-runtime",
  "licenseId": "00000000-0000-0000-0000-000000000000",
  "sessionId": "rs_<random>",
  "startupIdHash": "<sha256>",
  "leaseGeneration": 1,
  "issuedAt": 1787241600,
  "notBefore": 1787241600,
  "expiresAt": 1787242260,
  "plan": "pro",
  "concurrencyLimit": 20,
  "features": ["browser", "webdriver", "humanize"],
  "release": {
    "channel": "stable",
    "browserVersion": "<exact-version>",
    "browserSha256": "<sha256>",
    "driverSha256": "<sha256>",
    "artifactSha256": "<sha256>"
  },
  "deviceHash": "<optional>",
  "nonce": "<base64url>"
}
```

The browser and project WebDriver must validate:

- signature, key ID and audience;
- current time inside `notBefore`/`expiresAt` with bounded clock skew;
- exact browser version and binary hash match;
- exact driver/browser pairing when WebDriver is used;
- session ID and startup ID match the active native process;
- required feature is present before enabling paid-only behavior;
- `leaseGeneration` increases on heartbeat renewal;
- optional `deviceHash` matches the SDK/native computed value.

The SDK may hold the bootstrap token and temporary lease file long enough to
launch. The native process owns the runtime token after activation. Web pages,
renderers, extensions and user scripts must never access the license key,
session token, runtime token, or raw lease.

## 7. Paid-feature and anti-copy model

Paid features are enabled only when all gates pass:

1. v2 license file parses, verifies and targets a trusted service origin;
2. server entitlement is active and current;
3. concurrency reservation succeeds;
4. signed release manifest and downloaded bytes match;
5. browser and WebDriver are exact project-paired binaries;
6. native browser activation succeeds and rotates from bootstrap token to
   runtime token;
7. heartbeat refreshes the runtime lease before expiry.

Copying only `chromedriver.exe`, the browser ZIP, SDK code, a temporary lease
file, or an old release cache is insufficient:

- copied binaries cannot mint a fresh server session;
- copied encrypted license files cannot reveal the license key locally; the
  authorization service can revoke or reject them;
- copied leases expire quickly and are bound to exact artifact hashes;
- replayed `startupId` returns one reservation rather than extra capacity;
- expired, downgraded, revoked or refunded entitlements fail closed;
- patched SDKs cannot create server-signed leases;
- patched browsers should fail gated features when native activation, heartbeat
  or binary-hash checks fail.

This is defense in depth to raise abuse cost and support revocation. It must not
be marketed as impossible to crack.

## 8. File storage and logging rules

## 9. Payment binding

Payment produces or updates entitlements; it does not directly grant runtime
access.

First paid activation:

The following states must not generate or disclose a license file:

Renewal:

- extends `paid_through` on the existing entitlement;
- does not generate another license file;
- does not change the license key unless rotation is explicitly requested.

Cancellation:

- stops future renewal;
- keeps access until current `paid_through`;
- then the paid key returns `license_plan_expired` and cannot create or renew a session;
- never automatically converts the paid key to Free; Free use requires a separately
  issued Free license.

Refund/chargeback:

- applies the approved policy server-side;
- may put entitlement on hold or revoke it;
- kills or lets existing runtime sessions expire according to policy;
- never edits a customer-held file in place.

## 10. Implementation checklist

P0 before public paid checkout:

2026-09-28 implementation note: all four local SDK readers verify signed
certificate metadata and request online authorization. Local passphrase
decryption and Windows DPAPI sealed-authorization import have been removed from
the source candidate. Public release and clean-install acceptance are separate
gates.

P1 after controlled preview:

- support explicit license key rotation for compromised files;
- support enterprise trusted-origin allowlists;
- support enterprise trusted-origin policy for unattended server fleets;
- add optional device-count policy with privacy-preserving hashes;
- add customer self-service reissue/resend with verified identity.

## 11. Acceptance gates

The license-file scheme is ready for payment integration when:

