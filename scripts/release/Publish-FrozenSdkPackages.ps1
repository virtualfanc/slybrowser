[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ReleaseSet,
    [Parameter(Mandatory)][string]$ArtifactRoot,
    [ValidateSet('all', 'node', 'python', 'java', 'dotnet')][string[]]$Package = @('all'),
    [switch]$DryRun,
    [switch]$CredentialPreflight,
    [switch]$Publish,
    [string]$ReceiptDirectory,
    [int]$RegistryTimeoutSeconds = 900,
    [Parameter(DontShow)][string]$TestRegistryConfig
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }

if (@($DryRun, $CredentialPreflight, $Publish).Where({ $_ }).Count -ne 1) {
    throw 'Specify exactly one of -DryRun, -CredentialPreflight, or -Publish.'
}
if ($Publish -and -not $ReceiptDirectory) {
    throw '-ReceiptDirectory is required for publication receipts.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$releaseSetPath = (Resolve-Path -LiteralPath $ReleaseSet).Path
$artifactRootPath = (Resolve-Path -LiteralPath $ArtifactRoot).Path
$document = Get-Content -LiteralPath $releaseSetPath -Raw | ConvertFrom-Json
$targets = if ($Package -contains 'all') { @('node', 'python', 'java', 'dotnet') } else { @($Package | Select-Object -Unique) }
$registries = [ordered]@{
    npm = 'https://registry.npmjs.org'
    pypiMetadata = 'https://pypi.org/pypi'
    central = 'https://central.sonatype.com/api/v1/publisher'
    maven = 'https://repo1.maven.org/maven2'
    nugetSource = 'https://api.nuget.org/v3/index.json'
    nugetFlat = 'https://api.nuget.org/v3-flatcontainer'
}
$testCommandRoot = $null
if ($TestRegistryConfig) {
    if ($env:SLY_SDK_PUBLISH_TEST_MODE -ne '1') { throw 'Test registry configuration requires SLY_SDK_PUBLISH_TEST_MODE=1.' }
    $overrides = Get-Content -LiteralPath (Resolve-Path -LiteralPath $TestRegistryConfig) -Raw | ConvertFrom-Json
    foreach ($name in @('npm', 'pypiMetadata', 'central', 'maven', 'nugetSource', 'nugetFlat')) {
        $uri = [Uri]$overrides.$name
        if (-not $uri.IsLoopback -or $uri.Scheme -ne 'http') { throw "Test registry $name must be an HTTP loopback URL." }
        $registries[$name] = $uri.AbsoluteUri.TrimEnd('/')
    }
    $resolvedTestConfig = (Resolve-Path -LiteralPath $TestRegistryConfig).Path
    $testConfigRoot = (Split-Path -Parent $resolvedTestConfig).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $testCommandRoot = (Resolve-Path -LiteralPath $overrides.commandRoot).Path.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $testCommandRoot.StartsWith($testConfigRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test command root must be isolated under the test registry configuration directory.' }
}
$publicationMode = if ($TestRegistryConfig) { 'test' } else { 'production' }
$publicationStatus = if ($TestRegistryConfig) { 'SIMULATED' } else { 'PUBLISHED' }

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter()][string[]]$Arguments = @(), [string]$WorkingDirectory = $repoRoot)
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $FilePath" }
    } finally {
        Pop-Location
    }
}

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "$Name is required." }
    $path = if ($command.Source) { $command.Source } else { $command.Path }
    if ($TestRegistryConfig -and $Name -in @('npm', 'python', 'gpg', 'dotnet') -and -not $path.StartsWith($testCommandRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Test mode requires the $Name command shim under its isolated command root."
    }
    return $path
}

function Require-Environment([string]$Name) {
    if (-not [Environment]::GetEnvironmentVariable($Name)) { throw "$Name is required." }
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Artifact([string]$Name) {
    $entry = @($document.artifacts | Where-Object { $_.name -eq $Name })
    if ($entry.Count -ne 1) { throw "Release set does not contain exactly one $Name" }
    return [ordered]@{ entry = $entry[0]; path = Join-Path $artifactRootPath ($Name -replace '/', [IO.Path]::DirectorySeparatorChar) }
}

function Get-ZipPayload([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entries = @()
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($entry in @($archive.Entries | Sort-Object FullName)) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.EndsWith('/') -or $name -eq '.signature.p7s') { continue }
            if (-not $seen.Add($name)) { throw "Duplicate ZIP entry: $name" }
            $stream = $entry.Open()
            try {
                $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($stream)
            } finally {
                $stream.Dispose()
            }
            $entries += [ordered]@{ name = $name; size = $entry.Length; sha256 = [Convert]::ToHexString($digest).ToLowerInvariant() }
        }
        return $entries
    } finally {
        $archive.Dispose()
    }
}

