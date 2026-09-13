# SlyBrowser license file scheme

Last updated: 2026-08-21

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

1. Paid users receive one `slybrowser-license.json` file only after a verified
   payment creates an active entitlement.
2. The file is an encrypted container. The public header is non-secret; the
   license key is inside an AEAD-encrypted payload and is never stored as
   plaintext in the file.
3. The complete container is signed by SlyBrowser with Ed25519. The encrypted
   payload is authenticated with AES-256-GCM and binds to the public header as
   additional authenticated data.
4. The file contains no price, PayNow ID, checkout URL, raw email, plan authority,
   paid-through authority, browser version authority or feature authority.
5. The SDK verifies the container signature, decrypts the payload through an
   approved unlock mode, and sends the license key only to a trusted SlyBrowser
   API origin over TLS.
6. The service checks the entitlement, reserves concurrency and returns a
   signed runtime lease plus a signed release manifest.
7. The SDK downloads only the selected artifact, verifies hashes and launches the
   exact browser/driver pair.
8. The native browser/WebDriver validates the runtime lease and keeps the session
   alive through heartbeat. Paid features fail closed when the lease expires,
   is revoked, does not match the binary, or was not activated by the native
   process.

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

The SDK must verify that decrypted `audience`, `licenseId`, `fileId`,
`serviceUrl`, `channel` and `expiresAt` exactly match the public header. A
payload copied into another public header, a public header edited around a valid
ciphertext, or a payload that adds plan/feature/concurrency claims must fail.

### Unlock modes

There is no safe product-wide decryption key. The file supports explicit unlock
modes, each with different operational tradeoffs:

1. **Portable passphrase mode** — the customer supplies a passphrase when
   downloading/importing the file. The SDK derives the wrapping key with
   Argon2id and decrypts the payload. This is portable but requires a secret at
   use time.
2. **Machine-sealed mode** — after the first successful import, the SDK stores a
   copy of the decrypted license secret in the OS credential store, such as
   Windows DPAPI/Credential Manager, macOS Keychain or Linux libsecret/KWallet.
   Future launches use the OS store and do not require the passphrase. Copying
   the JSON file alone to another machine is not enough.
3. **Enterprise/KMS mode** — unattended servers may use an enterprise secret
   manager or KMS to provide the decrypt key at runtime. The key is never
   embedded in SDK code, process arguments, GitHub Actions variables visible to
   logs, or the license file itself.

If no unlock mode can produce the key, the SDK fails with
`license_file_locked`. SDKs must not silently fall back to a plaintext v1 file
for paid production use.

### Verification order

SDKs and CLIs must follow this order:

1. enforce file size limit and parse JSON;
2. validate top-level field set and trusted `serviceUrl`;
3. verify Ed25519 signature over the encrypted container;
4. derive or unseal the decrypt key using the declared unlock mode;
5. decrypt with AES-256-GCM using the canonical public header as AAD;
6. verify decrypted payload fields match the public header;
7. clear plaintext secret buffers as soon as the runtime session request is
   prepared;
8. call the trusted service origin with `Authorization: License <licenseKey>`.

Any failure uses a stable error code and logs only non-secret identifiers such as
`licenseId`, `fileId`, `keyId` and a redacted reason.

### Redacted license diagnostics

The authorization service exposes a read-only `POST /v2/licenses/info` endpoint for
support tooling. It authenticates with the same `Authorization: License ...` header
but does not reserve a runtime session, issue a download ticket or return a lease.
Node.js and Python CLIs wrap it as:

```text
slybrowser license info --authorization account.slybrowser-sealed-license.json
```

The response contains plan, effective plan, paid-through time, feature set,
active/available browser-process concurrency, selected release state, update
availability and `stableErrorCode`. It must not contain license keys, runtime tokens,
bootstrap tokens, activation tickets, download tickets, emails, PayNow identifiers,
profile paths or service access URLs.

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
- `encryption.kdf.name` must be one of the approved unlock modes; public paid
  launch starts with `argon2id`.
- `ciphertext`, `tag`, `nonce` and KDF salt must be valid unpadded base64url.
- `signature.keyId` must be trusted and the Ed25519 signature must verify.
- Unknown fields fail closed unless the schema explicitly adds them later.

### Fields intentionally excluded

The file must not contain:

- plan price, currency, billing period or PayNow product ID;
- PayNow checkout, customer, subscription or payment IDs;
- raw customer email or delivery address;
- plaintext license key;
- authoritative plan, paid-through, feature list or concurrency limit;
- browser version, download URL, artifact hash or rollback permission;
- session token, runtime token, runtime lease or download ticket;
- private signing keys, peppers, telemetry IDs or support-only notes.

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

The SDK verifies and decrypts the license file, then sends:

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

The client cannot submit price, plan, feature, concurrency, checkout URL,
artifact URL, hash, PayNow ID or paid-through time.

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
- copied encrypted license files cannot reveal the license key without the
  passphrase, OS credential store or enterprise KMS unlock material;
