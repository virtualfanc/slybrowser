# Authorized browser delivery

SlyBrowser SDKs obtain browser access through the public authorization and release contracts. Service implementation, deployment, secrets, storage, and operator commands are private and are not part of this repository.

## Client flow

1. Authenticate with the official service.
2. Request a release for the selected channel, platform, and architecture.
3. Verify the signed authorization and release Manifest.
4. Download the exact artifact named by the response.
5. Verify size, SHA-256, archive format, Browser identity, and Driver identity.
6. Extract into a private cache and launch only the paired Browser and Sly WebDriver.

The current release format is `.7z`. A runtime contains the Browser, its sibling Sly WebDriver, `BUILD-INFO.txt`, and required legal files. Symbols are separate.

## Failure behavior

Clients stop before launch when authorization is missing, expired, revoked, malformed, or inconsistent; when the Manifest signature or artifact hash fails; when Browser and Driver do not match; or when the requested platform is unsupported. They never fall back to system Chrome, a system Driver, Selenium Manager, or an unverified download.

## Public contracts

- `contracts/license-authorization.schema.json`
- `contracts/release-manifest.schema.json`
- `contracts/license-lease.schema.json`
- `contracts/error-codes.json`
- `contracts/platform-support.json`

See [Release process](release-process.md), [Browser and WebDriver pairing](webdriver-humanize-and-pairing.md), and [Licensing](licensing.md). Publishing or deployment requires separate authorization and private operational procedures.
