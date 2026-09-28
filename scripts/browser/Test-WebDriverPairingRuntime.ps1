[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [Parameter(Mandatory)][string]$StockBrowserExecutable,
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutputFile) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputFile = Join-Path $repoRoot "artifacts\test-results\compatibility\webdriver-pairing-$stamp.json"
}

& node (Join-Path $repoRoot 'tests\integration\webdriver-pairing-runtime.mjs') `
    --browser (Resolve-Path -LiteralPath $BrowserExecutable).Path `
    --driver (Resolve-Path -LiteralPath $DriverExecutable).Path `
    --stock-browser (Resolve-Path -LiteralPath $StockBrowserExecutable).Path `
    --output $OutputFile
if ($LASTEXITCODE -ne 0) {
    throw "WebDriver pairing runtime test failed. See $OutputFile"
}
