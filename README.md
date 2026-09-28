<p align="center"><img src="assets/brand/icon.svg" width="96" alt="SlyBrowser icon"></p>

# SlyBrowser

**Chromium with profiles, a matched driver, and native human-like input.**

SlyBrowser keeps the browser, driver, and profile together. The SDK selects the latest signed Chromium-based build available for your platform. Start with a [90-day Free license](https://slybrowser.com/free-license).

## Why SlyBrowser

- **27 profile groups** in the public fingerprint configuration contract. Thirteen stable groups have browser-level checks across pages, frames, workers, and network surfaces.
- **A browser and driver that belong together.** The SDK checks the pair and stops if a matching build is unavailable.
- **Human-like input built into WebDriver.** Click and typing flows use the same native path from Node.js, Python, Java, and .NET.
- **Signed updates.** Downloads are checked against signed manifests and file hashes.

## Free and Pro

Free runs one browser process at a time. **Pro runs up to 20 concurrent browser processes** and uses the same signed latest-build selection, profile controls, and native input. [See Pro](https://slybrowser.com/#pricing).

## Results from a saved run

SlyBrowser and stock Chromium ran on the same Windows host and network in one time window. They used different automation paths, so this is a snapshot of those setups. Every SlyBrowser result shown below reached **100/100**.

| Check | SlyBrowser | Stock Chromium |
| --- | ---: | ---: |
| Core automation signals | **100/100** | 80/100 |
| Page, frame, and worker consistency | **100/100** | 94.44/100 |
| Device & Browser Info interaction | **100/100** | 69.23/100 |

The native human-like input matrix also scored **100/100 in each of the four SDKs**: Node.js, Python, Java, and .NET. It covered page and frame interaction, clicking, and typing. A separate submitted interaction check scored **100/100** in its saved regression run.

[Read the dated results](docs/benchmark-latest.md) and [release notes](docs/release-notes.md). Detection sites can change, and a score from one run is not a guarantee for another site.

## SDKs

| Language | Guide |
| --- | --- |
| [TypeScript / Node.js](packages/node/README.md) | [Examples](packages/node/examples/README.md) |
| [Python](packages/python/README.md) | [User API](docs/user-api.md) |
| [Java](packages/java/README.md) | [User API](docs/user-api.md) |
| [.NET](packages/dotnet/README.md) | [User API](docs/user-api.md) |

The browser binary and SDKs have separate terms. See the [browser license](legal/BINARY-LICENSE.md).
