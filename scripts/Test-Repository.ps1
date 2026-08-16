[CmdletBinding()]
param(
    [switch]$RequireDotNet
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Get-Command python -ErrorAction Stop
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    $bundledPnpm = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
    if (Test-Path -LiteralPath $bundledPnpm) {
        $pnpm = Get-Item -LiteralPath $bundledPnpm
    } else {
        throw 'pnpm was not found.'
    }
}
$pnpmPath = if ($pnpm.Source) { $pnpm.Source } elseif ($pnpm.FullName) { $pnpm.FullName } else { $pnpm.Path }

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter()][string[]]$Arguments = @())
    Write-Verbose "Running: $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath"
    }
}

Push-Location $repoRoot
try {
    Invoke-Checked -FilePath 'git' -Arguments @('diff', '--check')
    $secretMatches = & rg -n 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AIza[0-9A-Za-z_-]{20,}' . -g '!**/.git/**' -g '!node_modules/**'
    if ($LASTEXITCODE -eq 0) {
        throw "Potential secret material found:`n$secretMatches"
    }
    if ($LASTEXITCODE -ne 1) {
        throw 'Secret scan failed.'
    }

    $pythonPackage = Join-Path $repoRoot 'packages\python'
    $previousPythonPath = $env:PYTHONPATH
    try {
        $env:PYTHONPATH = Join-Path $pythonPackage 'src'
        Push-Location $pythonPackage
        try {
            Invoke-Checked -FilePath $python.Source -Arguments @('-m', 'unittest', 'discover', '-s', 'tests', '-v')
        } finally {
            Pop-Location
        }
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }

    Invoke-Checked -FilePath $pnpmPath -Arguments @('--filter', 'slybrowser', 'typecheck')
    Invoke-Checked -FilePath $pnpmPath -Arguments @('--filter', 'slybrowser', 'test')
    Invoke-Checked -FilePath $pnpmPath -Arguments @('--filter', 'slybrowser', 'build')
    Invoke-Checked -FilePath $pnpmPath -Arguments @('--filter', '@slybrowser/license-service', 'typecheck')
    Invoke-Checked -FilePath $pnpmPath -Arguments @('--filter', '@slybrowser/license-service', 'test')
    Invoke-Checked -FilePath $pnpmPath -Arguments @('--filter', '@slybrowser/license-service', 'build')
    Invoke-Checked -FilePath 'node' -Arguments @('--test', 'tests/release/*.test.mjs')
    Invoke-Checked -FilePath 'node' -Arguments @('--check', 'tests/detection/run.mjs')
    Invoke-Checked -FilePath 'node' -Arguments @('--check', 'tests/detection/run-webdriver.mjs')
    Invoke-Checked -FilePath 'node' -Arguments @('--check', 'tests/detection/compare.mjs')
    Invoke-Checked -FilePath 'node' -Arguments @('--test', 'tests/detection/*.test.mjs')

    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    $hasDotNetSdk = $false
    if ($dotnet) {
        $sdkList = & $dotnet.Source --list-sdks
        $hasDotNetSdk = $LASTEXITCODE -eq 0 -and [bool]$sdkList
    }
    if ($hasDotNetSdk) {
        Invoke-Checked -FilePath $dotnet.Source -Arguments @(
            'test',
            'packages/dotnet/tests/SlyBrowser.Tests/SlyBrowser.Tests.csproj',
            '--configuration', 'Release'
        )
    } elseif ($RequireDotNet) {
        throw '.NET SDK is required but no SDK is installed.'
    } else {
        Write-Warning '.NET SDK is not installed; .NET tests were skipped.'
    }
} finally {
    Pop-Location
}
