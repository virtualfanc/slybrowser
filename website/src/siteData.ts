import planContract from "../../contracts/plans.json";

export type Language = "Node.js" | "Python" | "Java" | ".NET";
export type BillingCycle = "monthly";
export type PaidPlanId = "launch" | "studio" | "fleet" | "grid";
export type PlanId = "free" | PaidPlanId;
export type CapabilityStatus = "Verified" | "Adapter" | "Preview";

type PlanContractPlan = {
  id: PlanId;
  name: string;
  monthlyPriceCents: number;
  concurrency: number;
};

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

const planIds: readonly PlanId[] = ["free", "launch", "studio", "fleet", "grid"];

function toPlanId(value: string): PlanId {
  if (planIds.includes(value as PlanId)) return value as PlanId;
  throw new Error(`contracts/plans.json contains an unknown plan id: ${value}`);
}

function normalizePlan(plan: (typeof planContract.plans)[number]): PlanContractPlan {
  return {
    id: toPlanId(plan.id),
    name: plan.name,
    monthlyPriceCents: plan.monthlyPriceCents,
    concurrency: plan.concurrency,
  };
}

function formatMoney(cents: number, fixed = cents % 100 !== 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fixed ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatConcurrency(count: number): string {
  return `${count.toLocaleString("en-US")} concurrent browser process${count === 1 ? "" : "es"}`;
}

function formatUnitPrice(plan: PlanContractPlan): string {
  if (plan.monthlyPriceCents === 0) return "$0 per concurrent process / month";
  const unitCents = plan.monthlyPriceCents / plan.concurrency;
  const approximate = Number.isInteger(unitCents) ? "" : "~";
  return `${approximate}${formatMoney(Math.round(unitCents), true)} per concurrent process / month`;
}

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
  Java: `try (SlyWebDriverSession session = SlyBrowser.launch(
    Path.of("C:/path/to/SlyBrowser.exe"),
    Path.of("C:/path/to/chromedriver.exe"),
    licenseEnvelope
)) {
    session.getDriver().get("https://example.test");
}`,
  ".NET": `await using SlyWebDriverSession session =
    await SlyBrowserClient.LaunchAsync(
        @"C:\\path\\to\\SlyBrowser.exe",
        @"C:\\path\\to\\chromedriver.exe",
        licenseEnvelope
    );

session.Driver.Navigate().GoToUrl("https://example.test");`,
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
    title: "Four-language SDKs",
    body: "Use project WebDriver by default and Playwright explicitly in Node.js, Python, Java and .NET. Puppeteer stays Node.js/TypeScript only.",
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
  { value: "80.01 vs 71.11", label: "coverage-adjusted score / 100", note: "saved evidence · 2026-08-16" },
  { value: "+8.90", label: "SlyBrowser measured advantage", note: "same host, network and saved run" },
  { value: "100 vs 80", label: "core automation signals", note: "public Node SDK + matched WebDriver" },
];

export const benchmarkBrowsers = [
  {
    id: "slybrowser",
    name: "SlyBrowser",
    mode: "Headed · Node SDK + matched WebDriver · Chromium 148.0.7778.179",
    score: "80.01",
    rawScore: "88.74",
    coverage: "90.16%",
    counts: "7 selected passing checks highlighted",
  },
  {
    id: "chromium",
    name: "Stock Chromium",
    mode: "Headed · Playwright baseline · Chromium 153.0.8003.0",
    score: "71.11",
    rawScore: "78.86",
    coverage: "90.16%",
    counts: "2 selected passing checks highlighted",
  },
];

