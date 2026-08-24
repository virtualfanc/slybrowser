[CmdletBinding()]
param(
    [string]$BrowserExecutable = 'E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe',
    [string]$DriverExecutable = 'E:\multilogin\chrome\src\out\release_x64\chromedriver.exe',
    [string]$StockChromiumExecutable = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
    [string]$LicenseFile = $env:SLYBROWSER_TEST_LICENSE_FILE,
    [string]$TestLeasePrivateKeyFile = $env:SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE,
    [string]$TestLeaseKeyId = $(if ($env:SLYBROWSER_TEST_LEASE_KEY_ID) { $env:SLYBROWSER_TEST_LEASE_KEY_ID } else { 'local-test-v1' }),
    [string]$ProfileConfigFile,
    [string]$OutputDirectory,
    [string]$MavenExecutable = 'mvn',
    [string]$DotNetExecutable = 'dotnet',
    [int]$NavigationTimeout = 45000,
    [double]$MinimumSlyScore = 80,
    [double]$MinimumDelta = 0,
    [switch]$AllowProvisional,
    [switch]$AllowLatestStockBaseline,
    [switch]$ReportOnly,
    [switch]$SkipFrameworkBackends
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
$stockPath = (Resolve-Path -LiteralPath $StockChromiumExecutable).Path

if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\kernel-update-score\kernel-update-$timestamp"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

$strongestArguments = @(
    '-BrowserExecutable', $browserPath,
    '-DriverExecutable', $driverPath,
    '-StockChromiumExecutable', $stockPath,
    '-OutputDirectory', $outputPath,
    '-MavenExecutable', $MavenExecutable,
    '-DotNetExecutable', $DotNetExecutable,
    '-NavigationTimeout', ([string]$NavigationTimeout)
)
if ($LicenseFile) {
    $strongestArguments += @('-LicenseFile', (Resolve-Path -LiteralPath $LicenseFile).Path)
}
if ($TestLeasePrivateKeyFile) {
    $strongestArguments += @('-TestLeasePrivateKeyFile', (Resolve-Path -LiteralPath $TestLeasePrivateKeyFile).Path)
    $strongestArguments += @('-TestLeaseKeyId', $TestLeaseKeyId)
}
if ($ProfileConfigFile) {
    $strongestArguments += @('-ProfileConfigFile', (Resolve-Path -LiteralPath $ProfileConfigFile).Path)
}
if ($SkipFrameworkBackends) {
    $strongestArguments += @('-SkipFrameworkBackends')
}

Push-Location $repoRoot
try {
    & 'scripts\browser\Test-SlyVsChromiumStrongest.ps1' @strongestArguments
    if ($LASTEXITCODE -ne 0) { throw "SlyBrowser versus stock Chromium strongest benchmark failed with exit code $LASTEXITCODE." }

    $comparison = Join-Path $outputPath 'public\comparison.json'
    if (-not (Test-Path -LiteralPath $comparison)) {
        throw "Expected comparison report was not created: $comparison"
    }

    $gateArguments = @(
        'scripts\release\Build-KernelUpdateScoreGate.mjs',
        '--comparison', $comparison,
        '--output-dir', $outputPath,
        '--run-dir', $outputPath,
        '--minimum-sly-score', ([string]$MinimumSlyScore),
        '--minimum-delta', ([string]$MinimumDelta),
        '--sly-browser', $browserPath,
        '--sly-driver', $driverPath,
        '--stock-browser', $stockPath
    )
    if ($AllowProvisional) {
        $gateArguments += @('--allow-provisional')
    }
    if ($AllowLatestStockBaseline) {
        $gateArguments += @('--allow-latest-stock-baseline')
    }
    if ($ReportOnly) {
        $gateArguments += @('--report-only')
    }

    & node @gateArguments
    if ($LASTEXITCODE -ne 0) { throw "Kernel update score gate failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Output $outputPath
