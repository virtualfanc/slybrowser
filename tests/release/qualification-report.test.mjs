import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const sixtyFour = (character) => character.repeat(64);

test("qualification report generator emits saved versions while redacting secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-qualification-report-"));
  try {
    const release = join(root, "release.json");
    const kernelGate = join(root, "kernel-gate.json");
    const cleanMachine = join(root, "clean-machine.json");
    const nativeRuntimeHandoff = join(root, "native-runtime-handoff.json");
    const output = join(root, "out");
    await mkdir(output);
    await writeFile(release, JSON.stringify({
      status: "QUALIFIED",
      browserVersion: "150.0.0.0",
      driverVersion: "150.0.0.0",
      keyId: "release-test-v1",
      sdkCompatibility: ">=0.1.0 <1.0.0",
      artifactSha256: sixtyFour("a"),
      browserSha256: sixtyFour("b"),
      driverSha256: sixtyFour("c"),
      manifest: { sha256: sixtyFour("d") },
      artifact: {
        url: "https://api.slybrowser.com/v1/releases/artifacts/browser.zip",
        sha256: sixtyFour("a"),
        browserSha256: sixtyFour("b"),
        driverSha256: sixtyFour("c"),
      },
    }));
    await writeFile(kernelGate, JSON.stringify({
      status: "PASS",
      results: {
        sameMajorComparison: true,
        scoreDelta: 10.5,
        slybrowser: { driverVersion: "150.0.0.0" },
      },
      gates: [
        { id: "sly-score-floor", status: "PASS" },
        { id: "same-major-baseline", status: "PASS" },
        { id: "stock-delta", status: "PASS" },
      ],
    }));
    await writeFile(cleanMachine, JSON.stringify({
      status: "PASS",
      selectedVersion: "150.0.0.0",
      authFileRemoved: true,
      results: [
        { id: "fresh-latest-download", status: "PASS" },
        { id: "current-pointer-update-false-reuse", status: "PASS" },
      ],
    }));
    await writeFile(nativeRuntimeHandoff, JSON.stringify({
      passed: true,
      cases: [
        { id: "browser-license-only-rejected", passed: true },
        { id: "native-runtime-handoff", passed: true, stderr: "runtime-token-secret activation-ticket-secret sly_live_secret" },
      ],
    }));

    execFileSync(process.execPath, [
      resolve("scripts/release/Build-QualificationReport.mjs"),
      "--release-bundle", release,
      "--kernel-update-score-gate", kernelGate,
      "--clean-machine-validation", cleanMachine,
      "--native-runtime-handoff", nativeRuntimeHandoff,
      "--output", output,
      "--channel", "stable",
      "--platform", "windows",
      "--arch", "x64",
      "--artifact-sha256", sixtyFour("a"),
      "--browser-sha256", sixtyFour("b"),
      "--driver-sha256", sixtyFour("c"),
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(join(output, "release-qualification.json"), "utf8"));
    const human = await readFile(join(output, "release-qualification.md"), "utf8");
    assert.equal(machine.status, "PENDING");
    assert.equal(machine.release.browserVersion, "150.0.0.0");
    assert.equal(machine.release.kernelVersion, "150.0.0.0");
    assert.equal(machine.release.driverVersion, "150.0.0.0");
    assert.equal(machine.release.signedManifestSha256, sixtyFour("d"));
    assert.equal(machine.release.artifactUrl, "https://api.slybrowser.com/v1/releases/artifacts/browser.zip");
    assert.equal(machine.release.sdkCompatibility, ">=0.1.0 <1.0.0");
    assert.deepEqual(machine.release.privateFieldsOmitted, ["rawTokens", "licenseKeys", "privateSigningMaterial"]);
    assert.deepEqual(machine.gates.map((item) => [item.id, item.status]), [
      ["release-bundle", "PASS"],
      ["kernel-update-score-gate", "PASS"],
      ["clean-machine-release-validation", "PASS"],
      ["signed-private-browser", "PASS"],
      ["redacted-report-contract", "PASS"],
      ["production-security-matrix", "PENDING"],
    ]);
    const rendered = `${JSON.stringify(machine)}\n${human}`;
    assert.equal(rendered.includes("150.0.0.0"), true);
    assert.equal(rendered.includes("runtime-token-secret"), false);
    assert.equal(rendered.includes("activation-ticket-secret"), false);
    assert.equal(rendered.includes("sly_live_secret"), false);
    assert.match(human, /Release is not qualified yet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification report blocks when verified manifest hashes disagree with release inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-qualification-report-mismatch-"));
  try {
    const release = join(root, "release.json");
    const output = join(root, "out");
    await mkdir(output);
    await writeFile(release, JSON.stringify({
      status: "QUALIFIED",
      browserVersion: "150.0.0.0",
      keyId: "release-test-v1",
      artifact: {
        url: "https://api.slybrowser.com/v1/releases/artifacts/browser.zip",
        sha256: sixtyFour("d"),
        browserSha256: sixtyFour("b"),
        driverSha256: sixtyFour("c"),
      },
    }));

    execFileSync(process.execPath, [
      resolve("scripts/release/Build-QualificationReport.mjs"),
      "--release-bundle", release,
      "--output", output,
      "--channel", "stable",
      "--platform", "windows",
      "--arch", "x64",
      "--artifact-sha256", sixtyFour("a"),
      "--browser-sha256", sixtyFour("b"),
      "--driver-sha256", sixtyFour("c"),
    ], { encoding: "utf8" });

    const machine = JSON.parse(await readFile(join(output, "release-qualification.json"), "utf8"));
    const human = await readFile(join(output, "release-qualification.md"), "utf8");
    assert.equal(machine.status, "BLOCKED");
    const releaseGate = machine.gates.find((item) => item.id === "release-bundle");
    assert.equal(releaseGate.status, "FAIL");
    assert.deepEqual(releaseGate.mismatchedFields, ["artifactSha256"]);
    assert.match(human, /hash mismatch: artifactSha256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
