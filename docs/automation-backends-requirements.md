# Automation backends and language compatibility requirements

Status: approved implementation scope  
Last updated: 2026-08-17

## 1. Product decision

SlyBrowser ships one browser runtime and supports two automation families:

1. **Project WebDriver** is the default backend. It must use the WebDriver built
   and released with SlyBrowser.
2. **Playwright** is an opt-in backend for Node.js/TypeScript, Python, Java and
   .NET.
3. **Puppeteer** is an opt-in backend for Node.js/TypeScript.

All SDKs live in the main SlyBrowser repository. No language-specific or
Playwright-specific repository is required.

Adding a backend increases API compatibility; it does not by itself make a
session less detectable. Any comparison with another browser must be based on
repeatable live results collected with the strongest supported configuration on
both products.

## 2. Required behavior

### 2.1 Common launch contract

Every backend adapter must:

- launch only an explicitly selected, authorized SlyBrowser executable;
- reject a caller-supplied executable path inside framework launch options;
- never download or fall back to Playwright, Puppeteer, system Chrome or a
  system WebDriver browser binary;
- use the signed release manifest and the requested/selected/downloaded/launched
  version audit established by the release service;
- hand the browser a short-lived license envelope and profile configuration
  without exposing a long-lived license key in process arguments;
- apply plan concurrency before browser launch, independent of the selected
  automation backend;
- remove temporary handoff files after the browser has consumed them;
- reject unsupported backend, language, package version, platform or
  architecture combinations with a stable error code;
- preserve proxy fail-closed behavior and profile consistency in ephemeral and
  persistent modes.

`automationBackend` accepts `project-webdriver`, `playwright` or `puppeteer`.
Its default is always `project-webdriver`. `puppeteer` is valid only in the
Node.js/TypeScript SDK.

### 2.2 Language matrix

| Language | Project WebDriver | Playwright | Puppeteer |
| --- | --- | --- | --- |
| Node.js / TypeScript | Required, default | Required, opt-in | Required, opt-in |
| Python | Required, default | Required, opt-in | Not supported |
| Java | Required, default | Required, opt-in | Not supported |
| .NET | Required, default | Required, opt-in | Not supported |

The public API may use idiomatic names per language, but error codes, backend
names, launch semantics and capability reporting must remain equivalent.

### 2.3 Package-version control

Framework bindings and the SlyBrowser SDK are versioned independently. A
machine-readable compatibility manifest must declare the exact Playwright and
Puppeteer lines validated by CI for each language. Adapters must check the
runtime package version when the language exposes it and fail closed outside
the declared range.

The initial verification matrix covers:

- Node.js: supported LTS runtime lines with validated `playwright-core` and
  `puppeteer-core` versions;
- Python: supported CPython lines with validated `playwright` versions;
- Java: supported JDK lines with validated `com.microsoft.playwright` versions;
- .NET: supported target frameworks with validated `Microsoft.Playwright`
  versions.

An untested newer framework release is not silently accepted. Updating the
matrix requires unit, protocol and browser integration evidence.

## 3. Playwright and Puppeteer protocol consistency

Playwright and Puppeteer control Chromium through DevTools Protocol paths. CDP
must remain functional; removing or falsifying required protocol commands is
not an acceptable implementation.

The browser must instead eliminate page-observable side effects created only by
an attached protocol client. The release gate covers at least:

- `navigator.webdriver`, automation switches and browser globals;
- inspector serialization of `Error`, custom `Error.prepareStackTrace` and
  console arguments;
- runtime, debugger and console subscriptions;
- evaluation bindings and utility worlds;
- target creation and attachment for pages, popups, iframes and workers;
- new browser contexts and persistent profiles;
- headless and headed launch paths;
- window, screen, locale, timezone, geolocation, GPU and network consistency;
- cleanup after sessions and reconnection behavior.

CDP hardening must be implemented in the private browser source and retained in
the private Chromium patch archive. Public SDK code contains only adapters,
contracts and black-box regression tests.

## 4. Humanize requirements

Project WebDriver Humanize remains the reference native implementation.

Playwright and Puppeteer call one shared native Humanize control plane through a
short-lived `--sly-humanize-config` handoff file. Language SDKs must remain thin and
must not carry independent movement, typing or timing algorithms as the production
implementation. If a browser build does not advertise or consume the native capability,
requesting native Humanize from Playwright or Puppeteer must fail closed; it must not
silently degrade to ordinary framework input.

The native implementation must support Page, Frame and Element actions,
including mouse movement, click, typing and scrolling, across differing DPI,
viewport and window placements. Seeded mode exists only for repeatable tests;
normal sessions must not reuse deterministic traces.

## 5. Public APIs

Each SDK provides:

- an explicit WebDriver launch method;
- an explicit Playwright launch method, including persistent context launch;
- Node.js/TypeScript explicit Puppeteer launch;
- a high-level launch selector whose omitted backend resolves to
  `project-webdriver`;
- a capability query that reports backend, framework binding version, native
  Humanize availability and persistent-context support;
- stable configuration and protocol errors.

Framework objects may be injected by the caller. Convenience factories may
load optional dependencies, but they must never invoke framework browser
installers.

## 6. Acceptance test matrix

### 6.1 SDK tests

For each supported language/backend combination:

- unit-test launch option mapping and executable-path conflict rejection;
- verify temporary license/config files exist during launch and are removed
  afterward;
- verify long-lived secrets do not appear in arguments, logs or exceptions;
- verify unsupported versions and unsupported backends fail closed;
- verify default launch still selects project WebDriver;
- verify framework-owned browser download/fallback is never called.
- for the default project WebDriver backend, score the same Native Humanize
  Page/Frame/Element/DPI runtime matrix in Node.js, Python, Java and .NET.
  Node.js is the baseline; Python, Java and .NET must meet or exceed the Node
  score before a public multi-language runtime claim is updated.

### 6.2 Browser integration tests

Run headed, headless and persistent scenarios against the compiled x64 browser.
Each scenario covers the initial page, new page, popup, same-origin and
cross-origin iframe, dedicated Worker and service Worker where applicable.

Protocol regression evidence must include the local CDP probes plus the approved
live detection suite. Stock Chromium and SlyBrowser are tested from the same
machine, network route and framework version. Reports identify the automation
backend, framework binding version and saved browser/kernel version used for the run;
they must not expose private source paths, tokens or operational bypass details on
public pages.

### 6.3 Claim gate

The project may advertise multi-language WebDriver, Playwright and Puppeteer
compatibility after their matrix tests pass. It may advertise better detection
results than a named competitor only when a dated, reproducible, like-for-like
benchmark supports the claim. Supporting more backends alone is not evidence of
deeper concealment.

## 7. Non-goals

- Replacing Playwright or Puppeteer with a forked public API.
- Allowing Playwright/Puppeteer to choose or download their bundled browser.
- Supporting Firefox or WebKit through SlyBrowser adapters.
- Publishing private C++ implementation details in the public SDK repository.
- Claiming universal invisibility or guaranteed CAPTCHA outcomes.
