[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AuthorizationFile,
    [string]$MavenExecutable = 'mvn',
    [string]$DotNetExecutable = 'dotnet',
    [switch]$HeadlessOnly,
    [switch]$HeadedOnly,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$authorizationPath = (Resolve-Path -LiteralPath $AuthorizationFile).Path
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $repoRoot 'artifacts\test-results\authorized-frameworks'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $OutputDirectory "authorized-framework-matrix-$stamp"
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
    throw 'Node SDK build failed before authorized framework matrix.'
}

$caseFiles = New-Object System.Collections.Generic.List[string]
function Add-CommonNodeArgs([string]$backend, [string]$output, [bool]$headed) {
    $args = @(
        (Join-Path $repoRoot 'tests\integration\authorized-framework-node.mjs'),
        '--backend', $backend,
        '--authorization-file', $authorizationPath,
        '--output', $output
    )
    if ($headed) { $args += '--headed' }
    return $args
}

foreach ($mode in $modes) {
    foreach ($backend in @('playwright', 'puppeteer')) {
        $report = Join-Path $runDirectory "node-$backend-$($mode.Name).json"
        & node @(Add-CommonNodeArgs $backend $report ([bool]$mode.Headed))
        if ($LASTEXITCODE -ne 0) {
            throw "Node $backend $($mode.Name) authorized launch failed."
        }
        $caseFiles.Add($report)
    }

    $previousPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = Join-Path $repoRoot 'packages\python\src'
        $report = Join-Path $runDirectory "python-playwright-$($mode.Name).json"
        $pythonArgs = @(
            (Join-Path $repoRoot 'tests\integration\authorized_framework_python.py'),
            '--authorization-file', $authorizationPath,
            '--output', $report
        )
        if ($mode.Headed) { $pythonArgs += '--headed' }
        & python @pythonArgs
        if ($LASTEXITCODE -ne 0) {
            throw "Python Playwright $($mode.Name) authorized launch failed."
        }
        $caseFiles.Add($report)
    }
    finally {
        $env:PYTHONPATH = $previousPythonPath
    }

    $javaReport = Join-Path $runDirectory "java-playwright-$($mode.Name).json"
    $mavenArgs = @(
        '-f', (Join-Path $repoRoot 'packages\java\pom.xml'),
        '-Dtest=AuthorizedPlaywrightRuntimeTest',
        "-Dslybrowser.integration.authorizationFile=$authorizationPath",
        "-Dslybrowser.integration.output=$javaReport",
        "-Dslybrowser.integration.headed=$(([string]([bool]$mode.Headed)).ToLowerInvariant())",
        'test'
    )
    & $MavenExecutable @mavenArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Java Playwright $($mode.Name) authorized launch failed."
    }
    $caseFiles.Add($javaReport)

    $previousAuthorization = $env:SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE
    $previousOutput = $env:SLYBROWSER_INTEGRATION_OUTPUT
    $previousHeaded = $env:SLYBROWSER_INTEGRATION_HEADED
    try {
        $dotnetReport = Join-Path $runDirectory "dotnet-playwright-$($mode.Name).json"
        $env:SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE = $authorizationPath
        $env:SLYBROWSER_INTEGRATION_OUTPUT = $dotnetReport
        $env:SLYBROWSER_INTEGRATION_HEADED = if ($mode.Headed) { '1' } else { '0' }
        & $DotNetExecutable test (Join-Path $repoRoot 'packages\dotnet\tests\SlyBrowser.Tests\SlyBrowser.Tests.csproj') `
            --configuration Release `
            --filter 'FullyQualifiedName~AuthorizedPlaywrightRuntimeTests'
        if ($LASTEXITCODE -ne 0) {
            throw ".NET Playwright $($mode.Name) authorized launch failed."
        }
        $caseFiles.Add($dotnetReport)
    }
    finally {
        $env:SLYBROWSER_INTEGRATION_AUTHORIZATION_FILE = $previousAuthorization
        $env:SLYBROWSER_INTEGRATION_OUTPUT = $previousOutput
        $env:SLYBROWSER_INTEGRATION_HEADED = $previousHeaded
    }
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
$summaryPath = Join-Path $runDirectory 'authorized-framework-matrix.json'
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding utf8
$markdownPath = Join-Path $runDirectory 'authorized-framework-matrix.md'
$lines = @(
    '# Authorized framework matrix',
    '',
    "Generated: $($summary.generatedAt)",
    '',
    "| Language | Backend | Mode | Status | Browser | webdriver | window.chrome |",
    "| --- | --- | --- | --- | --- | --- | --- |"
)
foreach ($case in $cases) {
    $lines += "| $($case.language) | $($case.backend) | $(if ($case.headed) { 'headed' } else { 'headless' }) | $($case.status) | $($case.browserVersion) | $($case.signals.webdriver) | $($case.signals.chromeType) |"
}
$lines += ''
$lines += "Summary JSON: $summaryPath"
$lines | Set-Content -LiteralPath $markdownPath -Encoding utf8
Write-Output $summaryPath
