# SlyBrowser mailbox, license delivery and feedback setup

Last updated: 2026-08-25

This runbook covers the server mailbox layer used to send paid license files and
collect product feedback. The launch mailbox decision is now fixed: production uses
Resend SMTP for outbound transactional mail and Cloudflare Email Routing for inbound
aliases. The implementation remains SMTP-based so a future provider can replace Resend
without changing application code, but launch configuration and evidence should use
the Resend + Cloudflare split described here.

The current production decision separates sending from receiving:

- outbound transactional mail uses a server-side SMTP provider account;
- inbound domain mail uses Cloudflare Email Routing aliases that forward to a verified
  owner mailbox;
- Cloudflare Email Routing is receive/forward only, so replies or new outbound mail
  from `slybrowser.com` addresses must use the SMTP provider or a future dedicated
  mailbox provider;
- catch-all routing stays disabled.

## Mail identities

Use separate addresses for separate responsibilities:

- `license@slybrowser.com` — outbound license-file delivery only.
- `feedback@slybrowser.com` — product feedback and website contact intake.
- `support@slybrowser.com` — customer-facing support address shown in license emails.
- `billing@slybrowser.com` — billing operations and PayNow/customer order follow-up.
- `security@slybrowser.com` — security reports and vulnerability disclosure intake.
- `abuse@slybrowser.com` — abuse and platform-policy reports.
- `postmaster@slybrowser.com` — required domain postmaster contact.

Do not use a personal mailbox or a shared admin inbox as the SMTP sender. License
delivery should remain auditable and revocable without exposing personal accounts.
Inbound aliases may forward to a verified owner mailbox, but do not record that
personal destination address in public repository files.

Launch decision 2026-08-25: the verified owner mailbox is a private Gmail address
provided by the owner. Store it only in Cloudflare Email Routing, the SMTP provider or
secret-managed production environment files such as `SLY_OPS_ALERT_EMAIL`; do not
commit the full personal address, screenshots or provider exports to public
repositories.

## SKU test aliases

For checkout and license-delivery QA, create deterministic forwarding aliases. The
requirement name may be written as `test_sku_<sku>`, but the Cloudflare mailbox
local-part uses hyphens:

```text
test-sku-<sku>@slybrowser.com
```

Rules:

- `<sku>` is the lowercase canonical plan id (`free`, `launch`, `studio`, `fleet`,
  `grid`) or an explicitly approved QA SKU such as `billing_qa`.
- Do not put raw PayNow product IDs in mailbox local-parts.
- Each `test-sku-*` alias forwards to the same controlled owner mailbox used for QA.
- These aliases are delivery fixtures only; they are not login accounts, PayNow
  metadata, license authority or entitlement inputs.

Required baseline aliases:

| SKU | Alias | Purpose |
| --- | --- | --- |
| `free` | `test-sku-free@slybrowser.com` | Free-plan checkout and support-flow testing |
| `launch` | `test-sku-launch@slybrowser.com` | Launch paid checkout and license delivery |
| `studio` | `test-sku-studio@slybrowser.com` | Studio paid checkout and license delivery |
| `fleet` | `test-sku-fleet@slybrowser.com` | Fleet paid checkout and license delivery |
| `grid` | `test-sku-grid@slybrowser.com` | Grid paid checkout and license delivery |
| `billing_qa` | `test-sku-billing-qa@slybrowser.com` | Isolated recurring billing QA product |

## DNS and deliverability checklist

Before production use, configure the sender domain:

- Cloudflare Email Routing MX records for receiving whitelisted aliases on
  `slybrowser.com`.
- Resend-provided SPF records for the selected sending domain/subdomain.
- Resend-provided DKIM records for the selected sending domain/subdomain.
- Resend bounce/feedback records, such as a dedicated bounce subdomain, without
  overwriting Cloudflare's root inbound MX records.
- DMARC starting at `p=none` for observation, then moving to `quarantine`/`reject`
  after successful production monitoring.
- Bounce/complaint mailbox or Resend webhook when supported by the production plan.

Do not mark public launch ready until test messages from the production server land in
major inbox providers without authentication warnings.

## Environment variables

`billing-serve` reads these variables when SMTP and feedback delivery are enabled:

