[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SlyBrowserExecutable,
    [Parameter(Mandatory)][string]$SlyDriverExecutable,
    [Parameter(Mandatory)][string]$CloakBrowserExecutable,
    [Parameter(Mandatory)][string]$CloakDriverExecutable,
    [string]$SiteConfig,
    [string]$OutputDirectory,
    [string[]]$Only,
    [string[]]$SlyBrowserArgument,
    [string[]]$CloakBrowserArgument,
    [string]$SlyLicenseFile,
    [string]$SlyProfileConfigFile,
    [int]$CloakFingerprintSeed = 42424,
    [string]$Locale = 'zh-CN',
    [string]$Timezone = 'Asia/Shanghai',
    [switch]$Headed,
    [int]$NavigationTimeout = 20000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$testRunner = Join-Path $PSScriptRoot 'Test-DetectionPagesWebDriver.ps1'
$compareRunner = Join-Path $PSScriptRoot 'Compare-DetectionResults.ps1'

if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\detection\webdriver-sly-vs-cloak-$timestamp"
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$slyOutput = Join-Path $outputRoot 'sly'
$cloakOutput = Join-Path $outputRoot 'cloak'

$slyParameters = @{
    BrowserExecutable = $SlyBrowserExecutable
    DriverExecutable = $SlyDriverExecutable
    BrowserId = 'slybrowser-webdriver'
    BrowserName = 'SlyBrowser (project WebDriver)'
    OutputDirectory = $slyOutput
    NavigationTimeout = $NavigationTimeout
}
if ($SiteConfig) { $slyParameters.SiteConfig = $SiteConfig }
if ($Only) { $slyParameters.Only = $Only }
if ($SlyBrowserArgument) { $slyParameters.BrowserArgument = $SlyBrowserArgument }
if ($SlyLicenseFile) { $slyParameters.LicenseFile = $SlyLicenseFile }
if ($SlyProfileConfigFile) { $slyParameters.ProfileConfigFile = $SlyProfileConfigFile }
if ($Headed) { $slyParameters.Headed = $true }

& $testRunner @slyParameters

# CloakBrowser's wrapper enables its binary-level fingerprint system with a seed
# and platform persona. The seed fills canvas, WebGL, audio, fonts, hardware, and
# screen values. Locale/timezone use binary flags rather than CDP emulation.
$cloakArguments = @(
    '--no-sandbox',
    "--fingerprint=$CloakFingerprintSeed",
    '--fingerprint-platform=windows',
    '--ignore-gpu-blocklist',
    "--fingerprint-timezone=$Timezone",
    "--lang=$Locale",
    "--fingerprint-locale=$Locale"
) + @($CloakBrowserArgument)
$cloakParameters = @{
    BrowserExecutable = $CloakBrowserExecutable
    DriverExecutable = $CloakDriverExecutable
    BrowserId = 'cloakbrowser-webdriver'
    BrowserName = 'CloakBrowser (all available binary stealth features)'
    BrowserArgument = $cloakArguments
    ExcludeSwitch = @('enable-automation', 'enable-unsafe-swiftshader')
    OutputDirectory = $cloakOutput
    NavigationTimeout = $NavigationTimeout
}
if ($SiteConfig) { $cloakParameters.SiteConfig = $SiteConfig }
if ($Only) { $cloakParameters.Only = $Only }
if ($Headed) { $cloakParameters.Headed = $true }

& $testRunner @cloakParameters

$comparisonOutput = Join-Path $outputRoot 'comparison.md'
& $compareRunner `
    -Results @(
        (Join-Path $slyOutput 'slybrowser-webdriver.json'),
        (Join-Path $cloakOutput 'cloakbrowser-webdriver.json')
    ) `
    -Output $comparisonOutput

Write-Output $outputRoot
