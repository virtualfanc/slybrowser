[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ChromiumSrc,
    [string]$OutDir = 'out/release_x64',
    [string]$GnTarget = '//chrome:chrome',
    [string]$OutputDirectory,
    [string]$BinaryLicense,
    [string]$LicenseScope,
    [string[]]$ScanExcludeDir = @(
        'third_party/catapult',
        'third_party/cookie_editor',
        'third_party/crashpad/crashpad/third_party/zlib',
        'third_party/dawn/third_party/gn',
        'third_party/devtools-frontend/src/front_end/third_party/chromium',
        'third_party/perfetto/protos/third_party/chromium',
        'third_party/perfetto/protos/third_party/pprof',
        'third_party/rust',
        'third_party/swiftshader/third_party/marl'
    )
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $ChromiumSrc).Path
$licenseScript = Join-Path $sourceRoot 'tools\licenses\licenses.py'
if (-not (Test-Path -LiteralPath $licenseScript)) {
    throw "Chromium license scanner was not found: $licenseScript"
}
$outRoot = if ([System.IO.Path]::IsPathRooted($OutDir)) {
    [System.IO.Path]::GetFullPath($OutDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $OutDir))
}
$sourcePrefix = $sourceRoot.TrimEnd('\') + '\'
if (-not $outRoot.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutDir must resolve inside the Chromium source checkout.'
}
if (-not (Test-Path -LiteralPath (Join-Path $outRoot 'build.ninja'))) {
    throw "Chromium output directory has not been generated: $outRoot"
}
if ($GnTarget -notmatch '^//[A-Za-z0-9_./-]+(?::[A-Za-z0-9_.-]+)?$') {
    throw 'GnTarget is invalid.'
}
$relativeOut = $outRoot.Substring($sourcePrefix.Length).Replace('\', '/')
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'artifacts\licenses'
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $BinaryLicense) {
    $BinaryLicense = Join-Path $repoRoot 'legal\BINARY-LICENSE.md'
}
if (-not $LicenseScope) {
    $LicenseScope = Join-Path $repoRoot 'LICENSE-SCOPE.md'
}
foreach ($requiredFile in @($BinaryLicense, $LicenseScope)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required SlyBrowser legal file was not found: $requiredFile"
    }
}

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

