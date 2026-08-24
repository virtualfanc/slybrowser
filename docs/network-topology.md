# Production hostname and cache topology

## Host routing

| Hostname | Cloudflare mode | Purpose | Cache policy |
| --- | --- | --- | --- |
| `slybrowser.com` | Proxied | Public website | HTML is `no-store`; hashed `/assets/` are cache-eligible and immutable |
| `www.slybrowser.com` | Proxied | Redirect to apex website | No application content |
| `api.slybrowser.com` | DNS only | License, account, billing and webhook APIs | `no-store` for every response |

Cloudflare is authoritative through `ram.ns.cloudflare.com` and
`simone.ns.cloudflare.com`. The zone uses **Full (strict)** encryption and **Always Use
HTTPS**.

Active Cache Rules, in order:

1. `Bypass legacy /api routes` bypasses cache for `/api/*` on the apex and `www`
   hostnames as a defensive fallback.
2. `Cache hashed static assets` makes `/assets/*` eligible for cache on the apex and
   `www` hostnames. Vite content hashes and the origin's one-year `immutable` header
   make these files safe to cache long-term.

The API hostname intentionally bypasses Cloudflare's HTTP proxy. This avoids accidental
edge caching of customer-specific responses, webhook requests, license leases and
authorization failures. DNS-only records expose the origin IP, so API authentication,
rate limiting, request-size limits, monitoring and host firewall controls remain origin
responsibilities.

The website and DNS-only API currently share one public IP. That means the origin cannot
be firewalled to Cloudflare IP ranges only without also blocking the API. A separate API
origin IP or Cloudflare Tunnel is required if origin concealment becomes a requirement.

## API reverse-proxy routes

The checked-in nginx production draft keeps `/healthz` as a reserved gateway health
response and proxies reviewed route families to local services. Production is not
considered deployed until the server config has been applied, syntax-tested on the
target host, and exercised with real secrets.

Route families:

- `127.0.0.1:8787` — `/v1/billing/*` and `/v1/feedback` for PayNow checkout,
  customer order status, email delivery callbacks, webhook receiving and feedback.
- `127.0.0.1:8788` — `/v1/plans`, `/v1/licenses/*`, `/v1/releases/artifacts/*`,
  `/v2/runtime/*` and `/v1/admin/licenses*` for license issuance, runtime leases and
  protected browser artifacts.

The public website host also proxies only the narrow browser-needed surface
(`/v1/billing/checkout-intents`, checkout status, customer order status/resend and
`/v1/feedback`) so same-origin static pages work without CORS. Do not place these
routes under `https://slybrowser.com/api`. The public website host is CDN-proxied and
optimized for immutable static assets.
