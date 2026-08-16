[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ChromiumSrc,
    [string]$OutDir = 'out/release_x64',
    [string]$GnTarget = '//chrome:chrome',
    [string]$OutputDirectory
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

Push-Location $sourceRoot
try {
    $dependencyArguments = @('--gn-out-dir', $relativeOut, '--gn-target', $GnTarget)
    & python $licenseScript scan @dependencyArguments 2>&1 | Tee-Object -FilePath (Join-Path $outputRoot 'scan.log')
    if ($LASTEXITCODE -ne 0) { throw 'Chromium license scan failed.' }
    $creditsFile = Join-Path $outputRoot 'credits.html'
    & python $licenseScript credits @dependencyArguments $creditsFile 2>&1 | Tee-Object -FilePath (Join-Path $outputRoot 'credits.log')
    if ($LASTEXITCODE -ne 0) { throw 'Chromium credits generation failed.' }
} finally {
    Pop-Location
}
