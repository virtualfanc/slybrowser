[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseSet,
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [Parameter(Mandatory)][string]$ExpectedSdkSetId,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedSourceTree,
    [int]$TimeoutSeconds = 1800
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
& node (Join-Path $PSScriptRoot 'Verify-SdkReleaseSet.mjs') --release-set $ReleaseSet --artifact-root $ArtifactRoot --flat-artifacts --expected-sdk-set-id $ExpectedSdkSetId --expected-source-tree $ExpectedSourceTree | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'SDK release set verification failed.' }

foreach ($name in @('MAVEN_CENTRAL_USERNAME', 'MAVEN_CENTRAL_TOKEN', 'MAVEN_GPG_PASSPHRASE', 'MAVEN_GPG_FINGERPRINT')) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is required." }
}
$fingerprint = $env:MAVEN_GPG_FINGERPRINT.Trim().ToUpperInvariant()
if ($fingerprint -notmatch '^[0-9A-F]{40}$') { throw 'MAVEN_GPG_FINGERPRINT must be a full 40-character fingerprint.' }
& gpg --batch --with-colons --list-secret-keys --fingerprint $fingerprint | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The configured Maven signing key was not found.' }

$document = Get-Content -LiteralPath $ReleaseSet -Raw | ConvertFrom-Json
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) "slybrowser-central-$([Guid]::NewGuid().ToString('N'))"
$coordinateRoot = Join-Path $stageRoot "com\slybrowser\slybrowser\$($document.version)"
$bundle = "$stageRoot.zip"
try {
    New-Item -ItemType Directory -Path $coordinateRoot -Force | Out-Null
    $javaArtifacts = @($document.artifacts | Where-Object { $_.name -like 'java/*' })
    if ($javaArtifacts.Count -ne 4) { throw 'Release set must contain exactly four Maven artifacts.' }
    foreach ($artifact in $javaArtifacts) {
        $name = [IO.Path]::GetFileName($artifact.name)
        $destination = Join-Path $coordinateRoot $name
        Copy-Item -LiteralPath (Join-Path (Resolve-Path $ArtifactRoot).Path $name) -Destination $destination
        & gpg --batch --yes --pinentry-mode loopback --passphrase $env:MAVEN_GPG_PASSPHRASE --local-user $fingerprint --armor --detach-sign --output "$destination.asc" $destination
        if ($LASTEXITCODE -ne 0) { throw "GPG signing failed for $name" }
        foreach ($path in @($destination, "$destination.asc")) {
            foreach ($algorithm in @('MD5', 'SHA1', 'SHA256', 'SHA512')) {
                (Get-FileHash -LiteralPath $path -Algorithm $algorithm).Hash.ToLowerInvariant() | Set-Content -LiteralPath "$path.$($algorithm.ToLowerInvariant())" -NoNewline
            }
        }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stageRoot, $bundle, [IO.Compression.CompressionLevel]::Optimal, $false)
    $pair = "$($env:MAVEN_CENTRAL_USERNAME):$($env:MAVEN_CENTRAL_TOKEN)"
    $authorization = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
    $headers = @{ Authorization = "Bearer $authorization" }
    $uploadUrl = "https://central.sonatype.com/api/v1/publisher/upload?name=SlyBrowser-$($document.version)&publishingType=AUTOMATIC"
    $deploymentId = (Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -Form @{ bundle = Get-Item $bundle }).Trim()
    if ($deploymentId -notmatch '^[0-9a-f-]{36}$') { throw 'Maven Central returned an invalid deployment ID.' }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $state = Invoke-RestMethod -Method Post -Uri "https://central.sonatype.com/api/v1/publisher/status?id=$deploymentId" -Headers $headers
        if ($state.deploymentState -eq 'FAILED') { throw "Maven Central deployment failed: $($state.errors | ConvertTo-Json -Compress)" }
        if ($state.deploymentState -eq 'PUBLISHED') { break }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Maven Central publication timed out before PUBLISHED.' }
        Start-Sleep -Seconds 10
    } while ($true)
    & node (Join-Path $PSScriptRoot 'Verify-PublishedSdkArtifacts.mjs') --target java --release-set $ReleaseSet --artifact-root $ArtifactRoot --timeout-seconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) { throw 'Maven Central readback verification failed.' }
    [ordered]@{ status = 'PUBLISHED'; sdkSetId = $document.sdkSetId; target = 'java'; deploymentId = $deploymentId } | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue
}
