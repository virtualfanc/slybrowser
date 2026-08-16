# CloakBrowser issues and Reddit feedback → proposed SlyBrowser requirements

Date: 2026-08-16  
Status: proposed requirements; product-owner confirmation required before implementation

## Executive readout

The strongest recurring public signals are not requests for more fingerprint switches.
They are requests for a browser that remains internally consistent across releases,
never leaks traffic outside a configured proxy, behaves predictably through CDP and
persistent contexts, installs the exact requested version, and is trustworthy to run
as a downloaded binary. GitHub showed 172 open issues at collection time. This count
is a queue-size observation, not a defect rate.

Evidence strength is intentionally separated:

- **Official issue**: a real user report, but not a verified defect until reproduced.
- **Reddit anecdote**: useful discovery evidence, not prevalence or causality evidence.
- **Official documentation**: a product claim or supported workflow, not independent
  performance proof.

## Feedback clusters

| Cluster | Public signal | Product interpretation | Evidence |
| --- | --- | --- | --- |
| Detection consistency | High-comment issues report FingerprintJS, `nodriver`, tampering, VM/incognito and profile-consistency findings. Issue #294 reports a hard-coded RTX 5090 on an RTX 3060. | A plausible profile must be coherent and regression-tested as a whole; isolated API masking is insufficient. | GitHub issues #193, #197, #294, #320, #377, #395, #493 |
| CDP and context behavior | Reports cover persistent-context detection, direct CDP mode, new-page hangs, wrong window size and longer click timeouts. | CDP, W3C, persistent profile, page, frame and new-tab paths need one behavioral contract. | GitHub issues #307, #312–#316, #320, #325 |
| Proxy safety | Issue #157 reports authenticated SOCKS5 traffic falling back to the direct route; other reports cover SOCKS5 stalls and HTTP/2/QUIC differences. | Proxy failure must be fail-closed and observable; route integrity is a safety property, not a convenience option. | GitHub issues #157, #386, #501 |
| Release integrity | Reports include requesting v148 but receiving v150, old-version masking behavior and ambiguity around free-version access. | Selected, downloaded and launched versions must match a signed manifest and entitlement exactly. | GitHub issues #486, #491, #498, #499, #503 |
| Humanize reliability | A Python 3.14 TypeError and action timing/timeout reports show compatibility and actionability risks. | Humanize needs deterministic regression mode, supported-runtime coverage and identical page/frame/element behavior. | GitHub issues #307, #488 |
| Platform and browser APIs | Reports request macOS Apple Silicon, cover Linux/uv and Docker, WebAuthn/passkeys, external-protocol dialogs and mobile emulation. | Publish and test a finite platform/API matrix rather than implying universal Chromium parity. | GitHub issues #55, #252, #317, #318, #504, #505 |
| Agent integration | Reddit feedback describes strong Playwright+Cloak efficiency, but another user needed a compatibility shim because a nested authenticated CDP endpoint did not answer standard root probes. | Standard discovery endpoints and documented authenticated remote-CDP contracts matter for agent adoption. | Reddit ClaudeAI, opencode and ClaudeWorkflows threads |
| Supply-chain trust | A Reddit user explicitly raised malware/binary-risk concerns. GitHub users ask for public kernel patches. | Signed artifacts, hashes, provenance, SBOM and a clear source boundary are part of product value. | Reddit webscraping thread; GitHub issues #105 and #237 |

## Requirements proposed for confirmation

### P0 — release-blocking behavior

| ID | Proposed requirement | Acceptance boundary |
| --- | --- | --- |
| CB-P0-01 | Detection-consistency regression matrix | For every supported OS/version/mode, profile values remain coherent across page, iframe, Worker, network, GPU and timing surfaces. Known FPJS/BrowserScan/Incolumitas/Device & Browser Info findings are saved as reproducible evidence; no hard-coded hardware outside the selected profile. |
| CB-P0-02 | CDP, W3C and persistent-context parity | `connect_over_cdp`, project WebDriver, persistent profile, new page/tab and frame actions launch reliably; window/screen values agree; automation globals and timeouts meet the documented contract. |
| CB-P0-03 | Proxy fail-closed route integrity | Invalid or rejected HTTP/SOCKS5 credentials abort launch/navigation. No direct fallback is allowed. Exit IP, DNS/WebRTC route and protocol mode are verified before a profile is marked ready. |
| CB-P0-04 | Exact signed version delivery | Requested, entitled, selected, downloaded and launched browser/driver versions must match. Manifests are signed, artifacts are hashed, downgrade/rollback is explicit, and version mismatch is a hard error. |
| CB-P0-05 | Humanize compatibility and action coverage | Page/frame/element mouse, click, keyboard and scroll paths share actionability rules; supported Python/Node versions are tested; a seed produces repeatable regression traces without making normal runs mechanically identical. |
| CB-P0-06 | Persistent-profile privacy consistency | Persistent and ephemeral modes correctly expose their documented storage/incognito state; font, VM/Xvfb and profile identifiers do not accidentally link separately created profiles. |

