import { type FormEvent, useState } from "react";
import {
  fetchAdminOrders,
  isAdminActor,
  isAdminBearerToken,
  requestAdminOrderRefund,
  type AdminOrderSummaryPayload,
  type AdminOrdersPayload,
} from "./billing";

type OrdersState =
  | { kind: "idle"; message?: string }
  | { kind: "loading"; offset: number }
  | { kind: "ready"; payload: AdminOrdersPayload }
  | { kind: "error"; message: string };

type RefundState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "submitted"; message: string }
  | { kind: "error"; message: string };

const ADMIN_TOKEN_STORAGE_KEY = "slybrowser.admin.orders.token";
const ADMIN_ACTOR_STORAGE_KEY = "slybrowser.admin.orders.actor";
const ADMIN_TOKEN_MAX_LENGTH = 512;
const ADMIN_ACTOR_MAX_LENGTH = 160;
const ADMIN_PAGE_LIMIT = 50;

function sessionValue(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Session storage is a convenience only; RBAC remains enforced by the API.
  }
}

function limitInput(value: string, limit: number): string {
  return value.slice(0, limit);
}

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function epochDate(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(Math.floor(seconds) * 1000));
}

function money(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined || currency === undefined) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount / 100);
}

function refundBlockedReason(order: AdminOrderSummaryPayload): string | undefined {
  if (order.orderStatus === "refunded") return "Already refunded";
  if (order.orderStatus === "disputed") return "Disputed order";
  if (order.latestRefund?.status === "completed") return "Refund completed";
  if (order.latestRefund?.status === "requested" || order.latestRefund?.status === "processing") return "Refund in progress";
  if (order.latestPayment?.status !== "completed") return "No completed payment";
  return undefined;
}

