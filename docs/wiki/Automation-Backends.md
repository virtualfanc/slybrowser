# Automation backends

## Installation

Install the selected SDK and only the explicitly supported framework dependency.

## Configuration

Select WebDriver, Playwright, or Puppeteer only where the public backend contract marks
that binding and mode as supported.

## API and example

WebDriver is the default four-binding automation path. Playwright is declared where its
binding contract supports it; Puppeteer is a JavaScript API and is not inferred for
other languages.

## Errors

An unsupported binding/backend pair fails at configuration validation. It must not be
dropped or translated into another backend.

## Limitations

Backend parity means documented shared behavior, not identical upstream APIs.

## Platforms

Every supported backend still requires real target-specific Browser/Driver or Browser
Artifact Evidence before a release claim.
