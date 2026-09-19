# Changelog

All notable user-visible changes will be documented here once preview releases begin.

The format follows Keep a Changelog principles, and versions will follow Semantic
Versioning for SDK packages. Browser versions additionally record their Chromium base.

## [0.2.0] - 2026-09-15

### Added

- One authorization-file launch API across Node.js, Python, Java, and .NET.
- Package-managed Browser download, signed release verification, exact Sly WebDriver
  pairing, Playwright adapters in all four bindings, and a Node.js Puppeteer adapter.
- An immutable eight-artifact SDK release set with protected registry publication and
  registry readback verification.

### Security

- User-supplied executable paths, trust keys, short-lived leases, and system
  Browser/Driver fallback are excluded from the public launch API.

## [Unreleased]

### Changed

- Consolidated public delivery guidance, removed internal planning drafts and private operations, and added fail-closed repository boundaries for those materials.

### Added

- Initial SlyBrowser repository structure and shared configuration contracts.
- Approved brand assets for application, package, and documentation use.
- Explicit SDK, proprietary binary, third-party, and trademark license boundaries.
- Version-controlled full-feature Wiki source and exact-candidate delivery gate
  contracts with unit, integration, and CLI end-to-end regression coverage.
- A fixed seven-scanner public-candidate plan for staged-diff checks, repository
  disclosure guard, type checking, lint, Semgrep SAST, OSV dependency vulnerability
  scanning, and Syft dependency-license inventory. Verified runner output is bound to
  the exact Git index and retained as candidate-specific evidence.

### Fixed

- Kept the Python, Java, and .NET exported public authorization error-code inventories
  in parity with the canonical contract and Node.js binding.
- Removed private service, website-source, and internal research paths from the current
  public candidate; removed local machine paths and credential-shaped fixture literals
  from public material; and upgraded affected Java dependencies before re-scanning.
- Added a hash-pinned Python dependency inventory and NuGet lock files so OSV coverage
  for all four public SDK ecosystems is reproducible from candidate-controlled inputs.

### Security

- Public candidate checks now fail closed on missing scanner inputs, tool/version
  mismatch, candidate drift, incomplete npm/PyPI/Maven/NuGet coverage, unresolved
  high/critical vulnerabilities, and denied, unknown, or review-required licenses.
- Current-tree cleanup does not erase historical Git disclosure. History review,
  rewrite, credential rotation, or remote publication requires separate authorization
  and independently retained evidence.
