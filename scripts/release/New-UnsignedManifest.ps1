[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Artifact,
    [Parameter(Mandatory)][ValidateSet('windows', 'linux', 'macos')][string]$Platform,
    [Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$Arch,
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$BrowserVersion,
    [Parameter(Mandatory)][string]$SdkCompatibility,
    [ValidateSet('available', 'revoked')][string]$Status = 'available',
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [Parameter(Mandatory)][string[]]$PrivateModule,
    [string[]]$PrivateModulePath,
    [Parameter(Mandatory)][string[]]$PrivateModuleAbi,
    [string[]]$Resource = @(),
    [string[]]$ResourcePath,
    [Parameter(Mandatory)][string]$BinaryLicense,
    [Parameter(Mandatory)][string]$LicenseScope,
    [Parameter(Mandatory)][string]$ThirdPartyNotices,
    [Parameter(Mandatory)][string]$CreditsHtml,
    [ValidateSet('authenticode', 'apple-developer-id', 'x509-code-signing')][string]$CodeSignatureScheme = 'authenticode',
    [string]$CodeSignatureSubject,
    [string]$CodeSignatureCertificateSha256,
    [switch]$CodeSignatureTimestampRequired,
    [string]$Sbom,
    [string]$SbomUrl,
    [string]$Provenance,
    [string]$ProvenanceUrl,
    [string]$ChromiumPatchInventory,
    [string]$ChromiumPatchInventoryUrl,
    [string]$BrowserPath = 'SlyBrowser/SlyBrowser.exe',
    [string]$DriverPath = 'SlyBrowser/chromedriver.exe',
    [Parameter(Mandatory)][string]$Output
)

$ErrorActionPreference = 'Stop'

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$LiteralPath)

    $stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$artifactPath = (Resolve-Path -LiteralPath $Artifact).Path
