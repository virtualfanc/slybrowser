[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SlyBrowserExecutable,
    [Parameter(Mandatory)][string]$StockChromiumExecutable,
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$slyPath = (Resolve-Path -LiteralPath $SlyBrowserExecutable).Path
$stockPath = (Resolve-Path -LiteralPath $StockChromiumExecutable).Path
if (-not $OutputFile) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputFile = Join-Path $repoRoot "artifacts\test-results\compatibility\browser-api-$timestamp.json"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputFile)
& node (Join-Path $repoRoot 'tests\integration\browser-api-compatibility.mjs') `
    --sly-browser $slyPath --stock-browser $stockPath --output $outputPath
if ($LASTEXITCODE -ne 0) {
    throw "Browser API compatibility test failed. See $outputPath"
}
Write-Output $outputPath
