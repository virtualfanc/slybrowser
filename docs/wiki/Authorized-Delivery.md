# Authorized delivery

## Installation

Install one supported SDK and obtain authorization through the documented product flow.

## Configuration

Configure only public service endpoints and public verification keys. Private signing
material must never be embedded in an SDK, example, repository, or receipt.

For a proposed public commit, prepare one exact Git-index candidate and run the fixed
seven-scanner plan: staged diff, repository disclosure guard, type checking, lint,
Semgrep SAST, OSV dependency vulnerability, and Syft dependency-license inventory.
Tool versions and limitations are declared in `contracts/delivery/scanner-plan.json`.

## API and example

The SDK verifies the signed release manifest, requested platform and architecture,
release version, archive hash, Browser hash, and project WebDriver hash before launch.

Scanner runners create candidate-bound raw evidence. A separate receipt step verifies
the candidate, command, tool identity, raw-evidence digest, parsed findings, and
canonical plan. Incomplete or mismatched evidence cannot satisfy the public security
gate.

## Errors

Missing authorization, invalid signature, revocation, hash mismatch, or unavailable
exact version fails closed with a stable public error.

For public delivery, missing scanners, unavailable tools, version mismatch, incomplete
ecosystem coverage, candidate drift, or unresolved license metadata remain blocked;
high/critical findings and denied licenses fail.

## Limitations

Fixtures prove parser behavior only. Production delivery requires a real, dated
manifest and immutable Artifact receipt. Local scanner execution proves only what was
observed locally and does not grant commit or push authorization. Removing a path from
the current candidate also does not remove any copy already disclosed in Git history;
history remediation is a separate authorized operation.

## Platforms

Artifact selection is exact by operating system and architecture; another target is
never substituted.
