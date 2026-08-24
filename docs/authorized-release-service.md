# Authorized browser delivery and concurrency service

This is the operational design implemented by `packages/license-service`, the Node.js
SDK and the Python SDK. It selects the newest compatible Stable release, reserves one
licensed browser-process slot, authorizes the download, verifies the signed release,
and launches the exact browser/WebDriver pair from the local cache.

## Plan authority

`contracts/plans.json` is the public plan contract. The service keeps the same values
in an executable constant and tests every limit, including the first rejected session.

| Plan | Promotional monthly price | Browser-process concurrency | Monthly price per concurrent process |
| --- | ---: | ---: | ---: |
| Free | $0 | 1 | $0 |
| Launch | $19 | 5 | $3.80 |
| Studio | $49 | 20 | $2.45 |
| Fleet | $199 | 200 | about $1.00 |
| Grid | $499 | 2,000 | about $0.25 |

One operating-system browser process consumes one session. Tabs and contexts in that
process do not consume more capacity. A normal close releases the session immediately;
a crash releases it when the short session TTL expires. A paid entitlement falls back
to Free at its paid-through time. A downgrade keeps only the earliest sessions within
the new limit on their next heartbeat.

## Trust and request flow

```mermaid
sequenceDiagram
    participant SDK as Node/Python SDK
    participant LS as License service
    participant DB as Concurrency store
    participant FS as Protected artifacts
    participant WD as Sly WebDriver + browser
    SDK->>LS: License key, platform, architecture, SDK version
    LS->>DB: BEGIN IMMEDIATE; expire; count; reserve
    DB-->>LS: Session token and active count
    LS-->>SDK: Signed short lease + signed latest manifest
    SDK->>SDK: Verify lease, manifest, compatibility and artifact origin
    SDK->>LS: Download with session token
    LS->>DB: Verify active session and artifact hash binding
    LS->>FS: Stream immutable ZIP
    SDK->>SDK: Verify archive and executable SHA-256; safe extract/cache
    SDK->>WD: Launch exact signed browser/driver with one-time lease files
    SDK->>LS: Heartbeat; release on close
```

The current private-preview authorization file contains a long-lived random API key
and is a credential. The database stores only an HMAC-SHA256 hash of the secret using
a server-only pepper. This v1 plaintext authorization format must not be generated for
public paid launch. Public paid launch requires the encrypted/authenticated v2 license
file defined in [license file scheme](license-file-scheme.md): the license key is
inside an AEAD-encrypted payload and the whole container is authenticated by a
SlyBrowser Ed25519 signature. The lease and release manifests use separate Ed25519
key pairs. Clients contain only the public-key sets. Artifact responses require the
session token, do not redirect, and are bound to the exact SHA-256 selected for that
session. Node.js and Python clients can import the v2 file into a Windows DPAPI
current-user sealed authorization file; routine launches still perform online lease,
release and concurrency checks.

## Build and keys

Use Node.js 22.13 or later for the service. Generate two independent Ed25519 key pairs:
one for online short-lease signing and one for the protected/offline release workflow.

```powershell
openssl genpkey -algorithm ed25519 -out license-signing-private.pem
openssl pkey -in license-signing-private.pem -pubout -out license-signing-public.pem
openssl genpkey -algorithm ed25519 -out release-signing-private.pem
openssl pkey -in release-signing-private.pem -pubout -out release-signing-public.pem

pnpm install
pnpm --filter @slybrowser/license-service build
node scripts/release/Export-Ed25519PublicKey.mjs --key license-signing-public.pem
node scripts/release/Export-Ed25519PublicKey.mjs --key release-signing-public.pem
```

Do not place private keys, the HMAC pepper, the admin token, authorization files or the
service database in source control. Store production keys in an HSM/KMS or restricted
secret volume and give the service account read access only to the online lease key.

## Produce a signed release

