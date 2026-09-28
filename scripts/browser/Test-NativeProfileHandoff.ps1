[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
if (-not $OutputFile) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputFile = Join-Path $repoRoot "artifacts\test-results\cpp\native-profile-$timestamp.json"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputFile)
$runner = Join-Path $repoRoot 'tests\integration\native-profile-handoff.mjs'

& node $runner --browser $browserPath --output $outputPath
if ($LASTEXITCODE -ne 0) {
    throw "Native profile handoff test failed with exit code $LASTEXITCODE."
}
Write-Output $outputPath
