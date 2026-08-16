[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
if (-not $OutputFile) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $OutputFile = Join-Path $repoRoot "artifacts\test-results\compatibility\w3c-cdp-persistent-$stamp.json"
}

& pnpm --filter slybrowser build
if ($LASTEXITCODE -ne 0) {
    throw 'Node SDK build failed before W3C/CDP/persistent runtime test.'
}
& node (Join-Path $repoRoot 'tests\integration\w3c-cdp-persistent-runtime.mjs') `
    --browser $browserPath --driver $driverPath --output $OutputFile
if ($LASTEXITCODE -ne 0) {
    throw "W3C/CDP/persistent runtime test failed. See $OutputFile"
}