function adminError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function AdminOrders() {
  const [adminToken, setAdminToken] = useState(() => sessionValue(ADMIN_TOKEN_STORAGE_KEY));
  const [actor, setActor] = useState(() => sessionValue(ADMIN_ACTOR_STORAGE_KEY));
  const [state, setState] = useState<OrdersState>({ kind: "idle" });
  const [refundStates, setRefundStates] = useState<Record<string, RefundState>>({});

  const trimmedAdminToken = adminToken.trim();
  const trimmedActor = actor.trim();
  const canLoad = isAdminBearerToken(trimmedAdminToken) && isAdminActor(trimmedActor);

  async function loadOrders(offset: number) {
    if (!canLoad) {
      setState({ kind: "idle", message: "Enter an admin Bearer token with orders:read permission." });
      return;
    }
    writeSessionValue(ADMIN_TOKEN_STORAGE_KEY, trimmedAdminToken);
    writeSessionValue(ADMIN_ACTOR_STORAGE_KEY, trimmedActor);
    setState({ kind: "loading", offset });
    try {
      const payload = await fetchAdminOrders(trimmedAdminToken, trimmedActor || undefined, {
        limit: ADMIN_PAGE_LIMIT,
        offset,
      });
      setState({ kind: "ready", payload });
    } catch (error: unknown) {
      setState({ kind: "error", message: adminError(error, "Admin order list is not available.") });
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadOrders(0);
  }

  async function submitRefund(order: AdminOrderSummaryPayload) {
    const blocked = refundBlockedReason(order);
    if (blocked) {
      setRefundStates((current) => ({
        ...current,
        [order.publicOrderId]: { kind: "error", message: blocked },
      }));
      return;
    }
    const reason = window.prompt(`Manual refund for ${order.publicOrderId}. Enter the support reason:`);
    if (reason === null) return;
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 4) {
      setRefundStates((current) => ({
        ...current,
        [order.publicOrderId]: { kind: "error", message: "Reason must contain at least 4 characters." },
      }));
      return;
    }
    if (!window.confirm(`Submit a manual refund for ${order.publicOrderId}? This calls the PayNow refund API.`)) return;
    setRefundStates((current) => ({
      ...current,
      [order.publicOrderId]: { kind: "submitting" },
    }));
    try {
      const refunded = await requestAdminOrderRefund(
        trimmedAdminToken,
        trimmedActor || undefined,
        order.publicOrderId,
        normalizedReason,
      );
      setRefundStates((current) => ({
        ...current,
        [order.publicOrderId]: {
          kind: "submitted",
          message: `Refund ${refunded.status}: ${money(refunded.amount, refunded.currency)}.`,
        },
      }));
      await loadOrders(state.kind === "ready" ? state.payload.offset : 0);
    } catch (error: unknown) {
      setRefundStates((current) => ({
        ...current,
        [order.publicOrderId]: { kind: "error", message: adminError(error, "Manual refund could not be submitted.") },
      }));
    }
  }

  return (
    <section className="billing-result-page admin-orders-page">
      <div className="section-heading reveal is-visible">
        <span>Admin orders</span>
        <h1>SlyBrowser billing admin</h1>
        <p>Review all orders and submit manual refunds. The API still enforces RBAC; this page never stores tokens outside session storage.</p>
      </div>

      <article className="billing-result-card admin-orders-card reveal is-visible">
        <form className="billing-order-form admin-orders-auth" onSubmit={submit} noValidate>
          <label>
            <span>Admin Bearer token</span>
            <input
              type="password"
              value={adminToken}
              onChange={(event) => setAdminToken(limitInput(event.currentTarget.value, ADMIN_TOKEN_MAX_LENGTH))}
              placeholder="orders:read / orders:refund token"
              autoComplete="off"
              maxLength={ADMIN_TOKEN_MAX_LENGTH}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Actor label</span>
            <input
              value={actor}
              onChange={(event) => setActor(limitInput(event.currentTarget.value, ADMIN_ACTOR_MAX_LENGTH))}
              placeholder="support@slybrowser.com"
              autoComplete="off"
              maxLength={ADMIN_ACTOR_MAX_LENGTH}
              spellCheck={false}
            />
          </label>
          <button className="button button-primary" type="submit" disabled={state.kind === "loading"}>
            {state.kind === "loading" ? "Loading…" : "Load orders"}
          </button>
        </form>

        {state.kind === "idle" && state.message && <p className="billing-order-message">{state.message}</p>}
        {state.kind === "loading" && <p className="billing-order-message">Loading orders from admin API…</p>}
        {state.kind === "error" && <p className="billing-order-message billing-order-error">{state.message}</p>}

        {state.kind === "ready" && (
          <>
            <div className="admin-orders-summary">
              <span>{state.payload.orders.length} visible orders</span>
              <small>Offset {state.payload.offset} · Limit {state.payload.limit}</small>
            </div>
            <div className="admin-orders-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th>Payment</th>
                    <th>Refund</th>
                    <th>Paid through</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {state.payload.orders.map((order) => {
                    const blocked = refundBlockedReason(order);
                    const refundState = refundStates[order.publicOrderId] ?? { kind: "idle" };
                    return (
                      <tr key={order.publicOrderId}>
                        <td>
                          <strong>{order.publicOrderId}</strong>
                          <small>{order.payNowOrderId ?? "No PayNow order"}</small>
                        </td>
                        <td>{titleCase(order.plan)}</td>
                        <td>
                          <span>{titleCase(order.orderStatus)}</span>
                          <small>License {titleCase(order.licenseStatus)}</small>
                        </td>
                        <td>
                          <span>{money(order.latestPayment?.amount, order.latestPayment?.currency)}</span>
                          <small>{order.latestPayment ? titleCase(order.latestPayment.status) : "No payment"}</small>
                        </td>
                        <td>
                          <span>{order.latestRefund ? titleCase(order.latestRefund.status) : "None"}</span>
                          <small>{order.refundCount} refund record{order.refundCount === 1 ? "" : "s"}</small>
                        </td>
                        <td>{epochDate(order.paidThrough)}</td>
                        <td>
                          <button
                            className="button button-danger"
                            type="button"
                            onClick={() => void submitRefund(order)}
                            disabled={refundState.kind === "submitting" || blocked !== undefined}
                            title={blocked}
                          >
                            {refundState.kind === "submitting" ? "Refunding…" : "Manual refund"}
                          </button>
                          {refundState.kind === "submitted" && <small className="admin-action-success">{refundState.message}</small>}
                          {refundState.kind === "error" && <small className="admin-action-error">{refundState.message}</small>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="billing-result-actions admin-orders-pagination">
              <button
                className="button button-secondary"
                type="button"
                disabled={state.payload.offset <= 0}
                onClick={() => void loadOrders(Math.max(0, state.payload.offset - state.payload.limit))}
              >
                Previous
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={!state.payload.hasMore}
                onClick={() => void loadOrders(state.payload.offset + state.payload.orders.length)}
              >
                Next
              </button>
            </div>
          </>
        )}
      </article>
    </section>
  );
}
