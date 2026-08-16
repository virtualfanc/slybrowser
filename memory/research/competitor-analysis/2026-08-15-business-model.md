# Competitor brief: SlyBrowser business model

Date: 2026-08-15
Primary report: `docs/business-model-research-2026-08-15.md`

## Request and decision

Research a defensible business model for SlyBrowser using CloakBrowser and adjacent
browser products as references.

Decision: keep the MIT SDK as the adoption layer and sell access to the proprietary
local browser binary by maximum concurrent browser sessions. Do not meter local
profiles or local browser hours. Treat hosted cloud, OEM/SaaS rights, and offline/LTS
deployment as separate future or enterprise offers.

## Competitor facts

| Competitor | Observed commercial model | Reusable implication |
| --- | --- | --- |
| CloakBrowser | Local binary subscription by concurrency; free single session; separate OEM/SaaS and requested cloud/enterprise offers | Closest reference for the core SlyBrowser model |
| Multilogin | Subscription by browser/mobile profile count with bundled proxy and mobile usage | Profile pricing belongs to a managed identity workspace, not a local developer runtime |
| GoLogin | Profile tiers with team, proxy, API, and limited cloud-concurrency entitlements | Collaboration and managed services create add-on revenue around profile products |
| Browserbase | Hosted browser hours with plan concurrency and usage overages | Use capacity plus usage only if SlyBrowser operates the compute |
| Browserless | Thirty-second units, concurrency, overages, proxies, and enterprise self-hosting | Offline/private deployment and support are enterprise value, while cloud usage should be metered |

All facts above were observed on official vendor pages on 2026-08-15. Public pricing is
volatile; consult the linked sources in the primary report before quoting it externally.

## Positioning opportunities

- Lead with a developer-first, native Chromium runtime rather than a GUI multi-account
  workspace.
- Make unlimited customer-owned profiles a packaging advantage.
- Keep bring-your-own-proxy at launch to avoid variable cost and abuse complexity.
- Differentiate with reproducible evidence, explicit limitations, signed releases, and
  privacy-minimized entitlement checks—not with undetectability guarantees.
- Use a free one-session entitlement to convert SDK adoption into qualified product
  evaluation.

Keyword coverage, backlink strength, and traffic share are outside this commercial
packaging brief and were not measured. No inference about search visibility or market
share should be made from the competitor set.

## Handoff

### Immediate

- Validate 5/20/200-session capacity anchors and $19–29/$49–79/$199–299 monthly price
  ranges with 10–15 qualified design partners.
- Finalize binary, privacy, acceptable-use, refund, support, and OEM/SaaS terms.
- Define concurrency, grace, burst, cancellation, and upgrade semantics.

### Short term

- Deploy production lease exchange, signing, revocation, rotation, and concurrency
  authority.
- Launch Developer, Starter, and Team as an application-gated paid preview.
- Measure activation, conversion, utilization, support cost, retention, and margin.

### Long term

- Add Enterprise offline/LTS/SSO capabilities.
- Negotiate OEM/SaaS agreements after support and update costs are known.
- Price a managed cloud offer from measured compute economics, separately from local
  binary subscriptions.

