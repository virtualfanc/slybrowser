[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ChromiumSrc,
    [Parameter(Mandatory)][string]$OutDir,
    [string[]]$TestTargets,
    [hashtable]$Filters = @{},
    [string]$ResultsDir,
    [switch]$Full
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $ChromiumSrc).Path
$outRoot = if ([System.IO.Path]::IsPathRooted($OutDir)) {
    [System.IO.Path]::GetFullPath($OutDir)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $sourceRoot $OutDir))
}
$sourcePrefix = $sourceRoot.TrimEnd('\') + '\'
if (-not $outRoot.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutDir must resolve inside the Chromium source checkout.'
}
if (-not $TestTargets) {
    $TestTargets = if ($Full) {
        @('sly_license_unittests', 'sly_profile_unittests', 'components_unittests', 'browser_tests')
    } else {
        @('sly_license_unittests', 'sly_profile_unittests')
    }
} elseif ($Full) {
    throw 'Use either -Full or -TestTargets, not both.'
}
if (-not $ResultsDir) {
    $ResultsDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'artifacts\test-results\cpp'
}
$resultRoot = [System.IO.Path]::GetFullPath($ResultsDir)
New-Item -ItemType Directory -Force -Path $resultRoot | Out-Null

& (Join-Path $PSScriptRoot 'Build-Chromium.ps1') -ChromiumSrc $sourceRoot -OutDir $outRoot -Targets $TestTargets

$summary = [System.Collections.Generic.List[object]]::new()
foreach ($target in $TestTargets) {
    $extension = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '.exe' } else { '' }
    $targetName = ($target -split ':')[-1]
    $targetName = ($targetName -split '[/\\]')[-1]
    $binary = Join-Path $outRoot ($targetName + $extension)
    if (-not (Test-Path -LiteralPath $binary)) { throw "Test binary was not built: $binary" }
    $jsonPath = Join-Path $resultRoot ($targetName + '.json')
    $arguments = @("--test-launcher-summary-output=$jsonPath")
    if ($Filters.ContainsKey($target) -and $Filters[$target]) {
        $arguments += "--gtest_filter=$($Filters[$target])"
    }
    $started = Get-Date
    & $binary @arguments
    $exitCode = $LASTEXITCODE
    $summary.Add([ordered]@{
        target = $target
        exitCode = $exitCode
        durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 3)
        resultFile = $jsonPath
    })
    if ($exitCode -ne 0) { break }
}
$summaryPath = Join-Path $resultRoot 'summary.json'
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $summaryPath -Encoding utf8
if ($summary.Where({ $_.exitCode -ne 0 }).Count -gt 0) {
    throw "One or more C++ test targets failed. See $summaryPath"
}
