[CmdletBinding()]
param(
    [ValidateSet('all', 'node', 'python', 'java', 'dotnet')]
    [string[]]$Package = @('all'),
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$Version,
    [switch]$DryRun,
    [switch]$Publish,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
if (-not $DryRun -and -not $Publish) {
    throw 'Specify -DryRun for package validation or -Publish for registry upload.'
}
if ($DryRun -and $Publish) {
    throw 'Use either -DryRun or -Publish, not both.'
}
if ($Publish) {
    throw 'Source-tree publication is disabled. Publish only an exact verified release set through the dedicated protected registry workflow.'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$contractPath = Join-Path $repoRoot 'contracts\sdk-packages.json'
$contract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$contract.version }

function Invoke-Checked {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter()][string[]]$Arguments = @(), [string]$WorkingDirectory = $repoRoot)
    Push-Location $WorkingDirectory
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Require-Command([string]$Command) {
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { throw "$Command is required." }
    if ($resolved.Source) { return $resolved.Source }
    if ($resolved.FullName) { return $resolved.FullName }
    return $resolved.Path
}

function Test-EnvPresent([string]$Name, [string]$Message) {
    if (-not [Environment]::GetEnvironmentVariable($Name)) {
        throw "$Message ($Name is not set)."
    }
}

if ($Package -contains 'all') {
    $targets = @('node', 'python', 'java', 'dotnet')
} else {
    $targets = $Package
}

Invoke-Checked -FilePath 'powershell' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'Set-SdkPackageVersion.ps1'), '-Version', $Version, '-Check')

$artifactRoot = Join-Path $repoRoot 'artifacts\sdk'
if (-not (Test-Path -LiteralPath $artifactRoot)) {
    New-Item -ItemType Directory -Path $artifactRoot | Out-Null
}

foreach ($target in $targets) {
    switch ($target) {
        'node' {
            $pnpm = Require-Command 'pnpm'
            $npm = Require-Command 'npm'
            if (-not $SkipBuild) {
                Invoke-Checked -FilePath $pnpm -Arguments @('--filter', 'slybrowser', 'build')
            }
            $packageDir = Join-Path $repoRoot 'packages\node'
            if ($DryRun) {
                Invoke-Checked -FilePath $npm -Arguments @('pack', '--dry-run') -WorkingDirectory $packageDir
            } else {
                Invoke-Checked -FilePath $npm -Arguments @('whoami') -WorkingDirectory $packageDir
                $args = @('publish', '--access', 'public')
                if ($env:SLY_NPM_PROVENANCE -eq '1') { $args += '--provenance' }
                Invoke-Checked -FilePath $npm -Arguments $args -WorkingDirectory $packageDir
            }
        }
        'python' {
            $python = Require-Command 'python'
            $packageDir = Join-Path $repoRoot 'packages\python'
            if (-not $SkipBuild) {
                Invoke-Checked -FilePath $python -Arguments @('-m', 'build', '--sdist', '--wheel') -WorkingDirectory $packageDir
            }
            Invoke-Checked -FilePath $python -Arguments @('-m', 'twine', 'check', 'dist/*') -WorkingDirectory $packageDir
            if ($Publish) {
                Invoke-Checked -FilePath $python -Arguments @('-m', 'twine', 'upload', '--repository-url', $contract.registries.python.url, 'dist/*') -WorkingDirectory $packageDir
            }
        }
        'java' {
            $mvn = Require-Command 'mvn'
            $pom = Join-Path $repoRoot 'packages\java\pom.xml'
            if ($DryRun) {
                $javaArgs = @('-f', $pom, '-Prelease', '-DskipTests=false')
                if (-not (Get-Command gpg -ErrorAction SilentlyContinue)) {
                    Write-Warning 'gpg is not installed; Java dry-run validates tests, sources and javadocs with -Dgpg.skip=true. Publish still requires GPG signatures.'
                    $javaArgs += '-Dgpg.skip=true'
                }
                $javaArgs += 'verify'
                Invoke-Checked -FilePath $mvn -Arguments $javaArgs
            } else {
                if (-not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.m2\settings.xml'))) {
                    throw 'Maven Central publish requires ~/.m2/settings.xml with the central server token.'
                }
                if (-not (Get-Command gpg -ErrorAction SilentlyContinue)) {
                    throw 'Maven Central publish requires gpg for artifact signatures.'
                }
                Invoke-Checked -FilePath $mvn -Arguments @('-f', $pom, '-Prelease', '-DskipTests=false', 'deploy')
            }
        }
        'dotnet' {
            $dotnet = Require-Command 'dotnet'
            $project = Join-Path $repoRoot 'packages\dotnet\src\SlyBrowser\SlyBrowser.csproj'
            $output = Join-Path $artifactRoot 'dotnet'
            if (-not (Test-Path -LiteralPath $output)) { New-Item -ItemType Directory -Path $output | Out-Null }
            if (-not $SkipBuild) {
                Invoke-Checked -FilePath $dotnet -Arguments @('pack', $project, '--configuration', 'Release', '-o', $output)
            }
            if ($Publish) {
                Test-EnvPresent 'NUGET_API_KEY' 'NuGet publish requires an API key'
                $packageFile = Join-Path $output "SlyBrowser.$Version.nupkg"
                if (-not (Test-Path -LiteralPath $packageFile)) { throw "NuGet package was not built: $packageFile" }
                Invoke-Checked -FilePath $dotnet -Arguments @('nuget', 'push', $packageFile, '--api-key', $env:NUGET_API_KEY, '--source', $contract.registries.dotnet.url)
            }
        }
    }
}

if ($DryRun) {
    $modeLabel = 'dry-run checks'
} else {
    $modeLabel = 'publish'
}
Write-Output "SDK package $(@($targets) -join ', ') $modeLabel completed for version $Version"
