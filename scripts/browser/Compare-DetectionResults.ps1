[CmdletBinding()]
param(
    [Parameter(Mandatory)][string[]]$Results,
    [Parameter(Mandatory)][string]$Output
)

$ErrorActionPreference = 'Stop'
if ($Results.Count -lt 2) { throw 'At least two result JSON files are required.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runner = Join-Path $repoRoot 'tests\detection\compare.mjs'
$arguments = @($runner)
foreach ($result in $Results) {
    $arguments += @('--input', (Resolve-Path -LiteralPath $result).Path)
}
$arguments += @('--output', [System.IO.Path]::GetFullPath($Output))
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Comparison failed with exit code $LASTEXITCODE." }
