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

`billing-serve` requires `SLY_PAYNOW_STORE_ID`, `SLY_PAYNOW_WEBHOOK_SECRETS` and
`SLY_PAYNOW_DB`. It accepts only the four approved product IDs and subscription
activation, renewal and cancellation events. Checkout metadata may carry
`sly_account_id` and `sly_license_id`; hosted anonymous checkouts are recorded but stay
unlinked until an account-bound checkout flow supplies those identifiers.

The five enforced plans are defined by `contracts/plans.json`: Free 1, Launch 5,
Studio 20, Fleet 200 and Grid 2,000. See
`docs/authorized-release-service.md` for keys, environment variables, release signing,
authorization generation, API routes and deployment limits.

This package is not published to npm. Run it behind HTTPS and never commit its SQLite
database, signing key, HMAC pepper, admin token or generated authorization files.