The ZIP must contain the already-signed, hash-matched browser and project WebDriver.
They must not be changed after their individual hashes are recorded.
The ZIP must also contain the legal artifacts generated from the exact release build:
`BINARY-LICENSE.txt`, `LICENSE-SCOPE.txt`, `THIRD_PARTY_NOTICES.txt`, and
`CREDITS.html`. Generate them before manifest creation:

```powershell
.\scripts\browser\Check-Licenses.ps1 `
  -ChromiumSrc E:\multilogin\chrome\src `
  -OutDir out\release_x64 `
  -GnTarget //chrome:chrome `
  -OutputDirectory C:\release\legal
```

For the first production launch, artifact URLs are served by the owner's API origin
(`https://api.slybrowser.com/v1/releases/artifacts/*`) rather than a separate download
CDN. SBOM, provenance and patch inventory can be attached when available; if they are
present the verifier checks their hashes and content, but they are not a launch blocker.

```powershell
.\scripts\release\New-UnsignedManifest.ps1 `
  -Artifact C:\release\slybrowser-win-x64.zip `
  -Platform windows -Arch x64 `
  -Url https://api.slybrowser.com/v1/releases/artifacts/slybrowser-150.0.0.0-win-x64.zip `
  -BrowserVersion 150.0.0.0 -SdkCompatibility '>=0.1.0 <1.0.0' `
  -BrowserExecutable C:\release\SlyBrowser.exe `
  -DriverExecutable C:\release\chromedriver.exe `
  -BrowserPath SlyBrowser.exe -DriverPath chromedriver.exe `
  -BinaryLicense C:\release\legal\BINARY-LICENSE.txt `
  -LicenseScope C:\release\legal\LICENSE-SCOPE.txt `
  -ThirdPartyNotices C:\release\legal\THIRD_PARTY_NOTICES.txt `
  -CreditsHtml C:\release\legal\CREDITS.html `
  -Output C:\release\150.0.0.0.unsigned.json

node scripts/release/Sign-ReleaseManifest.mjs `
  --input C:\release\150.0.0.0.unsigned.json `
  --private-key C:\secrets\release-signing-private.pem `
  --key-id release-prod-v1 `
  --output C:\manifests\150.0.0.0.json
```

Place the immutable ZIP in the configured artifact root and the signed JSON in the
manifest directory. The service chooses the numerically newest browser version whose
manifest contains the requested platform/architecture and compatible SDK range. SDKs
independently verify the manifest signature; the service's manifest directory must
still be writable only by the trusted release process. Every published artifact URL
path must be unique; reusing a path for new bytes makes service startup fail.

New signed manifests must include `status: "available"` or `status: "revoked"`;
the catalog reader treats an omitted status as available only for legacy private
preview manifests. Revoked manifests remain signed audit records but are excluded
from new selection and artifact download. If an
already-active runtime session was leased from a release that later becomes revoked,
the next runtime heartbeat returns `kernel_update_required` and releases the server
session instead of extending the lease.

## Service configuration and start

The HTTP server is designed to run behind an HTTPS reverse proxy. Do not expose its
plain HTTP listener directly to customers.

Production runs the runtime/license API and the billing receiver as separate local
listeners behind the same HTTPS API hostname. Keep the billing receiver on
`127.0.0.1:8787` and the runtime/license service on `127.0.0.1:8788`; this prevents a
silent port conflict and keeps PayNow webhook traffic separated from browser-runtime
leases and artifact downloads.

```text
SLY_RELEASE_MANIFEST_DIR=C:\sly\manifests
SLY_RELEASE_ARTIFACT_ROOT=C:\sly\artifacts
SLY_LICENSE_SIGNING_KEY_FILE=C:\secrets\license-signing-private.pem
SLY_LICENSE_KEY_ID=license-prod-v1
SLY_LICENSE_KEY_PEPPER=<base64url random value containing at least 32 bytes>
SLY_LICENSE_STORE=postgres
SLY_LICENSE_POSTGRES_URL=postgres://sly_license:<password>@postgres.internal:5432/sly_license
SLY_LICENSE_ADMIN_TOKEN=<random admin bearer token>
SLY_LICENSE_HOST=127.0.0.1
SLY_LICENSE_PORT=8788
SLY_LICENSE_SESSION_TTL_SECONDS=660
SLY_LICENSE_HEARTBEAT_SECONDS=300
SLY_REDIS_URL=redis://redis.internal:6379
SLY_LICENSE_RATE_LIMIT_REDIS_PREFIX=slybrowser:license-rate-limit
```

For the first production server, prefer a private local filesystem location on
the API host instead of a CDN bucket:

```text
SLY_RELEASE_MANIFEST_DIR=/srv/slybrowser/releases/manifests
SLY_RELEASE_ARTIFACT_ROOT=/srv/slybrowser/releases/artifacts
```

The API service serves authorized artifact bytes from that root through
`https://api.slybrowser.com/v1/releases/artifacts/*` and
`https://api.slybrowser.com/v2/runtime/artifacts/*`. Upload immutable ZIP bytes
first, publish the signed manifest last, and never commit browser archives or
MD5 sidecars to Git. The local publish helper performs the same order and refuses
to overwrite a same-name file with different bytes:

