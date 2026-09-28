[CmdletBinding()]
param(
    [string]$Version = '0.2.0',
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceTree,
    [Parameter(Mandatory)][string]$SevenZip,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sevenZipPath = (Resolve-Path -LiteralPath $SevenZip).Path
if ([IO.Path]::GetFileName($sevenZipPath) -notin @('7z.exe', '7z', '7zz')) { throw 'SevenZip must identify a 7z or 7zz executable.' }
$env:SLYBROWSER_7Z_PATH = $sevenZipPath
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "artifacts\sdk\$Version" }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $outputRoot) {
    $existing = @(Get-ChildItem -LiteralPath $outputRoot -Force)
    if ($existing.Count -gt 0) { throw "Output directory must be absent or empty: $outputRoot" }
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

function Invoke-Checked([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $repoRoot) {
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $FilePath" }
    } finally { Pop-Location }
}

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "$Name is required." }
    if ($command.Source) { return $command.Source }
    return $command.Path
}

Invoke-Checked (Require-Command 'powershell') @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Set-SdkPackageVersion.ps1'), '-Version', $Version, '-Check')

$nodeOutput = New-Item -ItemType Directory -Path (Join-Path $outputRoot 'node') -Force
Invoke-Checked (Require-Command 'pnpm') @('--filter', 'slybrowser', 'build')
Invoke-Checked (Require-Command 'npm') @('pack', '--pack-destination', $nodeOutput.FullName) (Join-Path $repoRoot 'packages\node')

$pythonOutput = New-Item -ItemType Directory -Path (Join-Path $outputRoot 'python') -Force
$python = Require-Command 'python'
Invoke-Checked $python @('-m', 'build', '--sdist', '--wheel', '--outdir', $pythonOutput.FullName) (Join-Path $repoRoot 'packages\python')
Invoke-Checked $python @('-m', 'twine', 'check', (Join-Path $pythonOutput.FullName '*'))

$maven = Require-Command 'mvn'
$javaRoot = Join-Path $repoRoot 'packages\java'
Invoke-Checked $maven @('--batch-mode', '--no-transfer-progress', '-Prelease', '-Dgpg.skip=true', 'clean', 'verify') $javaRoot
$javaOutput = New-Item -ItemType Directory -Path (Join-Path $outputRoot 'java') -Force
foreach ($name in @("slybrowser-$Version.jar", "slybrowser-$Version-sources.jar", "slybrowser-$Version-javadoc.jar")) {
    Copy-Item -LiteralPath (Join-Path $javaRoot "target\$name") -Destination $javaOutput.FullName
}
Copy-Item -LiteralPath (Join-Path $javaRoot 'pom.xml') -Destination (Join-Path $javaOutput.FullName "slybrowser-$Version.pom")

$dotnetOutput = New-Item -ItemType Directory -Path (Join-Path $outputRoot 'dotnet') -Force
Invoke-Checked (Require-Command 'dotnet') @('pack', (Join-Path $repoRoot 'packages\dotnet\src\SlyBrowser\SlyBrowser.csproj'), '--configuration', 'Release', '--output', $dotnetOutput.FullName, '-p:EnableSourceControlManagerQueries=false')

$releaseSet = Join-Path (Split-Path -Parent $outputRoot) 'sdk-release-set.json'
$node = Require-Command 'node'
Invoke-Checked $node @((Join-Path $PSScriptRoot 'Verify-SdkReleaseSet.mjs'), '--create', '--version', $Version, '--source-tree', $SourceTree, '--artifact-root', $outputRoot, '--output', $releaseSet)
Invoke-Checked $node @((Join-Path $PSScriptRoot 'Verify-SdkReleaseSet.mjs'), '--release-set', $releaseSet, '--artifact-root', $outputRoot, '--expected-source-tree', $SourceTree)
Write-Output "SDK release set created at $releaseSet"
