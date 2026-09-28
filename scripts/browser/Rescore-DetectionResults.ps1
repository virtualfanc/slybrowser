[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ResultsDirectory,
    [string]$SiteConfig
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$resultsPath = (Resolve-Path -LiteralPath $ResultsDirectory).Path
if (-not $SiteConfig) { $SiteConfig = Join-Path $repoRoot 'tests\detection\sites.json' }
$siteConfigPath = (Resolve-Path -LiteralPath $SiteConfig).Path
$runner = Join-Path $repoRoot 'tests\detection\rescore.mjs'

& node $runner --directory $resultsPath --sites $siteConfigPath
if ($LASTEXITCODE -ne 0) { throw "Detection rescore failed with exit code $LASTEXITCODE." }