function Test-ZipEntry([string]$Path, [string]$Name) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try { return $null -ne $archive.GetEntry($Name) } finally { $archive.Dispose() }
}

function Assert-DownloadedArtifact([string]$Url, [string]$ExpectedSha256, [string]$Label) {
    $temporary = [IO.Path]::GetTempFileName()
    try {
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds($RegistryTimeoutSeconds)
        do {
            try {
                Invoke-WebRequest -Uri $Url -OutFile $temporary -UseBasicParsing | Out-Null
            } catch {
                if ([DateTimeOffset]::UtcNow -ge $deadline) { throw }
                Write-Output "$Label is not yet available; retrying"
                Start-Sleep -Seconds 10
                continue
            }
            $actual = Get-Sha256 $temporary
            if ($actual -ne $ExpectedSha256) { throw "$Label registry SHA-256 mismatch: $actual" }
            return [ordered]@{ url = $Url; sha256 = $actual; verifiedAt = [DateTimeOffset]::UtcNow.ToString('o') }
        } while ($true)
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Get-NpmTarballUrl([string]$Npm, [string]$Version) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($RegistryTimeoutSeconds)
    do {
        $value = (& $Npm @('view', "slybrowser@$Version", 'dist.tarball', '--registry', $registries.npm) 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $value) { return $value }
        if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'npm package metadata did not become available before the registry timeout.' }
        Write-Output 'npm package metadata is not yet available; retrying'
        Start-Sleep -Seconds 1
    } while ($true)
}

function Get-PypiMetadata([string]$Url) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($RegistryTimeoutSeconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Url
        } catch {
            if ([DateTimeOffset]::UtcNow -ge $deadline) { throw }
            Write-Output 'PyPI package metadata is not yet available; retrying'
            Start-Sleep -Seconds 1
        }
    } while ($true)
}

function Assert-NuGetArtifact([string]$Url, [object]$Artifact, [string]$Dotnet) {
    $temporary = [IO.Path]::GetTempFileName()
    try {
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds($RegistryTimeoutSeconds)
        do {
            try {
                Invoke-WebRequest -Uri $Url -OutFile $temporary -UseBasicParsing | Out-Null
                break
            } catch {
                if ([DateTimeOffset]::UtcNow -ge $deadline) { throw }
                Write-Output 'NuGet package is not yet available; retrying'
                Start-Sleep -Seconds 10
            }
        } while ($true)
        if (-not (Test-ZipEntry $temporary '.signature.p7s')) { throw 'NuGet package is missing its repository signature.' }
        Invoke-Checked $Dotnet @('nuget', 'verify', $temporary, '--all')
        $uploadedPayload = Get-ZipPayload $Artifact.path
        $downloadedPayload = Get-ZipPayload $temporary
        $uploadedJson = $uploadedPayload | ConvertTo-Json -Compress -Depth 5
        $downloadedJson = $downloadedPayload | ConvertTo-Json -Compress -Depth 5
        if ($uploadedJson -cne $downloadedJson) { throw 'NuGet signed package payload differs from the frozen upload.' }
        $payloadDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($uploadedJson))).ToLowerInvariant()
        return [ordered]@{
            url = $Url
            uploadedSha256 = $Artifact.entry.sha256
            downloadedSha256 = Get-Sha256 $temporary
            payloadSha256 = $payloadDigest
            repositorySignature = 'verified'
            verifiedAt = [DateTimeOffset]::UtcNow.ToString('o')
        }
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-GpgSignature([string]$Gpg, [string]$Fingerprint, [string]$InputPath, [string]$OutputPath) {
    Invoke-Checked $Gpg @('--batch', '--yes', '--local-user', $Fingerprint, '--armor', '--detach-sign', '--output', $OutputPath, $InputPath)
}

