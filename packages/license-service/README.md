# SlyBrowser license service

Private service package for entitlement creation, short-lived Ed25519 lease signing,
atomic browser-process concurrency and authorized Stable artifact delivery.

```powershell
pnpm --filter @slybrowser/license-service build
pnpm --filter @slybrowser/license-service test
node packages/license-service/dist/cli.js serve
```

The same private package also exposes the standalone PayNow billing receiver. It keeps
raw-body signature verification and the billing ledger separate from release signing,
so the webhook can be deployed before the production browser artifact gate is opened:

```powershell
pnpm --filter @slybrowser/license-service build
node packages/license-service/dist/cli.js billing-serve
```

`billing-serve` requires `SLY_PAYNOW_STORE_ID`, `SLY_PAYNOW_API_KEY`,
`SLY_PAYNOW_WEBHOOK_SECRETS`, `SLY_PAYNOW_DB` and the billing email encryption keys.
It creates PayNow customers and checkout sessions from the server-side plan catalog,
never from frontend price, product or URL input. Checkout metadata contains only the
random internal `sly_checkout_intent_id`; the delivery email is encrypted locally and
PayNow checkout tokens are stored only as hashes. Webhooks accept only the four approved
product IDs and subscription activation, renewal and cancellation events. In
PostgreSQL mode, every PayNow Management API call has a timeout, one-process rate limit
and structured redacted audit event; audit logs include operation/status/duration/error
codes, never the API key, request body or raw third-party response. Signed first-payment
webhooks that cannot be second-confirmed because the PayNow Management API is
temporarily unavailable are stored as normalized pending events and retried by a
separate worker:

```powershell
node packages/license-service/dist/cli.js billing-retry-pending-payments --limit 20 --max-attempts 5
```

The retry worker re-runs Management API confirmation and uses the same atomic
first-payment transaction as live webhook processing; hard verification failures do not
grant entitlements.

Run the reconciliation worker every 30–60 minutes from the billing server to repair
missed payment webhooks and sync PayNow subscription retry/cancel evidence:

```powershell
node packages/license-service/dist/cli.js billing-reconcile-paynow --payment-limit 100 --subscription-limit 100
```

Linux deployments can use the checked-in systemd units as the production scheduler
template:

```bash
sudo install -m 0644 packages/license-service/deploy/slybrowser-billing-reconcile.service /etc/systemd/system/
sudo install -m 0644 packages/license-service/deploy/slybrowser-billing-reconcile.timer /etc/systemd/system/
sudo install -m 0644 packages/license-service/deploy/slybrowser-billing-alert@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now slybrowser-billing-reconcile.timer
```

The timer runs 30 minutes after the previous run plus up to 30 minutes of randomized
delay. `slybrowser-billing-reconcile.service` uses the same
`/etc/slybrowser/billing.env` file as `billing-serve`; set
`SLY_OPS_ALERT_WEBHOOK_URL` there to send a redacted failure event from
`deploy/systemd-failure-alert.sh`. Production enablement still requires the server
operator to install the units, reload systemd and confirm the alert receiver.

It lists recent completed Payments and Subscriptions through the PayNow Management API.
Completed payments are still verified through the payment, order and subscription detail
APIs before a first license or renewal period is recorded. Subscription evidence updates
local status, `attempt_count` and `next_attempt_at`, but never extends `paid_through`;
only a completed payment can do that. Mismatched PayNow/customer/product identifiers
fail closed with `paynow_reconciliation_mismatch` for manual audit.

In PostgreSQL mode, customer order self-service is exposed through narrow public-order
routes that require the `customerAccessToken` from the license email. Customers can
check order state, request an encrypted license-file resend, and cancel automatic
renewal at the PayNow subscription period end:

```text
GET  /v1/billing/orders/{publicOrderId}/status
POST /v1/billing/orders/{publicOrderId}/license-resend
POST /v1/billing/orders/{publicOrderId}/cancel-subscription
```

The cancel route calls PayNow Management API `cancel subscription` with
`cancel_at_period_end=true`, then records local `cancel_at_period_end` state without
shortening the existing `paid_through`. Public responses never include PayNow customer,
subscription or payment IDs.

Customer-facing subscription status is derived server-side as
`active`, `grace_period`, `past_due`, `cancel_at_period_end`, `canceled` or
`suspended`. `SLY_BILLING_GRACE_PERIOD_SECONDS` is retained as a test/compatibility
knob, but the approved production launch policy is `0`: failed renewal does not create
extra paid-access grace. SDKs and browser clients do not hard-code the grace duration.

Read-only license diagnostics are available through:

```text
POST /v2/licenses/info
Authorization: License <license-key>
```

The endpoint returns plan, effective plan, paid-through, features, active/available
browser-process concurrency, selected release and update status. It does not reserve a
session or return secrets, leases, tickets, emails, PayNow IDs, profile paths or service
access URLs.

