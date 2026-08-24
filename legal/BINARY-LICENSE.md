# SlyBrowser Binary Distribution Terms

Version: `2026-08-24-launch`

Status: owner-approved launch terms for the personal/GitHub-channel release.

These terms apply only to SlyBrowser-owned proprietary material in an official
compiled SlyBrowser browser/WebDriver distribution and to access to official
SlyBrowser download, update, license and runtime-authorization services.

They do not apply to SDK source code in this repository, which remains licensed under
the repository license, and they do not reduce or replace rights granted directly by
Chromium or bundled third-party open-source licenses. If an upstream component license
gives a recipient a right for that component, that upstream license controls for that
component.

## 1. Official channel

An official SlyBrowser browser binary, project WebDriver, private module or release
artifact must be downloaded from an authorized SlyBrowser release channel and verified
against a signed SlyBrowser release manifest.

Unofficial repackaged, modified, renamed, mirrored or embedded binaries are not
authorized SlyBrowser releases.

## 2. Use grant

A customer with an active Free, Launch, Studio, Fleet or Grid entitlement may use the
official SlyBrowser browser binary and project WebDriver for their own authorized QA,
monitoring, research, compatibility testing and responsible automation, subject to the
plan's signed feature and concurrent-browser limits.

The Free plan may be used long term at one concurrent browser process. Paid plans add
the signed capacity and feature set associated with the purchased SKU while the paid
entitlement remains active.

Enterprise, OEM, SaaS, resale, redistribution, white-label, hosted third-party use,
offline deployment, custom capacity and SLA terms are not included in normal
self-serve plans. They require a separate owner-approved SKU or written authorization.

## 3. Restrictions

Without separate written authorization, a recipient must not:

- redistribute, resell, rent, sublicense, mirror, repackage or embed the official
  SlyBrowser browser binary, project WebDriver, private modules or private release
  artifacts for other customers;
- remove or hide SlyBrowser, Chromium or third-party copyright, license or notice
  files included with a release;
- bypass, disable, forge, replay or interfere with SlyBrowser license checks, release
  manifest verification, browser/WebDriver pairing, runtime authorization, heartbeat,
  concurrency limits, feature limits or revocation;
- publish license keys, license files, runtime tokens, bootstrap tokens, download
  tickets, private modules, signing material or non-public release artifacts;
- use SlyBrowser for unlawful access, credential attacks, fraud, spam, unauthorized
  account creation, malware delivery, identity theft, or automation on systems the user
  does not own or have permission to test.

These restrictions apply only to SlyBrowser-owned proprietary material and service
access. They are not intended to prohibit activities that an applicable open-source
license or mandatory law permits for an upstream component.

## 4. License files, refunds and expiry

License files and credentials are assigned to the purchasing customer and delivery
email. They must be kept private.

SlyBrowser supports full-order refunds only. A completed full refund immediately ends
paid entitlement for that order, releases paid concurrency on the next heartbeat and
leaves only Free-plan access available. Cancellation stops the next renewal but keeps
the current paid-through period. Failed renewal has no additional paid-access grace
period.

## 5. Updates and availability

SlyBrowser may require online startup validation, runtime heartbeats and exact
browser/WebDriver/release pairing. A release may be revoked when necessary for security,
licensing, integrity, compatibility, legal or operational reasons.

No plan guarantees that any third-party website, detection stack or account workflow
will accept automation.

## 6. Required notices

Every official browser release package must include at least:

- `BINARY-LICENSE.txt` — these SlyBrowser binary terms;
- `LICENSE-SCOPE.txt` — the repository/binary/open-source boundary;
- `THIRD_PARTY_NOTICES.txt` — notices generated from the exact Chromium build
  checkout;
- `CREDITS.html` — Chromium about://credits generated from the exact Chromium build
  checkout.

Release automation must fail closed when these files are missing from the signed
manifest, missing from the archive, empty, or mismatched by SHA-256.
