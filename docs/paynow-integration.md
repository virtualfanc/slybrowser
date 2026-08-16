# PayNow subscription integration

Status: four recurring monthly products exist in the PayNow test store and the website
uses their hosted product URLs. The store is still waiting for live-mode review and the
server-side entitlement webhook is not connected, so this is checkout-entry testing,
not production payment or automatic license activation.

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

The Vite application reads public hosted product-page URLs from environment variables:

```text
VITE_PAYNOW_LAUNCH_MONTHLY_URL
VITE_PAYNOW_STUDIO_MONTHLY_URL
VITE_PAYNOW_FLEET_MONTHLY_URL
VITE_PAYNOW_GRID_MONTHLY_URL
```

Create a separate recurring monthly PayNow product for each plan. This keeps
the displayed price, billing cycle and entitlement mapping explicit. Use the product
page from the PayNow hosted webstore, whose documented product route is
`GET /products/{product.slug}`. The production site only activates a payment button
when its corresponding environment value is a valid HTTPS URL.

Current test-store products:

| Plan | Product ID | Hosted product URL | Renewal |
| --- | --- | --- | --- |
| Launch | `592701767033036800` | `https://virtualbrowser.paynow.store/products/slybrowser-launch-monthly` | Monthly, $19 |
| Studio | `592701920221593600` | `https://virtualbrowser.paynow.store/products/slybrowser-studio-monthly` | Monthly, $49 |
| Fleet | `592702024412299264` | `https://virtualbrowser.paynow.store/products/slybrowser-fleet-monthly` | Monthly, $199 |
| Grid | `592702180452990976` | `https://virtualbrowser.paynow.store/products/slybrowser-grid-monthly` | Monthly, $499 |

All four disable one-time purchase, enable subscriptions, and renew every one month.
The hosted Summit template currently dereferences the missing `#hero` element before it
registers its product-page application, so its Subscribe button cannot progress. The
SlyBrowser pricing buttons bypass that template defect by submitting directly to the
documented `POST /products/{slug}/checkout?subscription=true` hosted-webstore route.

The static site must not call the PayNow Management API. That API uses a secret API key
and is only safe on a trusted server. If account-bound checkout is added later, the
server can call PayNow's `POST /v1/stores/{storeId}/checkouts` endpoint and redirect the
customer to the returned checkout URL. Do not place customer secrets in checkout
metadata.

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
| `ON_REFUND` | Apply the approved refund policy and shorten or revoke entitlement only when that policy requires it. |
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

It verifies the raw body before parsing JSON, rejects timestamps more than five minutes
from the server clock, compares the Base64 HMAC in constant time, binds events to the
expected PayNow store and four approved product IDs, and stores only a SHA-256 payload
digest plus normalized subscription state. Duplicate event IDs are accepted only when
their payload digest is identical.

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
  differ in concurrency, administration and support.
- Cancellation stops the next renewal. The current paid plan remains active through the
  paid-through timestamp and then falls back to Free at one concurrent process.
- Local profile data is not removed on downgrade.
- License telemetry must not include URLs, page content, cookies, credentials or profile
  configuration.

## Production activation checklist

Before setting any PayNow product URL in the production deployment:

1. approve paid-preview terms, refund rules, taxes, privacy and support ownership;
2. create products whose prices and billing cycles exactly match the website;
3. deploy the webhook receiver, account mapping and atomic concurrency authority;
4. test activation, renewal, cancellation, duplicate events, refunds and chargebacks in
   PayNow test mode;
5. test an unsupported recurring payment-method path and make the limitation visible;
6. verify the signed browser download/update and rollback flow; and
7. reconcile PayNow subscription state against SlyBrowser entitlements before launch.
