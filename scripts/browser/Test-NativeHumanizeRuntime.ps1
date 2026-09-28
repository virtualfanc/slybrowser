[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts\test-results\humanize'
}
$outputPath = Join-Path $OutputDirectory ("native-humanize-runtime-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

& node (Join-Path $repoRoot 'tests\integration\native-humanize-runtime.mjs') `
    --browser $browserPath --driver $driverPath --output $outputPath
if ($LASTEXITCODE -ne 0) {
    throw 'Native Humanize runtime regression failed.'
}