```text
SLY_EMAIL_SMTP_HOST=smtp.resend.com
SLY_EMAIL_SMTP_PORT=587
SLY_EMAIL_SMTP_SECURE=false
SLY_EMAIL_SMTP_STARTTLS=true
SLY_EMAIL_SMTP_USER=resend
SLY_EMAIL_SMTP_PASSWORD=<server-side Resend API key>
SLY_EMAIL_FROM=SlyBrowser <license@slybrowser.com>
SLY_EMAIL_SMTP_HELO=slybrowser.com
SLY_FEEDBACK_TO=feedback@slybrowser.com
SLY_FEEDBACK_SUBJECT_PREFIX=[SlyBrowser feedback]
SLY_FEEDBACK_RATE_LIMIT_WINDOW_SECONDS=900
SLY_FEEDBACK_RATE_LIMIT_MAX_PER_IP=10
SLY_FEEDBACK_RATE_LIMIT_MAX_PER_EMAIL=3
SLY_FEEDBACK_RATE_LIMIT_MAX_PER_USER_AGENT=20
SLY_SUPPORT_EMAIL=support@slybrowser.com
SLY_OPS_ALERT_EMAIL=<private owner mailbox>
SLY_LICENSE_EMAIL_WORKER_LIMIT=20
SLY_LICENSE_EMAIL_MAX_ATTEMPTS=5
```

For launch, use STARTTLS on port `587` with `SLY_EMAIL_SMTP_STARTTLS=true`. Keep the
Resend API key in the server secret manager or an untracked environment file; never
commit it. `SLY_FEEDBACK_TO` stays `feedback@slybrowser.com` and `SLY_SUPPORT_EMAIL`
stays `support@slybrowser.com`; Cloudflare forwards those inbound aliases to the
verified owner mailbox.

Production operations alert fallback should use `SLY_OPS_ALERT_EMAIL` pointing to the
same verified private owner mailbox. Feedback delivery still uses the public
`feedback@slybrowser.com` alias so user-facing addresses remain domain-owned and easy
to rotate.

Production check 2026-08-24: `api.slybrowser.com` has Resend SMTP variables in
`/etc/slybrowser/billing.env`; STARTTLS returned 220, SMTP AUTH returned 235, and a
local `/v1/feedback` smoke returned `202 received`. This proves the production billing
service can submit mail to Resend, but owner-mailbox receipt, Resend DNS verification
and provider callback delivery must still be verified from the provider/Cloudflare
control planes.

## Operational smoke tests

Run these after any SMTP, DNS, Cloudflare Email Routing, owner-mailbox or SKU-list
change:

- verify SMTP authentication from the production server over the configured TLS mode;
- send a small attachment from `license@slybrowser.com` to the owner mailbox;
- send a small attachment from `support@slybrowser.com` to `feedback@slybrowser.com`
  and confirm Cloudflare forwards it to the owner mailbox;
- send from the owner mailbox to `support@slybrowser.com` and at least one
  `test-sku-<sku>@slybrowser.com` alias;
- retain only redacted evidence: subject, timestamp, provider message ID/status and
  attachment filename/size. Do not save message bodies, license keys, SMTP secrets,
  attachment contents or full personal mailbox addresses in the repository.

Use the website repository's `scripts/Check-MailSystem.ps1` for the automated part of
the smoke test. It checks public DNS, public HTTP cache/security headers, production
SMTP authentication through SSH and, when explicitly requested with
`-SendFeedbackSmoke`, sends one feedback smoke message through the production billing
service.

PayNow live purchase, renewal, cancellation, refund and chargeback samples are
owner-operated. Record only redacted provider message IDs, public order IDs, timestamps
and statuses after the owner completes those live checks.

## HTTP feedback endpoint

The billing service exposes:

```text
POST /v1/feedback
```

Accepted fields:

```json
{
  "email": "optional@example.com",
  "name": "Optional name",
  "category": "general|billing|license|bug|feature",
  "message": "Required user message",
  "page": "https://slybrowser.com/pricing",
  "userAgent": "browser user agent",
  "website": ""
}
```

`website` is a honeypot field. If it is filled, the API returns `202 received` and
does not send an email. The endpoint rejects unknown fields, invalid emails and short
messages. If SMTP feedback delivery is not configured, it fails closed with
`feedback_email_not_configured`.