For offline QA or support-controlled test issuance, use the same production-format
license-file path without PayNow by running `issue-portable-v2`. It creates an
entitlement in the configured license store, then writes an encrypted and Ed25519
authenticated `portable-passphrase` v2 license file. In production set
`SLY_LICENSE_STORE=postgres`; local/private-preview can pass `--db` for SQLite:

```powershell
$env:SLY_LICENSE_STORE = "postgres"
$env:SLY_LICENSE_POSTGRES_URL = "postgres://..."
$env:SLY_LICENSE_KEY_PEPPER = "..."
$env:SLY_LICENSE_FILE_SERVICE_URL = "https://api.slybrowser.com"
$env:SLY_LICENSE_FILE_PRIVATE_PREVIEW_PASSPHRASE = "..."
$env:SLY_LICENSE_FILE_SIGNING_KEY_FILE = "C:\slybrowser\secrets\license-file-signing.pem"
$env:SLY_LICENSE_FILE_SIGNING_KEY_ID = "license-file-prod-v1"
node packages/license-service/dist/cli.js issue-portable-v2 --account test002@slybrowser.com --plan launch --paid-through 1797974400 --output test002-launch.slybrowser-license.json
```

The command output is metadata only; it never prints the generated license key. Keep
the passphrase, pepper, signing key, SQLite database and generated license files out of
Git and ordinary logs.

When `SLY_LICENSE_ADMIN_CREDENTIALS_JSON` is configured, `serve` exposes the local
license-admin routes with per-token permissions:

```text
POST /v1/admin/licenses
Authorization: Bearer <token with licenses:issue>

PATCH /v1/admin/licenses/{licenseId}
Authorization: Bearer <token with licenses:update>

POST /v1/admin/runtime-revocations
Authorization: Bearer <token with revocations:create>
```

`SLY_LICENSE_ADMIN_CREDENTIALS_JSON` is an array of `{ token, actor, permissions }`
objects. Keep `licenses:issue`, `licenses:update` and `revocations:create` separated for production
operations. The legacy `SLY_LICENSE_ADMIN_TOKEN` fallback remains only for local/dev
compatibility and should not be used as the final production admin model.

`/v1/admin/runtime-revocations` accepts one target at a time and fails closed on
unknown fields. Supported targets are:

```json
{ "target": { "scope": "session", "sessionId": "00000000-0000-4000-8000-000000000000" } }
{ "target": { "scope": "artifact", "artifactSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }
{ "target": { "scope": "release", "browserVersion": "150.0.8000.1" } }
{ "target": { "scope": "channel", "channel": "stable" } }
{ "target": { "scope": "feature", "feature": "playwright" } }
```

Matching active sessions are marked `denied`, released immediately from concurrency
counting and rejected on later heartbeat/download use. Production incident use still
requires the release/CDN rollback runbook and alert evidence.

License-service authorization denials also feed a local failure-backoff guard. Repeated
failures from the same IP, operation and authorization scheme return stable
`request_rate_limited` responses with `retryAfterSeconds` and `backoff=true`, without
echoing guessed credentials. Production deployments should still add shared edge
rate-limits and abuse monitoring in front of the API.

When `SLY_BILLING_ADMIN_CREDENTIALS_JSON` is configured, `billing-serve` exposes
billing-admin endpoints on the API domain with per-token permissions and audited
actors:

```text
GET /v1/admin/orders/{publicOrderId}
Authorization: Bearer <token with orders:read>

GET /v1/admin/orders?limit=50&offset=0
Authorization: Bearer <token with orders:read>

GET /v1/admin/orders/lookup?publicOrderId=... | payNowOrderId=... | licenseId=...
Authorization: Bearer <token with orders:read>

POST /v1/admin/orders/{publicOrderId}/notes
Authorization: Bearer <token with orders:note>

POST /v1/admin/orders/{publicOrderId}/customer-email
Authorization: Bearer <token with orders:email>

POST /v1/admin/orders/{publicOrderId}/subscription-cancellation
Authorization: Bearer <token with subscriptions:cancel>

POST /v1/admin/orders/{publicOrderId}/refunds
Authorization: Bearer <token with orders:refund>
Idempotency-Key: <stable-operation-key>

POST /v1/admin/orders/{publicOrderId}/license-resend
Authorization: Bearer <token with licenses:resend>

POST /v1/admin/orders/{publicOrderId}/license-rotation
Authorization: Bearer <token with licenses:rotate>
Idempotency-Key: <stable-operation-key>

POST /v1/admin/orders/{publicOrderId}/license-status
Authorization: Bearer <token with licenses:update>
```

`SLY_BILLING_ADMIN_CREDENTIALS_JSON` is an array of `{ token, actor, permissions }`
objects, for example separate `orders:read`/`orders:note`/`subscriptions:cancel`,
`orders:email`, `orders:refund`, and
`licenses:resend`/`licenses:rotate`/`licenses:update`
credentials.
The legacy `SLY_BILLING_ADMIN_TOKEN` fallback is kept only for local/dev compatibility
and should not be used as the final production admin model.

