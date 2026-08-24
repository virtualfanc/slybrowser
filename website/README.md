# SlyBrowser website

The official product website is a React and Vite application that reuses the approved
brand assets from `assets/brand`.

```powershell
pnpm --dir website dev
pnpm --dir website build
```

The production bundle is written to `website/dist`.

## Website cache and API origin

Production HTML is intentionally non-cacheable, while Vite's hashed `/assets/` files
are immutable and safe for long-lived edge caching. Browser, account, license, billing
and first-launch release download APIs use `VITE_SLY_API_ORIGIN=https://api.slybrowser.com`;
that hostname is DNS only and every sensitive or authorization-bound response must include
`Cache-Control: no-store`.

Do not introduce new application endpoints under `https://slybrowser.com/api`. The
Cloudflare zone includes a defensive cache-bypass rule for that path, but the dedicated
API hostname is the canonical route. A download CDN worker is optional after launch and
must pass `website/scripts/check-security.mjs` before it can be enabled.

## PayNow checkout

The pricing UI supports public PayNow hosted product URLs without exposing a secret in
the browser. Copy `.env.example` to `.env.local`, then set the recurring monthly
product URL for each approved paid plan. If a URL is missing or is not HTTPS, the site
shows the paid-preview request action instead of a broken checkout button.

Never add a PayNow API key or webhook signing secret to a `VITE_*` variable. Complete
subscription-to-license automation requires the server-side webhook flow documented in
[`docs/paynow-integration.md`](../docs/paynow-integration.md).
