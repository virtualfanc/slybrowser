[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Artifact,
    [Parameter(Mandatory)][ValidateSet('windows', 'linux', 'macos')][string]$Platform,
    [Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$Arch,
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$BrowserVersion,
    [Parameter(Mandatory)][string]$SdkCompatibility,
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [Parameter(Mandatory)][string]$Sbom,
    [Parameter(Mandatory)][string]$SbomUrl,
    [Parameter(Mandatory)][string]$Provenance,
    [Parameter(Mandatory)][string]$ProvenanceUrl,
    [Parameter(Mandatory)][string]$ChromiumPatchInventory,
    [Parameter(Mandatory)][string]$ChromiumPatchInventoryUrl,
    [string]$BrowserPath = 'SlyBrowser.exe',
    [string]$DriverPath = 'chromedriver.exe',
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
foreach ($evidenceUrl in @($SbomUrl, $ProvenanceUrl, $ChromiumPatchInventoryUrl)) {
    if (-not $evidenceUrl.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {
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
$browserHash = Get-Sha256Hex -LiteralPath $browserBinary
$driverHash = Get-Sha256Hex -LiteralPath $driverBinary
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
$manifest = [ordered]@{
    schemaVersion = 1
    browserVersion = $BrowserVersion
    sdkCompatibility = $SdkCompatibility
    publishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    artifacts = @([ordered]@{
        platform = $Platform
        arch = $Arch
        url = $Url
        sha256 = $hash
        size = $file.Length
        archiveFormat = 'zip'
        browserExecutable = $BrowserPath.Replace('\', '/')
        driverExecutable = $DriverPath.Replace('\', '/')
        browserSha256 = $browserHash
        driverSha256 = $driverHash
    })
    evidence = [ordered]@{
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
