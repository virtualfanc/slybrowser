[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [string]$LicenseFile,
    [string]$AuthorizationFile,
    [string]$CacheRoot,
    [string]$LicenseKeyId,
    [string]$LicensePublicKeyHex,
    [string]$ReleaseKeyId,
    [string]$ReleasePublicKeyBase64url,
    [string]$MavenExecutable = 'mvn',
    [string]$DotNetExecutable = 'dotnet',
    [switch]$Headed,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
$authorizationMode = -not [string]::IsNullOrWhiteSpace($AuthorizationFile)
if ($authorizationMode) {
    foreach ($name in @('CacheRoot', 'LicenseKeyId', 'LicensePublicKeyHex', 'ReleaseKeyId', 'ReleasePublicKeyBase64url')) {
        if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $name -ValueOnly))) {
            throw "$name is required with AuthorizationFile."
        }
    }
    $authorizationPath = (Resolve-Path -LiteralPath $AuthorizationFile).Path
    $cachePath = [System.IO.Path]::GetFullPath($CacheRoot)
} else {
    if ([string]::IsNullOrWhiteSpace($LicenseFile)) {
        throw 'Pass -LicenseFile for lease-only development mode or -AuthorizationFile with trust keys for production-like runtime handoff mode.'
    }
    $licensePath = (Resolve-Path -LiteralPath $LicenseFile).Path
    $licenseLength = (Get-Item -LiteralPath $licensePath).Length
    if ($licenseLength -lt 1 -or $licenseLength -gt 65536) {
        throw 'The signed test lease must contain between 1 and 65536 bytes.'
    }
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts\test-results\humanize'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$nodeReport = Join-Path $OutputDirectory "native-humanize-node-$stamp.json"
$pythonReport = Join-Path $OutputDirectory "native-humanize-python-$stamp.json"
$javaReport = Join-Path $OutputDirectory "native-humanize-java-$stamp.json"
$dotnetReport = Join-Path $OutputDirectory "native-humanize-dotnet-$stamp.json"
$summaryReport = Join-Path $OutputDirectory "native-humanize-score-parity-$stamp.json"
$headedValue = if ($Headed) { 'true' } else { 'false' }

& pnpm --filter slybrowser build
if ($LASTEXITCODE -ne 0) {
    throw 'Node SDK build failed before Native Humanize matrix.'
}

$nodeArguments = @(
    (Join-Path $repoRoot 'tests\integration\native-humanize-node-sdk.mjs'),
    '--browser', $browserPath,
    '--driver', $driverPath,
    '--output', $nodeReport
)
if ($authorizationMode) {
    $nodeArguments += @(
        '--authorization-file', $authorizationPath,
        '--cache-root', $cachePath,
        '--license-key-id', $LicenseKeyId,
        '--license-public-key-hex', $LicensePublicKeyHex,
        '--release-key-id', $ReleaseKeyId,
        '--release-public-key-base64url', $ReleasePublicKeyBase64url
    )
} else {
    $nodeArguments += @('--license', $licensePath)
}
if ($Headed) { $nodeArguments += '--headed' }
& node @nodeArguments
if ($LASTEXITCODE -ne 0) {
    throw 'Node SDK Native Humanize matrix failed.'
}

$previousPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = Join-Path $repoRoot 'packages\python\src'
    $pythonArguments = @(
        (Join-Path $repoRoot 'tests\integration\native_humanize_python_sdk.py'),
        '--browser', $browserPath,
        '--driver', $driverPath,
        '--output', $pythonReport
    )
    if ($authorizationMode) {
        $pythonArguments += @(
            '--authorization-file', $authorizationPath,
            '--cache-root', $cachePath,
            '--license-key-id', $LicenseKeyId,
            '--license-public-key-hex', $LicensePublicKeyHex,
            '--release-key-id', $ReleaseKeyId,
            '--release-public-key-base64url', $ReleasePublicKeyBase64url
        )
    } else {
        $pythonArguments += @('--license', $licensePath)
    }
    if ($Headed) { $pythonArguments += '--headed' }
    & python @pythonArguments
    if ($LASTEXITCODE -ne 0) {
        throw 'Python SDK Native Humanize matrix failed.'
    }
}
finally {
    $env:PYTHONPATH = $previousPythonPath
}

$mavenArguments = @(
    '-f', (Join-Path $repoRoot 'packages\java\pom.xml'),
    '-Dtest=NativeHumanizeRuntimeTest',
    "-Dslybrowser.integration.browser=$browserPath",
    "-Dslybrowser.integration.driver=$driverPath",
    "-Dslybrowser.integration.output=$javaReport",
    "-Dslybrowser.integration.headed=$headedValue"
)
if ($authorizationMode) {
    $mavenArguments += @(
        "-Dslybrowser.integration.authorizationFile=$authorizationPath",
        "-Dslybrowser.integration.cacheRoot=$cachePath",
        "-Dslybrowser.integration.licenseKeyId=$LicenseKeyId",
        "-Dslybrowser.integration.licensePublicKeyHex=$LicensePublicKeyHex",
        "-Dslybrowser.integration.releaseKeyId=$ReleaseKeyId",
        "-Dslybrowser.integration.releasePublicKeyBase64url=$ReleasePublicKeyBase64url"
    )
} else {
    $mavenArguments += "-Dslybrowser.integration.license=$licensePath"
}
$mavenArguments += 'test'
& $MavenExecutable @mavenArguments
if ($LASTEXITCODE -ne 0) {
    throw 'Java SDK Native Humanize matrix failed.'
}