The `orders:read` list endpoint returns a paginated, redacted support view of all
orders with plan, status, latest payment and latest refund summaries. The single-order
endpoint returns a redacted support view of one public order:
order/payment/subscription/refund statuses and admin audit events. It deliberately
does not return license files, license keys, customer email addresses, access tokens,
download tickets or runtime handoff secrets. The `/lookup` variant accepts exactly one
of `publicOrderId`, `payNowOrderId` or `licenseId` and returns the same redacted
support view. The `orders:note` endpoint appends an
audited support note to the same order event chain without requiring refund or license
rotation permissions. The `orders:email` endpoint changes the encrypted delivery
email only after a support operator supplies a reason, matching email confirmation and
ownership evidence; it returns only old/new masked email values and writes the change
to the admin audit chain. Future license-file resend jobs use the current encrypted
delivery email rather than the original outbox recipient. The `subscriptions:cancel` endpoint cancels automatic renewal
through PayNow before recording local cancellation, and does not refund or shorten the
current paid-through period. The `licenses:resend` endpoint queues the same signed
license file to the existing encrypted recipient with an hourly idempotency window; it
does not rotate keys. The `licenses:update` endpoint sets the backing license status to
`hold`, `revoked` or back to `active` from hold by updating both the billing entitlement
and runtime authorization entitlement in one transaction; revoked licenses are not
restored by this status route.

The implementation supports full-order PayNow refunds only. It records a
`requested` refund under the idempotency key, calls PayNow Management API
`/orders/{orderId}/refund`, maps PayNow `created/approved/processing` to local
`processing`, and records `completed` or `failed`. A completed refund marks the local
order/payment as refunded, cancels the local subscription record, shortens
`paid_through` to the refund completion time, revokes both billing and runtime
entitlements, and marks active runtime sessions as closing for fail-closed heartbeat
handling.

The website admin panel at `/admin/orders` uses these admin APIs to list all orders and
expose a manual refund button for support operators with `orders:refund` permission.
The button requires an operator reason and sends a fresh idempotency key; customers
cannot request refunds from the public order page.

PayNow `ON_CHARGEBACK` webhooks now fail closed for new runtime access: when the event
matches a known local order or payment, the order becomes `disputed`, the payment is
marked `chargeback`, and the related entitlement is moved to `hold`. Dispute-close
recovery remains policy-gated and is not automatic yet.

When `SLY_EMAIL_SMTP_HOST`, `SLY_EMAIL_FROM` and `SLY_FEEDBACK_TO` are configured,
`billing-serve` also accepts `POST /v1/feedback` and forwards validated feedback to
the configured mailbox through server-side SMTP. License-file delivery is handled by a
separate PostgreSQL outbox worker:

```powershell
node packages/license-service/dist/cli.js billing-send-license-emails --limit 20
```

The worker sends queued `license_file` rows that already contain a generated
license-file payload, plus `billing_notice` rows for renewal receipts, payment retries,
optional grace-period notices, cancellation, completed refunds, chargeback holds and account
restoration. Billing notices never attach or log a license file. Delivery attempts are
recorded in `billing_email_deliveries`, retried with backoff, and sent to the encrypted
website-entered delivery email rather than PayNow `billing_email`. See
`docs/mailbox-license-feedback.md` for SMTP, DNS and server process setup.

The receiver keeps a structured audit record for every accepted or rejected webhook
for 90 days. It records the result, HTTP status, verification state, duration, payload
size and SHA-256 digest, plus PayNow identifiers that pass strict validation. It never
stores the webhook signature or secret, raw payload, checkout metadata or customer
email in the audit table. Expired rows are pruned at startup and every six hours.

Operators can inspect the audit trail locally on the server; it is intentionally not
exposed as a public HTTP endpoint:

```powershell
node packages/license-service/dist/cli.js billing-logs --db paynow.sqlite --since-days 7 --outcome failure --limit 200
```

PayNow documents successful subscription lifecycle webhooks but does not document a
failed recurring-charge event. Consequently, a `failure` audit row means the receiver
rejected or could not process an incoming webhook. Provider-side card declines require
separate Management API reconciliation when that capability is added.

The five enforced plans are defined by `contracts/plans.json`: Free 1, Launch 5,
Studio 20, Fleet 200 and Grid 2,000. See
`docs/authorized-release-service.md` for keys, environment variables, release signing,
authorization generation, API routes and deployment limits.

For production multi-node deployments, configure `SLY_REDIS_URL` so license-key,
session/runtime-token, download-ticket and admin rate limits are shared across service
instances. If Redis is configured but unavailable, protected routes fail closed with
`request_rate_limited`; local/private-preview runs without `SLY_REDIS_URL` keep the
in-process limiter. The default `runtime-token` bucket is 6,000 requests/minute per IP
so a Grid license with 2,000 browser processes has a three-times heartbeat burst budget;
do not lower it in production without a replacement plan-aware limiter and soak test.

This package is not published to npm. Run it behind HTTPS and never commit its SQLite
database, signing key, HMAC pepper, admin token or generated authorization files.
