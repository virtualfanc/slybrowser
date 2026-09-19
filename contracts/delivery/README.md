# Public delivery gate contracts

These contracts define local eligibility checks for a proposed public SlyBrowser
commit. They do not authorize a commit, push, publication, deployment, or release.

- `public-surface.json` is a fail-closed allowlist. Current-tree remediation does not
  approve or erase excluded server or website source already present in Git history.
- `security-policy.json` combines exact-index disclosure scanning with required
  external scanner receipts. An unavailable required scanner blocks eligibility.
- `history-audit.json` defines the only public refs and author/committer identities
  allowed after a history replacement. `history-audit.schema.json` defines its
  redacted receipt; findings never include matched secret values.
- `scanner-plan.json` fixes exactly seven scanner IDs, versions, scopes, parsers,
  network policies, timeouts, ecosystem coverage, and limitations. Caller-supplied
  commands or shell wrappers cannot replace the canonical plan.
- `license-policy.json` is fail-closed: denied licenses fail; unknown or
  review-required production licenses remain blocked until independently resolved.
- `semgrep-rules.yml` is the candidate-controlled offline SAST ruleset; metrics and
  caller-supplied remote rules are disabled by the scanner plan.
- `feature-coverage.json` maps active public features to local documentation and to
  external surfaces that require separate same-candidate receipts when affected.
- `four-binding-test-plan.json` requires unit, integration, and real packaged E2E
  receipts for Node.js, Python, Java, and .NET.
- `staged-file-policy.json` rejects temporary, local-instruction, credential, database,
  package, and binary material in the proposed staged inventory or untracked boundary.
- `aggregate-policy.json` accepts only one fresh, complete, same-candidate receipt set.

Receipt files are evidence inputs, not durable claims that an unavailable real
Browser/Driver, operating system, remote Wiki, GitHub About page, or official website
has passed.

## Local command sequence

Run the commands against one intentionally staged candidate. Store receipts in a
controlled location outside the repository; the placeholders below are not literal
paths.

```text
pnpm delivery:candidate -- --repo . --output <candidate-receipt>
pnpm delivery:scanner:run -- --repo . --candidate <candidate-receipt> --id <canonical-scanner-id> --raw-evidence <raw-evidence> --raw-evidence-reference <controlled-reference> --tool-paths <absolute-tool-path-map> --output <unsigned-runner-result>
pnpm delivery:scanner:receipt -- --repo . --candidate <candidate-receipt> --runner-result <runner-result> --raw-evidence <raw-evidence> --output <scanner-receipt>
pnpm delivery:staged-files -- --repo . --candidate <candidate-receipt> --output <staged-file-receipt>
pnpm delivery:security -- --repo . --candidate <candidate-receipt> --metadata <proposed-metadata> --scanner-receipts <scanner-receipt-directory> --output <security-receipt>
node scripts/delivery/history-audit-cli.mjs --repo . --output <history-receipt>
pnpm delivery:docs -- --repo . --candidate <candidate-receipt> --context <change-context> --external-receipts <documentation-receipt-directory> --output <documentation-receipt>
pnpm delivery:four-binding -- --repo . --candidate <candidate-receipt> --receipts <test-receipt-directory> --output <four-binding-receipt>
pnpm delivery:rgr -- --repo . --candidate <candidate-receipt> --rgr-receipt <phase-receipt> --output <rgr-gate-receipt>
pnpm delivery:aggregate -- --repo . --candidate <candidate-receipt> --context <change-context> --receipts <gate-receipt-directory> --output <cumulative-receipt>
```

Production CLIs always load policy, plan, and manifest data from the canonical
`contracts/delivery/` paths inside the candidate repository. Caller-supplied
`--policy`, `--surface`, `--plan`, or `--manifest` overrides are rejected. Each local
gate receipt records the canonical contract digests and exact index-manifest digest.

`<absolute-tool-path-map>` is a JSON object keyed by canonical scanner ID. Paths are
resolved without a shell; a pnpm override must identify its JavaScript entry point,
not a `.cmd` or `.bat` wrapper. The runner materializes only the exact index into an
isolated temporary directory and verifies candidate identity before, during, and after
execution. Exit codes are `0` pass, `1` fail, and `2` blocked.

The canonical scanners are `git-diff-check`, `repository-guard`, `typecheck`, `lint`,
`sast`, `dependency-vulnerability`, and `dependency-license`. OSV coverage must include
npm, PyPI, Maven, and NuGet resolution inputs. Syft output must cover the same four
ecosystems; missing or unknown license metadata cannot be converted into a pass.

Each receipt includes a controlled raw-evidence reference and SHA-256 digest, command
digest, exit code, and candidate index-manifest digest. The cumulative gate recomputes
the current Git index and verifies every required receipt against the canonical plans.
Missing, stale, mixed-tree, incomplete, or tampered evidence cannot establish
eligibility. Retired producer, signature, receipt-digest, and trust-registry fields are
rejected so an older signed-envelope workflow cannot silently reappear.

The documentation gate infers affected features from staged paths and rejects a change
context that omits an inferred feature. For an affected feature, the local public
surfaces and a same-candidate official-website-source receipt are commit requirements.
Remote Wiki, About, and website publication remain separate explicitly authorized
actions and stay `not_evaluated` until actually performed and verified.

The history audit is a separate fail-closed boundary for a repository whose refs may be
replaced. It walks every local head, remote-tracking ref and tag, scans every reachable
commit tree and unique text blob, and checks commit/author metadata. Deleting a private
path in a later commit cannot make this gate pass because the earlier tree and blob stay
reachable. Before a force push, remove or replace every unapproved ref, rewrite author
metadata to an approved project or GitHub noreply identity, and require a zero-finding
receipt for the exact refs that will be published. Keep the pre-rewrite backup only in
a controlled private location; never push that backup namespace to the public remote.

`pnpm delivery:wiki:dry-run -- --output <publication-receipt>` validates and optionally
exports the version-controlled Wiki source without contacting GitHub. The included
publisher intentionally refuses remote mode until an approved repository-specific
adapter and authorization receipt are implemented.