function Test-Credentials([string]$Target) {
    switch ($Target) {
        'node' {
            $npm = Require-Command 'npm'
            Invoke-Checked $npm @('whoami', '--registry', $registries.npm)
        }
        'python' {
            $python = Require-Command 'python'
            Require-Environment 'TWINE_USERNAME'
            Require-Environment 'TWINE_PASSWORD'
            Invoke-Checked $python @('-m', 'twine', '--version')
        }
        'java' {
            $gpg = Require-Command 'gpg'
            Require-Environment 'CENTRAL_TOKEN_USERNAME'
            Require-Environment 'CENTRAL_TOKEN_PASSWORD'
            Require-Environment 'SLY_MAVEN_GPG_FINGERPRINT'
            $fingerprint = [Environment]::GetEnvironmentVariable('SLY_MAVEN_GPG_FINGERPRINT').Trim().ToUpperInvariant()
            if ($fingerprint -notmatch '^[0-9A-F]{40}$') { throw 'SLY_MAVEN_GPG_FINGERPRINT must be a full 40-character fingerprint.' }
            $secretKeys = & $gpg --batch --with-colons --list-secret-keys --fingerprint $fingerprint 2>$null
            if ($LASTEXITCODE -ne 0 -or -not ($secretKeys -match "^fpr:::::::::${fingerprint}:")) { throw 'The configured GPG secret key was not found.' }
            $probe = [IO.Path]::GetTempFileName()
            $signature = "$probe.asc"
            try {
                [IO.File]::WriteAllText($probe, 'SlyBrowser Maven signing preflight')
                Invoke-GpgSignature $gpg $fingerprint $probe $signature
                Invoke-Checked $gpg @('--batch', '--verify', $signature, $probe)
            } finally {
                Remove-Item -LiteralPath $probe, $signature -Force -ErrorAction SilentlyContinue
            }
        }
        'dotnet' {
            Require-Command 'dotnet' | Out-Null
            Require-Environment 'NUGET_API_KEY'
        }
    }
}

function Write-Receipt([string]$Target, [object]$Receipt) {
    $path = Join-Path $ReceiptDirectory "$Target.json"
    $Receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path
}

$node = Require-Command 'node'
$verification = & $node (Join-Path $PSScriptRoot 'Verify-SdkReleaseSet.mjs') --release-set $releaseSetPath --artifact-root $artifactRootPath | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $verification.status -ne 'VERIFIED') { throw 'SDK release set verification failed.' }

if ($DryRun) {
    $verification | ConvertTo-Json -Depth 10
    exit 0
}

foreach ($target in $targets) { Test-Credentials $target }
if ($CredentialPreflight) {
    [ordered]@{ status = 'READY'; mode = $publicationMode; sdkSetId = $document.sdkSetId; targets = $targets } | ConvertTo-Json -Depth 5
    exit 0
}

