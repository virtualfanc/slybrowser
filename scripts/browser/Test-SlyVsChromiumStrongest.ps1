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
    [switch]$SkipFrameworkBackends
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
$stockPath = (Resolve-Path -LiteralPath $StockChromiumExecutable).Path
$generatedLeaseRoot = $null
$generatedLeaseMetadata = $null

function Protect-SlyHandoffFile([string]$Path) {
    if ($env:OS -ne 'Windows_NT') { return }
    $identity = (& whoami).Trim()
    if (-not $identity) { throw 'Unable to determine current Windows identity for handoff ACL.' }
    & icacls $Path /inheritance:r /grant:r "${identity}:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict handoff ACL for $Path."
    }
}

if (-not $LicenseFile -and $TestLeasePrivateKeyFile) {
    $privateKeyPath = (Resolve-Path -LiteralPath $TestLeasePrivateKeyFile).Path
    $generatedLeaseRoot = Join-Path ([System.IO.Path]::GetTempPath()) "sly-generated-lease-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $generatedLeaseRoot -Force | Out-Null
    $LicenseFile = Join-Path $generatedLeaseRoot 'lease.json'
    $generatedLeaseMetadata = Join-Path $generatedLeaseRoot 'metadata.json'
    & node (Join-Path $repoRoot 'scripts\license\New-SignedTestLease.mjs') `
        --lease $LicenseFile `
        --metadata $generatedLeaseMetadata `
        --private-key-file $privateKeyPath `
        --key-id $TestLeaseKeyId `
        --duration-seconds 3600 `
        --feature browser `
        --feature webdriver `
        --feature humanize | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Signed test lease generation failed with exit code $LASTEXITCODE." }
    Protect-SlyHandoffFile $LicenseFile
}
if (-not $LicenseFile) {
    throw 'Pass -LicenseFile, set SLYBROWSER_TEST_LICENSE_FILE, or set SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE for a generated signed test lease.'
}
$licensePath = (Resolve-Path -LiteralPath $LicenseFile).Path
$licenseLength = (Get-Item -LiteralPath $licensePath).Length
if ($licenseLength -lt 1 -or $licenseLength -gt 65536) {
    throw 'The signed test lease must contain between 1 and 65536 bytes.'
}
if (-not $ProfileConfigFile) {
    $ProfileConfigFile = Join-Path $repoRoot 'tests\detection\profiles\strongest-benchmark.json'
}
$profilePath = (Resolve-Path -LiteralPath $ProfileConfigFile).Path
if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\detection\strongest-$timestamp"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$sdkPath = Join-Path $outputPath 'sdk'
$slyPath = Join-Path $outputPath 'sly'
$stockOutputPath = Join-Path $outputPath 'stock'
$frameworkOutputPath = Join-Path $outputPath 'frameworks'
$publicPath = Join-Path $outputPath 'public'
New-Item -ItemType Directory -Path $sdkPath, $slyPath, $stockOutputPath, $frameworkOutputPath, $publicPath -Force | Out-Null
if ($generatedLeaseMetadata) {
    Copy-Item -LiteralPath $generatedLeaseMetadata -Destination (Join-Path $publicPath 'generated-test-lease-metadata.json') -Force
}

$frameworkHandoffs = [System.Collections.Generic.List[string]]::new()
function New-SlyHandoffFile([string]$Source, [string]$Prefix) {
    $bytes = [System.IO.File]::ReadAllBytes($Source)
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 1048576) {
        throw "Handoff source must contain between 1 and 1048576 bytes: $Source"
    }
    $target = Join-Path ([System.IO.Path]::GetTempPath()) "$Prefix-$([guid]::NewGuid().ToString('N')).json"
    [System.IO.File]::WriteAllBytes($target, $bytes)
    Protect-SlyHandoffFile $target
    $frameworkHandoffs.Add($target)
    return $target
}

