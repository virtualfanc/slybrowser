# Installation and SDKs

## Installation

Use the package manager documented by the selected binding. The public bindings are
Node.js, Python, Java, and .NET. An SDK package does not include a Browser executable.

## Configuration

Configure the authorized release service and trusted public verification keys as
documented by the binding. Do not configure a system Chrome or system Driver fallback.
Current authorized runtime packages use `.7z`; install `7z` or `7zz` on the host, or set `SLYBROWSER_7Z_PATH`, before invoking automatic installation.

## API and example

Follow the quickstart in the root README and the selected package README. A normal flow
authorizes a release, downloads the exact package, verifies it, and launches it through
the project-built Sly WebDriver.

## Errors

Installation, manifest, platform, and pairing failures use the public error contract.
Treat verification failure as terminal; do not continue with a different binary.

## Limitations

An installed SDK alone does not prove that a real Browser/Driver package or target
platform is release-qualified.

## Platforms

See [Platform support](Platform-Support.md) for the declared runtime matrix and the
difference between contract support and real Artifact qualification.
