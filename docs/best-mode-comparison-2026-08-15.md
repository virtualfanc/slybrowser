# SlyBrowser vs CloakBrowser best-mode comparison (2026-08-15)

This report compares the best locally available launch mode for each product. It is
not a same-protocol or same-Chromium-major benchmark, so the protocol and version
differences are recorded alongside the scores.

## Configurations

| Setting | SlyBrowser | CloakBrowser |
| --- | --- | --- |
| Browser | Private preview build | Locally cached Free build |
| Automation | Project-built ChromeDriver, W3C WebDriver | Official wrapper 0.5.7 over Playwright Core 1.62 |
| Mode | Headed | Headed |
| Behavioral layer | Deterministic W3C actions | `humanize=true`, `careful` preset |
| Fingerprint | Current native project defaults | Seed 42424, Windows persona, default binary noise |
| Locale/timezone | Native host values | `zh-CN`, `Asia/Shanghai` through binary flags |
| GeoIP | Not configured | Enabled; explicit direct-connection locale/timezone avoided an unnecessary database lookup |
| Automation switches | Excluded `enable-automation`, `enable-unsafe-swiftshader` | Official wrapper defaults exclude the same Playwright switches |

No CloakBrowser license key was present. The newest Pro build was therefore not
available; this run uses every feature available in the cached Free
binary plus the open wrapper's Humanize layer. A valid Pro result is still required
before describing this as CloakBrowser's current commercial maximum.

## Full 40-entry result

Evidence root:
`artifacts/test-results/detection/best-sly-vs-cloak-20260815-142611/`

| Metric | SlyBrowser | CloakBrowser Free + Humanize |
| --- | ---: | ---: |
| Adjusted score | 87.36 | 87.86 |
| Required graded coverage | 100% | 100% |
| Pass / fail | 7 / 3 | 7 / 3 |
| Evidence-only | 16 | 16 |
| Runner/network errors | 11 | 11 |
| Environment-authorized skips | 3 | 3 |

The three configured production checks (managed Turnstile, non-interactive
Turnstile, and ShieldSquare) were skipped because no authorized URLs were configured.
All eleven BrowserLeaks entries failed with `ERR_CONNECTION_CLOSED` for both browsers,
so they are network/site availability failures and do not receive invented zero scores.

| Graded test | SlyBrowser | CloakBrowser Free + Humanize |
| --- | ---: | ---: |
| Local core signals | 100 | 100 |
| Window/iframe/worker consistency | 100 | 100 |
| Render stability | 100 | 100 |
| SannySoft | 100 | 100 |
| Incolumitas | 97.22 | 97.22 |
| BrowserScan | 100 | 100 |
| Device & Browser Info | 86.96 | 91.30 |
| Fingerprint web-scraping demo | 0 | 0 |
| reCAPTCHA v3 test page | 90 | 90 |
| Intoli headless | 100 | 100 |

Both Incolumitas runs had one failed check, `WEBDRIVER`, and a behavioral score of
zero. Both Fingerprint demo runs rendered an explicit blocked result. TLS JA4 and
Akamai hashes matched across the two runs, while JA3 differed; the browser majors also
differ, so TLS should not be presented as a like-for-like binary comparison.

## Complete Device & Browser Info fields

The old 14-field adapter was replaced with the current 22 detail fields plus the
aggregate `isBot` field. The previous 85.7 vs 92.9 result was not valid because it
omitted `hasInconsistentTimingResolution` and `isSeleniumChromeDefault`.

In the full best-mode run:

- SlyBrowser: `hasInconsistentTimingResolution=true`,
  `isAutomatedWithCDP=true`, `isBot=true`.
- CloakBrowser: `hasInconsistentTimingResolution=true`, `isBot=true`.
- All remaining current detail fields were false in these runs.

The SlyBrowser CDP result is consistent with the project ChromeDriver's main-frame
`Runtime.enable` path. The worker CDP field remained false.

## Submitted interaction test

Supplemental evidence root:
`artifacts/test-results/detection/best-sly-vs-cloak-20260815-144613/`

The harness now fills the public demonstration login form with inert values, submits
it through real keyboard or pointer input, and parses all 26 rendered fields.

| Result | SlyBrowser WebDriver | CloakBrowser Humanize careful |
| --- | ---: | ---: |
| Interaction score | 84.62 | 92.31 |
| `suspiciousClientSideBehavior` | true | false |
| `superHumanSpeed` | false | false |
| `hasCDPMouseLeak` | true | false |
| `isAutomatedWithCDP` | true | false |
| `hasInconsistentTimingResolution` | false | true |
| `isBot` | true | true |

CloakBrowser's Humanize layer therefore passed all three behavior-specific fields in
this run. Its remaining failure was the timing fingerprint. SlyBrowser's own
WebDriver also exposed a headed click-coordinate scaling mismatch on this host; the
final evidence used a W3C keyboard action to submit the form without JavaScript.

## Post-fix targeted regression

The two priority defects above were fixed and rebuilt in the private Chromium tree.
These are targeted regression results, not a replacement for the historical 40-entry
run above.

| Check | Sly before | Cloak best before | Sly after |
| --- | ---: | ---: | ---: |
| Device & Browser Info | 86.96 | 91.30 | **91.30** |
| Submitted interaction test | 84.62 | 92.31 | **100.00** |
| `isAutomatedWithCDP` | true | false | **false** |
| `hasCDPMouseLeak` | true | false | **false** |
| `suspiciousClientSideBehavior` | true | false | **false** |
| Interaction `isBot` | true | true | **false** |

CDP evidence:
`artifacts/test-results/detection/webdriver-20260815-153129/`

Humanize interaction evidence:
`artifacts/test-results/detection/webdriver-20260815-154017/`

Combined same-session regression evidence:
`artifacts/test-results/detection/webdriver-20260815-154239/`

The CDP correction keeps ChromeDriver's required `Runtime.enable` execution-context
tracking. Instead, V8 Inspector no longer invokes a page-defined
`Error.prepareStackTrace` while serializing an Error description or preview. A focused
Inspector protocol regression verifies that the hook remains untouched.

The WebDriver Humanize path uses DOM geometry only to choose a visible target. Actual
interaction is trusted W3C pointer and keyboard input, with curved non-center clicks,
per-character timing, native modifier handling, and a real submit-button click. Its
careful preset passed all 26 fields rendered by the public interaction test.

## Priority gaps

1. Diagnose the shared timing-resolution flag using manual/WebDriver and
   headed/headless matrix runs.
2. Add a dedicated device-scale-factor regression for stock element-center click;
   Humanize now avoids the faulty path by using validated viewport coordinates.
3. Repeat on the same Chromium major, rerun BrowserLeaks from a reachable network,
   and run CloakBrowser Pro 150 only after the owner configures a valid key locally.
