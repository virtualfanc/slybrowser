[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseSet,
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [Parameter(Mandatory)][string]$ExpectedSdkSetId,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceTree,
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$document = Get-Content -LiteralPath $ReleaseSet -Raw | ConvertFrom-Json
& node (Join-Path $PSScriptRoot 'Verify-SdkReleaseSet.mjs') --release-set $ReleaseSet --artifact-root $ArtifactRoot --flat-artifacts --expected-sdk-set-id $ExpectedSdkSetId --expected-source-tree $ExpectedSourceTree | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'SDK release set verification failed.' }

function Get-Payload([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $payload = @()
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in @($archive.Entries | Sort-Object FullName)) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.EndsWith('/') -or $name -eq '.signature.p7s') { continue }
            if (-not $seen.Add($name)) { throw "Duplicate NuGet entry: $name" }
            $stream = $entry.Open()
            try { $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($stream) }
            finally { $stream.Dispose() }
            $payload += [ordered]@{ name = $name; size = $entry.Length; sha256 = [Convert]::ToHexString($digest).ToLowerInvariant() }
        }
        return $payload
    } finally { $archive.Dispose() }
}

$artifact = @($document.artifacts | Where-Object { $_.name -like 'dotnet/*' })
if ($artifact.Count -ne 1) { throw 'Release set must contain exactly one NuGet artifact.' }
$localPath = Join-Path (Resolve-Path $ArtifactRoot).Path ([IO.Path]::GetFileName($artifact[0].name))
$url = "https://api.nuget.org/v3-flatcontainer/slybrowser/$($document.version)/slybrowser.$($document.version).nupkg"
$download = [IO.Path]::GetTempFileName()
try {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try { Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing | Out-Null; break }
        catch {
            if ([DateTimeOffset]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Seconds 10
        }
    } while ($true)
    & dotnet nuget verify $download --all
    if ($LASTEXITCODE -ne 0) { throw 'NuGet repository signature verification failed.' }
    $localPayload = Get-Payload $localPath | ConvertTo-Json -Compress -Depth 5
    $remotePayload = Get-Payload $download | ConvertTo-Json -Compress -Depth 5
    if ($localPayload -cne $remotePayload) { throw 'NuGet registry payload differs from the frozen upload.' }
    [ordered]@{
        status = 'VERIFIED'
        sdkSetId = $document.sdkSetId
        target = 'dotnet'
        url = $url
        uploadedSha256 = $artifact[0].sha256
        downloadedSha256 = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
        repositorySignature = 'verified'
    } | ConvertTo-Json -Depth 5
} finally {
    Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
}
