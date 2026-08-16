# Business model research — 2026-08-15

Status: pricing and packaging hypothesis for private-preview validation. This document
does not approve public pricing, change the binary license, or authorize a commercial
release.

Feature-matched follow-up: see
[SlyBrowser business model customization — 2026-08-16](business-model-customization-2026-08-16.md).
The follow-up narrows the initial scale tier and ties every package to current product
readiness; use it as the current recommendation.

## Executive decision

SlyBrowser should use an **open SDK + paid browser binary** model, with the local
product licensed primarily by **maximum concurrent browser sessions**. Profiles should
be unlimited within a plan, and local browser hours should not be metered.

The recommended commercial ladder is:

1. a free, one-concurrent-session Developer entitlement for evaluation;
2. self-serve concurrent-session subscriptions for individual and team production use;
3. an annual Enterprise agreement for offline use, long-term support, organization
   controls, deployment assistance, and higher capacity;
4. separate OEM/SaaS terms whenever a customer embeds the binary in a product or uses
   it to serve third parties; and
5. a future managed-cloud SKU priced by reserved concurrency plus consumed browser
   hours, only after SlyBrowser actually pays the browser infrastructure cost.

This aligns the price with the customer's peak productive capacity and with the signed
`sessionId` lease already designed in the repository. It also preserves a simple
developer experience: create as many local profiles as the workflow requires, but pay
for how many browsers can be active at once.

## Evidence labels and scope

- **Measured**: observed directly in this repository or on an official vendor page on
  2026-08-15.
- **Estimated**: a SlyBrowser recommendation, planning assumption, or unvalidated price
  hypothesis.
- **User-provided**: supplied in the project brief or owner direction. No quantitative
  user-provided commercial data was available for this report.

The competitor sample covers two different markets: local anti-detect/profile products
and hosted browser infrastructure. It is a commercial-model comparison, not a claim of
feature, detection, or benchmark parity.

## Product facts that constrain the model

| Fact | Evidence | Commercial consequence |
| --- | --- | --- |
| SDKs, schemas, scripts, tests, and repository documentation are MIT-licensed | Measured: `README.md`, `LICENSE-SCOPE.md` | Keep the integration layer free and easy to adopt. Do not attempt to monetize SDK seats. |
| The distributed browser binary is a separate proprietary deliverable | Measured: `README.md`, `LICENSE-SCOPE.md` | Subscription access and updates can be attached to the binary entitlement. |
| The lease schema supports features, browser-version bounds, device binding, and a concurrent `sessionId` | Measured: `docs/licensing.md` | Concurrency is technically compatible with the planned enforcement boundary. |
| Browser execution happens on customer infrastructure | Measured: architecture and current implementation | SlyBrowser does not incur browser-hour compute cost, so local usage metering would feel extractive and create telemetry pressure. |
| A production license service, signer, revocation authority, and concurrent-session authority are not deployed | Measured: `docs/benchmark-results-2026-08-15.md` | Paid production plans cannot launch until these controls and their tests exist. |
| Binary terms remain a non-effective draft | Measured: `LICENSE-SCOPE.md` | Legal entity, commercial grant, privacy, governing law, support, and refund terms must be approved before checkout. |

## Official competitor benchmark

Prices below are public USD prices observed on official vendor pages. Promotions,
annual discounts, taxes, selected profile counts, and checkout prices can change.