- copied leases expire quickly and are bound to exact artifact hashes;
- replayed `startupId` returns one reservation rather than extra capacity;
- expired, downgraded, revoked or refunded entitlements fail closed;
- patched SDKs cannot create server-signed leases;
- patched browsers should fail gated features when native activation, heartbeat
  or binary-hash checks fail.

This is defense in depth to raise abuse cost and support revocation. It must not
be marketed as impossible to crack.

## 8. File storage and logging rules

- The license file must be written with owner-only permissions where the
  platform supports them.
- The paid production license file must be encrypted and authenticated; plaintext
  license files are private-preview compatibility only.
- CLIs accept a file path such as `--authorization` or `--license-file`; they
  must not accept `--license-key=...`.
- SDKs must not put the license key in process arguments, environment variables,
  analytics events, exceptions, crash dumps, browser profiles or test snapshots.
- SDKs must not persist decrypted license secrets outside approved OS
  credential stores or enterprise/KMS integrations.
- Temporary runtime lease files are short-lived, owner-only and removed after
  launch handoff.
- Server logs store HMAC/fingerprint values, license ID, file ID, session ID and
  public order IDs, not raw license keys, raw emails, tokens, lease bodies or
  PayNow secrets.
- If a license file is exposed, revoke the entitlement or rotate to a new
  license key and invalidate all active sessions.

## 9. Payment binding

Payment produces or updates entitlements; it does not directly grant runtime
access.

First paid activation:

1. checkout intent stores the website-entered delivery email and selected plan;
2. PayNow checkout metadata contains only the internal checkout intent ID;
3. PayNow webhook signature is verified and the PayNow Management API confirms
   product, amount, currency, checkout, customer and subscription facts;
4. verified payment creates order, payment, first period, subscription,
   entitlement and email outbox in one transaction;
5. only after that transaction commits, the service generates one v2 license
   file and sends it only to the
   website-entered email;
6. PayNow `billing_email` never overrides delivery.

The following states must not generate or disclose a license file:

- pricing page form submitted but checkout intent not created;
- checkout intent created but PayNow checkout not completed;
- user returns from PayNow with success-looking redirect query parameters;
- webhook signature valid but Management API confirmation missing or mismatched;
- payment pending, disputed, refunded, chargeback, wrong product, wrong amount,
  wrong currency, wrong store, or stale webhook.

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

- define and test a v2 encrypted license-file JSON schema;
- generate encrypted/authenticated v2 files with AES-256-GCM and Ed25519;
- verify signatures, decrypt payloads and validate header/payload binding in
  Node.js, Python, Java and .NET readers;
- implement at least portable passphrase mode and one machine-sealed mode for
  Windows before paid public launch;
- enforce trusted service origins before any network request containing
  `licenseKey`;
- generate v2 files from the service/admin issue path;
- keep v1 read compatibility with warnings during private preview;
- ensure file generation never writes email, PayNow IDs, price or plan authority;
- ensure plaintext `licenseKey` exists only in bounded service/SDK memory and
  approved OS credential stores, never in generated files, logs or attachments;
- add redaction tests for logs, errors and CLI output;
- add N/N+1 concurrency tests per plan;
- add revoke, hold, expiry, downgrade, replay and clock-skew tests;
- add native activation and heartbeat tests before unlocking paid-only features;
- update the payment checkout flow to create entitlements and email the v2 file.

2026-08-22 implementation note: the payment service now creates a
`sly-portable-scrypt-v1` encrypted license-file attachment after verified first
payment, and the Node.js, Python, .NET and Java SDK readers verify/decrypt that
portable passphrase mode after signature and trusted-origin checks. The per-customer
passphrase capture flow remains a launch requirement. The Node.js and Python SDKs now
support Windows DPAPI current-user sealed authorization import; Java/.NET sealed import
parity and enterprise/KMS unlock mode remain public-launch blockers.

P1 after controlled preview:

- support explicit license key rotation for compromised files;
- support enterprise trusted-origin allowlists;
- support enterprise/KMS unlock mode for unattended server fleets;
- add optional device-count policy with privacy-preserving hashes;
- add customer self-service reissue/resend with verified identity.

## 11. Acceptance gates

The license-file scheme is ready for payment integration when:

- a fixture encrypted v2 file verifies and decrypts in every SDK language;
- tampering with `serviceUrl`, `channel`, `licenseId`, `fileId`, `encryption`,
  `ciphertext`, `tag` or `signature` fails before network access;
- copying the encrypted file to a machine without the passphrase, OS credential
  secret or enterprise/KMS unlock material returns `license_file_locked`;
- a valid file creates exactly one reserved browser runtime session per
  `startupId`; the project WebDriver child process uses a separate
  `driverActivationTicket` under that same session;
- N and N+1 concurrency tests pass for Free, Basic, Pro, Max and Ultra;
- copied/replayed temporary leases fail after expiry or mismatch;
- signed release download, hash verification and exact browser/driver pairing
  are bound to the same session;
- gated features require a signed runtime lease and native activation;
- logs, metrics and errors contain no license key, raw email, session token,
  runtime token or PayNow secret.
