import { createHmac } from "node:crypto";

const endpoint = process.argv[2] ?? "https://api.slybrowser.com/v1/billing/paynow/webhook";
const storeId = process.env.SLY_PAYNOW_STORE_ID;
const secret = process.env.SLY_PAYNOW_WEBHOOK_SECRETS?.split(",")[0]?.trim();
if (!storeId || !secret) throw new Error("PayNow smoke-test environment is incomplete");

const requestTimestamp = String(Date.now());
const payload = JSON.stringify({
  event_type: "ON_SUBSCRIPTION_ACTIVATED",
  event_id: "980000000000000001",
  body: {
    id: "980000000000000002",
    store_id: storeId,
    customer_id: "980000000000000003",
    product_id: "980000000000000004",
    current_period_start: new Date().toISOString(),
    current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
  },
});
const signature = createHmac("sha256", secret)
  .update(`${requestTimestamp}.${payload}`)
  .digest("base64");
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "paynow-timestamp": requestTimestamp,
    "paynow-signature": signature,
  },
  body: payload,
});
const result = await response.json();
if (response.status !== 400 || result?.error?.code !== "invalid_request") {
  throw new Error(`Signed webhook smoke test failed with HTTP ${response.status}`);
}
console.log(JSON.stringify({ status: response.status, code: result.error.code }));
