[CmdletBinding()]
param(
    [string]$ChromiumSrc = $env:SLYBROWSER_CHROMIUM_SRC,
    [string]$OutDir = 'out\release_x64',
    [string]$BrowserExecutable,
    [string]$DriverExecutable,
    [string]$SiteConfig,
    [string]$OutputDirectory,
    [string[]]$Only,
    [string[]]$BrowserArgument,
    [string[]]$ExcludeSwitch,
    [string]$LicenseFile,
    [string]$ProfileConfigFile,
    [string]$BrowserId = 'slybrowser-webdriver',
    [string]$BrowserName = 'SlyBrowser (project WebDriver)',
    [switch]$Headed,
    [switch]$CaptureBrowserLogs,
    [switch]$FailOnDetection,
    [switch]$Humanize,
    [ValidateSet('default', 'careful')][string]$HumanPreset = 'default',
    [ValidateRange(0, 2147483647)][int]$HumanSeed = 42424,
    [int]$NavigationTimeout = 45000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

if (-not $BrowserExecutable -or -not $DriverExecutable) {
    if (-not $ChromiumSrc) {
        throw 'Set -ChromiumSrc (or SLYBROWSER_CHROMIUM_SRC), or pass both -BrowserExecutable and -DriverExecutable.'
    }
    $chromiumRoot = (Resolve-Path -LiteralPath $ChromiumSrc).Path
    $buildDirectory = Join-Path $chromiumRoot $OutDir
    if (-not $BrowserExecutable) { $BrowserExecutable = Join-Path $buildDirectory 'SlyBrowser.exe' }
    if (-not $DriverExecutable) { $DriverExecutable = Join-Path $buildDirectory 'chromedriver.exe' }
}

$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
if (-not $SiteConfig) { $SiteConfig = Join-Path $repoRoot 'tests\detection\sites.json' }
$siteConfigPath = (Resolve-Path -LiteralPath $SiteConfig).Path
if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\detection\webdriver-$timestamp"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)

$launchArguments = @($BrowserArgument)
$browserLicenseHandoff = $null
$driverLicenseHandoff = $null
$profileConfigHandoff = $null
if ($LicenseFile) {
    $licensePath = (Resolve-Path -LiteralPath $LicenseFile).Path
    $leaseBytes = [System.IO.File]::ReadAllBytes($licensePath)
    if ($leaseBytes.Length -eq 0 -or $leaseBytes.Length -gt 65536) {
        throw 'The signed test lease must contain between 1 and 65536 bytes.'
    }
    $temporaryRoot = [System.IO.Path]::GetTempPath()
    $browserLicenseHandoff = Join-Path $temporaryRoot "sly-browser-license-$([guid]::NewGuid().ToString('N')).json"
    $driverLicenseHandoff = Join-Path $temporaryRoot "sly-driver-license-$([guid]::NewGuid().ToString('N')).json"
    [System.IO.File]::WriteAllBytes($browserLicenseHandoff, $leaseBytes)
    [System.IO.File]::WriteAllBytes($driverLicenseHandoff, $leaseBytes)
    $launchArguments += "--sly-license-file=$browserLicenseHandoff"
}
if ($ProfileConfigFile) {
    $profilePath = (Resolve-Path -LiteralPath $ProfileConfigFile).Path
    $profileBytes = [System.IO.File]::ReadAllBytes($profilePath)
    if ($profileBytes.Length -eq 0 -or $profileBytes.Length -gt 1048576) {
        throw 'The profile configuration must contain between 1 and 1048576 bytes.'
    }
    $profileConfigHandoff = Join-Path ([System.IO.Path]::GetTempPath()) "sly-profile-$([guid]::NewGuid().ToString('N')).json"
    [System.IO.File]::WriteAllBytes($profileConfigHandoff, $profileBytes)
    $launchArguments += "--sly-config-file=$profileConfigHandoff"
}

$runner = Join-Path $repoRoot 'tests\detection\run-webdriver.mjs'
$runnerArguments = @(
    $runner,
    '--browser', $browserPath,
    '--driver', $driverPath,
    '--browser-id', $BrowserId,
    '--browser-name', $BrowserName,
    '--sites', $siteConfigPath,
    '--output', $outputPath,
    '--navigation-timeout', [string]$NavigationTimeout
)
if ($driverLicenseHandoff) {
    $runnerArguments += @('--driver-license-file', $driverLicenseHandoff)
}
foreach ($launchArgument in $launchArguments) {
    if ($launchArgument) { $runnerArguments += @('--browser-arg', $launchArgument) }
}
foreach ($switchName in @($ExcludeSwitch)) {
    if ($switchName) { $runnerArguments += @('--exclude-switch', $switchName) }
}
if ($Only) { $runnerArguments += @('--only', ($Only -join ',')) }
if ($Headed) { $runnerArguments += '--headed' }
if ($CaptureBrowserLogs) { $runnerArguments += '--capture-browser-logs' }
if ($FailOnDetection) { $runnerArguments += '--fail-on-detection' }
if ($Humanize) {
    $runnerArguments += @('--humanize', '--human-preset', $HumanPreset, '--human-seed', [string]$HumanSeed)
}

try {
    & node @runnerArguments
    if ($LASTEXITCODE -ne 0) { throw "WebDriver detection runner failed with exit code $LASTEXITCODE." }
} finally {
    foreach ($handoff in @($browserLicenseHandoff, $driverLicenseHandoff, $profileConfigHandoff)) {
        if ($handoff -and (Test-Path -LiteralPath $handoff)) {
            Remove-Item -LiteralPath $handoff -Force
        }
    }
}
Write-Output $outputPath
