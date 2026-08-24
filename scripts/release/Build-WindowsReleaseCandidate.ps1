[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ChromiumOutDir,
    [Parameter(Mandatory)][string]$TemplateArchive,
    [Parameter(Mandatory)][string]$BrowserVersion,
    [Parameter(Mandatory)][string]$LegalDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$ArtifactName = "slybrowser-$BrowserVersion-win-x64.zip",
    [string]$ArtifactUrl,
    [string]$ManifestOutput,
    [string]$SdkCompatibility = '^0.1.0'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Resolve-ExistingDirectory {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if (-not (Get-Item -LiteralPath $resolved).PSIsContainer) {
        throw "$Label is not a directory: $resolved"
    }
    return $resolved
}

function Resolve-ExistingFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Label)
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
        throw "$Label is not a file: $resolved"
    }
    return $resolved
}

function Assert-ChildPath {
    param([Parameter(Mandatory)][string]$Parent, [Parameter(Mandatory)][string]$Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes expected parent: $childFull"
    }
}

function Get-ShaHex {
    param([Parameter(Mandatory)][ValidateSet('SHA256','MD5')][string]$Algorithm, [Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -Algorithm $Algorithm -LiteralPath $Path).Hash.ToLowerInvariant()
}

if ($ArtifactName -match '[\\/:*?"<>|]' -or -not $ArtifactName.EndsWith('.zip', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'ArtifactName must be a safe ZIP file name.'
}

$outDir = Resolve-ExistingDirectory -Path $ChromiumOutDir -Label 'ChromiumOutDir'
$templateArchivePath = Resolve-ExistingFile -Path $TemplateArchive -Label 'TemplateArchive'
$legalDir = Resolve-ExistingDirectory -Path $LegalDirectory -Label 'LegalDirectory'
$outputDirFull = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outputDirFull -Force | Out-Null
$legalArchiveNames = @(
    'BINARY-LICENSE.txt',
    'LICENSE-SCOPE.txt',
    'THIRD_PARTY_NOTICES.txt',
    'CREDITS.html'
)

$stage = Join-Path $outputDirFull "stage-$BrowserVersion-win-x64"
Assert-ChildPath -Parent $outputDirFull -Child $stage
if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null

$archive = [System.IO.Compression.ZipFile]::OpenRead($templateArchivePath)
try {
    foreach ($entry in $archive.Entries) {
        $entryName = $entry.FullName.Replace('\', '/')
        if ($entryName.EndsWith('/')) { continue }
        if ($entryName -match '(^|/)\.\.(/|$)' -or $entryName.StartsWith('/')) {
            throw "Unsafe template archive entry: $entryName"
        }

        $source = $null
        $versionPrefix = "SlyBrowser/$BrowserVersion/"
        if ($entryName.StartsWith($versionPrefix, [System.StringComparison]::Ordinal)) {
            $relative = $entryName.Substring($versionPrefix.Length)
            if ($relative -eq 'VisualElements/Logo.png') {
                $source = Join-Path $outDir 'Logo.png'
            } elseif ($relative -eq 'VisualElements/SmallLogo.png') {
                $source = Join-Path $outDir 'SmallLogo.png'
            } else {
                $source = Join-Path $outDir ($relative -replace '/', [System.IO.Path]::DirectorySeparatorChar)
            }
        } elseif ($entryName -eq 'SlyBrowser/SlyBrowser.exe') {
            $source = Join-Path $outDir 'SlyBrowser.exe'
        } elseif ($entryName -eq 'SlyBrowser/chromedriver.exe') {
            $source = Join-Path $outDir 'chromedriver.exe'
        } elseif ($entryName -eq 'SlyBrowser/chrome_proxy.exe') {
            $source = Join-Path $outDir 'chrome_proxy.exe'
        } elseif ($entryName -eq 'SlyBrowser/BUILD-INFO.txt') {
            $targetBuildInfo = Join-Path $stage ($entryName -replace '/', [System.IO.Path]::DirectorySeparatorChar)
            Assert-ChildPath -Parent $stage -Child $targetBuildInfo
            New-Item -ItemType Directory -Path (Split-Path -Parent $targetBuildInfo) -Force | Out-Null
            @(
                'SlyBrowser release candidate',
                "version=$BrowserVersion",
                'platform=windows',
                'arch=x64',
                "generatedAt=$([DateTimeOffset]::UtcNow.ToString('o'))",
                'source=local production-like build output'
            ) | Set-Content -LiteralPath $targetBuildInfo -Encoding utf8
            continue
        } elseif ($legalArchiveNames -contains $entryName) {
            continue
        } else {
            throw "Unexpected template archive entry: $entryName"
        }

        if (-not (Test-Path -LiteralPath $source)) {
            if ($relative -match '^\d+(?:\.\d+)+\.manifest$' -and $relative -ne "$BrowserVersion.manifest") {
                Write-Verbose "Skipping historical manifest not present in current output: $relative"
                continue
            }
        }
        $sourcePath = Resolve-ExistingFile -Path $source -Label "source for $entryName"
        Assert-ChildPath -Parent $outDir -Child $sourcePath
        $target = Join-Path $stage ($entryName -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        Assert-ChildPath -Parent $stage -Child $target
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $target -Force
    }
} finally {
    $archive.Dispose()
}

$legalMap = @{
    'BINARY-LICENSE.txt' = 'BINARY-LICENSE.txt'
    'LICENSE-SCOPE.txt' = 'LICENSE-SCOPE.txt'
    'THIRD_PARTY_NOTICES.txt' = 'THIRD_PARTY_NOTICES.txt'
    'credits.html' = 'CREDITS.html'
}
foreach ($sourceName in $legalMap.Keys) {
    $source = Resolve-ExistingFile -Path (Join-Path $legalDir $sourceName) -Label $sourceName
    $target = Join-Path $stage $legalMap[$sourceName]
    Assert-ChildPath -Parent $stage -Child $target
    Copy-Item -LiteralPath $source -Destination $target -Force
}

$artifact = Join-Path $outputDirFull $ArtifactName
Assert-ChildPath -Parent $outputDirFull -Child $artifact
if (Test-Path -LiteralPath $artifact) {
    Remove-Item -LiteralPath $artifact -Force
}
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $artifact, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$md5Path = "$artifact.md5"
$md5 = Get-ShaHex -Algorithm MD5 -Path $artifact
"$md5  $ArtifactName" | Set-Content -LiteralPath $md5Path -Encoding ascii

$artifactItem = Get-Item -LiteralPath $artifact
$createdArchive = [System.IO.Compression.ZipFile]::OpenRead($artifact)
try {
    $entryCount = $createdArchive.Entries.Count
} finally {
    $createdArchive.Dispose()
}

$manifestPath = $null
if ($ManifestOutput) {
    if (-not $ArtifactUrl) {
        throw 'ArtifactUrl is required when ManifestOutput is set.'
    }
    $manifestPath = [System.IO.Path]::GetFullPath($ManifestOutput)
    $manifestParent = Split-Path -Parent $manifestPath
    if ($manifestParent) {
        New-Item -ItemType Directory -Path $manifestParent -Force | Out-Null
    }
    & (Join-Path $PSScriptRoot 'New-UnsignedManifest.ps1') `
        -Artifact $artifact `
        -Platform windows `
        -Arch x64 `
        -Url $ArtifactUrl `
        -BrowserVersion $BrowserVersion `
        -SdkCompatibility $SdkCompatibility `
        -BrowserExecutable (Join-Path $outDir 'SlyBrowser.exe') `
        -DriverExecutable (Join-Path $outDir 'chromedriver.exe') `
        -PrivateModule (Join-Path $outDir 'chrome.dll') `
        -PrivateModulePath "SlyBrowser/$BrowserVersion/chrome.dll" `
        -PrivateModuleAbi windows-x64 `
        -Resource @((Join-Path $outDir 'resources.pak'), (Join-Path $outDir 'icudtl.dat')) `
        -ResourcePath @("SlyBrowser/$BrowserVersion/resources.pak", "SlyBrowser/$BrowserVersion/icudtl.dat") `
        -BinaryLicense (Join-Path $legalDir 'BINARY-LICENSE.txt') `
        -LicenseScope (Join-Path $legalDir 'LICENSE-SCOPE.txt') `
        -ThirdPartyNotices (Join-Path $legalDir 'THIRD_PARTY_NOTICES.txt') `
        -CreditsHtml (Join-Path $legalDir 'credits.html') `
        -BrowserPath 'SlyBrowser/SlyBrowser.exe' `
        -DriverPath 'SlyBrowser/chromedriver.exe' `
        -Output $manifestPath | Out-Null
}

[ordered]@{
    artifact = $artifact
    md5File = $md5Path
    unsignedManifest = $manifestPath
    size = $artifactItem.Length
    sha256 = Get-ShaHex -Algorithm SHA256 -Path $artifact
    md5 = $md5
    entryCount = $entryCount
} | ConvertTo-Json -Depth 4
