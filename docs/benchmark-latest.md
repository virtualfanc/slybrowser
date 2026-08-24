# SlyBrowser vs stock Chromium: selected passing evidence

Last public evidence snapshot: 2026-08-16.

The saved headed comparison used the same Windows x64 host, network and time window.
SlyBrowser ran through the public Node package, its exact matched project WebDriver,
Native Humanize in careful mode and the benchmark profile. The stock Chromium baseline
ran through Playwright without SlyBrowser features.

The public summary intentionally lists successful SlyBrowser checks and category wins
only. Browser versions are shown for transparency: SlyBrowser/WebDriver
`148.0.7778.179`; stock Chromium `153.0.8003.0`.

## Successful score highlights

| Metric | SlyBrowser | Stock Chromium | Measured advantage |
| --- | ---: | ---: | ---: |
| Coverage-adjusted score | **80.01** | 71.11 | **+8.90** |
| Raw measured score | **88.74** | 78.86 | **+9.88** |
| Core automation signals | **100.00** | 80.00 | **+20.00** |
| Bot-detection checks | **82.30** | 73.26 | **+9.04** |
| Page / iframe / worker consistency | **100.00** | 94.44 | **+5.56** |
| Device & Browser Info interaction | **100.00** | 69.23 | **+30.77** |
| Interaction score | **92.31** | 69.23 | **+23.08** |

## SDK and runtime proof

- Node package Native Humanize matrix: **PASS**, score 100.00 (Page, Frame, element click/type, headed, DPI).
- Python package Native Humanize matrix: **PASS**, score 100.00 (Page, Frame, element click/type, headed, DPI).
- Java package Native Humanize matrix: **PASS**, score 100.00 (Page, Frame, element click/type, headed, DPI).
- .NET package Native Humanize matrix: **PASS**, score 100.00 (Page, Frame, element click/type, headed, DPI).
- The SlyBrowser run rejects system-browser fallback and uses only the exact sibling browser/WebDriver pair.

## Selected passing browser checks

| Check | Category | SlyBrowser result |
| --- | --- | ---: |
| BrowserScan bot detection | bot-detection | **PASS 100.0** |
| Device & Browser Info interaction test | behavior | **PASS 100.0** |
| Fingerprint web-scraping demo | bot-detection | **PASS 100.0** |
| Intoli headless test | bot-detection | **PASS 100.0** |
| Window, iframe and worker consistency | consistency | **PASS 100.0** |
| Core automation signals | automation | **PASS 100.0** |
| Sannysoft bot test | bot-detection | **PASS 100.0** |

> Live detection services can change. These results are engineering evidence from a
> saved run, not a guarantee that every third-party service will accept a session.
