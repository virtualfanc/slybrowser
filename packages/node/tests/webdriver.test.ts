import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildWebDriverSessionPayload,
  defaultDriverExecutable,
  deriveReleaseRoot,
  describeDefaultDriver,
  SlyWebDriverService,
  SlyWebDriverSession,
  validateWebDriverCapabilities,
} from "../src/webdriver.js";

const originalDriverPath = process.env.SLYBROWSER_WEBDRIVER_PATH;

afterEach(() => {
  if (originalDriverPath === undefined) delete process.env.SLYBROWSER_WEBDRIVER_PATH;
  else process.env.SLYBROWSER_WEBDRIVER_PATH = originalDriverPath;
});

describe("default project WebDriver backend", () => {
  it("resolves explicit, environment, and sibling driver paths without a manager", () => {
    const browser = resolve("build", "SlyBrowser.exe");
    const sibling = join(dirname(browser), process.platform === "win32" ? "chromedriver.exe" : "chromedriver");
    delete process.env.SLYBROWSER_WEBDRIVER_PATH;
    expect(defaultDriverExecutable(browser)).toBe(sibling);
    process.env.SLYBROWSER_WEBDRIVER_PATH = resolve("configured", "slydriver.exe");
    expect(defaultDriverExecutable(browser)).toBe(resolve("configured", "slydriver.exe"));
    expect(defaultDriverExecutable(browser, resolve("explicit", "slydriver.exe"))).toBe(resolve("explicit", "slydriver.exe"));
    expect(describeDefaultDriver(browser).backend).toBe("project-webdriver");
  });

  it("derives the release root from the signed artifact executable path", () => {
    expect(deriveReleaseRoot(
      resolve("cache", "SlyBrowser", "SlyBrowser.exe"),
      "SlyBrowser/SlyBrowser.exe",
    )).toBe(resolve("cache"));
    expect(deriveReleaseRoot(
      resolve("cache", "SlyBrowser", "SlyBrowser.exe"),
      "OtherBrowser/SlyBrowser.exe",
    )).toBeUndefined();
  });

  it("builds a session for the exact browser with secure handoff and stealth defaults", () => {
    const payload = buildWebDriverSessionPayload("D:/build/SlyBrowser.exe", {
      headless: false,
      profileDir: "D:/profiles/test",
      args: ["--lang=en-US"],
      humanize: true,
      humanPreset: "careful",
      humanSeed: 42424,
    }, ["--sly-config-file=D:/temp/config.json", "--sly-license-file=D:/temp/lease.json"]);
    const alwaysMatch = (payload.capabilities as Record<string, unknown>).alwaysMatch as Record<string, unknown>;
    const chromeOptions = alwaysMatch["goog:chromeOptions"] as Record<string, unknown>;
    const slyOptions = alwaysMatch["sly:options"] as Record<string, unknown>;
    expect(slyOptions.humanize).toEqual({ enabled: true, preset: "careful", seed: 42424 });
    expect(chromeOptions.binary).toBe(resolve("D:/build/SlyBrowser.exe"));
    expect(chromeOptions.args).toEqual(expect.arrayContaining([
      "--sly-config-file=D:/temp/config.json",
      "--sly-license-file=D:/temp/lease.json",
      "--lang=en-US",
      `--user-data-dir=${resolve("D:/profiles/test")}`,
    ]));
    expect(chromeOptions.excludeSwitches).toEqual(["enable-automation", "enable-unsafe-swiftshader"]);
    expect(chromeOptions.args).not.toContain("--headless=new");
  });

  it("requires project browser and driver major versions to match", () => {
    expect(validateWebDriverCapabilities({
      browserVersion: "123.0.4567.89",
      chrome: { chromedriverVersion: "123.0.4567.89 (abcdef)" },
    })).toEqual({ browserVersion: "123.0.4567.89", driverVersion: "123.0.4567.89", browserMajor: 123 });
    expect(() => validateWebDriverCapabilities({
      browserVersion: "123.0.4567.89",
      chrome: { chromedriverVersion: "149.0.1.0" },
    })).toThrow(/different major versions/);
  });

  it("makes persistent versus ephemeral profile semantics explicit", () => {
    expect(() => buildWebDriverSessionPayload("D:/build/SlyBrowser.exe", { profileMode: "persistent" }))
      .toThrowError(expect.objectContaining({ code: "persistent_profile_dir_required" }));
    expect(() => buildWebDriverSessionPayload("D:/build/SlyBrowser.exe", {
      profileMode: "ephemeral",
      profileDir: "D:/profiles/not-ephemeral",
    })).toThrowError(expect.objectContaining({ code: "ephemeral_profile_dir_forbidden" }));
  });

  it("fails closed when native Humanize is not advertised", () => {
    const service = { executable: resolve("build", "chromedriver.exe") } as unknown as SlyWebDriverService;
    const capabilities = {
      browserVersion: "123.0.4567.89",
      chrome: { chromedriverVersion: "123.0.4567.89 (abcdef)" },
    };
    expect(() => new SlyWebDriverSession(
      service,
      "session",
      capabilities,
      resolve("build", "SlyBrowser.exe"),
      { enabled: true },
    )).toThrow(/did not enable the requested Humanize capability/);
  });

  it("maps one coherent mobile persona into ChromeDriver emulation", () => {
    const persona = {
      userAgent: "Mozilla/5.0 Mobile SlyBrowser/123",
      deviceMetrics: { width: 390, height: 844, pixelRatio: 3, mobile: true as const, touch: true as const },
      clientHints: { platform: "Android", mobile: true as const, platformVersion: "15.0.0" },
    };
    const payload = buildWebDriverSessionPayload("D:/build/SlyBrowser.exe", { mobilePersona: persona });
    const alwaysMatch = (payload.capabilities as Record<string, unknown>).alwaysMatch as Record<string, unknown>;
    const chromeOptions = alwaysMatch["goog:chromeOptions"] as Record<string, unknown>;
    expect(chromeOptions.mobileEmulation).toEqual(persona);
    expect(chromeOptions.args).toContain("--window-size=390,844");
  });

  it("uses standard WebDriver WebAuthn endpoints", async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: request.method === "POST" ? "authenticator-id" : [] }));
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("invalid test address");
    try {
      const service = {
        executable: resolve("build", "chromedriver.exe"),
        origin: `http://127.0.0.1:${address.port}`,
        commandTimeout: 1000,
      } as unknown as SlyWebDriverService;
      const session = new SlyWebDriverSession(service, "session-id", {
        browserVersion: "123.0.4567.89",
        chrome: { chromedriverVersion: "123.0.4567.89 (abcdef)" },
      }, resolve("build", "SlyBrowser.exe"));
      await expect(session.addVirtualAuthenticator()).resolves.toBe("authenticator-id");
      await session.removeVirtualAuthenticator("authenticator-id");
      expect(calls).toContain("POST /session/session-id/webauthn/authenticator");
      expect(calls).toContain("DELETE /session/session-id/webauthn/authenticator/authenticator-id");
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
    }
  });

  it("exposes async JavaScript and browser logs through the public session", async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      const value = request.url?.endsWith("/log") ? [] : "async-result";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value }));
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("invalid test address");
    try {
      const service = { executable: resolve("chromedriver.exe"), origin: `http://127.0.0.1:${address.port}`, commandTimeout: 1000 } as unknown as SlyWebDriverService;
      const session = new SlyWebDriverSession(service, "session-id", {
        browserVersion: "123.0.4567.89", chrome: { chromedriverVersion: "123.0.4567.89" },
      }, resolve("SlyBrowser.exe"));
      await expect(session.executeAsyncScript("arguments[arguments.length - 1]('ok')")).resolves.toBe("async-result");
      await expect(session.browserLogs()).resolves.toEqual([]);
      expect(calls).toEqual(expect.arrayContaining([
        "POST /session/session-id/execute/async",
        "POST /session/session-id/log",
      ]));
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
    }
  });

  it("uses W3C window, frame and dialog endpoints", async () => {
    const calls: string[] = [];
    const server = createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      let value: unknown = null;
      if (request.url?.endsWith("/window/new")) value = { handle: "tab-2", type: "tab" };
      else if (request.url?.endsWith("/window/handles")) value = ["tab-1", "tab-2"];
      else if (request.method === "DELETE" && request.url?.endsWith("/window")) value = ["tab-1"];
      else if (request.url?.endsWith("/alert/text") && request.method === "GET") value = "confirm text";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value }));
    });
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("invalid test address");
    try {
      const service = { executable: resolve("chromedriver.exe"), origin: `http://127.0.0.1:${address.port}`, commandTimeout: 1000 } as unknown as SlyWebDriverService;
      const session = new SlyWebDriverSession(service, "session-id", {
        browserVersion: "123.0.4567.89", chrome: { chromedriverVersion: "123.0.4567.89" },
      }, resolve("SlyBrowser.exe"));
      await expect(session.newWindow()).resolves.toEqual({ handle: "tab-2", type: "tab" });
      await session.switchToWindow("tab-2");
      await session.switchToFrame(null);
      await session.switchToParentFrame();
      await expect(session.alertText()).resolves.toBe("confirm text");
      await session.dismissAlert();
      await expect(session.closeWindow()).resolves.toEqual(["tab-1"]);
      expect(calls).toEqual(expect.arrayContaining([
        "POST /session/session-id/window/new",
        "POST /session/session-id/window",
        "POST /session/session-id/frame",
        "POST /session/session-id/frame/parent",
        "GET /session/session-id/alert/text",
        "POST /session/session-id/alert/dismiss",
      ]));
    } finally {
      await new Promise<void>((accept) => server.close(() => accept()));
    }
  });
});
