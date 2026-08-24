import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const allowedStatuses = new Set([
  "covered",
  "harness-required",
  "native-pending",
  "production-pending",
]);

const requiredThreats = new Set([
  "sdk-bypass-system-fallback",
  "frontend-plan-tamper",
  "release-manifest-tamper",
  "binary-hash-tamper",
  "direct-webdriver-run",
  "copied-installation-directory",
  "old-lease-replay",
  "activation-ticket-replay",
  "clock-rollback",
  "paid-feature-escalation",
  "production-normal-and-bypass-matrix",
  "redacted-security-report-archive",
]);

const matrix = [
  {
    id: "sdk-bypass-system-fallback",
    status: "covered",
    evidence: [
      {
        file: "packages/node/tests/licensed.test.ts",
        contains: ["without silent fallback", "requestedBrowserVersion", "selectionReason"],
      },
      {
        file: "packages/python/tests/test_licensed.py",
        contains: ["test_exact_version_and_explicit_rollback_are_reported", "version chain mismatch"],
      },
      {
        file: "tests/release/signed-private-browser-license-only.mjs",
        contains: ["webdriver-rejects-unpaired-browser", "project WebDriver rejects an unpaired system browser"],
      },
    ],
  },
  {
    id: "frontend-plan-tamper",
    status: "covered",
    evidence: [
      {
        file: "packages/license-service/tests/paynow.test.ts",
        contains: ["rejects client-side tampering", "price: 1", "checkout_url"],
      },
    ],
  },
  {
    id: "release-manifest-tamper",
    status: "covered",
    evidence: [
      {
        file: "packages/node/tests/licensed.test.ts",
        contains: ["rejects a manifest changed after signing", "manifest_invalid_signature"],
      },
      {
        file: "tests/release/release-tools.test.mjs",
        contains: ["produce a verifiable Ed25519 manifest", "available release manifest"],
      },
    ],
  },
  {
    id: "binary-hash-tamper",
    status: "covered",
    evidence: [
      {
        file: "packages/node/tests/licensed.test.ts",
        contains: ["tampered-again", ".bad-", "corrupt-archive"],
      },
      {
        file: "packages/python/tests/test_licensed.py",
        contains: ["tampered-again", ".bad-", "corrupt-archive"],
      },
      {
        file: "tests/release/release-tools.test.mjs",
        contains: ["raw PDB or symbol files", "artifact", "driver"],
      },
    ],
  },
  {
    id: "direct-webdriver-run",
    status: "harness-required",
    evidence: [
      {
        file: "tests/release/signed-private-browser-license-only.mjs",
        contains: ["webdriver-missing-driver-license", "project WebDriver fails closed without its own signed lease"],
      },
    ],
  },
  {
    id: "copied-installation-directory",
    status: "native-pending",
    evidence: [
      {
        file: "docs/security-regression-matrix.md",
        contains: ["copied installation directory", "native binary gate"],
      },
    ],
  },
  {
    id: "old-lease-replay",
    status: "covered",
    evidence: [
      {
        file: "packages/license-service/tests/service.test.ts",
        contains: ["device_changed_for_replay", "startup_binding_mismatch"],
      },
    ],
  },
  {
    id: "activation-ticket-replay",
    status: "covered",
    evidence: [
      {
        file: "packages/license-service/tests/service.test.ts",
        contains: ["activateRuntimeSession(first.sessionId, first.activationTicket)", "session_invalid"],
      },
    ],
  },
  {
    id: "clock-rollback",
    status: "covered",
    evidence: [
      {
        file: "packages/license-service/tests/service.test.ts",
        contains: ["context.now.value -= 5", "leaseGeneration"],
      },
    ],
  },
  {
    id: "paid-feature-escalation",
    status: "covered",
    evidence: [
      {
        file: "packages/license-service/tests/service.test.ts",
        contains: ["denies paid automation backends on Free", "license_feature_denied"],
      },
    ],
  },
  {
    id: "production-normal-and-bypass-matrix",
    status: "production-pending",
    evidence: [
      {
        file: "docs/security-regression-matrix.md",
        contains: ["production-like build", "normal path", "bypass path"],
      },
    ],
  },
  {
    id: "redacted-security-report-archive",
    status: "covered",
    evidence: [
      {
        file: "docs/security-regression-matrix.md",
        contains: ["Redacted report template", "Do not include"],
      },
    ],
  },
];

test("security regression matrix names every required anti-abuse category exactly once", () => {
  const ids = matrix.map((item) => item.id);
  assert.deepEqual(new Set(ids), requiredThreats);
  assert.equal(ids.length, requiredThreats.size);
  for (const item of matrix) {
    assert.equal(allowedStatuses.has(item.status), true, `${item.id} uses an unknown status`);
  }
});

test("covered security matrix rows are backed by repository tests or a redacted report contract", async () => {
  for (const item of matrix) {
    assert.ok(item.evidence?.length, `${item.id} must point at evidence`);
    for (const evidence of item.evidence) {
      const path = resolve(evidence.file);
      await access(path);
      const text = await readFile(path, "utf8");
      for (const expected of evidence.contains) {
        assert.ok(text.includes(expected), `${item.id} evidence ${evidence.file} must contain ${expected}`);
      }
    }
  }
});

test("native and production-only checks are not claimed as ordinary unit-test coverage", () => {
  const pendingNative = matrix.filter((item) => item.status === "native-pending" || item.status === "production-pending");
  assert.deepEqual(pendingNative.map((item) => item.id).sort(), [
    "copied-installation-directory",
    "production-normal-and-bypass-matrix",
  ]);

  const harness = matrix.find((item) => item.id === "direct-webdriver-run");
  assert.equal(harness?.status, "harness-required");
});
