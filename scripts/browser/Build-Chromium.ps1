[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ChromiumSrc,
    [Parameter(Mandatory)][string]$OutDir,
    [string[]]$Targets = @('chrome'),
    [int]$Jobs = 0
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $ChromiumSrc).Path
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'BUILD.gn'))) {
    throw "Not a Chromium source root: $sourceRoot"
}
$resolvedOut = if ([System.IO.Path]::IsPathRooted($OutDir)) {
    [System.IO.Path]::GetFullPath($OutDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $OutDir))
}
$sourcePrefix = $sourceRoot.TrimEnd('\') + '\'
if (-not $resolvedOut.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutDir must resolve inside the Chromium source checkout.'
}
if (-not $Targets -or @($Targets | Where-Object { $_ -notmatch '^[A-Za-z0-9_./:-]+$' }).Count -gt 0) {
    throw 'One or more Chromium target names are invalid.'
}
$relativeOut = $resolvedOut.Substring($sourcePrefix.Length).Replace('\', '/')
$autoninjaCommand = Get-Command autoninja -ErrorAction SilentlyContinue
$autoninjaPath = if ($autoninjaCommand) { $autoninjaCommand.Source } else { $null }
if (-not $autoninjaPath) {
    $candidate = Join-Path $sourceRoot 'third_party\depot_tools\autoninja.bat'
    if (Test-Path -LiteralPath $candidate) { $autoninjaPath = $candidate }
}
if (-not $autoninjaPath) { throw 'autoninja was not found in PATH or the Chromium checkout.' }

$arguments = @('-C', $relativeOut)
if ($Jobs -gt 0) { $arguments += @('-j', $Jobs) }
$arguments += $Targets
Push-Location $sourceRoot
try {
    & $autoninjaPath @arguments
    if ($LASTEXITCODE -ne 0) { throw "Chromium build failed with exit code $LASTEXITCODE." }
} finally {
    Pop-Location
}
