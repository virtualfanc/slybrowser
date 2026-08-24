param(
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$Artifact,
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [Parameter(Mandatory)][string]$PublicKey,
    [Parameter(Mandatory)][string]$KeyId,
    [Parameter(Mandatory)][string]$RemoteHost,
    [string]$RemoteUser,
    [int]$SshPort = 22,
    [string]$SshIdentityFile,
    [string]$RemoteArtifactRoot = '/srv/slybrowser/releases/artifacts',
    [string]$RemoteManifestRoot = '/srv/slybrowser/releases/manifests',
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

function Assert-RemoteRoot {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Value -notmatch '^/srv/[A-Za-z0-9._/-]+$' -or $Value -match '\.\.' -or $Value.EndsWith('/')) {
        throw "$Name must be an absolute /srv path without spaces, '..', or a trailing slash: $Value"
    }
}

function Assert-RemoteLeaf {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Name
    )
    if ($Value -notmatch '^[A-Za-z0-9._+-]+$') {
        throw "$Name must be a single safe file name: $Value"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Program,
        [Parameter(Mandatory)][string[]]$Arguments,
        [string]$InputText
    )
    if ($PSBoundParameters.ContainsKey('InputText')) {
        $InputText | & $Program @Arguments
    } else {
        & $Program @Arguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw "$Program failed with exit code $LASTEXITCODE"
    }
}

function Invoke-RemoteScript {
    param([Parameter(Mandatory)][string]$Script)
    $arguments = @()
    if ($SshIdentityFile) {
        $arguments += @('-i', (Resolve-Path -LiteralPath $SshIdentityFile).Path)
    }
    if ($SshPort -ne 22) {
        $arguments += @('-p', [string]$SshPort)
    }
    $arguments += @($script:SshTarget, "tr -d '\015' | sh -s")
    Invoke-Checked -Program 'ssh' -Arguments $arguments -InputText ($Script -replace "`r", '')
}

function Copy-ToRemote {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$RemotePath
    )
    $arguments = @()
    if ($SshIdentityFile) {
        $arguments += @('-i', (Resolve-Path -LiteralPath $SshIdentityFile).Path)
    }
    if ($SshPort -ne 22) {
        $arguments += @('-P', [string]$SshPort)
    }
    $arguments += @((Resolve-Path -LiteralPath $Source).Path, "$($script:SshTarget):$RemotePath")
    Invoke-Checked -Program 'scp' -Arguments $arguments
}

function Publish-RemoteImmutable {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$RemoteRoot,
        [Parameter(Mandatory)][string]$Leaf,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [Parameter(Mandatory)][string]$Label
    )
    Assert-RemoteLeaf -Value $Leaf -Name "$Label leaf"
    $remotePath = "$RemoteRoot/$Leaf"
    $uploadId = [System.Guid]::NewGuid().ToString('N')
    $remoteTempPath = "$remotePath.upload.$uploadId.tmp"
    $remoteScript = @"
set -eu
root='$RemoteRoot'
target='$remotePath'
expected='$ExpectedSha256'
mkdir -p -- "`$root"
if [ -e "`$target" ]; then
  actual=`$(sha256sum "`$target" | cut -d ' ' -f 1)
  if [ "`$actual" != "`$expected" ]; then
    echo "$Label already exists with different SHA-256: `$target" >&2
    exit 41
  fi
  echo already-present
else
  echo missing
fi
"@
    $statusOutput = ($remoteScript -replace "`r", '') | & ssh @script:SshBaseArguments $script:SshTarget "tr -d '\015' | sh -s"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect remote $Label"
    }
    $status = ($statusOutput | Select-Object -Last 1).Trim()
    if ($status -eq 'already-present') {
        return [ordered]@{
            path = $remotePath
            sha256 = $ExpectedSha256
            status = 'already-present'
        }
    }
    if ($status -ne 'missing') {
        throw "Unexpected remote $Label status: $status"
    }

    Copy-ToRemote -Source $Source -RemotePath $remoteTempPath
    $publishScript = @"
