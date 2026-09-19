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
    $OutputFile = Join-Path $repoRoot "artifacts\test-results\cpp\persistent-profile-$timestamp.json"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputFile)
& node (Join-Path $repoRoot 'tests\integration\persistent-profile-consistency.mjs') --browser $browserPath --output $outputPath
if ($LASTEXITCODE -ne 0) {
    throw "Persistent-profile consistency test failed. See $outputPath"
}
Write-Output $outputPath
