# Service routing and cache boundaries

SlyBrowser separates cacheable website assets from customer-specific API responses.

| Host | Purpose | Client boundary |
| --- | --- | --- |
| `slybrowser.com` | Official website, Free entry and Pancake purchase entry | HTML and customer responses are not cached; content-hashed static assets may be cached |
| `www.slybrowser.com` | Redirect to the official website | No independent application origin |
| `api.slybrowser.com` | Plans, licensing, runtime leases and authorized release delivery | Customer-specific responses and authorization failures are not cached |

The SDK obtains API and release destinations through the authorized delivery flow.
Applications supply the authorization file, profile and supported launch/Humanize
options. Deployment topology does not add executable-path or verification-key inputs
to the public SDK interface.

Paid purchases use Pancake’s hosted checkout. The SlyBrowser server determines the
canonical plan and confirms provider settlement before issuing a license. Browser
redirects and cached pages cannot authorize payment or grant an entitlement.
Historical billing compatibility remains a private service responsibility.

Cloudflare rules, nameservers, origin addresses, Nginx upstream ports and operational
deployment state belong to the private website repository and production Evidence.
They are not client configuration requirements.

