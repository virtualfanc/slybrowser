# Release process

SlyBrowser has four release lanes: GitHub, the official website, four SDK packages,
and a new browser kernel. One immutable candidate is qualified before its release
targets consume the result independently.

## 1. Freeze the candidate

Record the exact source, artifacts, runtime configuration, policy, test plan, and
toolchain for the lane. For a new kernel, also bind the patch, six artifact identities,
and Browser/WebDriver version and SHA-256 pairing. Any change to a bound input creates a
new candidate.

## 2. Qualify once

- Run checks required by the change class and affected surface. Verify package files,
  legal resources, signatures, hashes, safe paths, and private-content boundaries where
  applicable.
- For a new kernel, verify Browser/WebDriver pairing and run native unit, integration,
  and end-to-end coverage on Windows x64, Linux x64, and macOS arm64. Secondary
  architectures receive package checks and representative coverage, never a reported
  native pass.
- Verify affected license, Manifest, download, proxy, configuration, and tamper failures
  close safely. Produce an identity-bound qualification passport for the artifact set.

Unchanged candidates reuse the passport. Re-run only checks invalidated by changed
source, artifacts, policy, test plan, toolchain, security intelligence, or a prior test
failure.

CI keeps a stable summary and public-content guard for every change. It runs affected
bindings and delivery layers on a representative system; shared contracts, release
tooling, and unknown paths expand coverage. The complete compatibility matrix needs an
explicit dispatch bound to the checked-out candidate SHA. It does not replace the
artifact-bound qualification passport.
For Node changes, lint/typecheck and the Node test matrix start after scope selection
and run independently; the stable summary requires both results.

## 3. Release through one of four lanes

Every external target needs its own credential and environment preflight, exact-byte
check, authorization for the candidate and action, execution receipt, and remote
readback. A failed target stops that target. An unchanged candidate keeps its valid
qualification passport.

### GitHub release

The cumulative public-commit gate displays two groups for one exact candidate:

| Group | Required component receipts |
| --- | --- |
| Public content and documentation | `security`, `documentation`, `staged-file-audit` |
| Change and test evidence | `rgr`, `governance` |

All five component receipts must independently be `pass` and bind the same candidate;
grouping does not create a substitute receipt. The security scanner owns the staged
whitespace check. `staged-file-audit` checks the staged inventory and prohibited paths
without running that command again. Run the 12 four-binding cases (four SDKs × unit,
integration, packaged E2E) only when the change context requires them. Otherwise record
`not_applicable`, never a test pass.

Publish the qualified public SDK source. Create a GitHub Release with the approved
assets only when that target applies. Source push and Release are separate actions;
read back the remote commit and, for a Release, its tag, asset list, and anonymously
downloaded bytes.

### Official website release

Deploy the approved website and service build from the private website repository.
Check the deployment bytes and runtime configuration, then read back the official site
and affected service behavior. Payment changes follow the official-site production
acceptance rules; local build checks do not establish payment acceptance.

### Four SDK package releases

Publish the four language packages from one verified frozen eight-file release set:
Node.js to npm, Python to PyPI, Java to Maven Central, and .NET to NuGet. Each registry
is a separate promotion target with its own credential preflight, authorization,
publication, public-registry readback, and receipt. Run the frozen local publisher for
one registry at a time; one registry's result never gates another.

### New browser kernel release

Build and qualify the paired SlyBrowser and Sly WebDriver runtime for all six declared
targets under one kernel candidate. Verify package identities and the representative
native runtime matrix, then deliver the immutable runtime archives and signed Manifest
through the authorized private release service. Read back the published hashes,
Manifest, and clean-install client path. The kernel is not shipped as SDK source or in
the four language packages.

## 4. Verify online or roll back

Run the target's post-release smoke checks and public readback after every release.
Keep the previous supported runtime artifact and Manifest available. Revoke a bad
release and publish a new immutable version; never overwrite a published archive or
Manifest silently.
