# Security policy

## Supported versions

SlyBrowser is in private preview. Only the latest preview SDK and browser build receive
security fixes. A public version-support table will be published with the first release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, leaked signing material,
license bypass, or browser sandbox escape. Use the repository's private GitHub Security
Advisory reporting flow and include:

- affected SDK and browser versions;
- operating system and architecture;
- minimal reproduction steps;
- expected and observed behavior;
- impact and whether active exploitation is known.

Do not include real user credentials, license keys, private customer data, or signing
keys. The project owner will acknowledge a complete report, coordinate validation, and
publish a remediation timeline appropriate to its severity.

## Secret handling

Private signing keys, service credentials, Google API keys, and production license keys
must never be committed. Release manifests are signed outside CI or through a protected
signing service; only public verification keys may be stored in source.