if (-not $Url.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Artifact URL must use HTTPS.'
}
if ([bool]$Sbom -or [bool]$SbomUrl -or [bool]$Provenance -or [bool]$ProvenanceUrl -or [bool]$ChromiumPatchInventory -or [bool]$ChromiumPatchInventoryUrl) {
    if (-not ($Sbom -and $SbomUrl -and $Provenance -and $ProvenanceUrl -and $ChromiumPatchInventory -and $ChromiumPatchInventoryUrl)) {
        throw 'Supply-chain evidence is optional for launch, but all evidence paths and URLs must be supplied together when used.'
    }
}
foreach ($evidenceUrl in @($SbomUrl, $ProvenanceUrl, $ChromiumPatchInventoryUrl)) {
    if ($evidenceUrl -and -not $evidenceUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Supply-chain evidence URLs must use HTTPS.'
    }
}
$file = Get-Item -LiteralPath $artifactPath
$hash = Get-Sha256Hex -LiteralPath $artifactPath
$browserBinary = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverBinary = (Resolve-Path -LiteralPath $DriverExecutable).Path
foreach ($relativePath in @($BrowserPath, $DriverPath)) {
    if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'BrowserPath and DriverPath must be safe relative archive paths.'
    }
}
if ($CodeSignatureSubject -or $CodeSignatureCertificateSha256 -or $CodeSignatureTimestampRequired) {
    if (-not $CodeSignatureSubject -or -not $CodeSignatureCertificateSha256) {
        throw 'CodeSignatureSubject and CodeSignatureCertificateSha256 must be supplied together when optional code-signature metadata is used.'
    }
    if ($CodeSignatureCertificateSha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'CodeSignatureCertificateSha256 must be a lowercase SHA-256 hex string.'
    }
}
if (-not $PrivateModulePath) {
    $PrivateModulePath = @($PrivateModule | ForEach-Object { Split-Path -Leaf $_ })
}
$userResources = @($Resource)
if (-not $ResourcePath) {
    $ResourcePath = @($userResources | ForEach-Object { Split-Path -Leaf $_ })
}
$legalResources = @($BinaryLicense, $LicenseScope, $ThirdPartyNotices, $CreditsHtml)
$legalResourcePaths = @('BINARY-LICENSE.txt', 'LICENSE-SCOPE.txt', 'THIRD_PARTY_NOTICES.txt', 'CREDITS.html')
$Resource = @($legalResources + $userResources)
$ResourcePath = @($legalResourcePaths + @($ResourcePath))
if ($PrivateModule.Count -ne $PrivateModulePath.Count -or $PrivateModule.Count -ne $PrivateModuleAbi.Count) {
    throw 'PrivateModule, PrivateModulePath, and PrivateModuleAbi must have the same number of entries.'
}
if ($Resource.Count -ne $ResourcePath.Count) {
    throw 'Resource and ResourcePath must have the same number of entries.'
}
foreach ($relativePath in @($PrivateModulePath + $ResourcePath)) {
    if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'PrivateModulePath and ResourcePath entries must be safe relative archive paths.'
    }
}
$browserHash = Get-Sha256Hex -LiteralPath $browserBinary
$driverHash = Get-Sha256Hex -LiteralPath $driverBinary
function New-PrivateModuleEntry {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$Abi
    )
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolvedPath
    if ($item.PSIsContainer -or $item.Length -le 0) {
        throw "Private module is missing or empty: $Path"
    }
    return [ordered]@{
        path = $ArchivePath.Replace('\', '/')
        sha256 = Get-Sha256Hex -LiteralPath $resolvedPath
        size = $item.Length
        abi = $Abi
    }
}
function New-ResourceEntry {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ArchivePath
    )
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolvedPath
    if ($item.PSIsContainer -or $item.Length -le 0) {
        throw "Resource file is missing or empty: $Path"
    }
    return [ordered]@{
        path = $ArchivePath.Replace('\', '/')
        sha256 = Get-Sha256Hex -LiteralPath $resolvedPath
        size = $item.Length
    }
}
function New-EvidenceEntry {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$EvidenceUrl, [Parameter(Mandatory)][string]$MediaType)
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolvedPath
    if (-not $item.PSIsContainer -and $item.Length -gt 0) {
        return [ordered]@{
            url = $EvidenceUrl
            sha256 = Get-Sha256Hex -LiteralPath $resolvedPath
            size = $item.Length
            mediaType = $MediaType
        }
    }
    throw "Supply-chain evidence is missing or empty: $Path"
}
$artifactEntry = [ordered]@{
    platform = $Platform
    arch = $Arch
    url = $Url
    sha256 = $hash
    size = $file.Length
    archiveFormat = '7z'
    browserExecutable = $BrowserPath.Replace('\', '/')
    driverExecutable = $DriverPath.Replace('\', '/')
    browserSha256 = $browserHash
    driverSha256 = $driverHash
    privateModules = @(for ($index = 0; $index -lt $PrivateModule.Count; $index++) {
        New-PrivateModuleEntry -Path $PrivateModule[$index] -ArchivePath $PrivateModulePath[$index] -Abi $PrivateModuleAbi[$index]
    })
    resources = @(for ($index = 0; $index -lt $Resource.Count; $index++) {
        New-ResourceEntry -Path $Resource[$index] -ArchivePath $ResourcePath[$index]
    })
}
if ($CodeSignatureSubject -or $CodeSignatureCertificateSha256 -or $CodeSignatureTimestampRequired) {
    $artifactEntry['codeSignature'] = [ordered]@{
        scheme = $CodeSignatureScheme
        subject = $CodeSignatureSubject
        certificateSha256 = $CodeSignatureCertificateSha256
        timestampRequired = [bool]$CodeSignatureTimestampRequired
    }
}

$manifest = [ordered]@{
    schemaVersion = 1
    browserVersion = $BrowserVersion
    sdkCompatibility = $SdkCompatibility
    status = $Status
    publishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    artifacts = @($artifactEntry)
}
if ($Sbom) {
    $manifest['evidence'] = [ordered]@{
        sbom = New-EvidenceEntry -Path $Sbom -EvidenceUrl $SbomUrl -MediaType 'application/vnd.cyclonedx+json'
        provenance = New-EvidenceEntry -Path $Provenance -EvidenceUrl $ProvenanceUrl -MediaType 'application/vnd.in-toto+json'
        chromiumPatchInventory = New-EvidenceEntry -Path $ChromiumPatchInventory -EvidenceUrl $ChromiumPatchInventoryUrl -MediaType 'application/vnd.slybrowser.chromium-patch-inventory+json'
        sourceBoundary = [ordered]@{
            sdk = 'open-source'
            chromiumPatches = 'inventory-and-approved-patches'
            proprietaryCore = 'private'
        }
    }
}
$outputPath = [System.IO.Path]::GetFullPath($Output)
$parent = Split-Path -Parent $outputPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $outputPath -Encoding utf8
Write-Output $outputPath
