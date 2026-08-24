import { useEffect, useMemo, useState } from "react";
import { billingApiError, billingApiFetch } from "./billing";

type BillingStatus = "pending_checkout" | "checkout_created" | "paid";

interface BillingStatusPayload {
  status: BillingStatus;
  plan: {
    id: string;
    sku: string;
    name: string;
    monthlyPriceCents: number;
    currency: string;
    billingPeriod: string;
    autoRenew: boolean;
    concurrency: number;
  };
  maskedEmail: string;
  expiresAt: number;
}

type ResultState =
  | { kind: "loading" }
  | { kind: "missing"; message: string }
  | { kind: "ready"; payload: BillingStatusPayload; redirectStatus: string | null }
  | { kind: "error"; message: string };

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function statusCopy(status: BillingStatus): string {
  if (status === "paid") {
    return "Payment has been confirmed by the SlyBrowser billing API. License delivery is now queued and will not rely on PayNow redirect query parameters.";
  }
  if (status === "checkout_created") {
    return "Checkout was created by the SlyBrowser billing API. Access is not activated until a signed PayNow payment event and server-side confirmation are processed.";
  }
  return "Checkout intent is waiting for the PayNow checkout step. No browser entitlement has been granted yet.";
}

export function BillingResult() {
  const search = useMemo(() => new URLSearchParams(window.location.search), []);
  const intentId = search.get("intent_id") ?? "";
  const redirectStatus = search.get("status");
  const [state, setState] = useState<ResultState>({ kind: "loading" });

  useEffect(() => {
    if (!/^ci_[A-Za-z0-9_-]+$/.test(intentId)) {
      setState({ kind: "missing", message: "Checkout intent is missing or invalid." });
      return;
    }
    const token = search.get("token") ?? sessionStorage.getItem(`sly_checkout_status_${intentId}`);
    if (!token) {
      setState({
        kind: "missing",
        message: "This result page can only show status in the same browser tab that started checkout.",
      });
      return;
    }
    const controller = new AbortController();
    billingApiFetch(`/v1/billing/checkout-intents/${encodeURIComponent(intentId)}/status`, {
      headers: { "x-sly-checkout-status-token": token },
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as BillingStatusPayload & { error?: { message?: string } };
        if (!response.ok) throw billingApiError(payload, "Checkout status is not available.", response);
        setState({ kind: "ready", payload, redirectStatus });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: error instanceof Error ? error.message : "Checkout status is not available." });
      });
    return () => controller.abort();
  }, [intentId, redirectStatus, search]);

  return (
    <section className="billing-result-page">
      <div className="section-heading reveal is-visible">
        <span>Billing status</span>
        <h1>SlyBrowser checkout status</h1>
        <p>PayNow redirects are treated as navigation only. The status below comes from the SlyBrowser billing API.</p>
      </div>

      <article className="billing-result-card reveal is-visible">
        {state.kind === "loading" && <p>Checking local checkout status…</p>}
        {state.kind === "missing" && (
          <>
            <h2>Status token unavailable</h2>
            <p>{state.message}</p>
            <a className="button button-secondary" href="/#pricing">Return to pricing</a>
          </>
        )}
        {state.kind === "error" && (
          <>
            <h2>Status unavailable</h2>
            <p>{state.message}</p>
            <a className="button button-secondary" href="/#pricing">Return to pricing</a>
          </>
        )}
        {state.kind === "ready" && (
          <>
            <div className="billing-result-status">
              <span>{state.payload.status.replace("_", " ")}</span>
              <small>{state.redirectStatus === "return" ? "Returned from checkout" : "Local billing record"}</small>
            </div>
            <h2>{state.payload.plan.name} plan</h2>
            <dl className="billing-result-details">
              <div>
                <dt>Delivery email</dt>
                <dd>{state.payload.maskedEmail}</dd>
              </div>
              <div>
                <dt>Monthly price</dt>
                <dd>{money(state.payload.plan.monthlyPriceCents, state.payload.plan.currency)}</dd>
              </div>
              <div>
                <dt>Renewal</dt>
                <dd>{state.payload.plan.autoRenew ? "Automatic monthly renewal" : "No automatic renewal"}</dd>
              </div>
              <div>
                <dt>Concurrency</dt>
                <dd>{state.payload.plan.concurrency.toLocaleString("en-US")} browser process{state.payload.plan.concurrency === 1 ? "" : "es"}</dd>
              </div>
            </dl>
            <p>{statusCopy(state.payload.status)}</p>
            <a className="button button-secondary" href="/#pricing">Back to pricing</a>
          </>
        )}
      </article>
    </section>
  );
}
