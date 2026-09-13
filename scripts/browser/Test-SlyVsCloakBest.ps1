[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SlyBrowserExecutable,
    [Parameter(Mandatory)][string]$SlyDriverExecutable,
    [Parameter(Mandatory)][string]$CloakBrowserExecutable,
    [Parameter(Mandatory)][string]$CloakWrapperModule,
    [string]$SiteConfig,
    [string]$OutputDirectory,
    [string[]]$Only,
    [string[]]$SlyBrowserArgument,
    [string[]]$CloakBrowserArgument,
    [string]$SlyLicenseFile,
    [string]$SlyProfileConfigFile,
    [ValidateRange(1, 2147483647)][int]$CloakFingerprintSeed = 42424,
    [ValidateSet('default', 'careful')][string]$CloakHumanPreset = 'careful',
    [ValidateSet('default', 'careful')][string]$SlyHumanPreset = 'careful',
    [ValidateRange(0, 2147483647)][int]$SlyHumanSeed = 42424,
    [bool]$CloakGeoIP = $true,
    [string]$Locale,
    [string]$Timezone,
    [switch]$Headless,
    [int]$NavigationTimeout = 45000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$webdriverRunner = Join-Path $PSScriptRoot 'Test-DetectionPagesWebDriver.ps1'
$playwrightRunner = Join-Path $repoRoot 'tests\detection\run.mjs'
$compareRunner = Join-Path $PSScriptRoot 'Compare-DetectionResults.ps1'

$slyBrowserPath = (Resolve-Path -LiteralPath $SlyBrowserExecutable).Path
$slyDriverPath = (Resolve-Path -LiteralPath $SlyDriverExecutable).Path
$cloakBrowserPath = (Resolve-Path -LiteralPath $CloakBrowserExecutable).Path
$cloakModulePath = (Resolve-Path -LiteralPath $CloakWrapperModule).Path
if (-not $SiteConfig) { $SiteConfig = Join-Path $repoRoot 'tests\detection\sites.json' }
$siteConfigPath = (Resolve-Path -LiteralPath $SiteConfig).Path

if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\detection\best-sly-vs-cloak-$timestamp"
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$slyOutput = Join-Path $outputRoot 'sly'
$cloakOutput = Join-Path $outputRoot 'cloak'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$slyExtraArguments = @($SlyBrowserArgument | Where-Object { $_ })
$slyParameters = @{
    BrowserExecutable = $slyBrowserPath
    DriverExecutable = $slyDriverPath
    BrowserId = 'slybrowser-best-webdriver'
    BrowserName = 'SlyBrowser best available (project WebDriver)'
    BrowserArgument = $slyExtraArguments
    ExcludeSwitch = @('enable-automation', 'enable-unsafe-swiftshader')
    OutputDirectory = $slyOutput
    NavigationTimeout = $NavigationTimeout
    Humanize = $true
    HumanPreset = $SlyHumanPreset
    HumanSeed = $SlyHumanSeed
}
if ($SiteConfig) { $slyParameters.SiteConfig = $siteConfigPath }
if ($Only) { $slyParameters.Only = $Only }
if ($SlyLicenseFile) { $slyParameters.LicenseFile = $SlyLicenseFile }
if ($SlyProfileConfigFile) { $slyParameters.ProfileConfigFile = $SlyProfileConfigFile }
if (-not $Headless) { $slyParameters.Headed = $true }

& $webdriverRunner @slyParameters
if ($LASTEXITCODE -ne 0) { throw "SlyBrowser best-mode run failed with exit code $LASTEXITCODE." }

$cloakExtraArguments = @($CloakBrowserArgument | Where-Object { $_ })
$cloakTarget = [ordered]@{
    id = 'cloakbrowser-best'
    name = 'CloakBrowser best available (official wrapper, Humanize careful)'
    provider = 'cloakbrowser-wrapper'
    wrapperModule = $cloakModulePath
    executable = $cloakBrowserPath
    headless = [bool]$Headless
    stealthArgs = $true
    geoip = $CloakGeoIP
    humanize = $true
    humanPreset = $CloakHumanPreset
    args = @("--fingerprint=$CloakFingerprintSeed") + $cloakExtraArguments
}
if ($Locale) { $cloakTarget.locale = $Locale }
if ($Timezone) { $cloakTarget.timezone = $Timezone }

$browserConfig = [ordered]@{
    schemaVersion = 1
    browsers = @($cloakTarget)
}
$browserConfigPath = Join-Path $outputRoot 'cloak-best.browser.json'
$browserConfigJson = $browserConfig | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($browserConfigPath, $browserConfigJson, [System.Text.UTF8Encoding]::new($false))

$runnerArguments = @(
    $playwrightRunner,
    '--browsers', $browserConfigPath,
    '--sites', $siteConfigPath,
    '--output', $cloakOutput,
    '--navigation-timeout', [string]$NavigationTimeout
)
if ($Only) { $runnerArguments += @('--only', ($Only -join ',')) }
& node @runnerArguments
if ($LASTEXITCODE -ne 0) { throw "CloakBrowser best-mode run failed with exit code $LASTEXITCODE." }

$comparisonOutput = Join-Path $outputRoot 'comparison.md'
& $compareRunner `
    -Results @(
        (Join-Path $slyOutput 'slybrowser-best-webdriver.json'),
        (Join-Path $cloakOutput 'cloakbrowser-best.json')
    ) `
    -Output $comparisonOutput

Write-Output $outputRoot
