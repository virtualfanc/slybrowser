# Browser and WebDriver pairing

## Installation

Install Browser and project WebDriver from the same authorized release package.

## Configuration

Keep the exact package-selected executable paths. Node.js and Python must not silently
switch to a system browser or Driver.

## API and example

Launch through the binding's Sly WebDriver service. Pairing checks compare the release,
expected executable identity, version, and binary hash before a session is created.

## Errors

Missing sibling binaries, version mismatch, hash mismatch, or an unsupported executable
name is rejected before downstream automation starts.

## Limitations

Copying one executable does not create a valid pair. Source-only and mock tests cannot
qualify a packaged pair.

## Platforms

Each platform and architecture needs its own dated pairing and launch Evidence.