| Vendor | Primary value metric | Public examples observed | Free/trial motion | Enterprise or adjacent revenue | What it means for SlyBrowser |
| --- | --- | --- | --- | --- | --- |
| [CloakBrowser](https://cloakbrowser.dev/) | Concurrent local browser sessions | Promo prices: $19/month for 5 sessions, $49 for 20, $199 for 200, and $499 for 2,000; regular prices are displayed as $29, $79, $249, and $699 | One session free; cancellation falls back to the free version | Separate OEM/SaaS license for embedding or serving third parties; managed cloud and custom enterprise on request | Measured: this is the closest model—SDK/wrapper distribution, local binary, updates, support, and concurrency entitlement. |
| [Multilogin](https://multilogin.com/pricing/) | Stored local/cloud browser and mobile profiles | Official help lists regular monthly prices of $11 for 10 profiles, $29 for 50, $40 for 100, and $89 for 300; proxy traffic and mobile minutes are bundled | Free plan with up to 5 profiles; 14-day money-back policy is documented | Profile scale, team controls, proxy GB, and cloud-mobile minutes create expansion revenue | Measured: profile count fits a GUI-led multi-account workspace, but not a developer-first runtime with customer-owned profile directories. |
| [GoLogin](https://gologin.com/pricing/) | Unique browser profiles, with cloud-launch and API limits | Page displays annual prices from $24/month for Professional, $49 Business, $99 Enterprise, and $149 Custom alongside higher monthly prices; plan comparison shows 100, 300, 1,000, and 2,000 profiles | Free plan with 3 profiles; paid page advertises 7-day returns | Team/profile sharing, resident proxy allowances, cloud launches, and API rate limits | Measured: its packaging monetizes a managed identity workspace; concurrency is secondary and mainly attached to cloud execution. |
| [Browserbase](https://www.browserbase.com/pricing) | Hosted browser hours plus plan-level concurrency | $20/month Developer includes 25 concurrency and 100 browser hours, then $0.12/hour; $99 Startup includes 100 concurrency and 500 hours, then $0.10/hour | Free includes 3 concurrency and 1 browser hour | Proxy GB, agent/search/fetch usage, retention, enterprise compliance, and 250+ concurrency | Measured: usage pricing is credible because the vendor operates the browser infrastructure. It should inform a future SlyBrowser Cloud SKU, not the local binary. |
| [Browserless](https://www.browserless.io/pricing) | Thirty-second usage units plus concurrency | Annual-billing display: free 2 concurrency/1,000 units; $25/month 10 concurrency/20,000 units; $140 40/180,000; $350 100/500,000 | No-card free plan | Overage units, proxies, CAPTCHA solving, private deployment, licensed self-hosting, air-gapped licensing, and support | Measured: hybrid capacity + usage packaging is suitable for a hosted service, while self-hosted and air-gapped access belong in Enterprise. |

### Patterns across the sample

1. **The paid unit follows the cost and control surface.** Profile managers charge for
   stored identities; infrastructure vendors charge for browser time; the closest
   downloadable-binary peer charges for concurrency.
2. **A useful free tier is standard.** It reduces integration risk and lets developers
   produce a successful run before procurement.
3. **Enterprise is more than a larger numerical limit.** Private deployment, offline or
   air-gapped licensing, compliance, support, and redistribution rights are separately
   valuable.
4. **Proxy resale is an add-on business, not a prerequisite.** It introduces variable
   cost, abuse handling, location quality, and support obligations. SlyBrowser should
   remain bring-your-own-proxy during the initial release.
5. **Large annual discounts are common but not mandatory.** The observed range reaches
   30–50% in some products. SlyBrowser should first validate retention and support cost
   and use a more conservative two-month-free annual offer.

## Pricing metric decision

Scores are Estimated on a 1–5 scale, where 5 is strongest. Customer fit considers a
developer-first local runtime, not a GUI profile manager.

| Model | Customer-value fit | Cost alignment | Enforceability | Simplicity | Expansion path | Total / 25 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Maximum concurrent sessions | 5 | 5 | 4 | 5 | 5 | **24** |
| Number of stored profiles | 2 | 3 | 2 | 4 | 3 | 14 |
| Local browser hours | 2 | 1 | 3 | 2 | 4 | 12 |
| Team seats only | 2 | 5 | 5 | 4 | 2 | 18 |
| Perpetual binary version | 3 | 3 | 3 | 4 | 1 | 14 |

Concurrency wins because it is legible to automation teams, maps to peak throughput,
does not penalize persistent profiles, and already exists conceptually in the lease
design. Seats can be an administrative entitlement at higher tiers, but should not be
the primary usage metric.

Do not promise “unlimited use” without defining the maximum active-session rule and
reasonable technical limits. Do not count tabs or browser contexts as separate paid
sessions unless they start separate licensed browser processes.

## Recommended packaging hypothesis

The names, capacities, and prices are Estimated and should be tested before publishing.
All tiers should receive security updates and the same core browser behavior; packaging
should not intentionally weaken browser quality in lower tiers.

| Tier | Monthly price hypothesis | Included entitlement | Intended buyer | Deliberate exclusions |
| --- | --- | --- | --- | --- |
| Developer | $0 | 1 active session, unlimited local profiles, current stable channel, community support | Evaluation, local development, CI proof of concept | No production SLA, offline lease, redistribution, or priority support |
| Starter | $19–29 | 5 active sessions, commercial internal use, standard updates | Solo developer and small automation workloads | No redistribution or third-party hosted service |
| Team | $49–79 | 20 active sessions, organization key management, up to 5 admin seats, priority support | Product and data teams | No offline entitlement or custom browser build |
| Business | $199–299 | 200 active sessions, audit/admin controls, faster support, release-channel policy | High-throughput internal automation | No OEM/SaaS rights by default |
| Enterprise | From $12k annual contract | Custom capacity, SSO, bounded offline/air-gapped entitlement, LTS policy, deployment assistance, SLA, security/legal review | Regulated or large organizations | Redistribution and hosted third-party use remain separately negotiated |
| OEM/SaaS | Custom, with annual minimum commitment | Explicit right to embed or operate for third parties, capacity schedule, update and support terms | Software vendors and browser-as-a-service operators | Never implied by a normal subscription |

Recommended billing rules:

- offer monthly self-serve billing and annual billing at approximately two months free
  (16–17% discount);
- allow immediate upgrades with proration and schedule downgrades for renewal;
- enforce a short grace window for transient license-service failure, but never turn an
  expired or revoked entitlement into an unlimited license;
- show current concurrency and rejected-launch reason without collecting URLs, page
  content, cookies, proxy credentials, or profile configuration;
- use an application-gated private preview until production licensing and legal gates
  pass; and
- give early design partners a temporary founding discount in exchange for structured
  feedback, without representing it as permanent public pricing.

## Why profiles should remain unlimited

A SlyBrowser profile is a customer-controlled directory and configuration contract,
not a hosted record whose storage or collaboration cost is borne by SlyBrowser. A
profile limit would:

- import the mental model of GUI multi-account tools into a developer runtime;
- charge for inactive data rather than delivered throughput;
- encourage profile deletion or unsafe reuse merely to fit a plan; and
- require extra tracking while adding little protection against binary sharing.

Profiles can still be subject to filesystem, browser, and support boundaries. “Unlimited
profiles” means no license counter, not infinite vendor support or storage.

## Unit economics and price validation

No customer acquisition cost, conversion, support-cost, churn, or infrastructure data
exists yet. The following is an Estimated planning model, not a forecast.

For the local product:

```text
monthly contribution = subscription revenue
                     - payment fees
                     - license/control-plane usage
                     - binary distribution
                     - attributable support
```

Customer browser CPU, memory, storage, and proxy traffic are not SlyBrowser costs. This
should support a mature software gross-margin target above 85%, excluding browser R&D
and release engineering, but the target must be replaced with measured data after the
preview.

The proposed ranges imply decreasing list price per maximum concurrent session as
customers scale:

- Starter: approximately $3.80–5.80 per session/month;
- Team: approximately $2.45–3.95 per session/month;
- Business: approximately $1.00–1.50 per session/month.

Do not decide between the low and high ends by competitor matching alone. Test three
price cards with at least 10–15 qualified design partners and collect:

1. current tool and infrastructure spend;
2. peak and typical concurrency;
3. cost of a failed or delayed workflow;
4. must-have release cadence, support, and deployment requirements;
5. willingness to pay for 5, 20, and 200 sessions; and
6. whether the buyer needs internal use, offline deployment, or third-party service
   rights.

Require a paid pilot or refundable deposit from a subset of partners. Statements of
interest without a payment decision are weak price evidence.

## Future managed-cloud model

SlyBrowser Cloud should be a separate SKU, not a hidden feature of the local plan. When
the service operates compute, the defensible metric becomes:

```text
monthly cloud bill = platform commitment
                   + consumed browser hours
                   + reserved peak concurrency
                   + optional managed egress/proxy usage
```

Browserbase's current $0.10–0.12 browser-hour overage provides a public commodity
infrastructure reference, but SlyBrowser must measure its own VM/container density,
warm-pool waste, storage, egress, support, and regional cost before choosing a rate.
Managed proxy traffic, CAPTCHA solving, and task execution should not be bundled at
launch; each changes the compliance, abuse, margin, and product-support surface.

## Commercial funnel and success metrics

The acquisition loop should be:

```text
MIT SDK/docs -> first successful local run -> free Developer entitlement
             -> paid production concurrency -> team expansion
             -> Enterprise or OEM/SaaS agreement
```

Measure the funnel with privacy-minimized product/account events:

| Metric | Initial decision use |
| --- | --- |
| Time to first successful local run | Whether SDK/docs reduce adoption friction |
| Developer activation rate | Whether the free entitlement produces real evaluation |
| Preview-to-paid conversion | Whether the production boundary is valuable |
| Peak-to-entitled concurrency ratio | Whether tier sizes match actual workloads |
| 30/90-day logo retention and expansion | Whether browser updates create durable subscription value |
| Support hours and incidents per account | Whether price covers the support promise |
| Binary download and update success | Whether continued access is operationally reliable |
| Gross margin by tier | Whether support or infrastructure makes a tier uneconomic |

Do not collect browsing history to calculate these metrics.

## Commercial and product guardrails

- Position SlyBrowser as a reliable, configurable Chromium runtime for authorized
  automation. Do not guarantee undetectability, CAPTCHA passage, or acceptance by a
  third-party service.
- Maintain explicit prohibited-use and suspension terms for credential abuse, fraud,
  unauthorized access, account creation abuse, and restricted targets.
- Keep browser telemetry limited to entitlement, version, platform, install/session
  identifiers, and operational errors required for service delivery; document retention.
- Keep BYO proxy as the default. Proxy resale requires a separate margin, quality,
  geolocation, refund, and abuse review.
- Make normal subscriptions internal-use only. Embedding, repackaging, redistribution,
  and third-party hosted service rights require an OEM/SaaS agreement.
- Do not accept payment for a binary until release signing, license clearance, support
  scope, privacy terms, refund policy, and incident response are operational.

## Execution plan

### Immediate — before public pricing

1. Interview 10–15 qualified automation teams and record actual peak concurrency,
   current spend, deployment model, and purchase authority.
2. Run paid private-preview offers at the low and high ends of the Starter and Team
   ranges; do not expose the ranges as a permanent promise.
3. Finalize the legal entity, binary grant, privacy/telemetry disclosure, acceptable
   use, refunds, support boundaries, governing law, and OEM/SaaS boundary.
4. Define exact entitlement semantics: browser process, lease TTL, burst policy,
   duplicate session, upgrade, downgrade, cancellation, and transient outage behavior.

### Short term — required for paid preview

1. Deploy the license exchange, protected signer, public-key rotation, revocation, and
   concurrent-session authority.
2. Implement checkout/account lifecycle, invoices, proration, cancellation, and a
   privacy-minimized entitlement dashboard.
3. Complete release signing, update/rollback, license-scan clearance, affected browser
   tests, and support runbooks.
4. Launch Developer, Starter, and Team only; keep Business sales-assisted until support
   and concurrency evidence exists.

### Long term — after retention is proven

1. Add Enterprise offline/LTS/SSO capabilities without weakening revocation and expiry
   disclosure.
2. Negotiate OEM/SaaS contracts only after binary delivery, update, and support costs
   are measured.
3. Prototype SlyBrowser Cloud and price it from measured browser-hour economics rather
   than from the local-binary tiers.
4. Revisit tier sizes quarterly using utilization, conversion, churn, support cost, and
   gross-margin data.

## Open decisions

- Is the free Developer entitlement evaluation-only, or can one-session commercial
  production use remain free?
- Which operating systems and browser channels are support commitments rather than
  best-effort preview targets?
- Is a short burst above purchased concurrency useful, or should every excess launch
  fail closed?
- What support response times can be staffed at Team, Business, and Enterprise levels?
- Which jurisdictions, buyer types, and payment provider will be supported at launch?
- Does the product need any offline mode below Enterprise?

Until these questions and the release gates are resolved, the website should continue
to say **Private Preview** and use an access-request CTA rather than publish a checkout
price.

## Sources

- [CloakBrowser product, pricing, cloud, and OEM FAQ](https://cloakbrowser.dev/)
- [CloakBrowser legal policies](https://cloakbrowser.dev/legal/)
- [Multilogin pricing](https://multilogin.com/pricing/)
- [Multilogin current plan comparison](https://multilogin.com/help/en_US/help/subscription-plan-comparison)
- [GoLogin pricing](https://gologin.com/pricing/)
- [Browserbase pricing](https://www.browserbase.com/pricing)
- [Browserless pricing and self-hosting](https://www.browserless.io/pricing)