```powershell
pwsh scripts/release/Publish-ReleaseBundle.ps1 `
  -Manifest .\release\stable.json `
  -Artifact .\release\slybrowser-win-x64.zip `
  -BrowserExecutable .\release\SlyBrowser.exe `
  -DriverExecutable .\release\slywebdriver.exe `
  -PrivateModule .\release\sly_private.dll `
  -ResourceList ".\release\BINARY-LICENSE.txt;.\release\LICENSE-SCOPE.txt;.\release\THIRD_PARTY_NOTICES.txt;.\release\CREDITS.html;.\release\resources.pak" `
  -PublicKey .\release\release-public.pem `
  -KeyId release-prod-v1 `
  -ArtifactRoot /srv/slybrowser/releases/artifacts `
  -ManifestRoot /srv/slybrowser/releases/manifests
```

When publishing from the Windows build machine to the Linux API server, use the SSH/SCP
wrapper instead of hand-copying files. It verifies the bundle locally, uploads the ZIP
first, checks the remote hash, then uploads the signed manifest last:

```powershell
pwsh scripts/release/Publish-ReleaseBundleToServer.ps1 `
  -Manifest .\release\stable.json `
  -Artifact .\release\slybrowser-win-x64.zip `
  -BrowserExecutable .\release\SlyBrowser.exe `
  -DriverExecutable .\release\slywebdriver.exe `
  -ResourceList ".\release\BINARY-LICENSE.txt;.\release\LICENSE-SCOPE.txt;.\release\THIRD_PARTY_NOTICES.txt;.\release\CREDITS.html" `
  -PublicKey .\release\release-public.pem `
  -KeyId release-prod-v1 `
  -RemoteHost api.slybrowser.com `
  -RemoteUser slyrelease
```

```powershell
node packages/license-service/dist/cli.js serve
```

The reverse proxy must preserve `Authorization`, disable response caching, terminate
TLS, cap request bodies, and avoid redirects between API origins. Health and plan
metadata are available at `GET /healthz` and `GET /v1/plans`.

## Generate and change authorizations

The current offline CLI creates the entitlement and writes a v1 private-preview
credential file with exclusive creation semantics. Paid plans require a future
paid-through timestamp. The public billing path uses the encrypted/authenticated v2
license file generator; keep v1 issuance behind an explicit private-preview flag.

```powershell
$env:SLY_LICENSE_KEY_PEPPER = '<same server pepper>'
node packages/license-service/dist/cli.js issue `
  --db C:\sly\state\license.sqlite `
  --account account_123 `
  --plan studio `
  --paid-through 2026-09-16T00:00:00Z `
  --service-url https://api.slybrowser.com `
  --output C:\secure\account_123.authorization.json
