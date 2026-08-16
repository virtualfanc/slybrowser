[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BrowserExecutable,
    [string]$BrowserName
)

$ErrorActionPreference = 'Stop'
$browserPath = (Resolve-Path -LiteralPath $BrowserExecutable).Path
$browserFile = Get-Item -LiteralPath $browserPath
if ($browserFile.PSIsContainer) {
    throw 'BrowserExecutable must identify a file.'
}

if ([string]::IsNullOrWhiteSpace($BrowserName)) {
    $BrowserName = $browserFile.Name
}
if ($BrowserName -ne [System.IO.Path]::GetFileName($BrowserName) -or
    $BrowserName.Contains('"')) {
    throw 'BrowserName must be a plain file name without quotes.'
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $browserPath).Hash.ToLowerInvariant()

Write-Output 'sly_webdriver_pairing_enforcement_enabled = true'
Write-Output "sly_webdriver_paired_browser_sha256 = `"$hash`""
Write-Output "sly_webdriver_paired_browser_name = `"$BrowserName`""
