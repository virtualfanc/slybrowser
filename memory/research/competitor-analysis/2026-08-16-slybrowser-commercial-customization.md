# SlyBrowser commercial customization handoff

Date: 2026-08-16
Primary report: `docs/business-model-customization-2026-08-16.md`
Source task: `01a000a2-5523-7e30-9787-9e45fb768f49`

## Decision

Position SlyBrowser as a native Chromium automation runtime with a matched project-built
W3C WebDriver. Keep the MIT SDK/evidence layer and proprietary browser boundary. Give
every local tier the same core browser quality and charge by maximum concurrent browser
processes, operational controls and support.

## Feature-matched package hypothesis

| Package | Capacity | Price hypothesis | Release stage |
| --- | ---: | ---: | --- |
| Developer | 1 | $0 | After signed public artifact/license backend |
| Builder | 5 | $29/month | Gate 1 paid preview |
| Team | 20 | $79/month | Gate 1 after organization/release-channel controls |
| Business | 100 | $249/month | Gate 2, sales-assisted first |
| Enterprise | 200+ | From $15k/year | Gate 3 after offline/LTS/SSO/SLA exist |
| OEM/SaaS | Contracted | Custom | Separate approved agreement |

Annual self-serve hypothesis is ten months of monthly price. Do not publish prices until
legal, licensing, delivery and support gates pass.

## Durable product facts

- Python and Node default to the project-built W3C WebDriver; Playwright/Puppeteer are
  explicit compatibility adapters.
- Python 17, Node 19 and detection harness 18 tests passed on 2026-08-16; .NET remains
  uncompiled locally.
- The profile contract maps 29 inherited groups, with 13 stable groups verified end to
  end and two parser-only fields that must not be sold as active controls.
- Humanize and the matched WebDriver are core differentiation and should remain in the
  free tier.
- Signed manifest/artifact and short-lived lease verification exist, but automatic
  delivery, production entitlement services and enforcement are incomplete.
- Public paid release is blocked by legal approval, license service, release signing,
  update/rollback, Chromium clearance, supported tests and support operations.

## Immediate

- Validate $0/$29/$79/$249 and 1/5/20/100 with 10–15 qualified design partners.
- Keep the website on Private Preview and do not offer self-serve checkout.
- Complete the Gate 1 blockers in the primary report.

## Short term

- Launch Developer, Builder and Team only after Gate 1.
- Promise Windows, Python and Node first; qualify other platforms and .NET separately.
- Keep Business sales-assisted while capacity and support cost are measured.

## Long term

- Add Enterprise offline/LTS/SSO/SLA after demand is evidenced.
- Keep OEM/SaaS rights separate from internal-use subscriptions.
- Price any future cloud product from measured browser-hour economics.

