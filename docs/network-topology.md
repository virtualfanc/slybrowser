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

## Reserved API routes

The hostname is provisioned before the production service is ready. Until a reviewed
backend is deployed, `/healthz` reports a reserved service and all other paths return a
JSON `404`.

Planned route families:

- `/v1/licenses/*` — short-lived lease issue, renew and revoke operations;
- `/v1/billing/*` — PayNow checkout support and verified webhook receiver;
- `/v1/accounts/*` — authenticated account and entitlement state.

Do not place these routes under `https://slybrowser.com/api`. The public website host is
CDN-proxied and optimized for immutable static assets.
