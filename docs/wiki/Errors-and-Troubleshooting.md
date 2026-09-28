# Errors and troubleshooting

## Installation

Keep the SDK, signed manifest, package, Browser, and project WebDriver versions aligned.

## Configuration

Validate inputs against the public schemas before launch and keep diagnostic logging
redacted.

## API and example

Catch the stable public error code and present its safe message. Preserve the original
failure boundary instead of retrying with a different browser, Driver, route, or field.

## Errors

Common classes cover configuration, authorization, release selection, download,
signature/hash verification, pairing, launch, and session behavior. Refer to the
machine-readable error-code contract for exact identifiers.

## Limitations

Public diagnostics intentionally omit private source paths, patch details, credentials,
and bypass recipes.

## Platforms

Collect target-specific command, runtime, filesystem, and package identity before
comparing failures between operating systems.
