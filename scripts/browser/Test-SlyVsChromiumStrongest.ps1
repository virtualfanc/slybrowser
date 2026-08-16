[CmdletBinding()]
param(
    [string]$BrowserExecutable = 'F:\chrome\src\out\release_x64\chrome.exe',
    [string]$DriverExecutable = 'F:\chrome\src\out\release_x64\chromedriver.exe',
    [string]$StockChromiumExecutable = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
    [string]$ProfileConfigFile,
    [string]$OutputDirectory,
    [int]$NavigationTimeout = 45000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
$stockPath = (Resolve-Path -LiteralPath $StockChromiumExecutable).Path
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
$publicPath = Join-Path $outputPath 'public'
New-Item -ItemType Directory -Path $sdkPath, $slyPath, $stockOutputPath, $publicPath -Force | Out-Null

Push-Location $repoRoot
try {
    & pnpm --filter slybrowser build
    if ($LASTEXITCODE -ne 0) { throw "Node SDK build failed with exit code $LASTEXITCODE." }

    & node 'tests\integration\native-humanize-node-sdk.mjs' `
        --browser $browserPath --driver $driverPath --output (Join-Path $sdkPath 'node.json') --headed
    if ($LASTEXITCODE -ne 0) { throw "Node SDK runtime matrix failed with exit code $LASTEXITCODE." }

    $previousPythonPath = $env:PYTHONPATH
    $env:PYTHONPATH = Join-Path $repoRoot 'packages\python\src'
    try {
        & python 'tests\integration\native_humanize_python_sdk.py' `
            --browser $browserPath --driver $driverPath --output (Join-Path $sdkPath 'python.json') --headed
        if ($LASTEXITCODE -ne 0) { throw "Python SDK runtime matrix failed with exit code $LASTEXITCODE." }
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }

    & 'scripts\browser\Test-DetectionPagesWebDriver.ps1' `
        -BrowserExecutable $browserPath `
        -DriverExecutable $driverPath `
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

    $slyResult = Join-Path $slyPath 'slybrowser-strongest.json'
    $stockResult = Join-Path $stockOutputPath 'stock-playwright.json'
    & node 'tests\detection\compare.mjs' `
        --input $slyResult --input $stockResult --output (Join-Path $outputPath 'internal-comparison.md')
    if ($LASTEXITCODE -ne 0) { throw "Internal comparison failed with exit code $LASTEXITCODE." }

    & node 'tests\detection\publish-comparison.mjs' `
        --sly $slyResult `
        --stock $stockResult `
        --node-sdk (Join-Path $sdkPath 'node.json') `
        --python-sdk (Join-Path $sdkPath 'python.json') `
        --json (Join-Path $publicPath 'comparison.json') `
        --markdown (Join-Path $publicPath 'comparison.md')
    if ($LASTEXITCODE -ne 0) { throw "Public comparison failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Output $outputPath