`billing-serve` applies an application-level abuse guard before forwarding real
feedback mail. Defaults allow 10 submissions per IP, 3 per email address and 20 per
user-agent identity per 15-minute window. A blocked request returns
`feedback_rate_limited` with HTTP 429 and emits a structured `feedback_rate_limit`
alert containing only the limited dimension, a SHA-256-based key hash, count, limit
and retry window. It does not log raw email, message text or full user-agent strings.
Production reverse proxies should still enforce matching IP/UA/email policies and
sanitize `X-Forwarded-For` before traffic reaches `billing-serve`.

## License email worker

Paid license email is sent from the PostgreSQL `billing_email_outbox` table. The
payment transaction writes the outbox row; a separate worker sends the message.

Run one worker pass:

```powershell
node packages/license-service/dist/cli.js billing-send-license-emails --limit 20
```

The worker:

- claims rows with `FOR UPDATE SKIP LOCKED`, so multiple workers do not send the same
  email concurrently;
- only claims `license_file` rows whose JSON payload already contains `licenseFile`;
  first-payment rows get that attachment only after PayNow HMAC verification plus
  Management API second confirmation succeeds;
- decrypts the website-entered delivery email from the outbox row;
- attaches `slybrowser-license.json`;
- records a row in `billing_email_deliveries`;
- retries with backoff and marks final failure after `SLY_LICENSE_EMAIL_MAX_ATTEMPTS`.

It does not use PayNow `billing_email` as the license delivery address.

When `SLY_EMAIL_WEBHOOK_TOKEN` is configured in PostgreSQL mode, `billing-serve` also
accepts normalized provider delivery callbacks:

```text
POST /v1/billing/email-deliveries
Authorization: Bearer <SLY_EMAIL_WEBHOOK_TOKEN>
```

Body:

```json
{
  "provider": "postmark",
  "provider_message_id": "provider-message-id",
  "provider_event_id": "optional-provider-event-id",
  "status": "delivered",
  "error_code": "optional-bounded-code",
  "error_message": "optional-bounded-message"
}
```

`status` must be `delivered`, `bounced` or `failed`. The endpoint finds the existing
`sent` delivery by `provider + provider_message_id`, appends a new
`billing_email_deliveries` row, updates `billing_email_outbox.status`, and deduplicates
provider webhook retries by `provider_event_id` when present. It rejects unknown message
IDs instead of creating orphan delivery facts.

Final worker failures and provider `bounced`/`failed` callbacks are queued in
`billing_email_manual_reviews` with `status='open'`. The queue is deduplicated by
outbox, failure reason and provider event identity, and stores only bounded provider
diagnostics; it does not store decrypted recipient email, license keys or attachment
content. Human operators should resolve the open review after verifying order ownership
and then use the future admin resend/email-change flow rather than manually editing
outbox rows.

Private-preview paid licenses are generated as v2 encrypted/signed license files using
`SLY_LICENSE_FILE_SIGNING_KEY_FILE`, `SLY_LICENSE_FILE_SIGNING_KEY_ID`,
`SLY_LICENSE_FILE_SERVICE_URL` and `SLY_LICENSE_FILE_PRIVATE_PREVIEW_PASSPHRASE`.
Node.js and Python can import that file into Windows DPAPI current-user sealed
authorization storage. Public launch still needs the final per-customer passphrase
capture/delivery flow, Java/.NET sealed import parity and enterprise KMS unlock mode.

## Process layout

Recommended server processes:

```text
reverse proxy / HTTPS
  -> billing-serve
       POST /v1/billing/checkout-intents
       GET  /v1/billing/checkout-intents/:id/status
       POST /v1/billing/paynow/webhook
       POST /v1/feedback

systemd timer or scheduler
  -> billing-send-license-emails --limit 20
```

Example systemd timer cadence:

```text
OnBootSec=30s
OnUnitActiveSec=60s
RandomizedDelaySec=10s
```

Keep `billing-serve`, the email delivery callback endpoint and the email worker on the
private API host, not in the static website hosting process. Rate-limit `/v1/feedback`
and provider callback endpoints at the reverse proxy.

## Security boundaries

- SMTP credentials, DKIM keys and license signing keys are server-only secrets.
- License email attachments and decrypted payloads must not be logged.
- Feedback email may include user text; treat it as untrusted and never render it in an
  admin HTML view without escaping.
- Public repositories must not contain production mailbox config, generated license
  files, outbox evidence, raw feedback exports or SMTP debug logs.
- Sender-domain DNS changes are a production release gate and require explicit owner
  authorization before deployment.
