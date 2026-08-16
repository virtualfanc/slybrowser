# SlyBrowser pricing alignment handoff

Date: 2026-08-16
Competitor: https://cloakbrowser.dev/

## Decision

The user approved four public monthly promotional tiers with the same concurrency
anchors as CloakBrowser and prices that do not exceed CloakBrowser's current public
promotion. SlyBrowser uses its own package names.

| SlyBrowser package | Monthly promo | Concurrency | Unit price |
| --- | ---: | ---: | ---: |
| Launch | $19 | 5 | $3.80 |
| Studio | $49 | 20 | $2.45 |
| Fleet | $199 | 200 | approximately $1.00 |
| Grid | $499 | 2,000 | approximately $0.25 |

## Competitor evidence

- Measured from CloakBrowser's public pricing page on 2026-08-16: Solo $19/5,
  Team $49/20, Business $199/200, and Scale $499/2,000.
- The comparison is promotional monthly pricing. No annual SlyBrowser price was
  inferred or published.

## Implementation

- The website pricing grid contains exactly four paid plans.
- The one-process free entitlement remains a fallback/evaluation entitlement rather
  than a fifth pricing card.
- PayNow public environment variables now map one recurring monthly product to each
  of Launch, Studio, Fleet, and Grid.

## Open operational gate

Publishing a capacity allowance is not proof the current licensing service and
release operations can enforce or support it. Fleet and Grid require concurrency,
soak, support-cost, and abuse-control evidence before self-serve activation.
