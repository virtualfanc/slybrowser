[CmdletBinding()]
param(
    [string]$SlyBrowserRoot,
    [string]$WebsiteRoot,
    [string]$ReleaseBundleVerification,
    [string]$ReleaseQualification,
    [string]$LegalSummary,
    [string]$ProductionSecretDomainReport,
    [string]$OutputDirectory,
    [switch]$SkipInventoryGeneration
)

$ErrorActionPreference = 'Stop'

if (-not $SlyBrowserRoot) {
    $SlyBrowserRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
} else {
    $SlyBrowserRoot = (Resolve-Path -LiteralPath $SlyBrowserRoot).Path
}
if (-not $WebsiteRoot) {
    $WebsiteRoot = (Resolve-Path (Join-Path $SlyBrowserRoot '..\slybrowser-websites')).Path
} else {
    $WebsiteRoot = (Resolve-Path -LiteralPath $WebsiteRoot).Path
}
if (-not $ReleaseBundleVerification) {
    $ReleaseBundleVerification = 'E:\multilogin\artifacts\release-candidates\148.0.7778.179\release-bundle-verification-current.json'
}
if (-not $ReleaseQualification) {
    $ReleaseQualification = 'E:\multilogin\artifacts\release-candidates\148.0.7778.179\qualification-20260824-2348-current\release-qualification.json'
}
if (-not $LegalSummary) {
    $LegalSummary = Join-Path $SlyBrowserRoot 'artifacts\licenses\release-legal-summary.json'
}
if (-not $OutputDirectory) {
    $OutputDirectory = 'E:\multilogin\artifacts\supply-chain'
}

$ReleaseBundleVerification = (Resolve-Path -LiteralPath $ReleaseBundleVerification).Path
$ReleaseQualification = (Resolve-Path -LiteralPath $ReleaseQualification).Path
$LegalSummary = (Resolve-Path -LiteralPath $LegalSummary).Path
if ($ProductionSecretDomainReport) {
    $ProductionSecretDomainReport = (Resolve-Path -LiteralPath $ProductionSecretDomainReport).Path
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path ([System.IO.Path]::GetFullPath($OutputDirectory)) "supply-chain-$stamp"
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function New-Gate {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL', 'EXTERNAL')] [string]$Status,
        [hashtable]$Details = @{}
    )
    $gate = [ordered]@{
        id = $Id
        label = $Label
        status = $Status
    }
    foreach ($key in $Details.Keys) {
        $gate[$key] = $Details[$key]
    }
    return $gate
}