set -eu
target='$remotePath'
tmp='$remoteTempPath'
expected='$ExpectedSha256'
actual=`$(sha256sum "`$tmp" | cut -d ' ' -f 1)
if [ "`$actual" != "`$expected" ]; then
  rm -f -- "`$tmp"
  echo "$Label upload SHA-256 mismatch: `$actual" >&2
  exit 42
fi
if [ -e "`$target" ]; then
  existing=`$(sha256sum "`$target" | cut -d ' ' -f 1)
  rm -f -- "`$tmp"
  if [ "`$existing" != "`$expected" ]; then
    echo "$Label already exists with different SHA-256: `$target" >&2
    exit 43
  fi
  echo already-present
else
  chmod 0444 "`$tmp"
  mv -- "`$tmp" "`$target"
  echo published
fi
"@
    $publishOutput = ($publishScript -replace "`r", '') | & ssh @script:SshBaseArguments $script:SshTarget "tr -d '\015' | sh -s"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to publish remote $Label"
    }
    $publishStatus = ($publishOutput | Select-Object -Last 1).Trim()
    if ($publishStatus -ne 'published' -and $publishStatus -ne 'already-present') {
        throw "Unexpected remote $Label publish status: $publishStatus"
    }
    return [ordered]@{
        path = $remotePath
        sha256 = $ExpectedSha256
        status = $publishStatus
    }
}

Assert-RemoteRoot -Value $RemoteArtifactRoot -Name 'RemoteArtifactRoot'
Assert-RemoteRoot -Value $RemoteManifestRoot -Name 'RemoteManifestRoot'

$script:SshTarget = if ($RemoteUser) { "$RemoteUser@$RemoteHost" } else { $RemoteHost }
$script:SshBaseArguments = @()
if ($SshIdentityFile) {
    $script:SshBaseArguments += @('-i', (Resolve-Path -LiteralPath $SshIdentityFile).Path)
}
if ($SshPort -ne 22) {
    $script:SshBaseArguments += @('-p', [string]$SshPort)
}

$manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
$artifactPath = (Resolve-Path -LiteralPath $Artifact).Path
$document = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $document.artifacts -or $document.artifacts.Count -ne 1) {
    throw 'Remote publish expects exactly one platform artifact in the signed manifest.'
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
    throw "Artifact URL must use https://$AllowedArtifactHost for self-hosted downloads."
}
if (-not $artifactUri.AbsolutePath.StartsWith($AllowedArtifactPathPrefix, [System.StringComparison]::Ordinal)) {
    throw "Artifact URL path must start with $AllowedArtifactPathPrefix"
}
$artifactFileName = [System.Uri]::UnescapeDataString([System.IO.Path]::GetFileName($artifactUri.AbsolutePath))
Assert-RemoteLeaf -Value $artifactFileName -Name 'Artifact file name'
$manifestFileName = "$($document.browserVersion).json"
Assert-RemoteLeaf -Value $manifestFileName -Name 'Manifest file name'

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

Invoke-Checked -Program 'node' -Arguments $arguments

$artifactSha256 = Get-Sha256Hex -LiteralPath $artifactPath
$manifestSha256 = Get-Sha256Hex -LiteralPath $manifestPath

$artifactResult = Publish-RemoteImmutable `
    -Source $artifactPath `
    -RemoteRoot $RemoteArtifactRoot `
    -Leaf $artifactFileName `
    -ExpectedSha256 $artifactSha256 `
    -Label 'Release artifact'

$manifestResult = Publish-RemoteImmutable `
    -Source $manifestPath `
    -RemoteRoot $RemoteManifestRoot `
    -Leaf $manifestFileName `
    -ExpectedSha256 $manifestSha256 `
    -Label 'Release manifest'

([ordered]@{
    status = 'PUBLISHED'
    server = $script:SshTarget
    artifact = $artifactResult
    manifest = $manifestResult
}) | ConvertTo-Json -Depth 5