function New-LegalArtifactEntry {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ArchivePath,
        [Parameter(Mandatory)][string]$Purpose
    )
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $item = Get-Item -LiteralPath $resolvedPath
    if ($item.PSIsContainer -or $item.Length -le 0) {
        throw "Legal artifact is missing or empty: $Path"
    }
    return [ordered]@{
        path = $resolvedPath
        archivePath = $ArchivePath
        sha256 = Get-Sha256Hex -LiteralPath $resolvedPath
        size = $item.Length
        purpose = $Purpose
    }
}
function ConvertTo-GnList {
    param([string[]]$Values)
    if (-not $Values -or $Values.Count -eq 0) { return '[]' }
    $separator = [string][System.IO.Path]::DirectorySeparatorChar
    $normalized = @($Values | ForEach-Object {
        $value = $_.Replace('/', $separator).Replace('\', $separator).TrimStart('/', '\')
        if ($value -match '"') { throw "GN list value must not contain a quote: $value" }
        $value = $value.Replace('\', '\\')
        '"' + $value + '"'
    })
    return '[' + ($normalized -join ',') + ']'
}
function ConvertTo-CommandLineArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Argument)
    if ($Argument.Length -eq 0) { return '""' }
    if ($Argument -notmatch '[\s"]') { return $Argument }
    $result = '"'
    $backslashCount = 0
    foreach ($char in $Argument.ToCharArray()) {
        if ($char -eq '\') {
            $backslashCount += 1
            continue
        }
        if ($char -eq '"') {
            $result += ('\' * (($backslashCount * 2) + 1))
            $result += '"'
            $backslashCount = 0
            continue
        }
        if ($backslashCount -gt 0) {
            $result += ('\' * $backslashCount)
            $backslashCount = 0
        }
        $result += $char
    }
    if ($backslashCount -gt 0) {
        $result += ('\' * ($backslashCount * 2))
    }
    $result += '"'
    return $result
}
function Invoke-LicenseTool {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = 'python'
    $processInfo.WorkingDirectory = $sourceRoot
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.Arguments = (@($licenseScript) + $Arguments | ForEach-Object { ConvertTo-CommandLineArgument -Argument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::Start($processInfo)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $combined = ($stdout + $stderr).TrimEnd()
    if ($combined) {
        $combined | Tee-Object -FilePath $LogPath
    } else {
        Set-Content -LiteralPath $LogPath -Value '' -Encoding utf8
    }
    if ($process.ExitCode -ne 0) { throw $FailureMessage }
}

Push-Location $sourceRoot
try {
    $dependencyArguments = @('--gn-out-dir', $relativeOut, '--gn-target', $GnTarget)
    $scanArguments = @($dependencyArguments)
    if ($ScanExcludeDir -and $ScanExcludeDir.Count -gt 0) {
        $scanArguments += @('--exclude-dirs', (ConvertTo-GnList -Values $ScanExcludeDir))
    }
    Invoke-LicenseTool -Arguments (@('scan') + $scanArguments) -LogPath (Join-Path $outputRoot 'scan.log') -FailureMessage 'Chromium license scan failed.'
    $creditsFile = Join-Path $outputRoot 'credits.html'
    Invoke-LicenseTool -Arguments (@('credits') + $dependencyArguments + @($creditsFile)) -LogPath (Join-Path $outputRoot 'credits.log') -FailureMessage 'Chromium credits generation failed.'
    $thirdPartyNoticeFile = Join-Path $outputRoot 'THIRD_PARTY_NOTICES.txt'
    Invoke-LicenseTool -Arguments (@('license_file') + $dependencyArguments + @('--format', 'notice', $thirdPartyNoticeFile)) -LogPath (Join-Path $outputRoot 'third-party-notices.log') -FailureMessage 'Chromium third-party NOTICE generation failed.'
    $chromiumLicenseFile = Join-Path $outputRoot 'CHROMIUM_LICENSES.txt'
    Invoke-LicenseTool -Arguments (@('license_file') + $dependencyArguments + @('--format', 'txt', $chromiumLicenseFile)) -LogPath (Join-Path $outputRoot 'chromium-licenses.log') -FailureMessage 'Chromium license file generation failed.'
} finally {
    Pop-Location
}

$releaseBinaryLicense = Join-Path $outputRoot 'BINARY-LICENSE.txt'
$releaseLicenseScope = Join-Path $outputRoot 'LICENSE-SCOPE.txt'
Copy-Item -LiteralPath (Resolve-Path -LiteralPath $BinaryLicense).Path -Destination $releaseBinaryLicense -Force
Copy-Item -LiteralPath (Resolve-Path -LiteralPath $LicenseScope).Path -Destination $releaseLicenseScope -Force

$summary = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    chromiumSource = $sourceRoot
    gnOutDir = $relativeOut
    gnTarget = $GnTarget
    scanExcludedDirs = @($ScanExcludeDir | ForEach-Object { $_.Replace('\', '/') })
    requiredArchiveFiles = @(
        'BINARY-LICENSE.txt',
        'LICENSE-SCOPE.txt',
        'THIRD_PARTY_NOTICES.txt',
        'CREDITS.html'
    )
    artifacts = @(
        New-LegalArtifactEntry -Path $releaseBinaryLicense -ArchivePath 'BINARY-LICENSE.txt' -Purpose 'SlyBrowser binary distribution terms'
        New-LegalArtifactEntry -Path $releaseLicenseScope -ArchivePath 'LICENSE-SCOPE.txt' -Purpose 'Repository and binary license boundary'
        New-LegalArtifactEntry -Path $thirdPartyNoticeFile -ArchivePath 'THIRD_PARTY_NOTICES.txt' -Purpose 'Chromium and bundled third-party notices'
        New-LegalArtifactEntry -Path $creditsFile -ArchivePath 'CREDITS.html' -Purpose 'Chromium about://credits HTML'
        New-LegalArtifactEntry -Path $chromiumLicenseFile -ArchivePath 'CHROMIUM_LICENSES.txt' -Purpose 'Chromium and bundled third-party license text'
    )
}
$summaryPath = Join-Path $outputRoot 'release-legal-summary.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8
$summary | ConvertTo-Json -Depth 6
