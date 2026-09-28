[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserConfig,
    [string]$SiteConfig,
    [string]$OutputDirectory,
    [string[]]$Only,
    [switch]$Headed,
    [switch]$FailOnDetection,
    [int]$NavigationTimeout = 45000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserConfigPath = (Resolve-Path -LiteralPath $BrowserConfig).Path
if (-not $SiteConfig) { $SiteConfig = Join-Path $repoRoot 'tests\detection\sites.json' }
$siteConfigPath = (Resolve-Path -LiteralPath $SiteConfig).Path
if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\detection\$timestamp"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$runner = Join-Path $repoRoot 'tests\detection\run.mjs'
$arguments = @(
    $runner,
    '--browsers', $browserConfigPath,
    '--sites', $siteConfigPath,
    '--output', $outputPath,
    '--navigation-timeout', [string]$NavigationTimeout
)
if ($Only) { $arguments += @('--only', ($Only -join ',')) }
if ($Headed) { $arguments += '--headed' }
if ($FailOnDetection) { $arguments += '--fail-on-detection' }

& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Detection runner failed with exit code $LASTEXITCODE." }
Write-Output $outputPath
