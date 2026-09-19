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
- `release/Publish-SdkPackages.ps1` performs source-tree package validation only;
  direct source-tree publication is disabled.
- `release/Build-SdkReleaseSet.ps1` builds the eight canonical artifacts and binds
  them to an exact Git tree and release-set digest.
- `release/Verify-SdkReleaseSet.mjs` rejects missing, extra, changed, mixed-version,
  source-tree-mismatched, or digest-mismatched release sets.
- `release/Verify-SdkReleaseAuthorization.mjs` requires a candidate-bound authorization
  receipt whose exact SHA-256 is stored in the protected registry environment. The
  receipt fixes the candidate ID, release tag, source tree, version, and SDK set ID;
  workflow-dispatch input cannot replace those identities.
- The four `sdk-publish-*` workflows publish only `sdk-v0.2.0` assets after protected
  environment approval. npm, PyPI, and NuGet use OIDC trusted publishing; Maven
  Central uses its protected portal token and GPG signing key. Maven credentials are
  scoped only to their import or publication step.

Run package-specific tests and verify the complete release set before any authorized
registry action. Every workflow verifies registry readback before reporting success.

## Release contracts

- `release/New-UnsignedManifest.ps1` creates an unsigned Manifest from exact artifact metadata.
- `release/Sign-ReleaseManifest.mjs` signs a prepared Manifest with an explicitly supplied key.
- `release/Verify-ReleaseBundle.mjs` verifies Manifest, artifact, Browser/Driver, legal-file, and optional supply-chain evidence.
- `release/Generate-SupplyChainEvidence.mjs` creates public SBOM/provenance inputs.
- `release/Build-QualificationReport.mjs` summarizes saved evidence without claiming unrun checks.

Current runtime archives are `.7z` with SHA-256 and MD5 sidecars. Browser packaging, server synchronization, webhook checks, and direct deployment are owned by the private repositories.

## Browser QA

Scripts under `browser/` require explicit SlyBrowser and Sly WebDriver paths and fail closed on mismatch or missing authorization. Generated logs and reports stay in ignored local evidence directories. Detection or competitor claims require dated, reproducible evidence and cannot promise universal bypass or invisibility.
