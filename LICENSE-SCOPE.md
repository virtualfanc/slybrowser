# License scope

This document explains which SlyBrowser materials are covered by which license. It is
part of the repository documentation and does not replace any license text.

## MIT-licensed repository source

Unless a file states otherwise, the SDK source, automation scripts, JSON schemas,
tests, examples, and documentation stored in this repository are licensed under the
[MIT License](LICENSE).

The MIT License does **not** apply merely because a file is downloaded by an
MIT-licensed SDK. In particular, it does not cover a SlyBrowser browser executable,
its proprietary resources, private signing material, hosted services, or unpublished
Chromium modifications.

## Browser binary

A compiled SlyBrowser browser release is a separate deliverable. Each release must
include or link to the effective binary license for SlyBrowser-owned material and must
also reproduce all notices required by Chromium and bundled third-party components.

The current launch binary terms are maintained in
[`legal/BINARY-LICENSE.md`](legal/BINARY-LICENSE.md). They cover only SlyBrowser-owned
proprietary browser/WebDriver material and official service access; they do not replace
or narrow Chromium or third-party open-source licenses.

Every official browser release package must include `BINARY-LICENSE.txt`,
`LICENSE-SCOPE.txt`, `THIRD_PARTY_NOTICES.txt`, and `CREDITS.html` generated or copied
for the exact release. Release verification fails when those files are missing from the
signed manifest or archive.

No SlyBrowser commercial term is intended to restrict rights that a recipient receives
directly under an applicable open-source license. If terms conflict for an upstream
component, the upstream component's license controls for that component.

## Private Chromium source

The private source checkout contains both upstream open-source code and SlyBrowser
changes. Keeping that checkout private does not remove upstream copyright notices or
third-party obligations. Every shipped build must pass the Chromium license scan and
generate credits from the exact source revision used for the build.

## Brand assets

The SlyBrowser name and logo identify the project and are not granted under the MIT
License. They may be used factually to refer to SlyBrowser, but modified products must
not imply that they are official SlyBrowser releases. See [TRADEMARKS.md](TRADEMARKS.md).

## Contributions

Unless agreed otherwise in writing, contributions submitted to this repository are
licensed under MIT. A contributor must have the right to submit the contribution and
must preserve notices for incorporated third-party material.
