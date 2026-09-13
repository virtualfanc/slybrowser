# Public scripts

These scripts validate public contracts, SDKs, release metadata, and explicitly supplied Browser/Driver candidates. They do not contain website, payment, license-service, server deployment, or Chromium source operations.

## Repository checks

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm delivery:test
```

`Test-Repository.ps1` combines the local public-repository checks. Delivery commands in `package.json` produce candidate-bound diagnostic receipts; a pass does not authorize commit, push, publication, deployment, or release.

## SDK packages

- `release/Set-SdkPackageVersion.ps1` keeps the four SDK versions aligned.
- `release/Publish-SdkPackages.ps1` builds packages and publishes only when explicitly invoked with the publication option.

Run the package-specific tests before any authorized registry action.

## Release contracts

- `release/New-UnsignedManifest.ps1` creates an unsigned Manifest from exact artifact metadata.
- `release/Sign-ReleaseManifest.mjs` signs a prepared Manifest with an explicitly supplied key.
- `release/Verify-ReleaseBundle.mjs` verifies Manifest, artifact, Browser/Driver, legal-file, and optional supply-chain evidence.
- `release/Generate-SupplyChainEvidence.mjs` creates public SBOM/provenance inputs.
- `release/Build-QualificationReport.mjs` summarizes saved evidence without claiming unrun checks.

Current runtime archives are `.7z` with SHA-256 and MD5 sidecars. Browser packaging, server synchronization, webhook checks, and direct deployment are owned by the private repositories.

## Browser QA

Scripts under `browser/` require explicit SlyBrowser and Sly WebDriver paths and fail closed on mismatch or missing authorization. Generated logs and reports stay in ignored local evidence directories. Detection or competitor claims require dated, reproducible evidence and cannot promise universal bypass or invisibility.
