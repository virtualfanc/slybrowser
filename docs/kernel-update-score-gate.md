# Kernel update score gate

Use this gate after every private Chromium kernel refresh to compare the freshly built
SlyBrowser binary against a stock Chromium/Chrome baseline on the same Windows x64
host, network and time window.

The gate intentionally writes evidence under `artifacts/test-results/`. Public
comparison reports may include the browser/kernel versions captured in saved evidence,
but must still omit local source paths, raw secrets, private signing material and
operational bypass details. Publish only reviewed `public/comparison.json` and
`public/comparison.md`.

## One-command run

```powershell
pnpm benchmark:kernel-update
```

Equivalent direct command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts/browser/Test-KernelUpdateScoreGate.ps1 `
  -BrowserExecutable '<chromium-output>\SlyBrowser.exe' `
  -DriverExecutable '<chromium-output>\chromedriver.exe' `
  -StockChromiumExecutable "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Provide either `-LicenseFile`/`SLYBROWSER_TEST_LICENSE_FILE` or
`-TestLeasePrivateKeyFile`/`SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE` for local signed
lease generation.

## Outputs

The script creates a timestamped directory:

```text
artifacts/test-results/kernel-update-score/kernel-update-YYYYMMDD-HHMMSS/
```

Important files:

- `public/comparison.json` and `public/comparison.md` — redacted public comparison.
- `internal-comparison.json` and `internal-comparison.md` — local raw comparison.
- `kernel-update-score-gate.json` and `kernel-update-score-gate.md` — release gate
  decision, thresholds, binary hashes and SDK runtime evidence.

## Gate defaults

- Minimum SlyBrowser coverage-adjusted score: `80`.
- Minimum SlyBrowser delta versus stock Chromium: `0`.
- The SlyBrowser and stock Chromium evidence must report the same browser major.
- Both SlyBrowser and stock Chromium runs must be `qualified`.
- Node, Python, Java and .NET Native Humanize runtime checks must report `PASS`.

Use `-ReportOnly` to keep evidence even when the gate fails. Use `-AllowProvisional`
only for exploratory local diagnostics, not release qualification.

If the stock baseline is a different Chromium major, the public comparison still keeps
the saved per-run scores and versions as engineering evidence, but the gate suppresses
numeric deltas and fails until a same-major stock baseline is supplied.
