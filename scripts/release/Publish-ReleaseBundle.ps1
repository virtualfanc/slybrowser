param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$Artifact,
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [Parameter(Mandatory)][string]$PublicKey,
    [Parameter(Mandatory)][string]$KeyId,
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [Parameter(Mandatory)][string]$ManifestRoot,
    [string[]]$PrivateModule = @(),
    [string[]]$Resource = @(),
    [string]$ResourceList,
    [string]$Sbom,
    [string]$Provenance,
    [string]$ChromiumPatchInventory,
    [string]$AllowedArtifactHost = 'api.slybrowser.com',
    [string]$AllowedArtifactPathPrefix = '/v1/releases/artifacts/'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($ResourceList) {
    $Resource += @($ResourceList -split ';' | Where-Object { $_ })
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Resolve-ChildFile {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Leaf
    )
    if ([System.IO.Path]::IsPathRooted($Leaf) -or $Leaf -match '[\\/]') {
        throw "Published file name must be a single relative file name: $Leaf"
    }
    $rootPath = [System.IO.Path]::GetFullPath($Root)
    $targetPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($rootPath, $Leaf))
    $prefix = $rootPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $targetPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Publish target escapes root: $targetPath"
    }
    return $targetPath
}

function Copy-ImmutableFile {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$Label
    )
    $sourcePath = (Resolve-Path -LiteralPath $Source).Path
    $destinationDirectory = Split-Path -Parent $Destination
    if ($destinationDirectory) {
        New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    }
    $sourceHash = Get-Sha256Hex -LiteralPath $sourcePath
    if (Test-Path -LiteralPath $Destination) {
        $destinationHash = Get-Sha256Hex -LiteralPath $Destination
        if ($destinationHash -ne $sourceHash) {
            throw "$Label already exists with different SHA-256: $Destination"
        }
        return [ordered]@{
            path = $Destination
            sha256 = $sourceHash
            status = 'already-present'
        }
    }
    Copy-Item -LiteralPath $sourcePath -Destination $Destination
    $item = Get-Item -LiteralPath $Destination
    $item.IsReadOnly = $true
    return [ordered]@{
        path = $Destination
        sha256 = $sourceHash
        status = 'published'
    }
}

$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$artifactPath = (Resolve-Path -LiteralPath $Artifact).Path
$document = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $document.artifacts -or $document.artifacts.Count -ne 1) {
    throw 'Publish expects exactly one platform artifact in the signed manifest.'
}
if ($document.status -ne 'available') {
    throw 'Only an available signed release manifest can be published.'
}
if ($document.browserVersion -notmatch '^\d+(\.\d+){0,7}$') {
    throw "Manifest browserVersion is not a safe release file name: $($document.browserVersion)"
}

$artifactEntry = @($document.artifacts)[0]
$artifactUri = [System.Uri]$artifactEntry.url
if ($artifactUri.Scheme -ne 'https' -or $artifactUri.Host -ne $AllowedArtifactHost) {
    throw "Artifact URL must use https://$AllowedArtifactHost for first-launch self-hosted downloads."
}
if (-not $artifactUri.AbsolutePath.StartsWith($AllowedArtifactPathPrefix, [System.StringComparison]::Ordinal)) {
    throw "Artifact URL path must start with $AllowedArtifactPathPrefix"
}
$artifactFileName = [System.Uri]::UnescapeDataString([System.IO.Path]::GetFileName($artifactUri.AbsolutePath))
if (-not $artifactFileName) {
    throw 'Artifact URL must end in a file name.'
}
$manifestFileName = "$($document.browserVersion)-$($artifactEntry.platform)-$($artifactEntry.arch).json"
$publishedArtifact = Resolve-ChildFile -Root $ArtifactRoot -Leaf $artifactFileName
$publishedManifest = Resolve-ChildFile -Root $ManifestRoot -Leaf $manifestFileName

$verifyScript = Join-Path $PSScriptRoot 'Verify-ReleaseBundle.mjs'
$arguments = @(
    $verifyScript,
    '--manifest', $manifestPath,
    '--public-key', (Resolve-Path -LiteralPath $PublicKey).Path,
    '--key-id', $KeyId,
    '--artifact', $artifactPath,
    '--browser', (Resolve-Path -LiteralPath $BrowserExecutable).Path,
    '--driver', (Resolve-Path -LiteralPath $DriverExecutable).Path
)
foreach ($path in $PrivateModule) {
    $arguments += @('--private-module', (Resolve-Path -LiteralPath $path).Path)
}
foreach ($path in $Resource) {
    $arguments += @('--resource', (Resolve-Path -LiteralPath $path).Path)
}
$hasEvidence = $document.PSObject.Properties.Name -contains 'evidence'
if ($hasEvidence) {
    if (-not $Sbom -or -not $Provenance -or -not $ChromiumPatchInventory) {
        throw 'Manifest declares supply-chain evidence; provide -Sbom, -Provenance and -ChromiumPatchInventory.'
    }
    $arguments += @(
        '--sbom', (Resolve-Path -LiteralPath $Sbom).Path,
        '--provenance', (Resolve-Path -LiteralPath $Provenance).Path,
        '--patch-inventory', (Resolve-Path -LiteralPath $ChromiumPatchInventory).Path
    )
}

& node @arguments | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Release bundle verification failed.'
}

$artifactResult = Copy-ImmutableFile -Source $artifactPath -Destination $publishedArtifact -Label 'Release artifact'
$manifestResult = Copy-ImmutableFile -Source $manifestPath -Destination $publishedManifest -Label 'Release manifest'

([ordered]@{
    status = 'PUBLISHED'
    artifact = $artifactResult
    manifest = $manifestResult
}) | ConvertTo-Json -Depth 5
