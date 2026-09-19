[CmdletBinding()]
param(
    [switch]$RequireDotNet,
    [switch]$RequireMaven,
    [switch]$RepositoryGuardOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$python = Get-Command python -ErrorAction Stop
$pnpm = Get-Command pnpm -ErrorAction Stop
$pnpmPath = if ($pnpm.Source) { $pnpm.Source } elseif ($pnpm.FullName) { $pnpm.FullName } else { $pnpm.Path }

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter()][string[]]$Arguments = @())
    Write-Verbose "Running: $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath"
    }
}

function Test-RepositoryGuard {
    Invoke-Checked -FilePath 'git' -Arguments @('diff', '--check')

    $secretMatches = & rg -n 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AIza[0-9A-Za-z_-]{20,}' . -g '!**/.git/**' -g '!node_modules/**'
    if ($LASTEXITCODE -eq 0) {
        throw "Potential secret material found:`n$secretMatches"
    }
    if ($LASTEXITCODE -ne 1) {
        throw 'Secret scan failed.'
    }

    $trackedFiles = & git ls-files
    if ($LASTEXITCODE -ne 0) { throw 'Unable to list tracked repository files.' }
    $forbidden = @()
    $rules = @(
        @{ Pattern = '(^|/)(AGENTS(\.override)?|CLAUDE)\.md$'; Reason = 'local AI-agent instruction file' },
        @{ Pattern = '(^|/)(\.codex|\.claude|\.cursor|\.continue|\.aider|\.windsurf|\.agent|\.agents|\.ai)(/|$)'; Reason = 'local AI-agent state directory' },
        @{ Pattern = '(^|/)(PROJECT|PROJECT_REQUIREMENTS|PROJECT_STATUS|ROADMAP)\.md$'; Reason = 'internal project constraint or planning file' },
        @{ Pattern = '(^|/)(governance|internal|planning)(/|$)'; Reason = 'internal governance or planning material' },
        @{ Pattern = '(^|/)docs/[^/]*(backlog|design-draft|plan|proposal|requirements|todo)\.md$'; Reason = 'internal lifecycle document' },
        @{ Pattern = '(^|/)(dist|coverage|TestResults|node_modules|target|bin|obj)(/|$)'; Reason = 'generated build/test dependency output' },
        @{ Pattern = '(^|/)memory/(hot-cache|open-loops)\.md$'; Reason = 'local AI-agent memory cache' },
        @{ Pattern = '(^|/)secrets(/|$)|\.(key|pem|pfx|sqlite|sqlite-shm|sqlite-wal)$|\.authorization\.json$'; Reason = 'secret, database, or local authorization material' },
        @{ Pattern = 'codex-clipboard|ai-scratch|agent-scratch|codex-scratch|ai-transcript|agent-transcript|codex-transcript|\.ai\.tmp$|\.agent\.tmp$|\.codex\.tmp$'; Reason = 'AI-agent temporary artifact' },
        @{ Pattern = '\.(exe|dll|pdb|dSYM|zip|7z|rar|tar|tgz|gz)$'; Reason = 'binary, symbol, or release archive artifact' }
    )
    foreach ($file in $trackedFiles) {
        $normalized = $file -replace '\\', '/'
        foreach ($rule in $rules) {
            if ($normalized -match $rule.Pattern) {
                $forbidden += "$normalized`t$($rule.Reason)"
                break
            }
        }
    }
    if ($forbidden.Count -gt 0) {
        throw "Forbidden tracked repository artifacts found:`n$($forbidden -join "`n")"
    }
}

Push-Location $repoRoot
try {
    Test-RepositoryGuard
    if ($RepositoryGuardOnly) { return }

    Invoke-Checked -FilePath 'powershell' -Arguments @(
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        (Join-Path $repoRoot 'scripts\release\Set-SdkPackageVersion.ps1'),
        '-Check'
    )

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

    $maven = Get-Command mvn -ErrorAction SilentlyContinue
    if ($maven) {
        $mavenPath = if ($maven.Source) { $maven.Source } elseif ($maven.FullName) { $maven.FullName } else { $maven.Path }
        Invoke-Checked -FilePath $mavenPath -Arguments @(
            '-f',
            'packages/java/pom.xml',
            'test'
        )
    } elseif ($RequireMaven) {
        throw 'Maven is required but was not found.'
    } else {
        Write-Warning 'Maven is not installed; Java tests were skipped.'
    }
} finally {
    Pop-Location
}
