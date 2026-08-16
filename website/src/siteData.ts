export type Language = "Node.js" | "Python" | ".NET";
export type BillingCycle = "monthly";
export type PaidPlanId = "launch" | "studio" | "fleet" | "grid";
export type PlanId = "free" | PaidPlanId;
export type CapabilityStatus = "Verified" | "Adapter" | "Preview";

export type PricingPlan = {
  id: PlanId;
  name: string;
  audience: string;
  availability: string;
  featured?: boolean;
  price: Record<BillingCycle, { amount: string; cadence: string }>;
  concurrency: string;
  unitPrice: string;
  features: string[];
};

export type Profile = {
  id: string;
  name: string;
  locale: string;
  timezone: string;
  screen: string;
  coordinates: string;
  proxy: string;
  webrtc: string;
};

export const profiles: Profile[] = [
  {
    id: "paris",
    name: "Paris QA",
    locale: "fr-FR",
    timezone: "Europe/Paris",
    screen: "1440 × 900",
    coordinates: "48.8566, 2.3522",
    proxy: "Paris route",
    webrtc: "Proxy route",
  },
  {
    id: "new-york",
    name: "New York Agent",
    locale: "en-US",
    timezone: "America/New_York",
    screen: "1536 × 960",
    coordinates: "40.7128, −74.0060",
    proxy: "New York route",
    webrtc: "Proxy route",
  },
  {
    id: "singapore",
    name: "Singapore Research",
    locale: "en-SG",
    timezone: "Asia/Singapore",
    screen: "1440 × 900",
    coordinates: "1.3521, 103.8198",
    proxy: "Singapore route",
    webrtc: "Proxy route",
  },
];

export const snippets: Record<Language, string> = {
  "Node.js": `import { launch } from "slybrowser";

await using browser = await launch(
  executable, lease, {
    profile: {
      locale: "fr-FR",
      timezone: "Europe/Paris",
      screen: { width: 1440, height: 900 },
      webrtc: "proxy"
    },
    humanize: true
  }
);

await browser.get("https://example.test");`,
  Python: `from slybrowser import launch

with launch(
    executable, lease,
    profile={
        "locale": "fr-FR",
        "timezone": "Europe/Paris",
        "screen": {"width": 1440, "height": 900},
        "webrtc": "proxy",
    },
    humanize=True,
) as browser:
    browser.get("https://example.test")`,
  ".NET": `await using var plan =
    await SlyBrowserLauncher.PrepareAsync(
        executable,
        new {
            locale = "fr-FR",
            timezone = "Europe/Paris",
            screen = new { width = 1440, height = 900 },
            webrtc = "proxy"
        },
        licenseEnvelope
    );`,
};

export const capabilities = [
  {
    icon: "globe",
    title: "Matched Chromium + WebDriver",
    body: "The SDK selects the project driver, rejects major-version mismatches and never falls back to a system Chrome.",
    status: "Verified" as CapabilityStatus,
  },
  {
    icon: "settings",
    title: "Native profile contract",
    body: "29 groups are validated and mapped; 13 stable groups are verified through the browser, iframe, Worker and network paths.",
    status: "Verified" as CapabilityStatus,
  },
  {
    icon: "profile",
    title: "Persistent or clean profiles",
    body: "Keep an isolated user-data directory between runs or start from an ephemeral profile every time.",
    status: "Verified" as CapabilityStatus,
  },
  {
    icon: "puzzle",
    title: "JavaScript + Python SDKs",
    body: "Use project WebDriver by default, Playwright explicitly in both SDKs, or the Puppeteer adapter in JavaScript.",
    status: "Adapter" as CapabilityStatus,
  },
  {
    icon: "contract",
    title: "Humanized W3C input",
    body: "Use curved non-center pointer paths, click holds, variable key timing and repeatable seeded regression runs.",
    status: "Verified" as CapabilityStatus,
  },
  {
    icon: "shield",
    title: "Artifact + lease validation",
    body: "SDK validators cover signed manifests, SHA-256 artifacts and short-lived leases; production signing remains gated.",
    status: "Preview" as CapabilityStatus,
  },
];

export const capabilityEvidence = [
  { value: "29", label: "configuration groups mapped" },
  { value: "13", label: "stable groups verified end to end" },
  { value: "40", label: "checks in the reproducible evidence harness" },
];

export const verificationMetrics = [
  { value: "148 ↔ 153", label: "SlyBrowser vs stock Chromium", note: "paired run · 2026-08-15" },
  { value: "75.73 vs 72.11", label: "coverage-adjusted score / 100", note: "40-entry comparison" },
  { value: "+3.62", label: "SlyBrowser measured advantage", note: "same host and time window" },
];

