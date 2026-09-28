# SlyBrowser SDK 0.2.1 · Chromium 148.0.7778.179

Chromium 148.0.7778.179 is available for Windows, Linux, and macOS on x64 and ARM64. Each archive contains SlyBrowser and its matched WebDriver. The six browser archives and the final Node.js, Python, Java, and .NET SDK packages are attached below.

## Browser archives

| Platform | Release asset |
| --- | --- |
| Windows x64 | `slybrowser-148.0.7778.179-win-x64.7z` |
| Windows ARM64 | `slybrowser-148.0.7778.179-win-arm64.7z` |
| Linux x64 | `slybrowser-148.0.7778.179-linux-x64.7z` |
| Linux ARM64 | `slybrowser-148.0.7778.179-linux-arm64.7z` |
| macOS x64 | `slybrowser-148.0.7778.179-mac-x64.7z` |
| macOS ARM64 | `slybrowser-148.0.7778.179-mac-arm64.7z` |

The signed release Manifest remains the source of version, platform, signature, and SHA-256 information. The SDK installer currently reads that Manifest and downloads from the SlyBrowser release service. GitHub assets are a second distribution location; switching the installer to these URLs will be a separate signed Manifest update.

## Install 148.0.7778.179

Node.js:

```sh
npm install slybrowser@0.2.1
npx slybrowser license info --authorization ./account.authorization.json --version 148.0.7778.179
npx slybrowser install --authorization ./account.authorization.json --version 148.0.7778.179
```

Python:

```sh
python -m pip install slybrowser==0.2.1
python -m slybrowser install --authorization ./account.authorization.json --version 148.0.7778.179
```

Use your own authorization file. The CLI installs and verifies the browser; launch a session through the SDK. Selection is limited by your license and the build available for your platform.

## SDK files

- **Node.js / TypeScript:** `slybrowser-0.2.1.tgz`
- **Python:** wheel and source archive
- **Java:** JAR, sources, Javadoc, and Maven POM
- **.NET:** `SlyBrowser.0.2.1.nupkg`

The SDKs share one launch model, 27 public profile groups, native human-like input, and exact browser/WebDriver pairing. Pro supports up to 20 concurrent browser processes. [Docs](https://github.com/virtualfanc/slybrowser/blob/main/README.md) · [Plans](https://slybrowser.com/#pricing)

In a saved Windows run, SlyBrowser scored **100/100** for core automation signals, page/frame/worker consistency, and the interaction check. Native human-like input scored **100/100** in each of the four SDK matrices. [Recorded results](https://github.com/virtualfanc/slybrowser/blob/main/docs/benchmark-latest.md). Results from one setup do not guarantee another site's outcome.
