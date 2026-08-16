export type PlanId = "free" | "launch" | "studio" | "fleet" | "grid";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  monthlyPriceCents: number;
  concurrency: number;
}

export const PLAN_CATALOG: Readonly<Record<PlanId, PlanDefinition>> = Object.freeze({
  free: Object.freeze({ id: "free", name: "Free", monthlyPriceCents: 0, concurrency: 1 }),
  launch: Object.freeze({ id: "launch", name: "Launch", monthlyPriceCents: 1900, concurrency: 5 }),
  studio: Object.freeze({ id: "studio", name: "Studio", monthlyPriceCents: 4900, concurrency: 20 }),
  fleet: Object.freeze({ id: "fleet", name: "Fleet", monthlyPriceCents: 19900, concurrency: 200 }),
  grid: Object.freeze({ id: "grid", name: "Grid", monthlyPriceCents: 49900, concurrency: 2000 }),
});

export const FULL_FEATURES = Object.freeze(["browser", "fingerprint", "humanize", "webdriver"]);

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.hasOwn(PLAN_CATALOG, value);
}

export function effectivePlan(plan: PlanId, paidThrough: number | null, now: number): PlanId {
  if (plan === "free") return "free";
  return paidThrough !== null && paidThrough > now ? plan : "free";
}