export const benchmarkBrowsers = [
  {
    id: "slybrowser",
    name: "SlyBrowser",
    version: "148.0.7778.179",
    score: "75.73",
    rawScore: "83.99",
    coverage: "90.16%",
    counts: "5 pass · 4 fail · 11 error · 17 evidence · 3 skip",
  },
  {
    id: "chromium",
    name: "Stock Chromium / Playwright",
    version: "153.0.8003.0",
    score: "72.11",
    rawScore: "72.11",
    coverage: "100%",
    counts: "3 pass · 7 fail · 11 error · 16 evidence · 3 skip",
  },
];

export const benchmarkComparisonRows = [
  { metric: "Coverage-adjusted score", slybrowser: "75.73", chromium: "72.11", delta: "+3.62 SlyBrowser" },
  { metric: "Raw measured score", slybrowser: "83.99", chromium: "72.11", delta: "+11.88 SlyBrowser" },
  { metric: "Automation signals", slybrowser: "100.00", chromium: "60.00", delta: "+40.00 SlyBrowser" },
  { metric: "Bot-detection checks", slybrowser: "76.75", chromium: "64.16", delta: "+12.59 SlyBrowser" },
  { metric: "Consistency checks", slybrowser: "94.44", chromium: "94.44", delta: "Tie" },
  { metric: "Required coverage", slybrowser: "90.16%", chromium: "100%", delta: "Chromium +9.84 pp" },
];

export const focusedTestRuns = [
  { name: "JavaScript SDK", result: "23 / 23", detail: "7 files · rerun 2026-08-16" },
  { name: "Python SDK", result: "21 / 21", detail: "rerun 2026-08-16" },
  { name: "Authorization service", result: "11 / 11", detail: "Grid 2,000 boundary included" },
  { name: "Detection + WebDriver harness", result: "17 / 17", detail: "rerun 2026-08-16" },
  { name: "Native license + profile", result: "21 / 21", detail: "focused C++ evidence · 2026-08-15" },
];

export const benchmarkOutcome = [
  { label: "Pass", value: "5", tone: "pass" },
  { label: "Measured fail", value: "4", tone: "fail" },
  { label: "Runner / network error", value: "11", tone: "error" },
  { label: "Evidence only", value: "17", tone: "evidence" },
  { label: "Not configured", value: "3", tone: "skip" },
];

export const consistencyRows = [
  ["Page", "Chromium runtime", "Profile-aligned"],
  ["Iframe", "Browser layer", "Same profile"],
  ["Worker", "Browser layer", "Same profile"],
  ["WebRTC", "Network route", "Proxy-aware"],
];

export const pricingPlans: PricingPlan[] = [
  {
    id: "free",
    name: "Free",
    audience: "Evaluation, development and small internal workflows",
    availability: "Always available",
    price: {
      monthly: { amount: "$0", cadence: "per month" },
    },
    concurrency: "1 concurrent browser process",
    unitPrice: "$0 per concurrent process / month",
    features: [
      "Latest verified Chromium build",
      "JavaScript + Python SDKs; .NET source preview",
      "Project WebDriver and Humanize",
      "Supported native profile controls",
      "Community support",
    ],
  },
  {
    id: "launch",
    name: "Launch",
    audience: "Independent developers and focused automation",
    availability: "Promo price",
    price: {
      monthly: { amount: "$19", cadence: "per month" },
    },
    concurrency: "5 concurrent browser processes",
    unitPrice: "$3.80 per concurrent process / month",
    features: [
      "Latest verified Chromium build",
      "JavaScript + Python SDKs; .NET source preview",
      "Playwright and Puppeteer adapters",
      "Internal commercial use",
      "Standard support queue",
    ],
  },
  {
    id: "studio",
    name: "Studio",
    audience: "Product, QA and data teams",
    availability: "Promo price",
    featured: true,
    price: {
      monthly: { amount: "$49", cadence: "per month" },
    },
    concurrency: "20 concurrent browser processes",
    unitPrice: "$2.45 per concurrent process / month",
    features: [
      "Everything in Launch",
      "Shared team entitlement",
      "Preview-channel opt in",
      "Priority support queue",
    ],
  },
  {
    id: "fleet",
    name: "Fleet",
    audience: "Production browser operations",
    availability: "Promo price",
    price: {
      monthly: { amount: "$199", cadence: "per month" },
    },
    concurrency: "200 concurrent browser processes",
    unitPrice: "~$1.00 per concurrent process / month",
    features: [
      "Everything in Studio",
      "Production rollout assistance",
      "Organization-owned entitlement",
      "Release and admin visibility",
      "Priority support",
    ],
  },
  {
    id: "grid",
    name: "Grid",
    audience: "High-scale distributed automation",
    availability: "Promo price",
    price: {
      monthly: { amount: "$499", cadence: "per month" },
    },
    concurrency: "2,000 concurrent browser processes",
    unitPrice: "~$0.25 per concurrent process / month",
    features: [
      "Everything in Fleet",
      "High-scale capacity validation",
      "Admin and release visibility",
      "Priority support",
    ],
  },
];
