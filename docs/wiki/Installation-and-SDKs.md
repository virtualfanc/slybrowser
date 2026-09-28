# Installation and SDKs

## Installation

Use the package manager documented by the selected binding. The public bindings are
Node.js, Python, Java, and .NET. An SDK package does not include a Browser executable.

| Language | Install |
| --- | --- |
| Node.js | `npm install slybrowser@0.2.0` |
| Python | `pip install slybrowser==0.2.0` |
| Java | Maven coordinate `com.slybrowser:slybrowser:0.2.0` |
| .NET | `dotnet add package SlyBrowser --version 0.2.0` |

## Configuration

Provide the authorization file and optionally set `profile`, `launch`, and `humanize`.
No import command is required. Verification material, release selection, downloads,
and executable pairing remain inside the SDK. Do not configure a system browser or
driver fallback.

## API and example

Follow the [SDK user API](https://github.com/virtualfanc/slybrowser/blob/main/docs/user-api.md)
or the selected package README. A normal flow
validates the authorization file, verifies the exact package, and launches it through
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