$previousIntegrationBrowser = $env:SLYBROWSER_INTEGRATION_BROWSER
$previousIntegrationDriver = $env:SLYBROWSER_INTEGRATION_DRIVER
$previousIntegrationLicense = $env:SLYBROWSER_INTEGRATION_LICENSE
$previousIntegrationAuthorization = $env:SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE
$previousIntegrationCacheRoot = $env:SLYBROWSER_INTEGRATION_CACHE_ROOT
$previousIntegrationLicenseKeyId = $env:SLYBROWSER_INTEGRATION_LICENSE_KEY_ID
$previousIntegrationLicensePublicKeyHex = $env:SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX
$previousIntegrationReleaseKeyId = $env:SLYBROWSER_INTEGRATION_RELEASE_KEY_ID
$previousIntegrationReleasePublicKeyBase64url = $env:SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL
$previousIntegrationOutput = $env:SLYBROWSER_INTEGRATION_OUTPUT
$previousIntegrationHeaded = $env:SLYBROWSER_INTEGRATION_HEADED
try {
    $env:SLYBROWSER_INTEGRATION_BROWSER = $browserPath
    $env:SLYBROWSER_INTEGRATION_DRIVER = $driverPath
    $env:SLYBROWSER_INTEGRATION_LICENSE = if ($authorizationMode) { $null } else { $licensePath }
    $env:SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE = if ($authorizationMode) { $authorizationPath } else { $null }
    $env:SLYBROWSER_INTEGRATION_CACHE_ROOT = if ($authorizationMode) { $cachePath } else { $null }
    $env:SLYBROWSER_INTEGRATION_LICENSE_KEY_ID = if ($authorizationMode) { $LicenseKeyId } else { $null }
    $env:SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX = if ($authorizationMode) { $LicensePublicKeyHex } else { $null }
    $env:SLYBROWSER_INTEGRATION_RELEASE_KEY_ID = if ($authorizationMode) { $ReleaseKeyId } else { $null }
    $env:SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL = if ($authorizationMode) { $ReleasePublicKeyBase64url } else { $null }
    $env:SLYBROWSER_INTEGRATION_OUTPUT = $dotnetReport
    $env:SLYBROWSER_INTEGRATION_HEADED = if ($Headed) { '1' } else { '0' }
    & $DotNetExecutable test (Join-Path $repoRoot 'packages\dotnet\tests\SlyBrowser.Tests\SlyBrowser.Tests.csproj') `
        --configuration Release `
        --filter 'FullyQualifiedName~NativeHumanizeRuntimeTests'
    if ($LASTEXITCODE -ne 0) {
        throw '.NET SDK Native Humanize matrix failed.'
    }
}
finally {
    $env:SLYBROWSER_INTEGRATION_BROWSER = $previousIntegrationBrowser
    $env:SLYBROWSER_INTEGRATION_DRIVER = $previousIntegrationDriver
    $env:SLYBROWSER_INTEGRATION_LICENSE = $previousIntegrationLicense
    $env:SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE = $previousIntegrationAuthorization
    $env:SLYBROWSER_INTEGRATION_CACHE_ROOT = $previousIntegrationCacheRoot
    $env:SLYBROWSER_INTEGRATION_LICENSE_KEY_ID = $previousIntegrationLicenseKeyId
    $env:SLYBROWSER_INTEGRATION_LICENSE_PUBLIC_KEY_HEX = $previousIntegrationLicensePublicKeyHex
    $env:SLYBROWSER_INTEGRATION_RELEASE_KEY_ID = $previousIntegrationReleaseKeyId
    $env:SLYBROWSER_INTEGRATION_RELEASE_PUBLIC_KEY_BASE64URL = $previousIntegrationReleasePublicKeyBase64url
    $env:SLYBROWSER_INTEGRATION_OUTPUT = $previousIntegrationOutput
    $env:SLYBROWSER_INTEGRATION_HEADED = $previousIntegrationHeaded
}

& node (Join-Path $repoRoot 'tests\integration\compare-native-humanize-scores.mjs') `
    --report node $nodeReport `
    --report python $pythonReport `
    --report java $javaReport `
    --report dotnet $dotnetReport `
    --output $summaryReport
if ($LASTEXITCODE -ne 0) {
    throw 'Native Humanize SDK score parity failed.'
}

Write-Output $summaryReport
