# Native Humanize

## Installation

Humanize is exposed by each public binding through the project-built Sly WebDriver.

## Configuration

Use the documented W3C capability and supported timing or motion options. Unsupported
capabilities fail closed.

## API and example

Call the binding's thin pointer or keyboard wrapper against a Page, Frame, or Element.
The native implementation remains in Sly WebDriver rather than page injection.

## Errors

Missing native capability, stale element, covered target, timeout, or invalid action
input returns the documented error instead of synthesizing success.

## Limitations

Playwright and Puppeteer use their documented framework adapters; they do not prove the
WebDriver-native path.

## Platforms

Release qualification checks scale, window size, headed behavior, and each binding on
the exact packaged Browser/Driver pair.