New-Item -ItemType Directory -Path $ReceiptDirectory -Force | Out-Null
foreach ($target in $targets) {
    $before = & $node (Join-Path $PSScriptRoot 'Verify-SdkReleaseSet.mjs') --release-set $releaseSetPath --artifact-root $artifactRootPath | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $before.sdkSetId -ne $document.sdkSetId) { throw "SDK release set changed before $target publication." }
    $publishedAt = [DateTimeOffset]::UtcNow.ToString('o')

    switch ($target) {
        'node' {
            $artifact = Get-Artifact "node/slybrowser-$($document.version).tgz"
            $npm = Require-Command 'npm'
            Invoke-Checked $npm @('publish', $artifact.path, '--access', 'public', '--registry', $registries.npm)
            $tarballUrl = Get-NpmTarballUrl $npm $document.version
            $tarballUri = if ($tarballUrl) { [Uri]$tarballUrl } else { $null }
            $validTarball = $LASTEXITCODE -eq 0 -and $null -ne $tarballUri -and (
                ($TestRegistryConfig -and $tarballUri.IsLoopback -and $tarballUri.Scheme -eq 'http') -or
                (-not $TestRegistryConfig -and $tarballUrl.StartsWith('https://registry.npmjs.org/'))
            )
            if (-not $validTarball) { throw 'npm registry returned an invalid tarball URL.' }
            $remote = Assert-DownloadedArtifact $tarballUrl $artifact.entry.sha256 'npm package'
            Write-Receipt $target ([ordered]@{ status = $publicationStatus; mode = $publicationMode; sdkSetId = $document.sdkSetId; target = $target; publishedAt = $publishedAt; artifacts = @($remote) })
        }
        'python' {
            $wheel = Get-Artifact "python/slybrowser-$($document.version)-py3-none-any.whl"
            $sdist = Get-Artifact "python/slybrowser-$($document.version).tar.gz"
            $python = Require-Command 'python'
            Invoke-Checked $python @('-m', 'twine', 'upload', '--repository-url', 'https://upload.pypi.org/legacy/', $wheel.path, $sdist.path)
            $metadataUrl = "$($registries.pypiMetadata)/slybrowser/$($document.version)/json"
            $metadata = Get-PypiMetadata $metadataUrl
            $remote = @()
            foreach ($artifact in @($wheel, $sdist)) {
                $file = @($metadata.urls | Where-Object { $_.filename -eq [IO.Path]::GetFileName($artifact.path) })
                if ($file.Count -ne 1 -or $file[0].digests.sha256 -ne $artifact.entry.sha256) { throw "PyPI registry identity mismatch for $($artifact.entry.name)" }
                $remote += Assert-DownloadedArtifact $file[0].url $artifact.entry.sha256 "PyPI $($artifact.entry.name)"
            }
            Write-Receipt $target ([ordered]@{ status = $publicationStatus; mode = $publicationMode; sdkSetId = $document.sdkSetId; target = $target; publishedAt = $publishedAt; artifacts = $remote })
        }
        'java' {
            $gpg = Require-Command 'gpg'
            $stageRoot = Join-Path ([IO.Path]::GetTempPath()) "slybrowser-central-$([Guid]::NewGuid().ToString('N'))"
            $coordinateRoot = Join-Path $stageRoot "com\slybrowser\slybrowser\$($document.version)"
            $bundle = "$stageRoot.zip"
            try {
                New-Item -ItemType Directory -Path $coordinateRoot -Force | Out-Null
                $names = @(
                    "slybrowser-$($document.version).jar",
                    "slybrowser-$($document.version)-sources.jar",
                    "slybrowser-$($document.version)-javadoc.jar",
                    "slybrowser-$($document.version).pom"
                )
                foreach ($name in $names) {
                    $artifact = Get-Artifact "java/$name"
                    $destination = Join-Path $coordinateRoot $name
                    Copy-Item -LiteralPath $artifact.path -Destination $destination
                    Invoke-GpgSignature $gpg ([Environment]::GetEnvironmentVariable('SLY_MAVEN_GPG_FINGERPRINT')) $destination "$destination.asc"
                    foreach ($algorithm in @('MD5', 'SHA1')) {
                        $extension = $algorithm.ToLowerInvariant()
                        (Get-FileHash -LiteralPath $destination -Algorithm $algorithm).Hash.ToLowerInvariant() | Set-Content -LiteralPath "$destination.$extension" -NoNewline
                    }
                }
                Compress-Archive -Path (Join-Path $stageRoot 'com') -DestinationPath $bundle -CompressionLevel Optimal
                $pair = "$([Environment]::GetEnvironmentVariable('CENTRAL_TOKEN_USERNAME'))`:$([Environment]::GetEnvironmentVariable('CENTRAL_TOKEN_PASSWORD'))"
                $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
                $headers = @{ Authorization = "Bearer $token" }
                $uploadUrl = "$($registries.central)/upload?name=SlyBrowser-$($document.version)&publishingType=AUTOMATIC"
                $deploymentId = (Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -Form @{ bundle = Get-Item $bundle }).Trim()
                if ($deploymentId -notmatch '^[0-9a-f-]{36}$') { throw 'Central returned an invalid deployment ID.' }
                $deadline = [DateTimeOffset]::UtcNow.AddSeconds($RegistryTimeoutSeconds)
                do {
                    $state = Invoke-RestMethod -Method Post -Uri "$($registries.central)/status?id=$deploymentId" -Headers $headers
                    if ($state.deploymentState -eq 'FAILED') { throw "Central deployment failed: $($state.errors | ConvertTo-Json -Compress)" }
                    if ($state.deploymentState -eq 'PUBLISHED') { break }
                    if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Central publication timed out.' }
                    Write-Output "Central deployment state: $($state.deploymentState)"
                    Start-Sleep -Seconds 10
                } while ($true)
                $remote = @()
                foreach ($name in $names) {
                    $artifact = Get-Artifact "java/$name"
                    $url = "$($registries.maven)/com/slybrowser/slybrowser/$($document.version)/$name"
                    $remote += Assert-DownloadedArtifact $url $artifact.entry.sha256 "Maven Central $name"
                }
                Write-Receipt $target ([ordered]@{ status = $publicationStatus; mode = $publicationMode; sdkSetId = $document.sdkSetId; target = $target; publishedAt = $publishedAt; deploymentId = $deploymentId; artifacts = $remote })
            } finally {
                Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue
            }
        }
        'dotnet' {
            $artifact = Get-Artifact "dotnet/SlyBrowser.$($document.version).nupkg"
            $dotnet = Require-Command 'dotnet'
            Invoke-Checked $dotnet @('nuget', 'push', $artifact.path, '--api-key', $env:NUGET_API_KEY, '--source', $registries.nugetSource)
            $url = "$($registries.nugetFlat)/slybrowser/$($document.version)/slybrowser.$($document.version).nupkg"
            $remote = Assert-NuGetArtifact $url $artifact $dotnet
            Write-Receipt $target ([ordered]@{ status = $publicationStatus; mode = $publicationMode; sdkSetId = $document.sdkSetId; target = $target; publishedAt = $publishedAt; artifacts = @($remote) })
        }
    }
}

[ordered]@{ status = $publicationStatus; mode = $publicationMode; sdkSetId = $document.sdkSetId; targets = $targets; receiptDirectory = (Resolve-Path $ReceiptDirectory).Path } | ConvertTo-Json -Compress -Depth 5
