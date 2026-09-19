[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$Version,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$contractPath = Join-Path $repoRoot 'contracts\sdk-packages.json'
$contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$contract.version }

function Read-Text([string]$Path) {
    return Get-Content -LiteralPath $Path -Raw
}

function Write-Text([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-JsonVersion([string]$Path) {
    return [string]((Read-Text $Path | ConvertFrom-Json).version)
}

function Set-JsonVersion([string]$Path, [string]$NewVersion) {
    $json = Read-Text $Path | ConvertFrom-Json
    $json.version = $NewVersion
    Write-Text $Path (($json | ConvertTo-Json -Depth 20) + "`n")
}

function Get-RegexVersion([string]$Path, [string]$Pattern) {
    $match = [regex]::Match((Read-Text $Path), $Pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { throw "Unable to find version in $Path" }
    return $match.Groups['version'].Value
}

function Set-RegexVersion([string]$Path, [string]$Pattern, [string]$Replacement) {
    $text = Read-Text $Path
    $updated = [regex]::Replace($text, $Pattern, $Replacement, [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($updated -eq $text) { throw "Unable to update version in $Path" }
    Write-Text $Path $updated
}

$files = [ordered]@{
    workspace = Join-Path $repoRoot 'package.json'
    node = Join-Path $repoRoot 'packages\node\package.json'
    python = Join-Path $repoRoot 'packages\python\pyproject.toml'
    dotnet = Join-Path $repoRoot 'packages\dotnet\src\SlyBrowser\SlyBrowser.csproj'
    java = Join-Path $repoRoot 'packages\java\pom.xml'
    contract = $contractPath
}

$current = [ordered]@{
    workspace = Get-JsonVersion $files.workspace
    node = Get-JsonVersion $files.node
    python = Get-RegexVersion $files.python '(?m)^version\s*=\s*"(?<version>[^"]+)"'
    dotnet = Get-RegexVersion $files.dotnet '<Version>(?<version>[^<]+)</Version>'
    java = Get-RegexVersion $files.java '<project\b.*?<version>(?<version>[^<]+)</version>'
    contract = [string]$contract.version
}

$mismatches = @()
foreach ($entry in $current.GetEnumerator()) {
    if ($entry.Value -ne $Version) {
        $mismatches += "$($entry.Key)=$($entry.Value)"
    }
}

if ($Check) {
    if ($mismatches.Count -gt 0) {
        throw "SDK package version mismatch. Expected $Version but found: $($mismatches -join ', ')"
    }
    Write-Output "SDK package versions match $Version"
    return
}

if ($PSCmdlet.ShouldProcess($repoRoot, "Set SDK package version to $Version")) {
    Set-JsonVersion $files.workspace $Version
    Set-JsonVersion $files.node $Version
    Set-RegexVersion $files.python '(?m)^version\s*=\s*"[^"]+"' "version = `"$Version`""
    Set-RegexVersion $files.dotnet '<Version>[^<]+</Version>' "<Version>$Version</Version>"
    Set-RegexVersion $files.java '(<project\b.*?<version>)[^<]+(</version>)' "`${1}$Version`${2}"
    $contract.version = $Version
    Write-Text $contractPath (($contract | ConvertTo-Json -Depth 20) + "`n")
    Write-Output "Updated SDK package versions to $Version"
}
