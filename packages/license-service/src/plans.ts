import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PlanId = "free" | "launch" | "studio" | "fleet" | "grid";

export interface PlanDefinition {
  id: PlanId;
  sku: string;
  name: string;
  monthlyPriceCents: number;
  autoRenew: boolean;
  concurrency: number;
  features: readonly FeatureId[];
}

export interface PlanContract {
  schemaVersion: 1;
  currency: "USD";
  billingPeriod: "month";
  plans: readonly PlanDefinition[];
}

export const PLAN_IDS: readonly PlanId[] = Object.freeze(["free", "launch", "studio", "fleet", "grid"]);
export const FEATURE_IDS = Object.freeze([
  "browser",
  "release-download",
  "webdriver",
  "fingerprint",
  "humanize",
  "playwright",
  "puppeteer",
] as const);
export type FeatureId = typeof FEATURE_IDS[number];

const PLAN_CONTRACT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/plans.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readContractFile(): unknown {
  return JSON.parse(readFileSync(PLAN_CONTRACT_PATH, "utf8")) as unknown;
}

function parsePlanId(value: unknown): PlanId {
  if (typeof value === "string" && PLAN_IDS.includes(value as PlanId)) return value as PlanId;
  throw new Error(`contracts/plans.json contains an unknown plan id: ${String(value)}`);
}

function parseFeatureId(value: unknown, plan: PlanId): FeatureId {
  if (typeof value === "string" && FEATURE_IDS.includes(value as FeatureId)) return value as FeatureId;
  throw new Error(`contracts/plans.json ${plan}.features contains an unknown feature id: ${String(value)}`);
}

function parseIntegerAtLeast(value: unknown, field: string, minimum: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) return value;
  throw new Error(`contracts/plans.json ${field} must be a safe integer >= ${minimum}`);
}

function parseSku(value: unknown, plan: PlanId): string {
  if (typeof value === "string" && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value)) return value;
  throw new Error(`contracts/plans.json ${plan}.sku must be a lowercase SKU`);
}

function parseAutoRenew(value: unknown, plan: PlanId): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`contracts/plans.json ${plan}.autoRenew must be a boolean`);
  }
  if (plan === "free" && value) {
    throw new Error("contracts/plans.json free.autoRenew must be false");
  }
  if (plan !== "free" && !value) {
    throw new Error(`contracts/plans.json paid SKU ${plan} must default to autoRenew=true`);
  }
  return value;
}

function parsePlan(value: unknown): PlanDefinition {
  if (!isRecord(value)) throw new Error("contracts/plans.json plans entries must be objects");
  const id = parsePlanId(value.id);
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error(`contracts/plans.json ${id}.name must be a non-empty string`);
  }
  if (!Array.isArray(value.features) || value.features.length === 0) {
    throw new Error(`contracts/plans.json ${id}.features must be a non-empty array`);
  }
  const features = value.features.map((feature) => parseFeatureId(feature, id));
  if (new Set(features).size !== features.length) {
    throw new Error(`contracts/plans.json ${id}.features contains duplicates`);
  }
  return Object.freeze({
    id,
    sku: parseSku(value.sku, id),
    name: value.name,
    monthlyPriceCents: parseIntegerAtLeast(value.monthlyPriceCents, `${id}.monthlyPriceCents`, 0),
    autoRenew: parseAutoRenew(value.autoRenew, id),
    concurrency: parseIntegerAtLeast(value.concurrency, `${id}.concurrency`, 1),
    features: Object.freeze(features),
  });
}

function loadPlanContract(): PlanContract {
  const value = readContractFile();
  if (!isRecord(value)) throw new Error("contracts/plans.json must contain an object");
  if (value.schemaVersion !== 1) throw new Error("contracts/plans.json schemaVersion must be 1");
  if (value.currency !== "USD") throw new Error("contracts/plans.json currency must be USD");
  if (value.billingPeriod !== "month") throw new Error("contracts/plans.json billingPeriod must be month");
  if (!Array.isArray(value.plans)) throw new Error("contracts/plans.json plans must be an array");

  const plans = value.plans.map(parsePlan);
  const seen = new Set<PlanId>();
  const seenSkus = new Set<string>();
  for (const plan of plans) {
    if (seen.has(plan.id)) throw new Error(`contracts/plans.json contains duplicate plan id: ${plan.id}`);
    if (seenSkus.has(plan.sku)) throw new Error(`contracts/plans.json contains duplicate SKU: ${plan.sku}`);
    seen.add(plan.id);
    seenSkus.add(plan.sku);
  }
  for (const id of PLAN_IDS) {
    if (!seen.has(id)) throw new Error(`contracts/plans.json is missing required plan id: ${id}`);
  }

  return Object.freeze({
    schemaVersion: 1,
    currency: "USD",
    billingPeriod: "month",
    plans: Object.freeze(plans),
  });
}

function toPlanCatalog(contract: PlanContract): Readonly<Record<PlanId, PlanDefinition>> {
  return Object.freeze(Object.fromEntries(
    contract.plans.map((plan) => [plan.id, plan]),
  ) as Record<PlanId, PlanDefinition>);
}

export const PLAN_CONTRACT = loadPlanContract();
export const PLAN_CATALOG = toPlanCatalog(PLAN_CONTRACT);

export const FULL_FEATURES = Object.freeze([...new Set(PLAN_CONTRACT.plans.flatMap((plan) => plan.features))]);

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.hasOwn(PLAN_CATALOG, value);
}

export function effectivePlan(plan: PlanId, paidThrough: number | null, now: number): PlanId {
  if (plan === "free") return "free";
  return paidThrough !== null && paidThrough > now ? plan : "free";
}

export function featuresForPlan(plan: PlanId): readonly FeatureId[] {
  return PLAN_CATALOG[plan].features;
}

export function skuForPlan(plan: PlanId): string {
  return PLAN_CATALOG[plan].sku;
}

export function autoRenewForPlan(plan: PlanId): boolean {
  return PLAN_CATALOG[plan].autoRenew;
}

export function missingPlanFeatures(plan: PlanId, requiredFeatures: readonly string[]): string[] {
  const granted = new Set(featuresForPlan(plan));
  return [...new Set(requiredFeatures)].filter((feature) => !granted.has(feature as FeatureId)).sort();
}
