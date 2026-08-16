import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { diagnoseNetworkAlignment, prepareLaunch } from "../src/launcher.js";

const directories: string[] = [];

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
    const plan = await prepareLaunch(executable, { headless: true }, { lease: secret }, {
      tempRoot: directory,
      extraArguments: ["--no-first-run"],
      includeDriverLease: true,
    });
    expect(plan.arguments.join(" ")).not.toContain(secret);
    await expect(access(plan.configFile)).resolves.toBeUndefined();
    await expect(access(plan.licenseFile)).resolves.toBeUndefined();
    expect(plan.driverLicenseFile).toBeDefined();
    await expect(access(plan.driverLicenseFile!)).resolves.toBeUndefined();
    await plan.cleanup();
    await expect(access(plan.configFile)).rejects.toBeDefined();
    await expect(access(plan.licenseFile)).rejects.toBeDefined();
    await expect(access(plan.driverLicenseFile!)).rejects.toBeDefined();
  });

  it("rejects license material in extra arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    await expect(prepareLaunch(executable, {}, { lease: "test" }, {
      extraArguments: ["--license-key=secret"],
    })).rejects.toMatchObject({ code: "license_argument_forbidden" });
  });

  it("rejects a long-lived license key in the profile handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    await expect(prepareLaunch(executable, { licenseKey: "long-lived-secret" }, { lease: "test" }, {
      tempRoot: directory,
    })).rejects.toMatchObject({ code: "profile_secret_forbidden" });
  });

  it("forces configured proxies to fail closed and aligns WebRTC by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const plan = await prepareLaunch(executable, {
      proxy: { server: "socks5://127.0.0.1:65534" },
    }, { lease: "test" }, { tempRoot: directory });
    const config = JSON.parse(await (await import("node:fs/promises")).readFile(plan.configFile, "utf8"));
    expect(config.proxy.failClosed).toBe(true);
    expect(config.webrtc).toBe("proxy");
    await plan.cleanup();

    await expect(prepareLaunch(executable, {
      proxy: { server: "http://127.0.0.1:8080", failClosed: false },
    }, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "proxy_fail_closed_required" });
  });

  it("applies observed proxy geography as one coherent profile and rejects contradictions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-launch-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const options = {
      proxy: { server: "http://127.0.0.1:8080" },
      proxyAlignment: {
        source: "proxy-observer",
        exitIp: "203.0.113.10",
        observedAt: "2026-08-16T12:00:00Z",
        locale: "fr-FR",
        languages: ["fr-FR", "fr"],
        timezone: "Europe/Paris",
        geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 25 },
      },
    };
    expect(diagnoseNetworkAlignment(options)).toMatchObject({ configured: true, aligned: true, exitIp: "203.0.113.10" });
    const plan = await prepareLaunch(executable, options, { lease: "test" }, { tempRoot: directory });
    const config = JSON.parse(await (await import("node:fs/promises")).readFile(plan.configFile, "utf8"));
    expect(config.proxyAlignment).toBeUndefined();
    expect(config.locale).toBe("fr-FR");
    expect(config.timezone).toBe("Europe/Paris");
    expect(config.geolocation.permission).toBe("allow");
    await plan.cleanup();

    await expect(prepareLaunch(executable, {
      ...options,
      profile: { locale: "en-US" },
    }, { lease: "test" }, { tempRoot: directory })).rejects.toMatchObject({ code: "proxy_alignment_conflict" });
    expect(diagnoseNetworkAlignment({ proxy: { server: "http://127.0.0.1:8080" } }).missing)
      .toContain("profile.geolocation");
  });
});
