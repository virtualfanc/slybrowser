const GOOGLE_ANALYTICS_SCRIPT_ID = "sly-google-analytics";
const GOOGLE_ANALYTICS_ID_PATTERN = /^G-[A-Z0-9]+$/;
const DEFAULT_GOOGLE_ANALYTICS_ID = "G-SGC11DVXTD";
const ANALYTICS_CONSENT_STORAGE_KEY = "slybrowser.analytics-consent.v1";
const ANALYTICS_CONSENT_VERSION = 1;
const VISITOR_REGION_ENDPOINT = "/visitor-region";
const VISITOR_REGION_TIMEOUT_MS = 2_000;

export const CONSENT_REQUIRED_COUNTRY_CODES = [
  "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GR", "HR",
  "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MT", "NL", "NO", "PL", "PT", "RO", "SE",
  "SI", "SK",
] as const;

const consentRequiredCountries = new Set<string>(CONSENT_REQUIRED_COUNTRY_CODES);

export type AnalyticsConsent = "granted" | "denied" | null;
export type VisitorConsentRegion = "regulated" | "unregulated" | "unknown";

type StoredAnalyticsConsent = {
  analytics: Exclude<AnalyticsConsent, null>;
  updatedAt: string;
  version: typeof ANALYTICS_CONSENT_VERSION;
};

type GoogleTag = (...args: unknown[]) => void;
type AnalyticsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: GoogleTag;
};

let analyticsScheduled = false;

function getGoogleTag() {
  const analyticsWindow = window as AnalyticsWindow;
  analyticsWindow.dataLayer ??= [];
  analyticsWindow.gtag ??= function gtag(..._args: unknown[]) {
    analyticsWindow.dataLayer!.push(arguments);
  };
  return analyticsWindow.gtag;
}

export function getAnalyticsConsent(): AnalyticsConsent {
  try {
    const storedValue = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    if (!storedValue) {
      return null;
    }

    const storedConsent = JSON.parse(storedValue) as Partial<StoredAnalyticsConsent>;
    if (
      storedConsent.version === ANALYTICS_CONSENT_VERSION
      && (storedConsent.analytics === "granted" || storedConsent.analytics === "denied")
    ) {
      return storedConsent.analytics;
    }
  } catch {
    // Storage can be unavailable in hardened browsing contexts. Default denied.
  }

  return null;
}

function persistAnalyticsConsent(analytics: Exclude<AnalyticsConsent, null>) {
  const storedConsent: StoredAnalyticsConsent = {
    analytics,
    updatedAt: new Date().toISOString(),
    version: ANALYTICS_CONSENT_VERSION,
  };

  try {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, JSON.stringify(storedConsent));
  } catch {
    // Consent still applies to the current page when storage is unavailable.
  }
}

function clearGoogleAnalyticsCookies() {
  const cookieNames = document.cookie
    .split(";")
    .map((cookie) => cookie.split("=", 1)[0]?.trim())
    .filter((name): name is string => Boolean(name))
    .filter((name) => ["_ga", "_gid", "_gat"].includes(name) || /^(?:_ga_|_gac_|_gcl_)/.test(name));

  const hostname = window.location.hostname;
  const domains = hostname === "slybrowser.com" || hostname.endsWith(".slybrowser.com")
    ? [undefined, "slybrowser.com", ".slybrowser.com"]
    : [undefined];

  for (const name of cookieNames) {
    for (const domain of domains) {
      const domainAttribute = domain ? ` domain=${domain};` : "";
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;${domainAttribute} SameSite=Lax`;
    }
  }
}

function consentValues(analytics: Exclude<AnalyticsConsent, null>) {
  return {
    ad_personalization: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    analytics_storage: analytics,
  } as const;
}

export function requiresAnalyticsConsent(countryCode: string) {
  return consentRequiredCountries.has(countryCode.trim().toUpperCase());
}

export async function getVisitorConsentRegion(): Promise<VisitorConsentRegion> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), VISITOR_REGION_TIMEOUT_MS);

  try {
    const response = await fetch(VISITOR_REGION_ENDPOINT, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return "unknown";
    }

    const payload = await response.json() as { country?: unknown };
    if (typeof payload.country !== "string" || !/^[A-Za-z]{2}$/.test(payload.country)) {
      return "unknown";
    }

    const country = payload.country.toUpperCase();
    if (country === "XX") {
      return "unknown";
    }

    return requiresAnalyticsConsent(country) ? "regulated" : "unregulated";
  } catch {
    return "unknown";
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function updateAnalyticsConsent(
  analytics: Exclude<AnalyticsConsent, null>,
  options: { persist?: boolean } = {},
) {
  if (options.persist !== false) {
    persistAnalyticsConsent(analytics);
  }
  getGoogleTag()("consent", "update", consentValues(analytics));

  if (analytics === "denied") {
    clearGoogleAnalyticsCookies();
  }
}

function loadGoogleAnalytics(measurementId: string) {
  const existingScript = document.querySelector(
    `script[src*="googletagmanager.com/gtag/js?id=${measurementId}"]`,
  );
  if (document.getElementById(GOOGLE_ANALYTICS_SCRIPT_ID) || existingScript) {
    return;
  }

  const script = document.createElement("script");
  script.id = GOOGLE_ANALYTICS_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  script.dataset.measurementId = measurementId;
  document.head.append(script);
}

export function scheduleGoogleAnalytics() {
  if (analyticsScheduled) {
    return;
  }

  const configuredId = import.meta.env.VITE_GOOGLE_ANALYTICS_ID?.trim();
  const measurementId = configuredId || (import.meta.env.PROD ? DEFAULT_GOOGLE_ANALYTICS_ID : undefined);
  if (!measurementId || !GOOGLE_ANALYTICS_ID_PATTERN.test(measurementId)) {
    return;
  }

  analyticsScheduled = true;
  const gtag = getGoogleTag();
  gtag("consent", "default", {
    ...consentValues("denied"),
    region: CONSENT_REQUIRED_COUNTRY_CODES,
    wait_for_update: 2_000,
  });
  gtag("consent", "default", {
    ...consentValues("granted"),
    wait_for_update: 2_000,
  });
  gtag("set", "ads_data_redaction", true);
  gtag("js", new Date());
  gtag("config", measurementId, {
    allow_ad_personalization_signals: false,
    allow_google_signals: false,
    debug_mode: ["localhost", "127.0.0.1"].includes(window.location.hostname),
  });

  const start = () => loadGoogleAnalytics(measurementId);
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(start, { timeout: 2_000 });
    return;
  }

  globalThis.setTimeout(start, 0);
}