export const benchmarkComparisonRows = [
  { metric: "Coverage-adjusted score", slybrowser: "80.01", chromium: "71.11", delta: "+8.90 SlyBrowser" },
  { metric: "Raw measured score", slybrowser: "88.74", chromium: "78.86", delta: "+9.88 SlyBrowser" },
  { metric: "Automation signals", slybrowser: "100.00", chromium: "80.00", delta: "+20.00 SlyBrowser" },
  { metric: "Bot-detection checks", slybrowser: "82.30", chromium: "73.26", delta: "+9.04 SlyBrowser" },
  { metric: "Consistency checks", slybrowser: "100.00", chromium: "94.44", delta: "+5.56 SlyBrowser" },
  { metric: "Device & Browser Info", slybrowser: "100.00", chromium: "73.91", delta: "+26.09 SlyBrowser" },
  { metric: "Interaction score", slybrowser: "92.31", chromium: "69.23", delta: "+23.08 SlyBrowser" },
];

export const focusedTestRuns = [
  { name: "JavaScript SDK", result: "38 / 38", detail: "9 files · rerun 2026-08-17" },
  { name: "Python SDK", result: "34 / 34", detail: "rerun 2026-08-17" },
  { name: "Java SDK", result: "6 / 6", detail: "Java 11 compile · rerun 2026-08-17" },
  { name: ".NET SDK", result: "6 / 6", detail: ".NET 8 compile · rerun 2026-08-17" },
  { name: "Detection + WebDriver harness", result: "19 / 19", detail: "rerun 2026-08-17" },
  { name: "Node headed Humanize", result: "PASS", detail: "Page · Frame · Element · DPI" },
  { name: "Python headed Humanize", result: "PASS", detail: "Page · Frame · Element · DPI" },
];

export const benchmarkOutcome = [
  { label: "Selected passing checks", value: "7", tone: "pass" },
  { label: "Core automation signals", value: "100", tone: "pass" },
  { label: "Consistency score", value: "100", tone: "pass" },
  { label: "Interaction score", value: "92.31", tone: "pass" },
];

export const consistencyRows = [
  ["Page", "Chromium runtime", "Profile-aligned"],
  ["Iframe", "Browser layer", "Same profile"],
  ["Worker", "Browser layer", "Same profile"],
  ["WebRTC", "Network route", "Proxy-aware"],
];

const pricingPlanMetadata: Record<PlanId, Omit<PricingPlan, "id" | "name" | "price" | "concurrency" | "unitPrice">> = {
  free: {
    audience: "Evaluation, development and small internal workflows",
    availability: "Always available",
    features: [
      "Latest verified Chromium build",
      "Node.js, Python, Java and .NET SDKs",
      "Project WebDriver and Humanize",
      "Supported native profile controls",
      "Community support",
    ],
  },
  launch: {
    audience: "Independent developers and focused automation",
    availability: "Promo price",
    features: [
      "Latest verified Chromium build",
      "Node.js, Python, Java and .NET SDKs",
      "Playwright adapters; Puppeteer for Node.js",
      "Internal commercial use",
      "Standard support queue",
    ],
  },
  studio: {
    audience: "Product, QA and data teams",
    availability: "Promo price",
    featured: true,
    features: [
      "Everything in Launch",
      "Shared team entitlement",
      "Preview-channel opt in",
      "Priority support queue",
    ],
  },
  fleet: {
    audience: "Production browser operations",
    availability: "Self-serve promo",
    features: [
      "Everything in Studio",
      "Production rollout assistance",
      "Organization-owned entitlement",
      "Release and admin visibility",
      "Priority support",
    ],
  },
  grid: {
    audience: "High-scale distributed automation",
    availability: "Self-serve promo",
    features: [
      "Everything in Fleet",
      "High-scale capacity validation",
      "Admin and release visibility",
      "Priority support",
    ],
  },
};

export const pricingPlans: PricingPlan[] = planContract.plans.map((rawPlan) => {
  const plan = normalizePlan(rawPlan);
  const metadata = pricingPlanMetadata[plan.id];
  return {
    id: plan.id,
    name: plan.name,
    ...metadata,
    price: {
      monthly: { amount: formatMoney(plan.monthlyPriceCents), cadence: "per month" },
    },
    concurrency: formatConcurrency(plan.concurrency),
    unitPrice: formatUnitPrice(plan),
  };
});