```

The deployed admin API provides the same creation path and can update plan, status and
paid-through time. Runtime revocation uses a separate permission so incident response
tokens can be narrower than license issuance/update tokens:

```text
POST  /v1/admin/licenses
PATCH /v1/admin/licenses/{licenseId}
POST  /v1/admin/runtime-revocations
Authorization: Bearer <admin token>
```

Use `licenses:issue` for issuance, `licenses:update` for plan/status changes and
`revocations:create` for runtime revocation. The revocation endpoint accepts one target:
`session`, `artifact`, `release`, `channel` or `feature`. Matching active sessions are
marked `denied`, immediately removed from concurrency counting and rejected on later
heartbeat/download use.

Never send an authorization/license file through logs or browser command-line
arguments. Never log the decrypted v2 payload. If a file or unlock material is exposed,
revoke the entitlement and issue a new one; the current v1 schema does not rotate only
the secret for an existing license ID.

## Client installation and launch

Export raw 32-byte Ed25519 public keys as base64url. During key rotation, include both
old and new key IDs until all valid leases/manifests using the old key have expired.

```powershell
$env:SLYBROWSER_LICENSE_PUBLIC_KEYS_JSON = '{"license-prod-v1":"<base64url>"}'
$env:SLYBROWSER_RELEASE_PUBLIC_KEYS_JSON = '{"release-prod-v1":"<base64url>"}'
$env:SLYBROWSER_LICENSE_FILE_PUBLIC_KEYS_JSON = '{"license-file-prod-v1":"<base64url>"}'
slybrowser license import --input C:\secure\account_123.slybrowser-license.json --output C:\secure\account_123.slybrowser-sealed-license.json --passphrase '<customer passphrase>'
slybrowser install --authorization C:\secure\account_123.slybrowser-sealed-license.json
```

Node applications call `launchLatest(...)`; Python applications call
`launch_latest(...)`. Both reserve before download, heartbeat through long downloads
and runtime use, release on a normal browser close, and refuse redirects or unsigned,
incompatible, modified and path-escaping artifacts. Cached browser and WebDriver files
are re-hashed before every load; modified cache content is rebuilt from the verified
archive.

## Deployment limits and hardening

Production must set `SLY_LICENSE_STORE=postgres`. The service refuses to start in
production mode with SQLite, because independent SQLite writers behind a load balancer
would split the concurrency authority. The PostgreSQL writer creates the entitlement
and runtime-session tables, then reserves, activates, heartbeats, closes and releases
sessions inside per-license advisory-lock transactions. `reserved` and `active`
sessions both count against Free/Launch/Studio/Fleet/Grid concurrency, repeated
`startupId` requests reuse one reservation, and N+1 attempts fail closed with
`session_limit`.

Production multi-node services should set `SLY_REDIS_URL`. With Redis configured,
license key, session token, runtime token, download ticket and admin credential
rate-limit buckets are shared across all service instances. Redis failures fail closed
with `request_rate_limited` rather than allowing unlimited retries. Without
`SLY_REDIS_URL`, the same buckets use the local in-process limiter and are suitable
only for local/private-preview single-process runs.

SQLite remains available only for local development and private-preview tests through
`SLY_LICENSE_STORE=sqlite` plus `SLY_LICENSE_DB=C:\sly\state\license.sqlite`. The
real PostgreSQL integration matrix is enabled by setting `SLY_TEST_POSTGRES_URL` before
running `pnpm --dir packages/license-service test`; without that variable, local tests
skip the destructive/shared-database checks instead of pretending PostgreSQL was
verified.

The SDK heartbeat and close behavior is cooperative. A modified open-source SDK cannot
mint a valid lease or exceed server reservations, but it can refuse to close a process;
that process remains usable only until its signed lease expires while its reservation
remains counted until TTL. Stronger adversarial runtime enforcement requires a private
native renewal watchdog in both the browser and driver. This limitation should be
stated as an engineering boundary, not described as copy-proof DRM.