Push-Location $repoRoot
try {
    & pnpm --filter slybrowser build
    if ($LASTEXITCODE -ne 0) { throw "Node SDK build failed with exit code $LASTEXITCODE." }

    & node 'tests\integration\native-humanize-node-sdk.mjs' `
        --browser $browserPath --driver $driverPath --license $licensePath --output (Join-Path $sdkPath 'node.json') --headed
    if ($LASTEXITCODE -ne 0) { throw "Node SDK runtime matrix failed with exit code $LASTEXITCODE." }

    $previousPythonPath = $env:PYTHONPATH
    $env:PYTHONPATH = Join-Path $repoRoot 'packages\python\src'
    try {
        & python 'tests\integration\native_humanize_python_sdk.py' `
            --browser $browserPath --driver $driverPath --license $licensePath --output (Join-Path $sdkPath 'python.json') --headed
        if ($LASTEXITCODE -ne 0) { throw "Python SDK runtime matrix failed with exit code $LASTEXITCODE." }
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }

    & $MavenExecutable `
        -f (Join-Path $repoRoot 'packages\java\pom.xml') `
        '-Dtest=NativeHumanizeRuntimeTest' `
        "-Dslybrowser.integration.browser=$browserPath" `
        "-Dslybrowser.integration.driver=$driverPath" `
        "-Dslybrowser.integration.license=$licensePath" `
        "-Dslybrowser.integration.output=$(Join-Path $sdkPath 'java.json')" `
        '-Dslybrowser.integration.headed=true' `
        test
    if ($LASTEXITCODE -ne 0) { throw "Java SDK runtime matrix failed with exit code $LASTEXITCODE." }

    $previousIntegrationBrowser = $env:SLYBROWSER_INTEGRATION_BROWSER
    $previousIntegrationDriver = $env:SLYBROWSER_INTEGRATION_DRIVER
    $previousIntegrationLicense = $env:SLYBROWSER_INTEGRATION_LICENSE
    $previousIntegrationOutput = $env:SLYBROWSER_INTEGRATION_OUTPUT
    $previousIntegrationHeaded = $env:SLYBROWSER_INTEGRATION_HEADED
    try {
        $env:SLYBROWSER_INTEGRATION_BROWSER = $browserPath
        $env:SLYBROWSER_INTEGRATION_DRIVER = $driverPath
        $env:SLYBROWSER_INTEGRATION_LICENSE = $licensePath
        $env:SLYBROWSER_INTEGRATION_OUTPUT = Join-Path $sdkPath 'dotnet.json'
        $env:SLYBROWSER_INTEGRATION_HEADED = '1'
        & $DotNetExecutable test (Join-Path $repoRoot 'packages\dotnet\tests\SlyBrowser.Tests\SlyBrowser.Tests.csproj') `
            --configuration Release `
            --filter 'FullyQualifiedName~NativeHumanizeRuntimeTests'
        if ($LASTEXITCODE -ne 0) { throw ".NET SDK runtime matrix failed with exit code $LASTEXITCODE." }
    } finally {
        $env:SLYBROWSER_INTEGRATION_BROWSER = $previousIntegrationBrowser
        $env:SLYBROWSER_INTEGRATION_DRIVER = $previousIntegrationDriver
        $env:SLYBROWSER_INTEGRATION_LICENSE = $previousIntegrationLicense
        $env:SLYBROWSER_INTEGRATION_OUTPUT = $previousIntegrationOutput
        $env:SLYBROWSER_INTEGRATION_HEADED = $previousIntegrationHeaded
    }

    & node 'tests\integration\compare-native-humanize-scores.mjs' `
        --report node (Join-Path $sdkPath 'node.json') `
        --report python (Join-Path $sdkPath 'python.json') `
        --report java (Join-Path $sdkPath 'java.json') `
        --report dotnet (Join-Path $sdkPath 'dotnet.json') `
        --output (Join-Path $sdkPath 'score-parity.json')
    if ($LASTEXITCODE -ne 0) { throw "Native Humanize SDK score parity failed with exit code $LASTEXITCODE." }

    & 'scripts\browser\Test-DetectionPagesWebDriver.ps1' `
        -BrowserExecutable $browserPath `
        -DriverExecutable $driverPath `
        -LicenseFile $licensePath `
        -ProfileConfigFile $profilePath `
        -OutputDirectory $slyPath `
        -BrowserId 'slybrowser-strongest' `
        -BrowserName 'SlyBrowser strongest mode' `
        -Headed `
        -Humanize `
        -HumanPreset 'careful' `
        -HumanSeed 42424 `
        -ExcludeSwitch @('enable-automation','enable-unsafe-swiftshader') `
        -NavigationTimeout $NavigationTimeout
    if ($LASTEXITCODE -ne 0) { throw "SlyBrowser detection run failed with exit code $LASTEXITCODE." }

    if (-not $SkipFrameworkBackends) {
        $playwrightLicense = New-SlyHandoffFile $licensePath 'sly-playwright-license'
        $playwrightProfile = New-SlyHandoffFile $profilePath 'sly-playwright-profile'
        $puppeteerLicense = New-SlyHandoffFile $licensePath 'sly-puppeteer-license'
        $puppeteerProfile = New-SlyHandoffFile $profilePath 'sly-puppeteer-profile'
        $frameworkConfig = Join-Path ([System.IO.Path]::GetTempPath()) "sly-framework-matrix-$([guid]::NewGuid().ToString('N')).json"
        $frameworkHandoffs.Add($frameworkConfig)
        @{
            schemaVersion = 1
            browsers = @(
                @{
                    id = 'slybrowser-playwright'
                    name = 'SlyBrowser (Playwright)'
                    provider = 'playwright-core'
                    executable = $browserPath
                    headless = $false
                    args = @('--no-first-run', '--no-default-browser-check', "--sly-license-file=$playwrightLicense", "--sly-config-file=$playwrightProfile")
                },
                @{
                    id = 'slybrowser-puppeteer'
                    name = 'SlyBrowser (Puppeteer)'
                    provider = 'puppeteer-core'
                    executable = $browserPath
                    headless = $false
                    args = @('--no-first-run', '--no-default-browser-check', "--sly-license-file=$puppeteerLicense", "--sly-config-file=$puppeteerProfile")
                },
                @{
                    id = 'stock-playwright'
                    name = 'Stock Chromium (Playwright)'
                    provider = 'playwright-core'
                    executable = $stockPath
                    headless = $false
                    args = @('--no-first-run', '--no-default-browser-check')
                },
                @{
                    id = 'stock-puppeteer'
                    name = 'Stock Chromium (Puppeteer)'
                    provider = 'puppeteer-core'
                    executable = $stockPath
                    headless = $false
                    args = @('--no-first-run', '--no-default-browser-check')
                }
            )
        } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $frameworkConfig -Encoding utf8
        & node 'tests\detection\run.mjs' `
            --browsers $frameworkConfig `
            --sites 'tests\detection\sites.json' `
            --output $frameworkOutputPath `
            --headed `
            --navigation-timeout ([string]$NavigationTimeout)
        if ($LASTEXITCODE -ne 0) { throw "Framework detection matrix failed with exit code $LASTEXITCODE." }
    }

    if ($SkipFrameworkBackends) {
        $previousStockPath = $env:STOCK_CHROMIUM_EXE
        $env:STOCK_CHROMIUM_EXE = $stockPath
        try {
            & node 'tests\detection\run.mjs' `
                --browsers 'tests\detection\browsers.stock.json' `
                --sites 'tests\detection\sites.json' `
                --output $stockOutputPath `
                --headed `
                --navigation-timeout ([string]$NavigationTimeout)
            if ($LASTEXITCODE -ne 0) { throw "Stock Chromium detection run failed with exit code $LASTEXITCODE." }
        } finally {
            $env:STOCK_CHROMIUM_EXE = $previousStockPath
        }
    }

    $slyResult = Join-Path $slyPath 'slybrowser-strongest.json'
    $stockResult = if ($SkipFrameworkBackends) {
        Join-Path $stockOutputPath 'stock-playwright.json'
    } else {
        Join-Path $frameworkOutputPath 'stock-playwright.json'
    }
    & node 'tests\detection\compare.mjs' `
        --input $slyResult --input $stockResult --output (Join-Path $outputPath 'internal-comparison.md')
    if ($LASTEXITCODE -ne 0) { throw "Internal comparison failed with exit code $LASTEXITCODE." }

    & node 'tests\detection\publish-comparison.mjs' `
        --sly $slyResult `
        --stock $stockResult `
        --node-sdk (Join-Path $sdkPath 'node.json') `
        --python-sdk (Join-Path $sdkPath 'python.json') `
        --java-sdk (Join-Path $sdkPath 'java.json') `
        --dotnet-sdk (Join-Path $sdkPath 'dotnet.json') `
        --json (Join-Path $publicPath 'comparison.json') `
        --markdown (Join-Path $publicPath 'comparison.md')
    if ($LASTEXITCODE -ne 0) { throw "Public comparison failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
    foreach ($handoff in $frameworkHandoffs) {
        if (Test-Path -LiteralPath $handoff) { Remove-Item -LiteralPath $handoff -Force }
    }
    if ($generatedLeaseRoot -and
        (Test-Path -LiteralPath $generatedLeaseRoot) -and
        ([System.IO.Path]::GetFileName($generatedLeaseRoot)).StartsWith('sly-generated-lease-')) {
        Remove-Item -LiteralPath $generatedLeaseRoot -Recurse -Force
    }
}

Write-Output $outputPath
