# Platform support

## Installation

Select the package matching the exact operating system and architecture declared by the
release service.

## Configuration

Do not force another architecture or use emulation as proof of a native target unless
the public contract explicitly defines that mode.

## API and example

Request the target through the authorized SDK flow. An absent exact release returns a
stable unavailable result.

## Errors

Undeclared target, absent Artifact, wrong executable, and mixed-version pairings fail
closed.

## Limitations

Contract-declared support and real release qualification are separate. A missing runner,
required skip, or unavailable Artifact remains blocked or not evaluated.

## Platforms

Windows, Linux, and macOS targets require independent unit, integration, and real E2E
receipts bound to one candidate before platform-dependent publication.
