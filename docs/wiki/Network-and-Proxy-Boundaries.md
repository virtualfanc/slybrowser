# Network and proxy boundaries

## Installation

Network behavior is part of the Browser runtime; there is no separate routing package.

## Configuration

Use only modes declared by the current public launch contract. Unsupported proxy,
geolocation, WebRTC replacement, or route options are rejected.

## API and example

When a supported proxy mode is enabled, validate the configured route and the expected
exit behavior before treating the session as usable.

## Errors

Authentication failure, an unreachable proxy, DNS or WebRTC route-integrity failure,
or an unsupported field must never fall back to a direct connection.

## Limitations

The first public release may intentionally exclude modes documented as unsupported.

## Platforms

Network, DNS, WebRTC, process, and container edges require target-specific Evidence.
