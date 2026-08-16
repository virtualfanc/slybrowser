import type { BillingCycle, PaidPlanId } from "./siteData";

type CheckoutMatrix = Record<PaidPlanId, Record<BillingCycle, string | undefined>>;

const hostedPayNowProducts: Record<PaidPlanId, string> = {
  launch: "https://virtualbrowser.paynow.store/products/slybrowser-launch-monthly",
  studio: "https://virtualbrowser.paynow.store/products/slybrowser-studio-monthly",
  fleet: "https://virtualbrowser.paynow.store/products/slybrowser-fleet-monthly",
  grid: "https://virtualbrowser.paynow.store/products/slybrowser-grid-monthly",
};

function validHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const checkoutUrls: CheckoutMatrix = {
  launch: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_LAUNCH_MONTHLY_URL) ?? hostedPayNowProducts.launch,
  },
  studio: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_STUDIO_MONTHLY_URL) ?? hostedPayNowProducts.studio,
  },
  fleet: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_FLEET_MONTHLY_URL) ?? hostedPayNowProducts.fleet,
  },
  grid: {
    monthly: validHttpsUrl(import.meta.env.VITE_PAYNOW_GRID_MONTHLY_URL) ?? hostedPayNowProducts.grid,
  },
};

export const paidPreviewUrl = validHttpsUrl(import.meta.env.VITE_PAID_PREVIEW_URL)
  ?? "https://github.com/virtualfanc/slybrowser";

export const manageSubscriptionsUrl = validHttpsUrl(import.meta.env.VITE_PAYNOW_SUBSCRIPTIONS_URL)
  ?? "https://checkout.paynow.gg/subscriptions";

export function getCheckoutUrl(plan: PaidPlanId, cycle: BillingCycle): string | undefined {
  return checkoutUrls[plan][cycle];
}

export function getSubscriptionCheckoutAction(plan: PaidPlanId, cycle: BillingCycle): string | undefined {
  const productUrl = getCheckoutUrl(plan, cycle);
  if (!productUrl) return undefined;

  const url = new URL(productUrl);
  if (!url.hostname.endsWith(".paynow.store") || !/^\/products\/[^/]+\/?$/.test(url.pathname)) {
    return undefined;
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/checkout`;
  url.searchParams.set("subscription", "true");
  return url.toString();
}

export const hasConfiguredCheckout = Object.values(checkoutUrls)
  .some((cycles) => Object.values(cycles).some(Boolean));
