# PayNow subscription integration

Status: four paid-plan products plus one isolated recurring billing QA product exist in
the PayNow test store. The website now collects a delivery email and calls the
SlyBrowser billing API, which creates PayNow customer/checkout sessions server-side
from the canonical plan-to-product mapping. The signed receiver is deployed at
`https://api.slybrowser.com/v1/billing/paynow/webhook`, and activation, renewal and
cancellation webhooks are connected. The store is still waiting for live-mode review;
Management API second confirmation, PostgreSQL accounting, pending-payment retry and
SMTP-based feedback/license/billing-notice outbox workers now exist locally. Production
sender-domain setup, provider/DNS/bounce handling, live-mode approval and
legal/commercial approval remain launch blockers.

## Does PayNow support automatic renewal?

Yes. A PayNow product configured with a billing cycle can be sold as a recurring
subscription and PayNow automatically charges the customer at that interval. Not every
payment method supports recurring billing, so the actual methods offered at checkout
must be tested for each target market. Customers can stop future renewals from PayNow's
[subscription management page](https://checkout.paynow.gg/subscriptions); cancellation
does not remove access before the end of the paid billing period.

Sources:

- [PayNow Packages FAQ](https://guides.paynow.gg/getting-started/faq/packages-faq)
- [PayNow subscription guide](https://guides.paynow.gg/content/subscriptions)
- [PayNow customer subscription FAQ](https://guides.paynow.gg/getting-started/faq/manage-my-subscriptions)

## Website integration

The Vite application posts paid-plan selections to the trusted billing API:

```text
POST /v1/billing/checkout-intents
{ "plan_id": "studio", "email": "customer@example.com", "email_confirmation": "customer@example.com" }
```

The frontend never sends price, currency, SKU, product ID, renewal flag or checkout
URL. The billing service stores an encrypted delivery email, keeps a server-side plan
snapshot including `sku` and `autoRenew`, creates the PayNow customer and checkout with
a Management API key, then returns the PayNow checkout URL for browser redirect.

The Vite application may still read the isolated QA checkout values for recurring
billing tests:

```text
VITE_ENABLE_BILLING_QA
VITE_PAYNOW_RECURRING_TEST_URL
VITE_PAYNOW_RECURRING_TEST_PRICE
VITE_PAYNOW_RECURRING_TEST_COUPON
```

The QA checkout widget is hard-disabled in production builds and only appears when
`VITE_ENABLE_BILLING_QA=true` in a non-production environment.

Create a separate recurring monthly PayNow product for each plan. This keeps
the displayed price, billing cycle and entitlement mapping explicit. Use the product
page from the PayNow hosted webstore, whose documented product route is
`GET /products/{product.slug}`. The production site only activates a payment button
when its corresponding environment value is a valid HTTPS URL.

Current test-store products:

| Plan | SKU | Product ID | Hosted product URL | Renewal |
| --- | --- | --- | --- | --- |
| Launch | `launch` | `592701767033036800` | Server-side checkout intent only | Monthly, $19 |
| Studio | `studio` | `592701920221593600` | Server-side checkout intent only | Monthly, $49 |
| Fleet | `fleet` | `592702024412299264` | Server-side checkout intent only | Monthly, $199 |
| Grid | `grid` | `592702180452990976` | Server-side checkout intent only | Monthly, $499 |
| Billing QA | `billing_qa` | `592719053055860736` | Non-production env var only | Monthly, $1.00 base; `SLY10MONTHLY` applies $0.90 forever for a $0.10 renewal total |

All four disable one-time purchase, enable subscriptions, and renew every one month.
SlyBrowser pricing buttons do not depend on hosted product-page template behavior; they
use the server-side PayNow Management API path instead.

The server contract requires every paid canonical SKU to default to `autoRenew: true`
and Free to remain `autoRenew: false`. Checkout intent/status responses expose
`sku` and `autoRenew` for display and audit, but callers cannot override them. PayNow
checkout creation fails closed with `paynow_sku_not_renewable` if a paid SKU is ever
configured without automatic renewal, rather than silently creating a one-time purchase.

The isolated Billing QA product follows the same subscription-only monthly lifecycle.
It never grants a browser plan. PayNow rejects a direct $0.10 product price, so its
$1.00 base price is reduced by the product-scoped `SLY10MONTHLY` fixed coupon. The
coupon is subscription-only and applies the $0.90 discount forever, including renewal
cycles. Always verify the checkout total before entering payment details. Do not set
`VITE_ENABLE_BILLING_QA=true` for a production website build.

The static site must not call the PayNow Management API. That API uses a secret API key
and is only safe on a trusted server. The implemented server-side path uses
`POST /v1/stores/{storeId}/customers` followed by
`POST /v1/stores/{storeId}/checkouts`, and checkout metadata contains only the random
internal `sly_checkout_intent_id`. Do not place customer secrets in checkout metadata.

References:

- [Hosted webstore routes](https://docs.paynow.gg/hosted-webstores/routes)
- [Server-side checkout API](https://docs.paynow.gg/management/management-api/checkout)
- [Storefront checkout API](https://docs.paynow.gg/storefront-headless/storefront-api/checkout)

## Required renewal-to-license service

Payment and browser entitlement are separate systems. A production webhook service
must connect them:

```text
SlyBrowser website
  -> PayNow hosted checkout
  -> subscription activated or renewed
  -> verified SlyBrowser webhook endpoint
  -> account subscription record
  -> concurrency authority
  -> short-lived signed browser leases
```

The production receiver should use the DNS-only API origin rather than the CDN-backed
website hostname:

```text
https://api.slybrowser.com/v1/billing/paynow/webhook
```

License lease, account and billing endpoints should also use
`https://api.slybrowser.com`. The API hostname must send `Cache-Control: no-store` and
must not be placed behind the website's static-asset cache rules.

Subscribe the endpoint to at least these events:

| PayNow event | SlyBrowser action |
| --- | --- |
| `ON_SUBSCRIPTION_ACTIVATED` | Link the PayNow customer and subscription to the SlyBrowser account; set plan and paid-through time. |
| `ON_SUBSCRIPTION_RENEWED` | Extend the paid-through time idempotently; keep the existing plan capacity. |
| `ON_SUBSCRIPTION_CANCELED` | Mark cancel-at-period-end; do not immediately revoke already-paid access. |
| `ON_REFUND` | Record the full-order refund and immediately revoke the paid entitlement. Partial refunds are not exposed by SlyBrowser admin APIs. |
| `ON_CHARGEBACK` | Place the entitlement on hold and send it to manual review. |

Webhook processing must be idempotent. Store `event_id` and ignore a duplicate event
after the first successful transaction. Do not issue or extend an entitlement from a
browser redirect alone.

PayNow signs webhooks using HMAC-SHA256 over
`{PayNow-Timestamp}.{raw_request_body}`. The endpoint must preserve the raw body,
compare the Base64 signature from `PayNow-Signature` in constant time, reject timestamps
outside a five-minute tolerance and deduplicate the event ID. The signing secret belongs
only in server-side secret storage.

The implemented receiver is built from `packages/license-service` with:

```text
node packages/license-service/dist/cli.js billing-serve
```

Required local environment for the commercial checkout/webhook process:

```text
SLY_PAYNOW_STORE_ID=...
SLY_PAYNOW_API_KEY=...
SLY_PAYNOW_WEBHOOK_SECRETS=...
SLY_PAYNOW_DB=...
SLY_BILLING_EMAIL_ENCRYPTION_KEY=...
SLY_BILLING_EMAIL_HMAC_KEY=...
SLY_BILLING_PUBLIC_ORIGIN=https://slybrowser.com
SLY_PAYNOW_API_BASE_URL=https://api.paynow.gg/v1
SLY_PAYNOW_API_TIMEOUT_MS=20000
SLY_PAYNOW_API_RATE_LIMIT_PER_MINUTE=120
SLY_PAYNOW_API_RATE_LIMIT_MAX_QUEUE=100
SLY_LICENSE_KEY_PEPPER=...
SLY_LICENSE_FILE_SERVICE_URL=https://api.slybrowser.com
SLY_LICENSE_FILE_SIGNING_KEY_FILE=...
SLY_LICENSE_FILE_SIGNING_KEY_ID=license-file-private-preview-v1
SLY_LICENSE_FILE_PRIVATE_PREVIEW_PASSPHRASE=...
```

For automatic paid activation, `SLY_BILLING_POSTGRES_URL` and
`SLY_LICENSE_POSTGRES_URL` must point to the same PostgreSQL database/schema. The
first-payment transaction writes both billing rows and the runtime `entitlements` row
atomically; using separate databases would create a license file that the authorization
service cannot validate.

It verifies the raw body before parsing JSON, rejects timestamps more than five minutes
from the server clock, compares the Base64 HMAC in constant time, binds events to the
expected PayNow store and approved product IDs, and stores only a SHA-256 payload digest
plus normalized state. Duplicate event IDs are accepted only when their payload digest
is identical.

For `ON_PAYMENT_COMPLETED`, the webhook is not trusted as the source of entitlement.
`billing-serve` calls the PayNow Management API to fetch the payment, order and
subscription, then cross-checks store, customer, checkout, subscription, product, amount,
currency and current period. A verified `subscription_initial` payment enters the
PostgreSQL first-payment transaction: it records the webhook digest, creates the
order/payment/subscription period, writes the runtime `entitlements` row, generates a v2
encrypted/signed private-preview license file and queues the first license email outbox
row. Missing Management API confirmation or missing license-file signing configuration
fails closed with no entitlement and no email.

A verified `subscription_renewal` payment enters the renewal transaction instead. It
creates an independent order, payment and subscription period, then extends
`paidThrough` by `max(existingPaidThrough, renewedPeriodEnd)` on the subscription,
billing entitlement and runtime entitlement. It deliberately does not create a new
license file. It queues a separate `billing_notice` renewal receipt with plan, order,
amount and paid-through details, but no license attachment.

All PayNow Management API calls go through the same client-side guard: request timeout,
one-process rate limiting and a structured redacted audit event. The audit event includes
operation, method, path, outcome, HTTP status, duration, rate-limit wait and bounded error
codes. It deliberately excludes the API key, request body, raw third-party response,
checkout token, customer email and webhook payload.

If PayNow's Management API is temporarily unavailable after a valid signed
`ON_PAYMENT_COMPLETED` webhook, `billing-serve` stores a normalized pending record in
`billing_pending_paynow_events` and returns `202`. The pending table stores the event
ID, event type, payload SHA-256 digest, normalized payment identifiers and bounded error
text; it does not store the raw webhook JSON, webhook signature, API key, checkout
metadata or customer email. Payload hash mismatches still fail closed instead of being
queued.

Run the retry worker on the billing server until it reports no claimed rows:

```text
node packages/license-service/dist/cli.js billing-retry-pending-payments --limit 20 --max-attempts 5
```

The worker claims rows with `FOR UPDATE SKIP LOCKED`, re-runs PayNow Management API
second confirmation, then executes either the PostgreSQL first-payment transaction or the
renewal transaction used by live webhook processing. Temporary Management API failures
back off for another retry; hard verification failures are marked failed and never grant
or extend an entitlement.

Run the reconciliation worker every 30–60 minutes to cover webhook silence and recurring
billing drift:

```text
node packages/license-service/dist/cli.js billing-reconcile-paynow \
  --payment-limit 100 --subscription-limit 100
```

The repository includes a production scheduler template:

- `packages/license-service/deploy/slybrowser-billing-reconcile.service`
- `packages/license-service/deploy/slybrowser-billing-reconcile.timer`
- `packages/license-service/deploy/slybrowser-billing-alert@.service`
- `packages/license-service/deploy/systemd-failure-alert.sh`

Install the two unit files and the alert template on the billing host, then enable
`slybrowser-billing-reconcile.timer`. The timer uses `OnUnitActiveSec=30min` with
`RandomizedDelaySec=30min`, so production runs land inside the required 30–60 minute
window. The alert service posts only `source`, `severity`, `event`, `unit` and `host`
to `SLY_OPS_ALERT_WEBHOOK_URL`; it does not include webhook bodies, email addresses,
license keys, PayNow IDs or raw logs.

The worker lists recent completed Payments and Subscriptions through the PayNow
Management API. Each completed Payment is still second-confirmed through payment, order
and subscription detail APIs before the existing first-payment or renewal transaction is
called. Subscription list evidence is used only to sync cancellation/retry facts such as
`status`, `attempt_count` and `next_attempt_at`; it never extends `paidThrough`. When
those facts change, the same transaction can queue `billing_notice` messages for payment
retry, grace period, cancellation or restoration.
Identifier mismatches fail closed with `paynow_reconciliation_mismatch` and must be
reviewed by an operator. This keeps failed recurring charges from granting time while
still letting successful PayNow retries create the next paid period.

Current limitation: the automatic paid license file uses the implemented
`sly-portable-scrypt-v1` unlock mode so every SDK reader can verify it today. Node.js and
Python can import that file into a Windows DPAPI current-user sealed authorization file
for routine launches. Public launch still requires the per-customer passphrase
capture/delivery flow, Java/.NET sealed import parity and the planned enterprise KMS
unlock mode before this should be advertised as complete license-file hardening.

### Mailbox and feedback delivery

The same billing service can accept product feedback and license-delivery support
messages:

```text
POST /v1/feedback
```

When `SLY_EMAIL_SMTP_HOST`, `SLY_EMAIL_FROM` and `SLY_FEEDBACK_TO` are configured,
validated website feedback is forwarded to the configured mailbox through SMTP. The
feedback route allows only whitelisted fields, includes a honeypot field named
`website`, and fails closed with `feedback_email_not_configured` when no mailbox is
configured.

Paid license files and billing notices are sent by a separate outbox worker, not
directly from the webhook request:

```text
node packages/license-service/dist/cli.js billing-send-license-emails --limit 20
```

The worker claims PostgreSQL outbox rows with `FOR UPDATE SKIP LOCKED`. `license_file`
rows must already contain `licenseFile`; `billing_notice` rows must not contain
`licenseFile` and never attach one. Notice templates are distinct for renewal receipt,
payment retry, grace period, cancellation, completed refund, chargeback hold and account
restoration. The worker writes `billing_email_deliveries` and backs off retries up to
`SLY_LICENSE_EMAIL_MAX_ATTEMPTS`. Full server setup is in
[`mailbox-license-feedback.md`](mailbox-license-feedback.md).

When `SLY_EMAIL_WEBHOOK_TOKEN` is configured, `billing-serve` can also accept normalized
email provider delivery callbacks at `POST /v1/billing/email-deliveries` with
`Authorization: Bearer <token>`. The callback records `delivered`, `bounced` or `failed`
against an existing `provider + provider_message_id`, deduplicates provider event
retries with `provider_event_id`, and rejects unknown message IDs instead of creating
orphan delivery records.

Final send failures plus `bounced` and provider `failed` callbacks are also queued in
`billing_email_manual_reviews` with `status='open'`. The manual queue keeps only bounded
provider diagnostics and identifiers; it does not store decrypted delivery email or
license attachment contents.

### Customer status and license-file resend

The PostgreSQL billing store issues a `customerAccessToken` when the first verified
payment creates the order, entitlement and license email. The token is included in the
license email together with the public order ID, while the database stores only an HMAC
hash on `billing_orders.customer_access_token_hash`.

Customer self-service endpoints:

```text
GET  /v1/billing/orders/{publicOrderId}/status
POST /v1/billing/orders/{publicOrderId}/license-resend
POST /v1/billing/orders/{publicOrderId}/cancel-subscription
```

The website exposes this flow at `/billing/order`. The license email includes the
customer order page, public order ID and customer access token, but does not embed the
token in the URL. The status page sends the token in `X-Sly-Customer-Access-Token`;
the API does not accept URL query tokens for customer status.

The status response is deliberately narrow: public order/subscription IDs, plan,
concurrency, order/subscription state, `paidThrough`, dynamic `remainingDays`,
auto-renew/cancel-at-period-end booleans and license delivery status. It does not return
PayNow IDs, customer email, license key, license file contents or payment card fields.

The resend endpoint accepts only `{ "token": "cst_..." }`, verifies the same hashed
customer token, then queues a replacement license email from the original encrypted
outbox payload. It is idempotent per order per hour and records a
`license_file_resend_requested` audit event.

The cancel endpoint also accepts only `{ "token": "cst_..." }`. After ownership
verification it calls PayNow Management API `cancel subscription` with
`cancel_at_period_end=true`, then records local `cancel_at_period_end` state and an
audit event. It does not refund, does not shorten `paidThrough`, and does not expose
PayNow customer/subscription/payment IDs in the response. If PayNow cancellation fails,
local subscription state is left unchanged. Successful local cancellation queues a
`subscription-canceled` billing notice to the original encrypted delivery email.

Customer-facing subscription status is derived server-side as `active`,
`grace_period`, `past_due`, `cancel_at_period_end`, `canceled` or `suspended`.
`SLY_BILLING_GRACE_PERIOD_SECONDS` is kept as a test/compatibility knob, but the
approved launch policy is `0`: failed renewal does not create a grace period and access
expires at the existing paid-through time. Browser and SDK clients never hard-code a
grace duration.

### Admin billing support and full-order refunds

`billing-serve` can expose billing-admin routes when
`SLY_BILLING_ADMIN_CREDENTIALS_JSON` is configured with least-privilege
`orders:read`, `orders:note`, `subscriptions:cancel`, `orders:refund`,
`orders:email`, `licenses:resend`, `licenses:rotate` or `licenses:update`
credentials:

```text
GET /v1/admin/orders/{publicOrderId}
Authorization: Bearer <token with orders:read>

GET /v1/admin/orders/lookup?payNowOrderId=...
Authorization: Bearer <token with orders:read>

POST /v1/admin/orders/{publicOrderId}/notes
Authorization: Bearer <token with orders:note>
{ "note": "Customer asked support to review renewal timing." }

POST /v1/admin/orders/{publicOrderId}/customer-email
Authorization: Bearer <token with orders:email>
{
  "email": "new.owner@example.com",
  "email_confirmation": "new.owner@example.com",
  "reason": "Customer opened support ticket and verified order ownership.",
  "ownership_evidence": "support-ticket-id-or-safe-verification-summary"
}

POST /v1/admin/orders/{publicOrderId}/subscription-cancellation
Authorization: Bearer <token with subscriptions:cancel>
{ "reason": "Customer requested support-assisted cancellation." }

POST /v1/admin/orders/{publicOrderId}/refunds
Authorization: Bearer <token with orders:refund>
Idempotency-Key: <stable-operation-key>
{ "reason": "Customer requested refund" }

POST /v1/admin/orders/{publicOrderId}/license-resend
Authorization: Bearer <token with licenses:resend>
{ "reason": "Customer lost the original license email." }

POST /v1/admin/orders/{publicOrderId}/license-status
Authorization: Bearer <token with licenses:update>
{ "status": "hold", "reason": "Payment risk review while support investigates." }
```

The `orders:read` route records an audit event and returns a redacted support view:
order/payment/subscription/refund statuses plus existing admin audit events. It does
not expose license files, license keys, delivery emails, customer access tokens,
download tickets or runtime handoff secrets. The `/lookup` variant accepts exactly one
of `publicOrderId`, `payNowOrderId` or `licenseId` and returns the same support view.
`orders:note` adds an audited support note to the same event chain. `orders:email`
updates the encrypted delivery email after matching confirmation and ownership
evidence, returns only old/new masked email values, and records the operator, reason,
masked before/after values and redacted evidence in admin audit logs; future license
resends use this current encrypted delivery email. `subscriptions:cancel` calls PayNow subscription
cancellation before local state changes and never creates a refund or shortens the
current paid-through period. `licenses:resend` queues the same signed license file to
the existing encrypted recipient with an hourly idempotency window; it does not rotate
keys. The same RBAC credential file can grant
`licenses:rotate` to a separate operator token for
`POST /v1/admin/orders/{publicOrderId}/license-rotation`. `licenses:update` updates
both the billing entitlement and runtime authorization entitlement in the same
transaction for hold/revoke/hold recovery; a revoked license is not restored by this
route. The legacy `SLY_BILLING_ADMIN_TOKEN` fallback is retained only for local/dev
compatibility.

This route is intentionally API-domain only. It creates a local `requested` refund with
a hashed idempotency key, calls PayNow Management API
`POST /v1/stores/{storeId}/orders/{orderId}/refund`, then stores the PayNow refund ID
and maps third-party status into local `processing`, `completed` or `failed`.
SlyBrowser exposes only full-order refunds. Completed refunds mark the local
order/payment as refunded, cancel the local subscription record, shorten
`paidThrough` to the refund completion time, revoke the billing entitlement, revoke
the runtime authorization entitlement and mark active runtime sessions as closing so
the next heartbeat fails closed. A completed refund queues a refund receipt notice and
Free-plan access remains available. Processing or failed refund API responses do not
send a customer receipt. Partial order-line refunds are intentionally not exposed even
though PayNow's API supports `order_line_id`.

For `ON_CHARGEBACK`, PostgreSQL processing now applies an immediate hold if the webhook
can be matched to a local PayNow order or payment: order status becomes `disputed`,
payment status becomes `chargeback`, and the related entitlement moves to `hold` so new
runtime sessions are denied. The same transaction queues a `chargeback-hold` billing
notice. `ON_CHARGEBACK_CLOSED` is still recorded as evidence only until the dispute
outcome policy is approved.

### 90-day payment audit trail

Every webhook request is written to `paynow_payment_logs` as either `success` or
`failure` and retained for 90 days. The service prunes expired records on startup and
every six hours while it is running. Each record contains only:

- receive/expiry time, processing result, HTTP status and verification status;
- processing duration, payload byte length and SHA-256 digest;
- strictly validated PayNow event, store, product, subscription and customer IDs; and
- a bounded service error code and message for rejected requests.

The table deliberately excludes the webhook signature and secret, raw JSON, checkout
metadata, customer email and browser/account telemetry. There is no public log API.
Query it from an authenticated server shell:

```text
node /opt/slybrowser-billing/current/dist/cli.js billing-logs \
  --db /var/lib/slybrowser-billing/paynow.sqlite \
  --since-days 7 --outcome failure --limit 200
```

PayNow currently documents activation, renewal and cancellation lifecycle events but
does not document a failed recurring-charge webhook. `success` therefore means a
verified lifecycle event was processed (or safely deduplicated), while `failure` means
the receiver rejected or could not process a request, such as a missing/invalid
signature, stale timestamp, malformed payload, unmapped product or oversized request.
Actual provider-side card declines need Management API reconciliation and must not be
inferred from webhook silence.

The subscription ledger deliberately does not invent an account identity. Hosted
anonymous checkout events remain unlinked. Automatic browser-entitlement activation
requires an account-bound checkout that adds `sly_account_id` and `sly_license_id` to
server-created checkout metadata.

References:

- [PayNow webhook events](https://docs.paynow.gg/webhooks/webhook-events/webhooks)
- [Validating incoming webhooks](https://docs.paynow.gg/webhooks/validating-incoming-webhooks)
- [Preventing replay attacks](https://docs.paynow.gg/webhooks/preventing-replay-attacks)

## Entitlement and cancellation policy

- One licensed browser OS process consumes one concurrent session; tabs and contexts do
  not consume additional capacity.
- Profile directories are unlimited and customer-owned.
- Free, Launch, Studio, Fleet and Grid share the same browser-quality baseline; they
  differ in concurrency, administration and support. Fleet and Grid are self-serve
  SKUs at launch.
- Cancellation stops the next renewal. The current paid plan remains active through the
  paid-through timestamp and then falls back to Free at one concurrent process.
- Local profile data is not removed on downgrade.
- License telemetry must not include URLs, page content, cookies, credentials or profile
  configuration.

## Production activation checklist

Before setting any PayNow product URL in the production deployment:

1. approve paid-preview terms, taxes, privacy and support ownership;
2. create products whose prices and billing cycles exactly match the website;
3. deploy the webhook receiver, account mapping and atomic concurrency authority;
4. test activation, renewal, cancellation, duplicate events, refunds and chargebacks in
   PayNow test mode;
5. test an unsupported recurring payment-method path and make the limitation visible;
6. verify the signed browser download/update and rollback flow; and
7. reconcile PayNow subscription state against SlyBrowser entitlements before launch.
