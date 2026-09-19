# PayNow.gg payments

SlyBrowser supports PayNow.gg and a self-hosted crypto payment flow. The current public website exposes only the self-hosted USDT checkout and the Free certificate claim; PayNow checkout entry points are disabled while the server integration remains available for compatibility. This public document describes customer-visible behavior only. Provider credentials, product IDs, webhook validation, database code, reconciliation, refunds, and deployment procedures live in the private website repository.

## Plans

| Plan | Monthly price | Concurrent browsers |
|---|---:|---:|
| Free | $0 | 1 |
| Basic | $19 | 5 |
| Pro | $49 | 20 |
| Max | $199 | 200 |
| Ultra | $499 | 2,000 |

`contracts/plans.json` is authoritative.

## Checkout behavior

- The website creates checkout sessions through the SlyBrowser service.
- The browser never receives provider secrets and never decides whether a payment succeeded.
- Entitlements are issued only after authenticated server-side confirmation.
- Duplicate, delayed, inconsistent, reversed, refunded, or unsupported events fail closed or remain pending for reconciliation.
- Crypto orders disclose the network, asset, destination, exact amount, confirmation state, and expiry before payment.

Live payment, renewal, cancellation, refund, chargeback, and chain-reorganization claims require dated evidence from authorized real transactions. Test fixtures prove only the modeled contract.

For account or delivery problems, use the official support channel described in [License and billing support](mailbox-license-feedback.md).
