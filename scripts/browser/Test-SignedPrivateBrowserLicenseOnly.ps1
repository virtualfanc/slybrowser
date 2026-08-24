[CmdletBinding()]
param(
    [string]$BrowserExecutable = 'E:\multilogin\chrome\src\out\release_x64\SlyBrowser.exe',
    [string]$DriverExecutable = 'E:\multilogin\chrome\src\out\release_x64\chromedriver.exe',
    [string]$LicenseFile = $env:SLYBROWSER_TEST_LICENSE_FILE,
    [string]$PrivateKeyFile = $env:SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE,
    [string]$KeyId = $env:SLYBROWSER_TEST_LEASE_KEY_ID,
    [string]$StockChromiumExecutable = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
    [string]$OutputDirectory,
    [int]$TimeoutMs = 45000
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path

if (-not $LicenseFile) {
    throw 'Pass -LicenseFile or set SLYBROWSER_TEST_LICENSE_FILE to a signed private-browser test lease.'
}
$licensePath = (Resolve-Path -LiteralPath $LicenseFile).Path
if (-not $PrivateKeyFile) {
    throw 'Pass -PrivateKeyFile or set SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE to the Ed25519 test signing key matching the compiled public key.'
}
if (-not $KeyId) {
    throw 'Pass -KeyId or set SLYBROWSER_TEST_LEASE_KEY_ID to the key id compiled into the tested build.'
}
$privateKeyPath = (Resolve-Path -LiteralPath $PrivateKeyFile).Path
if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\runtime-handoff\signed-private-browser-$timestamp"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

Push-Location $repoRoot
try {
    & pnpm --filter slybrowser build
    if ($LASTEXITCODE -ne 0) { throw "Node SDK build failed with exit code $LASTEXITCODE." }
    & pnpm --filter '@slybrowser/license-service' build
    if ($LASTEXITCODE -ne 0) { throw "License service build failed with exit code $LASTEXITCODE." }

    $nodeArgs = @(
        'tests\release\signed-private-browser-license-only.mjs',
        '--browser', $browserPath,
        '--driver', $driverPath,
        '--license', $licensePath,
        '--private-key-file', $privateKeyPath,
        '--key-id', $KeyId,
        '--output', $outputPath,
        '--timeout-ms', ([string]$TimeoutMs)
    )
    if ($StockChromiumExecutable -and (Test-Path -LiteralPath $StockChromiumExecutable)) {
        $nodeArgs += @('--stock', (Resolve-Path -LiteralPath $StockChromiumExecutable).Path)
    }
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw "Signed private-browser native runtime handoff matrix failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Output $outputPath
