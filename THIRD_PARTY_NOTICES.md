# Third-party notices

SlyBrowser is built from Chromium and includes many independently licensed components.
This repository does not claim ownership of those projects.

This file is a release-process notice, not a complete credits bundle. The final credits
must be generated from the exact Chromium revision and dependency graph used for each
browser build. A stale copied list is not sufficient.

For every distributable browser build:

1. Run Chromium's license scanner against the source checkout.
2. Generate the browser credits/attribution output from that exact checkout.
3. Confirm the credits page is reachable in the packaged browser.
4. Reproduce license text in the distribution where an upstream license requires it.
5. Retain the Chromium BSD notice in binary documentation and release materials.
6. Record the Chromium commit/tag and SlyBrowser patch revision in the release manifest.

Chromium's top-level source is distributed under a BSD-style license. Individual
directories and dependencies may use different terms. The source checkout's license
metadata and generated credits are authoritative for the corresponding build.
