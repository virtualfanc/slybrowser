# Profile configuration

## Installation

Profile support is part of the public SDK and does not require an additional package.

## Configuration

Use fields declared by the public launch-options contract. Nested profile fields and
legacy flat fields must not be mixed when the contract forbids that combination.

## API and example

Pass the documented profile object to the high-level launch helper. Configuration must
remain consistent across pages, frames, workers, persistent contexts, CDP, and W3C.

## Errors

Unknown, malformed, or unsupported fields fail at the first validation or handoff
boundary with a stable error.

## Limitations

Reserved fields are not partially implemented. Unsupported proxy or WebRTC modes are
rejected rather than silently dropped.

## Platforms

Path, permissions, line endings, process behavior, and persistent-profile semantics are
validated independently for each supported target.
