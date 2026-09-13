[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [string]$ReleaseHarnessModule = $env:SLYBROWSER_RELEASE_HARNESS_MODULE,
    [string]$PrivateKeyFile = $env:SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE,
    [string]$KeyId = $env:SLYBROWSER_TEST_LEASE_KEY_ID,
    [string]$OutputDirectory,
    [int]$TimeoutMs = 45000,
    [int]$RevocationTimeoutMs = 70000,
    [int]$TransientExpiryTimeoutMs = 170000,
    [switch]$IncludeTransientExpiry,
    [switch]$IncludeRevocationExit
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path

if (-not $ReleaseHarnessModule) {
    throw 'Pass -ReleaseHarnessModule or set SLYBROWSER_RELEASE_HARNESS_MODULE to the operator-supplied release-service test harness module.'
}
$releaseHarnessPath = (Resolve-Path -LiteralPath $ReleaseHarnessModule).Path
if (-not $PrivateKeyFile) {
    throw 'Pass -PrivateKeyFile or set SLYBROWSER_TEST_LEASE_PRIVATE_KEY_FILE to the Ed25519 test signing key matching the compiled public key.'
}
if (-not $KeyId) {
    throw 'Pass -KeyId or set SLYBROWSER_TEST_LEASE_KEY_ID to the key id compiled into the tested build.'
}
$privateKeyPath = (Resolve-Path -LiteralPath $PrivateKeyFile).Path

if (-not $OutputDirectory) {
    $timestamp = [DateTimeOffset]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $OutputDirectory = Join-Path $repoRoot "artifacts\test-results\native-watchdog\native-runtime-watchdog-$timestamp"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null

Push-Location $repoRoot
try {
    & pnpm --filter slybrowser build
    if ($LASTEXITCODE -ne 0) { throw "Node SDK build failed with exit code $LASTEXITCODE." }

    $nodeArgs = @(
        'tests\release\native-runtime-watchdog-matrix.mjs',
        '--browser', $browserPath,
        '--driver', $driverPath,
        '--release-harness-module', $releaseHarnessPath,
        '--private-key-file', $privateKeyPath,
        '--key-id', $KeyId,
        '--output', $outputPath,
        '--timeout-ms', ([string]$TimeoutMs),
        '--revocation-timeout-ms', ([string]$RevocationTimeoutMs),
        '--transient-expiry-timeout-ms', ([string]$TransientExpiryTimeoutMs)
    )
    if ($IncludeRevocationExit) {
        $nodeArgs += '--include-revocation-exit'
    }
    if ($IncludeTransientExpiry) {
        $nodeArgs += '--include-transient-expiry'
    }
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw "Native runtime watchdog matrix failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}

Write-Output $outputPath