function Assert-ExternalCommand {
    param(
        [Parameter(Mandatory)][scriptblock]$Command,
        [Parameter(Mandatory)][string]$FailureMessage
    )
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function ConvertTo-ItemCount {
    param($Json)
    if ($null -eq $Json) { return 0 }
    if ($Json -is [System.Array]) { return $Json.Count }
    $properties = @($Json.PSObject.Properties)
    if ($properties.Count -eq 0) { return 0 }
    return $properties.Count
}

function Invoke-Inventory {
    param(
        [Parameter(Mandatory)][string]$RepositoryName,
        [Parameter(Mandatory)][string]$RepositoryRoot
    )
    $safeName = $RepositoryName -replace '[^A-Za-z0-9_.-]', '-'
    $licensePath = Join-Path $runDirectory "$safeName-license-inventory.json"
    $dependencyPath = Join-Path $runDirectory "$safeName-dependency-inventory.json"
    $auditPath = Join-Path $runDirectory "$safeName-audit.txt"

    if (-not $SkipInventoryGeneration) {
        Push-Location $RepositoryRoot
        try {
            Assert-ExternalCommand -Command { pnpm licenses list --prod --json | Set-Content -LiteralPath $licensePath -Encoding utf8 } -FailureMessage "$RepositoryName license inventory generation failed"
            Assert-ExternalCommand -Command { pnpm list --prod --json --depth Infinity | Set-Content -LiteralPath $dependencyPath -Encoding utf8 } -FailureMessage "$RepositoryName dependency inventory generation failed"
            pnpm audit --prod --audit-level high *> $auditPath
            if ($LASTEXITCODE -ne 0) {
                throw "$RepositoryName production dependency audit failed"
            }
        }
        finally {
            Pop-Location
        }
    }
    if (-not (Test-Path -LiteralPath $licensePath) -or (Get-Item -LiteralPath $licensePath).Length -le 2) {
        throw "$RepositoryName license inventory is missing or empty"
    }
    if (-not (Test-Path -LiteralPath $dependencyPath) -or (Get-Item -LiteralPath $dependencyPath).Length -le 2) {
        throw "$RepositoryName dependency inventory is missing or empty"
    }
    $licenseJson = Read-JsonFile -Path $licensePath
    $dependencyJson = Read-JsonFile -Path $dependencyPath
    return [ordered]@{
        repository = $RepositoryName
        licenseInventory = $licensePath
        licenseInventoryBytes = (Get-Item -LiteralPath $licensePath).Length
        licenseInventoryItemCount = ConvertTo-ItemCount -Json $licenseJson
        dependencyInventory = $dependencyPath
        dependencyInventoryBytes = (Get-Item -LiteralPath $dependencyPath).Length
        dependencyInventoryItemCount = ConvertTo-ItemCount -Json $dependencyJson
        auditOutput = $auditPath
    }
}

$releaseBundle = Read-JsonFile -Path $ReleaseBundleVerification
$legal = Read-JsonFile -Path $LegalSummary
$qualification = Read-JsonFile -Path $ReleaseQualification
$gates = New-Object System.Collections.Generic.List[object]

$requiredLegalResources = @('BINARY-LICENSE.txt', 'LICENSE-SCOPE.txt', 'THIRD_PARTY_NOTICES.txt', 'CREDITS.html')
$bundleLegal = @($releaseBundle.artifact.requiredLegalResources)
$missingBundleLegal = @($requiredLegalResources | Where-Object { $bundleLegal -notcontains $_ })
$gates.Add((New-Gate -Id 'release-artifact-signature-hash' -Label 'Release artifact signature, hash and public archive safety' -Status $(if ($releaseBundle.status -eq 'QUALIFIED' -and $missingBundleLegal.Count -eq 0) { 'PASS' } else { 'FAIL' }) -Details @{
    keyId = $releaseBundle.keyId
    artifactSha256 = $releaseBundle.artifactSha256
    browserSha256 = $releaseBundle.browserSha256
    driverSha256 = $releaseBundle.driverSha256
    manifestSha256 = $releaseBundle.manifest.sha256
    artifactUrl = $releaseBundle.artifact.url
    missingLegalResources = $missingBundleLegal
}))

$legalArtifacts = @($legal.artifacts)
$legalArchivePaths = @($legalArtifacts | ForEach-Object { $_.archivePath })
$missingLegalSummary = @($requiredLegalResources | Where-Object { $legalArchivePaths -notcontains $_ })
$invalidLegalArtifacts = @($legalArtifacts | Where-Object { -not $_.sha256 -or $_.sha256 -notmatch '^[a-f0-9]{64}$' -or $_.size -le 0 })
$gates.Add((New-Gate -Id 'legal-license-inventory' -Label 'Chromium and third-party legal/license inventory' -Status $(if ($missingLegalSummary.Count -eq 0 -and $invalidLegalArtifacts.Count -eq 0) { 'PASS' } else { 'FAIL' }) -Details @{
    artifactCount = $legalArtifacts.Count
    requiredArchiveFiles = @($legal.requiredArchiveFiles)
    missingRequiredArchiveFiles = $missingLegalSummary
    invalidArtifactCount = $invalidLegalArtifacts.Count
    source = $LegalSummary
}))

$inventoryResults = @(
    Invoke-Inventory -RepositoryName 'SlyBrowser' -RepositoryRoot $SlyBrowserRoot
    Invoke-Inventory -RepositoryName 'slybrowser-websites' -RepositoryRoot $WebsiteRoot
)
$gates.Add((New-Gate -Id 'dependency-license-inventory' -Label 'Repository production dependency and license inventories' -Status 'PASS' -Details @{
    repositories = $inventoryResults
}))

$requiredQualificationGateIds = @('release-bundle', 'redacted-report-contract', 'production-security-matrix')
$qualificationGates = @($qualification.gates)
$failedQualificationGates = @($qualificationGates | Where-Object { $requiredQualificationGateIds -contains $_.id -and $_.status -ne 'PASS' })
$missingQualificationGates = @($requiredQualificationGateIds | Where-Object { $id = $_; -not ($qualificationGates | Where-Object { $_.id -eq $id }) })
$gates.Add((New-Gate -Id 'release-security-qualification-inputs' -Label 'Supply-chain relevant release qualification gates' -Status $(if ($failedQualificationGates.Count -eq 0 -and $missingQualificationGates.Count -eq 0) { 'PASS' } else { 'FAIL' }) -Details @{
    requiredGateIds = $requiredQualificationGateIds
    failedGateIds = @($failedQualificationGates | ForEach-Object { $_.id })
    missingGateIds = $missingQualificationGates
    qualificationStatus = $qualification.status
    ignoredNonSupplyChainFailures = @($qualificationGates | Where-Object { $_.status -ne 'PASS' -and $requiredQualificationGateIds -notcontains $_.id } | ForEach-Object { $_.id })
}))

$workflowFiles = @(
    Join-Path $SlyBrowserRoot '.github\workflows\sdk-platform-matrix.yml'
    Join-Path $SlyBrowserRoot '.github\workflows\codeql.yml'
    Join-Path $WebsiteRoot '.github\workflows\web-platform.yml'
    Join-Path $WebsiteRoot '.github\workflows\codeql.yml'
)
$workflowText = ($workflowFiles | ForEach-Object {
    if (Test-Path -LiteralPath $_) { Get-Content -Raw -LiteralPath $_ } else { '' }
}) -join "`n"
$workflowChecks = [ordered]@{
    dependencyAudit = $workflowText -match 'pnpm audit --prod --audit-level high'
    licenseInventory = $workflowText -match 'pnpm licenses list --prod --json'
    dependencyInventory = $workflowText -match 'pnpm list --prod --json --depth Infinity'
    codeql = $workflowText -match 'github/codeql-action/analyze'
    leastPrivilegeContentsRead = $workflowText -match 'contents:\s*read'
    codeqlSecurityEventsWrite = $workflowText -match 'security-events:\s*write'
}
$gates.Add((New-Gate -Id 'ci-supply-chain-guards' -Label 'CI dependency audit, inventory and CodeQL guards' -Status $(if (($workflowChecks.Values | Where-Object { $_ -ne $true }).Count -eq 0) { 'PASS' } else { 'FAIL' }) -Details @{
    workflowFiles = $workflowFiles
    checks = $workflowChecks
}))

if ($ProductionSecretDomainReport) {
    $secretReport = Read-JsonFile -Path $ProductionSecretDomainReport
    $keyFiles = @($secretReport.keyFiles.PSObject.Properties | ForEach-Object { $_.Value })
    $badKeyFiles = @($keyFiles | Where-Object { $_.present -ne $true -or ($_.mode -ne '0o600' -and $_.mode -ne '0o640') })
    $secretStatus = if (
        @($secretReport.missingRequired).Count -eq 0 -and
        $secretReport.separation.onlineVsLicenseFileKeyPathDifferent -eq $true -and
        $secretReport.separation.onlineVsLicenseFileKeyIdDifferent -eq $true -and
        $badKeyFiles.Count -eq 0
    ) { 'PASS' } else { 'FAIL' }
    $gates.Add((New-Gate -Id 'production-secret-domain-separation' -Label 'Production secret/key domain separation' -Status $secretStatus -Details @{
        source = $ProductionSecretDomainReport
        missingRequired = @($secretReport.missingRequired)
        keyFileCount = $keyFiles.Count
        badKeyFileCount = $badKeyFiles.Count
        separation = $secretReport.separation
    }))
} else {
    $gates.Add((New-Gate -Id 'production-secret-domain-separation' -Label 'Production secret/key domain separation' -Status 'EXTERNAL' -Details @{
        reason = 'No production secret domain report supplied'
    }))
}

$publishControls = [ordered]@{
    githubReleaseProtectedEnvironment = $env:SLY_GITHUB_RELEASE_PROTECTED_ENV_VERIFIED -eq '1'
    npmTrustedPublishingOrTwoFactor = $env:SLY_NPM_PUBLISH_2FA_VERIFIED -eq '1'
    pypiTrustedPublishingOrTwoFactor = $env:SLY_PYPI_PUBLISH_2FA_VERIFIED -eq '1'
    mavenCentralTwoFactor = $env:SLY_MAVEN_CENTRAL_PUBLISH_2FA_VERIFIED -eq '1'
    nugetTwoFactor = $env:SLY_NUGET_PUBLISH_2FA_VERIFIED -eq '1'
}
$publishStatus = if (($publishControls.Values | Where-Object { $_ -ne $true }).Count -eq 0) { 'PASS' } else { 'EXTERNAL' }
$gates.Add((New-Gate -Id 'package-publish-account-controls' -Label 'Package registry and GitHub release token/2FA/protected environment controls' -Status $publishStatus -Details @{
    checks = $publishControls
    reason = if ($publishStatus -eq 'EXTERNAL') { 'Registry/GitHub account-level 2FA and protected-environment settings require authenticated provider-side verification' } else { $null }
}))

$status = if (($gates | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) {
    'FAIL'
} elseif (($gates | Where-Object { $_.status -eq 'EXTERNAL' }).Count -gt 0) {
    'EXTERNAL'
} else {
    'PASS'
}

$jsonPath = Join-Path $runDirectory 'supply-chain-production-gate.json'
$markdownPath = Join-Path $runDirectory 'supply-chain-production-gate.md'

$report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    status = $status
    evidence = [ordered]@{
        directory = $runDirectory
        jsonPath = $jsonPath
        markdownPath = $markdownPath
    }
    release = [ordered]@{
        product = 'SlyBrowser'
        browserVersion = $releaseBundle.browserVersion
        platform = $releaseBundle.platform
        arch = $releaseBundle.arch
        artifactSha256 = $releaseBundle.artifactSha256
        manifestSha256 = $releaseBundle.manifest.sha256
    }
    gates = @($gates | ForEach-Object { $_ })
}
$report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $jsonPath -Encoding utf8

$lines = @(
    '# SlyBrowser supply-chain production gate',
    '',
    "Generated: $($report.generatedAt)",
    "Status: $($report.status)",
    '',
    '| Gate | Status | Notes |',
    '| --- | --- | --- |'
)
foreach ($gate in $gates) {
    $notes = @(
        if ($gate.artifactSha256) { "artifact $($gate.artifactSha256)" }
        if ($gate.manifestSha256) { "manifest $($gate.manifestSha256)" }
        if ($gate.artifactCount -ne $null) { "$($gate.artifactCount) legal artifacts" }
        if ($gate.repositories) { "$(@($gate.repositories).Count) repos inventoried" }
        if ($gate.missingRequired -and @($gate.missingRequired).Count -gt 0) { "missing: $($gate.missingRequired -join ', ')" }
        if ($gate.reason) { $gate.reason }
    ) -join '; '
    $lines += "| $($gate.label) | $($gate.status) | $($notes -replace '\|','/') |"
}
$lines += ''
$lines += "Summary JSON: $jsonPath"
$lines | Set-Content -LiteralPath $markdownPath -Encoding utf8

Write-Output $jsonPath