### P1 — product completeness

| ID | Proposed requirement | Acceptance boundary |
| --- | --- | --- |
| CB-P1-01 | Supported platform matrix | Clean-install and smoke suites for declared Windows, Linux, macOS arm64 and Docker targets; unsupported combinations fail with a diagnostic. |
| CB-P1-02 | Geo/locale/timezone/proxy alignment | Optional proxy-derived defaults produce a coherent locale, timezone, coordinates and WebRTC route; diagnostics explain overrides and contradictions. |
| CB-P1-03 | Browser API compatibility | Test WebAuthn/passkeys and external-protocol/dialog behavior against stock Chromium semantics. |
| CB-P1-04 | Coherent mobile emulation | Mobile UA, client hints, touch, screen, DPR, viewport, hardware and GPU values are selected as one persona. |
| CB-P1-05 | Entitlement and release clarity | CLI/UI reports plan, concurrency, available browser versions, requested/selected version, update rights and actionable denial reasons. |
| CB-P1-06 | Standard agent/remote-CDP contract | Provide authenticated `/json/version` and WebSocket discovery compatible with common agents, or publish and test a small official adapter with stable endpoints. |
| CB-P1-07 | Verifiable binary supply chain | Publish release signatures, SHA-256, SBOM, provenance/attestation and the public Chromium patch inventory permitted by the source boundary. |

### P2 — adoption accelerators

| ID | Proposed requirement | Acceptance boundary |
| --- | --- | --- |
| CB-P2-01 | First-party MCP/agent adapters | Supported examples and CI for selected agent frameworks; no hidden dependency on an undocumented manager endpoint. |
| CB-P2-02 | Profile/session manager API | Create, inspect, start, stop and delete isolated profiles; report cookies/extensions/CDP endpoints without exposing secrets. |
| CB-P2-03 | Per-release public benchmark history | Publish methodology, browser/driver versions, coverage, errors and artifacts for each tested release; never convert network errors or unconfigured services into passes. |

## Decisions awaiting product-owner confirmation

1. Approve **CB-P0-01 through CB-P0-06** as the next release-blocking requirement set.
2. Decide whether **CB-P1-06 standard remote CDP/agent compatibility** belongs in the
   first commercial preview or the following release.
3. Select the public supply-chain level for **CB-P1-07**: signatures+hashes only, add
   SBOM/provenance, or also publish the complete allowed Chromium patch inventory.
4. Confirm whether macOS arm64 and Docker are launch targets or documented later-stage
   targets; the acceptance matrix depends on this decision.

## Sources

- [CloakBrowser open issues](https://github.com/CloakHQ/CloakBrowser/issues)
- [Issue #294: detected by FingerprintJS / incorrect GPU](https://github.com/CloakHQ/CloakBrowser/issues/294)
- [Issue #157: SOCKS5 authentication can fall back to direct traffic](https://github.com/CloakHQ/CloakBrowser/issues/157)
- [Reddit: “is cloak browser good?”](https://www.reddit.com/r/webscraping/comments/1t9g0kr/is_cloak_browser_good/)
- [Reddit: Claude Chrome usage thread](https://www.reddit.com/r/ClaudeAI/comments/1ur5rzb/what_are_you_actually_using_the_claude_chrome/)
- [Reddit: agent integration and CDP shim](https://www.reddit.com/r/opencode/comments/1uz4d34/whats_the_best_way_to_use_opencode_for_browser/)
- [Reddit: self-hosted browser-search workflow](https://www.reddit.com/r/ClaudeWorkflows/comments/1ud22dl/workflow_selfhosted_ai_agent_web_search_browsing/)
- [CloakBrowser repository and documented features](https://github.com/CloakHQ/CloakBrowser)

## Handoff summary

Keep the user-facing framing around reliability, safe routing, exact versions and
verifiability. Do not treat issue or Reddit counts as market prevalence. The next
implementation work must wait for the four confirmation decisions above.
