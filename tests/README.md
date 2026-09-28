# Test suites

The root test directory holds fixtures and cross-language contract tests. SDK-specific
unit tests live beside each package. Browser integration and page-detection reports are
written to `artifacts/test-results`, which is ignored by Git.

Contract fixtures never contain real credentials. Values that look like proxy or
license secrets are inert examples used only to verify redaction and schema behavior.

The full Windows entry point is:

```powershell
./scripts/Test-Repository.ps1
```

Chromium C++ and test-page suites have separate entry points because they require a
private checkout and built browser.
