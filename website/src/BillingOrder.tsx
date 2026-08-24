import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  fetchCustomerBillingStatus,
  isCustomerAccessToken,
  isCustomerOrderId,
  requestCustomerLicenseResend,
  requestCustomerSubscriptionCancel,
  type CustomerBillingStatusPayload,
  type CustomerLicenseResendPayload,
  type CustomerSubscriptionCancellationPayload,
} from "./billing";

type LoadState =
  | { kind: "idle"; message?: string }
  | { kind: "loading" }
  | { kind: "ready"; payload: CustomerBillingStatusPayload }
  | { kind: "error"; message: string };

type ResendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; payload: CustomerLicenseResendPayload }
  | { kind: "error"; message: string };

type CancelState =
  | { kind: "idle" }
  | { kind: "canceling" }
  | { kind: "canceled"; payload: CustomerSubscriptionCancellationPayload }
  | { kind: "error"; message: string };

function queryValue(search: URLSearchParams, names: string[]): string {
  for (const name of names) {
    const value = search.get(name)?.trim();
    if (value) return value;
  }
  return "";
}

function epochDate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(Math.floor(seconds) * 1000));
}

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function boolCopy(value: boolean): string {
  return value ? "Yes" : "No";
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Customer billing status is not available.";
}

export function BillingOrder() {
  const search = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialOrderId = useMemo(() => queryValue(search, ["order_id", "order", "public_order_id"]), [search]);
  const initialAccessToken = useMemo(() => queryValue(search, ["token", "access_token"]), [search]);
  const [orderId, setOrderId] = useState(initialOrderId);
  const [accessToken, setAccessToken] = useState(initialAccessToken);
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [resendState, setResendState] = useState<ResendState>({ kind: "idle" });
  const [cancelState, setCancelState] = useState<CancelState>({ kind: "idle" });

  useEffect(() => {
    if (search.has("token") || search.has("access_token")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      url.searchParams.delete("access_token");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [search]);

  useEffect(() => {
    if (!isCustomerOrderId(initialOrderId) || !isCustomerAccessToken(initialAccessToken)) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    fetchCustomerBillingStatus(initialOrderId, initialAccessToken, controller.signal)
      .then((payload) => {
        setState({ kind: "ready", payload });
        setResendState({ kind: "idle" });
        setCancelState({ kind: "idle" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: "error", message: loadErrorMessage(error) });
      });
    return () => controller.abort();
  }, [initialAccessToken, initialOrderId]);

  const normalizedOrderId = orderId.trim();
  const normalizedAccessToken = accessToken.trim();
  const canSubmit = isCustomerOrderId(normalizedOrderId) && isCustomerAccessToken(normalizedAccessToken);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setState({
        kind: "idle",
        message: "Enter the public order ID and customer access token from your license email.",
      });
      return;
    }
    setState({ kind: "loading" });
    setResendState({ kind: "idle" });
    setCancelState({ kind: "idle" });
    try {
      const payload = await fetchCustomerBillingStatus(normalizedOrderId, normalizedAccessToken);
      setState({ kind: "ready", payload });
    } catch (error: unknown) {
      setState({ kind: "error", message: loadErrorMessage(error) });
    }
  }

  async function resendLicenseFile() {
    if (!canSubmit || state.kind !== "ready") return;
    setResendState({ kind: "sending" });
    try {
      const payload = await requestCustomerLicenseResend(normalizedOrderId, normalizedAccessToken);
      setResendState({ kind: "sent", payload });
    } catch (error: unknown) {
      setResendState({
        kind: "error",
        message: error instanceof Error ? error.message : "License file resend is not available.",
      });
    }
  }

  async function cancelSubscriptionRenewal() {
    if (!canSubmit || state.kind !== "ready") return;
    if (!state.payload.autoRenew || state.payload.cancelAtPeriodEnd || state.payload.subscriptionStatus !== "active") return;
    if (!window.confirm("Cancel automatic renewal? Access remains available until the paid-through date. This does not create a refund request.")) return;
    setCancelState({ kind: "canceling" });
    try {
      const payload = await requestCustomerSubscriptionCancel(normalizedOrderId, normalizedAccessToken);
      setCancelState({ kind: "canceled", payload });
      setState((current) => current.kind === "ready"
        ? {
            kind: "ready",
            payload: {
              ...current.payload,
              subscriptionStatus: "cancel_at_period_end",
              autoRenew: false,
              cancelAtPeriodEnd: true,
              paidThrough: payload.paidThrough,
            },
          }
        : current);
    } catch (error: unknown) {
      setCancelState({
        kind: "error",
        message: error instanceof Error ? error.message : "Subscription cancellation is not available.",
      });
    }
  }

  return (
    <section className="billing-result-page">
      <div className="section-heading reveal is-visible">
        <span>Customer order</span>
        <h1>SlyBrowser order status</h1>
        <p>Use the public order ID and customer access token from your license email. We do not expose status by email address alone.</p>
      </div>

      <article className="billing-result-card reveal is-visible">
        <form className="billing-order-form" onSubmit={submit} noValidate>
          <label>
            <span>Public order ID</span>
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.currentTarget.value)}
              placeholder="spo_..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label>
            <span>Customer access token</span>
            <input
              type="password"
              value={accessToken}
              onChange={(event) => setAccessToken(event.currentTarget.value)}
              placeholder="cst_..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={state.kind === "loading"}>
            {state.kind === "loading" ? "Checking…" : "Check status"}
          </button>
        </form>

        <p className="billing-token-note">
          Keep this token private. It can view billing status and request a license-file resend for this order.
        </p>

        {state.kind === "idle" && state.message && <p className="billing-order-message">{state.message}</p>}
        {state.kind === "loading" && <p className="billing-order-message">Checking customer order status…</p>}
        {state.kind === "error" && <p className="billing-order-message billing-order-error">{state.message}</p>}

        {state.kind === "ready" && (
          <>
            <div className="billing-result-status">
              <span>{titleCase(state.payload.subscriptionStatus)}</span>
              <small>{state.payload.remainingDays} paid day{state.payload.remainingDays === 1 ? "" : "s"} remaining</small>
            </div>
            <h2>{state.payload.planName} plan</h2>
            <dl className="billing-result-details billing-order-details">
              <div>
                <dt>Order</dt>
                <dd>{state.payload.publicOrderId}</dd>
              </div>
              <div>
                <dt>Subscription</dt>
                <dd>{state.payload.publicSubscriptionId ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Concurrency</dt>
                <dd>{state.payload.concurrency.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt>Paid through</dt>
                <dd>{epochDate(state.payload.paidThrough)}</dd>
              </div>
              <div>
                <dt>Auto renew</dt>
                <dd>{boolCopy(state.payload.autoRenew)}</dd>
              </div>
              <div>
                <dt>Cancel at period end</dt>
                <dd>{boolCopy(state.payload.cancelAtPeriodEnd)}</dd>
              </div>
              <div>
                <dt>Order status</dt>
                <dd>{titleCase(state.payload.orderStatus)}</dd>
              </div>
              <div>
                <dt>License status</dt>
                <dd>{titleCase(state.payload.licenseStatus)}</dd>
              </div>
              <div>
                <dt>License email</dt>
                <dd>{state.payload.licenseFileDeliveryStatus ? titleCase(state.payload.licenseFileDeliveryStatus) : "Queued or unavailable"}</dd>
              </div>
            </dl>

            <div className="billing-result-actions">
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void resendLicenseFile()}
                disabled={resendState.kind === "sending"}
              >
                {resendState.kind === "sending" ? "Requesting resend…" : "Resend encrypted license file"}
              </button>
              {state.payload.autoRenew && !state.payload.cancelAtPeriodEnd && state.payload.subscriptionStatus === "active" && (
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => void cancelSubscriptionRenewal()}
                  disabled={cancelState.kind === "canceling"}
                >
                  {cancelState.kind === "canceling" ? "Canceling renewal…" : "Cancel automatic renewal"}
                </button>
              )}
              <a className="button button-secondary" href="/#feedback">Contact support</a>
            </div>
            <p className="billing-token-note">
              Cancellation only stops the next renewal and keeps the current paid-through period. Refunds are full-order support/admin actions, and completed full refunds immediately end paid access for that order.
            </p>

            {cancelState.kind === "canceled" && (
              <p className="billing-order-message billing-order-success">
                Automatic renewal has been canceled. Access remains available until {epochDate(cancelState.payload.paidThrough)}. No refund was requested by this action.
              </p>
            )}
            {cancelState.kind === "error" && (
              <p className="billing-order-message billing-order-error">{cancelState.message}</p>
            )}
            {resendState.kind === "sent" && (
              <p className="billing-order-message billing-order-success">
                {resendState.payload.status === "duplicate"
                  ? "A resend request is already queued for this order."
                  : "A replacement license email has been queued."} Next attempt: {epochDate(resendState.payload.nextAttemptAt)}.
              </p>
            )}
            {resendState.kind === "error" && (
              <p className="billing-order-message billing-order-error">{resendState.message}</p>
            )}
          </>
        )}
      </article>
    </section>
  );
}
