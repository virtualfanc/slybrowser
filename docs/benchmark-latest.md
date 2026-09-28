# SlyBrowser and stock Chromium: selected results

Evidence snapshot: 2026-08-16. Both browsers ran headed on the same Windows x64 host, network, and time window. SlyBrowser used its matched WebDriver and native human-like input; the stock Chromium baseline used Playwright. The automation paths differed. These scores describe the recorded runs, not a universal comparison.

Only checks where SlyBrowser scored 100/100 are listed here.

| Check | SlyBrowser | Stock Chromium |
| --- | ---: | ---: |
| Core automation signals | **100/100** | 80/100 |
| Page, frame, and worker consistency | **100/100** | 94.44/100 |
| Device & Browser Info interaction | **100/100** | 69.23/100 |

## Human-like input

The native interaction matrix passed at **100/100** for each public SDK: Node.js, Python, Java, and .NET. The recorded checks covered page and frame interaction, clicking, typing, and headed display conditions. A separate submitted interaction regression also reached **100/100**.

## Other 100-point checks

| Check | Recorded score |
| --- | ---: |
| BrowserScan bot detection | **100/100** |
| Fingerprint web-scraping demo | **100/100** |
| Intoli headless test | **100/100** |
| Sannysoft bot test | **100/100** |

Live detection services can change. These are results from a saved run, not a promise that every site will accept every session.
