[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [Parameter(Mandatory)][string]$DriverExecutable,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$driverPath = (Resolve-Path -LiteralPath $DriverExecutable).Path
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts\test-results\humanize'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

& pnpm --filter slybrowser build
if ($LASTEXITCODE -ne 0) {
    throw 'Node SDK build failed before Native Humanize matrix.'
}

& node (Join-Path $repoRoot 'tests\integration\native-humanize-node-sdk.mjs') `
    --browser $browserPath --driver $driverPath `
    --output (Join-Path $OutputDirectory "native-humanize-node-$stamp.json")
if ($LASTEXITCODE -ne 0) {
    throw 'Node SDK Native Humanize matrix failed.'
}

$previousPythonPath = $env:PYTHONPATH
try {
    $env:PYTHONPATH = Join-Path $repoRoot 'packages\python\src'
    & python (Join-Path $repoRoot 'tests\integration\native_humanize_python_sdk.py') `
        --browser $browserPath --driver $driverPath `
        --output (Join-Path $OutputDirectory "native-humanize-python-$stamp.json")
    if ($LASTEXITCODE -ne 0) {
        throw 'Python SDK Native Humanize matrix failed.'
    }
}
finally {
    $env:PYTHONPATH = $previousPythonPath
}
