import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readDeployFile(name: string): string {
  return readFileSync(resolve(packageRoot, "deploy", name), "utf8");
}

describe("license service deploy units", () => {
  it("schedules PayNow reconciliation every 30-60 minutes and alerts on failure", () => {
    const service = readDeployFile("slybrowser-billing-reconcile.service");
    expect(service).toContain("billing-reconcile-paynow --payment-limit 100 --subscription-limit 100");
    expect(service).toContain("OnFailure=slybrowser-billing-alert@%n.service");
    expect(service).toContain("EnvironmentFile=/etc/slybrowser/billing.env");
    expect(service).toContain("ProtectSystem=strict");

    const timer = readDeployFile("slybrowser-billing-reconcile.timer");
    expect(timer).toContain("OnUnitActiveSec=30min");
    expect(timer).toContain("RandomizedDelaySec=30min");
    expect(timer).toContain("Persistent=true");

    const alertService = readDeployFile("slybrowser-billing-alert@.service");
    expect(alertService).toContain("systemd-failure-alert.sh %i");

    const alertScript = readDeployFile("systemd-failure-alert.sh");
    expect(alertScript).toContain("SLY_OPS_ALERT_WEBHOOK_URL");
    expect(alertScript).toContain("systemd_unit_failed");
    expect(alertScript).not.toContain("journalctl");
  });
});
