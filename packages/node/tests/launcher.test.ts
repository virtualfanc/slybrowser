import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { diagnoseNetworkAlignment, prepareLaunch } from "../src/launcher.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

async function expectPrivateHandoffFile(path: string): Promise<void> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("icacls", [path], { windowsHide: true });
    expect(stdout).not.toContain("(I)");
    expect(stdout).not.toMatch(/\\(?:Users|Everyone):/i);
    return;
  }
  const mode = (await stat(path)).mode & 0o777;
  expect(mode & 0o077).toBe(0);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("prepareLaunch", () => {
  it("keeps secrets out of arguments and cleans handoff files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const secret = "license-secret-must-not-appear-in-arguments";
    const runtimeSecret = "bootstrap-token-must-not-appear-in-arguments";
    const driverRuntimeSecret = "driver-bootstrap-token-must-not-appear-in-arguments";
    const plan = await prepareLaunch(executable, { headless: true }, { lease: secret }, {
      tempRoot: directory,
      extraArguments: ["--no-first-run"],
      includeDriverLease: true,
      runtimeHandoff: { schemaVersion: 2, bootstrapToken: runtimeSecret },
      driverRuntimeHandoff: { schemaVersion: 2, bootstrapToken: driverRuntimeSecret },
    });
    expect(plan.arguments.join(" ")).not.toContain(secret);
    expect(plan.arguments.join(" ")).not.toContain(runtimeSecret);
    expect(plan.arguments.join(" ")).not.toContain(driverRuntimeSecret);
    await expect(access(plan.configFile)).resolves.toBeUndefined();
    await expect(access(plan.licenseFile)).resolves.toBeUndefined();
    expect(plan.driverLicenseFile).toBeDefined();
    await expect(access(plan.driverLicenseFile!)).resolves.toBeUndefined();
    expect(plan.runtimeFile).toBeDefined();
    await expect(access(plan.runtimeFile!)).resolves.toBeUndefined();
    expect(plan.driverRuntimeFile).toBeDefined();
    await expect(access(plan.driverRuntimeFile!)).resolves.toBeUndefined();
    await expect(readFile(plan.runtimeFile!, "utf8")).resolves.toContain(runtimeSecret);
    await expect(readFile(plan.driverRuntimeFile!, "utf8")).resolves.toContain(driverRuntimeSecret);
    await Promise.all([
      expectPrivateHandoffFile(plan.configFile),
      expectPrivateHandoffFile(plan.licenseFile),
      expectPrivateHandoffFile(plan.driverLicenseFile!),
      expectPrivateHandoffFile(plan.runtimeFile!),
      expectPrivateHandoffFile(plan.driverRuntimeFile!),
    ]);
    expect(plan.arguments).toEqual(expect.arrayContaining([expect.stringMatching(/^--sly-runtime-file=/)]));
    await plan.cleanup();
    await expect(access(plan.configFile)).rejects.toBeDefined();
    await expect(access(plan.licenseFile)).rejects.toBeDefined();
    await expect(access(plan.driverLicenseFile!)).rejects.toBeDefined();
    await expect(access(plan.runtimeFile!)).rejects.toBeDefined();
    await expect(access(plan.driverRuntimeFile!)).rejects.toBeDefined();
  });

  it("creates a private native-ready request and waits for the matching marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const plan = await prepareLaunch(executable, {}, { lease: "test" }, {
      tempRoot: directory,
      nativeReady: true,
    });
    expect(plan.nativeReadyRequestFile).toBeDefined();
    expect(plan.nativeReadyFile).toBeDefined();
    expect(plan.nativeReadyNonce).toBeDefined();
    expect(plan.arguments).toEqual(expect.arrayContaining([expect.stringMatching(/^--sly-native-ready-request-file=/)]));
    await expectPrivateHandoffFile(plan.nativeReadyRequestFile!);
    await expectPrivateHandoffFile(plan.nativeReadyFile!);
    const request = JSON.parse(await readFile(plan.nativeReadyRequestFile!, "utf8")) as {
      readyFile: string;
      nonce: string;
    };
    expect(request.readyFile).toBe(plan.nativeReadyFile);
    await writeFile(plan.nativeReadyFile!, JSON.stringify({
      schemaVersion: 1,
      kind: "slybrowser.native-ready",
      ready: true,
      nonce: request.nonce,
    }));
    await expect(plan.waitForNativeReady(100)).resolves.toBeUndefined();
    await plan.cleanup();
    await expect(access(plan.nativeReadyRequestFile!)).rejects.toBeDefined();
    await expect(access(plan.nativeReadyFile!)).rejects.toBeDefined();
  });

  it("rejects license material in extra arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    await expect(prepareLaunch(executable, {}, { lease: "test" }, {
      extraArguments: ["--license-key=secret"],
    })).rejects.toMatchObject({ code: "license_argument_forbidden" });
    await expect(prepareLaunch(executable, {}, { lease: "test" }, {
      extraArguments: ["--sly-runtime-token=secret"],
    })).rejects.toMatchObject({ code: "license_argument_forbidden" });
  });

  it("rejects post-activation runtime secrets in runtime handoff files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    await expect(prepareLaunch(executable, {}, { lease: "test" }, {
      tempRoot: directory,
      runtimeHandoff: { schemaVersion: 2, runtimeToken: "must-stay-native" },
    })).rejects.toMatchObject({ code: "runtime_handoff_secret_forbidden" });
    await expect(prepareLaunch(executable, {}, { lease: "test" }, {
      tempRoot: directory,
      runtimeHandoff: { schemaVersion: 2, activationTicket: "activation-secret" },
    })).rejects.toMatchObject({ code: "runtime_handoff_secret_forbidden" });
    await expect(prepareLaunch(executable, {}, { lease: "test" }, {
      tempRoot: directory,
      runtimeHandoff: { schemaVersion: 2, downloadTicket: { token: "download-secret" } },
    })).rejects.toMatchObject({ code: "runtime_handoff_secret_forbidden" });
  });

  it("allows runtime text in non-secret argument values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const plan = await prepareLaunch(executable, {}, { lease: "test" }, {
      tempRoot: directory,
      extraArguments: ["--enable-features=RuntimeCallStats"],
    });
    expect(plan.arguments).toContain("--enable-features=RuntimeCallStats");
    await plan.cleanup();
  });

  it("passes the signed release root as a non-secret native argument", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "SlyBrowser.exe");
    await writeFile(executable, "test");
    const releaseRoot = join(directory, "release-root");
    const plan = await prepareLaunch(executable, {}, { lease: "test" }, {
      tempRoot: directory,
      releaseRoot,
    });
    expect(plan.releaseRoot).toBe(releaseRoot);
    expect(plan.arguments).toContain(`--sly-release-root=${releaseRoot}`);
    await plan.cleanup();
  });

  it("rejects a long-lived license key in the profile handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    await expect(prepareLaunch(executable, { licenseKey: "long-lived-secret" }, { lease: "test" }, {
      tempRoot: directory,
    })).rejects.toMatchObject({ code: "profile_secret_forbidden" });
    await expect(prepareLaunch(executable, { runtimeToken: "short-lived-secret" }, { lease: "test" }, {
      tempRoot: directory,
    })).rejects.toMatchObject({ code: "profile_secret_forbidden" });
    await expect(prepareLaunch(executable, { activationTicket: "activation-secret" }, { lease: "test" }, {
      tempRoot: directory,
    })).rejects.toMatchObject({ code: "profile_secret_forbidden" });
  });

  it("rejects proxy and GEO launch features in the first release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");

    await expect(prepareLaunch(executable, {
      proxy: { server: "http://127.0.0.1:8080" },
    }, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "launch_feature_unsupported" });
    await expect(prepareLaunch(executable, {
      proxyAlignment: {
        source: "proxy-observer",
        exitIp: "203.0.113.10",
        observedAt: "2026-08-16T12:00:00Z",
        locale: "fr-FR",
        languages: ["fr-FR", "fr"],
        timezone: "Europe/Paris",
        geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 25 },
      },
    }, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "launch_feature_unsupported" });
    await expect(prepareLaunch(executable, {
      profile: { geolocation: { latitude: 48.8566, longitude: 2.3522 } },
    }, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "launch_feature_unsupported" });
    await expect(prepareLaunch(executable, {
      profile: { webrtc: "proxy" },
    }, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "launch_feature_unsupported" });
    expect(diagnoseNetworkAlignment({ proxy: { server: "http://127.0.0.1:8080" } }).missing)
      .toContain("proxy is not supported in the first SlyBrowser release");
  });

  it("validates the seeded fingerprint envelope before native launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const plan = await prepareLaunch(executable, {
      fingerprintMode: "seeded", fingerprintSeed: "stable-profile-seed", fingerprintSchemaVersion: 1,
    }, { lease: "test" }, { tempRoot: directory });
    expect(JSON.parse(await readFile(plan.configFile, "utf8"))).toMatchObject({ fingerprintMode: "seeded", fingerprintSeed: "stable-profile-seed", fingerprintSchemaVersion: 1 });
    await plan.cleanup();
    for (const invalid of [
      { fingerprintMode: "seeded", fingerprintSeed: "missing-schema" },
      { fingerprintMode: "explicit", fingerprintSeed: "forbidden", fingerprintSchemaVersion: 1 },
      { fingerprintSeed: "bad-version", fingerprintSchemaVersion: 2 },
    ]) {
      await expect(prepareLaunch(executable, invalid, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "profile_invalid" });
    }
  });
});
