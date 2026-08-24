#!/bin/sh
set -eu

unit_name="${1:-unknown.service}"
safe_unit=$(printf '%s' "$unit_name" | tr -cd 'A-Za-z0-9@._:-')
host_name=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9@._:-' || printf 'unknown')
webhook_url="${SLY_OPS_ALERT_WEBHOOK_URL:-}"
timeout_seconds="${SLY_OPS_ALERT_TIMEOUT_SECONDS:-5}"

if [ -z "$webhook_url" ]; then
  printf '%s\n' "SlyBrowser billing alert skipped: SLY_OPS_ALERT_WEBHOOK_URL is not configured for ${safe_unit}" >&2
  exit 0
fi

payload=$(printf '{"source":"slybrowser-billing","severity":"critical","event":"systemd_unit_failed","unit":"%s","host":"%s"}' "$safe_unit" "$host_name")

curl --fail --silent --show-error --max-time "$timeout_seconds" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "$webhook_url" >/dev/null
