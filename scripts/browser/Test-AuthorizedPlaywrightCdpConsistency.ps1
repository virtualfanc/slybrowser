[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AuthorizationFile,
    [Parameter(Mandatory)][string]$CacheRoot,
    [Parameter(Mandatory)][string]$LicenseKeyId,
    [Parameter(Mandatory)][string]$LicensePublicKeyHex,
    [Parameter(Mandatory)][string]$ReleaseKeyId,
    [Parameter(Mandatory)][string]$ReleasePublicKeyBase64url,
    [switch]$HeadlessOnly,
    [switch]$HeadedOnly,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$authorizationPath = (Resolve-Path -LiteralPath $AuthorizationFile).Path
$cachePath = [System.IO.Path]::GetFullPath($CacheRoot)
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts\test-results\authorized-playwright-cdp'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $OutputDirectory "authorized-playwright-cdp-$stamp"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

if ($HeadlessOnly -and $HeadedOnly) {
    throw 'Use only one of -HeadlessOnly or -HeadedOnly.'
}
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
$modes = if ($HeadlessOnly) {
    @(@{ Name = 'headless'; Headed = $false })
} elseif ($HeadedOnly) {
    @(@{ Name = 'headed'; Headed = $true })
} else {
    @(
        @{ Name = 'headless'; Headed = $false },
        @{ Name = 'headed'; Headed = $true }
    )
}

& pnpm --dir $repoRoot --filter slybrowser build
if ($LASTEXITCODE -ne 0) {
    throw 'Node SDK build failed before authorized Playwright CDP consistency test.'
}

$caseFiles = New-Object System.Collections.Generic.List[string]
foreach ($mode in $modes) {
    $report = Join-Path $runDirectory "node-playwright-cdp-$($mode.Name).json"
    $args = @(
        (Join-Path $repoRoot 'tests\integration\authorized-playwright-cdp-node.mjs'),
        '--authorization-file', $authorizationPath,
        '--cache-root', $cachePath,
        '--license-key-id', $LicenseKeyId,
        '--license-public-key-hex', $LicensePublicKeyHex,
        '--release-key-id', $ReleaseKeyId,
        '--release-public-key-base64url', $ReleasePublicKeyBase64url,
        '--output', $report
    )
    if ($mode.Headed) { $args += '--headed' }
    & node @args
    if ($LASTEXITCODE -ne 0) {
        throw "Authorized Playwright CDP $($mode.Name) consistency test failed."
    }
    $caseFiles.Add($report)
}

$cases = @()
foreach ($file in $caseFiles) {
    $cases += (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json)
}
$summary = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    status = if (($cases | Where-Object { $_.status -ne 'PASS' }).Count -eq 0) { 'PASS' } else { 'FAIL' }
    caseCount = $cases.Count
    modes = @($modes | ForEach-Object { $_.Name })
    cases = $cases
}
$summaryPath = Join-Path $runDirectory 'authorized-playwright-cdp.json'
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding utf8
$markdownPath = Join-Path $runDirectory 'authorized-playwright-cdp.md'
$lines = @(
    '# Authorized Playwright CDP consistency',
    '',
    "Generated: $($summary.generatedAt)",
    '',
    "| Mode | Status | Browser | CDP protocol | no stack side effect | webdriver hidden | persistent restored |",
    "| --- | --- | --- | --- | --- | --- | --- |"
)
foreach ($case in $cases) {
    $lines += "| $(if ($case.headed) { 'headed' } else { 'headless' }) | $($case.status) | $($case.browserVersion) | $($case.checks.protocolRemainsFunctional) | $($case.checks.noInspectorStackSideEffect) | $($case.checks.webdriverHiddenAcrossContexts) | $($case.checks.persistentProfileRestored) |"
}
$lines += ''
$lines += "Summary JSON: $summaryPath"
$lines | Set-Content -LiteralPath $markdownPath -Encoding utf8
Write-Output $summaryPath
