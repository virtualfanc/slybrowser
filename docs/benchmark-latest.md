# SlyBrowser vs stock Chromium: verified comparison

Last verified: 2026-08-16.

Both browsers were tested on the same Windows x64 host, network and time window against
the same 40-entry definition. SlyBrowser ran headed through the public Node package,
its exact matched project WebDriver, Native Humanize in `careful` mode and the benchmark
profile. The stock baseline ran headed through Playwright without SlyBrowser features.

## Headline results

| Metric | SlyBrowser | Stock Chromium | Difference |
| --- | ---: | ---: | ---: |
| Coverage-adjusted score | **80.01** | 71.11 | **SlyBrowser +8.90** |
| Raw measured score | **88.74** | 78.86 | **SlyBrowser +9.88** |
| Required coverage | 90.16% | 90.16% | Tie |

| Category | SlyBrowser | Stock Chromium | Difference | Coverage (Sly / stock) |
| --- | ---: | ---: | ---: | ---: |
| Automation | **100.00** | 80.00 | **SlyBrowser +20.00** | 100% / 100% |
| Bot detection | **82.30** | 73.26 | **SlyBrowser +9.04** | 100% / 100% |
| Consistency | **100.00** | 94.44 | **SlyBrowser +5.56** | 100% / 100% |
| Challenge | 0.00 | 0.00 | Tie | 0% / 0% |

## SDK and runtime proof

- Node package Native Humanize matrix: **PASS** (Page, Frame, element click/type,
  headed and DPI).
- Python package Native Humanize matrix: **PASS** (Page, Frame, element click/type,
  headed and DPI).
- The SlyBrowser run rejects system-browser fallback and uses only the exact sibling
  browser/WebDriver pair.

## All test outcomes

| Test | Category | SlyBrowser | Stock Chromium |
| --- | --- | ---: | ---: |
| Core automation signals | automation | **PASS 100.0** | FAIL 80.0 |
| Window, iframe and worker consistency | consistency | **PASS 100.0** | FAIL 91.7 |
| Canvas and WebGL stability | consistency | PASS 100.0 | PASS 100.0 |
| Sannysoft bot test | bot-detection | **PASS 100.0** | FAIL 98.3 |
| Incolumitas bot test | bot-detection | **FAIL 97.2** | FAIL 88.9 |
| BrowserScan bot detection | bot-detection | PASS 100.0 | PASS 100.0 |
| Device & Browser Info bot test | bot-detection | **PASS 100.0** | FAIL 73.9 |
| Device & Browser Info interaction test | behavior | **FAIL 92.3** | FAIL 69.2 |
| Fingerprint web-scraping demo | bot-detection | FAIL 0.0 | FAIL 0.0 |
| FingerprintJS OSS demo | fingerprint | EVIDENCE | EVIDENCE |
| reCAPTCHA v3 public score demo | challenge | EVIDENCE | EVIDENCE |
| Turnstile visible functional test | challenge | EVIDENCE | EVIDENCE |
| Turnstile invisible functional test | challenge | EVIDENCE | EVIDENCE |
| Turnstile non-interactive authorized test | challenge | SKIP | SKIP |
| Turnstile managed authorized test | challenge | SKIP | SKIP |
| ShieldSquare authorized production test | challenge | SKIP | SKIP |
| Pixelscan | fingerprint | EVIDENCE | EVIDENCE |
| CreepJS official deployment | fingerprint | EVIDENCE | EVIDENCE |
| AmIUnique fingerprint | fingerprint | EVIDENCE | EVIDENCE |
| DeviceInfo | fingerprint | EVIDENCE | EVIDENCE |
| BrowserLeaks JavaScript | fingerprint | ERROR | ERROR |
| BrowserLeaks Canvas | fingerprint | ERROR | ERROR |
| BrowserLeaks WebGL | fingerprint | ERROR | ERROR |
| BrowserLeaks Audio | fingerprint | ERROR | ERROR |
| BrowserLeaks Fonts | fingerprint | ERROR | ERROR |
| BrowserLeaks WebRTC | network | ERROR | ERROR |
| BrowserLeaks Client Hints | headers | ERROR | ERROR |
| BrowserLeaks TLS | tls | ERROR | ERROR |
| BrowserLeaks Proxy | network | ERROR | ERROR |
| BrowserLeaks Features | fingerprint | ERROR | ERROR |
| BrowserLeaks WebGPU | fingerprint | ERROR | ERROR |
| Peet TLS and HTTP/2 fingerprint | tls | ERROR | ERROR |
| HTTPBin request headers | headers | EVIDENCE | EVIDENCE |
| IPHey consistency | network | EVIDENCE | EVIDENCE |
| Whoer anonymity test | network | EVIDENCE | EVIDENCE |
| EFF Cover Your Tracks | fingerprint | EVIDENCE | EVIDENCE |
| BrowserAudit | standards | EVIDENCE | EVIDENCE |
| Are You Headless | bot-detection | EVIDENCE | EVIDENCE |
| Intoli headless test | bot-detection | **PASS 100.0** | FAIL 83.3 |
| Rebrowser bot detector | bot-detection | EVIDENCE | EVIDENCE |

## Evidence rules and limitations

- `PASS` and `FAIL` are the only states included in numeric scoring.
- `ERROR` reduces required coverage; it is never converted into an invented zero.
- `EVIDENCE` means the page was captured but did not expose a defensible automated
  verdict.
- Owner-authorized protected-service endpoints remain `SKIP` until their URLs are
  explicitly configured.
- Live services can change after the verification date. Results describe this saved
  run, not guaranteed future acceptance by a third party.

Reproduce the complete run with:

```powershell
pnpm benchmark:strongest
```
