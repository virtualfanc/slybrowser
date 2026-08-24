import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  launchPlaywright,
  launchPlaywrightPersistent,
  launchPuppeteer,
  launchPuppeteerPersistent,
} from "../src/browser.js";
import { humanizePage, resolveHumanConfig } from "../src/humanize.js";

const directories: string[] = [];

async function assertHandoff(options: Record<string, unknown>, expectedFiles = 2): Promise<string[]> {
  const arguments_ = options.args as string[];
  const paths = arguments_.filter((item) => item.startsWith("--sly-")).map((item) => item.split("=", 2)[1]!);
  expect(paths).toHaveLength(expectedFiles);
  await Promise.all(paths.map((path) => expect(access(path)).resolves.toBeUndefined()));
  return arguments_;
}

async function writeNativeReady(options: Record<string, unknown>): Promise<void> {
  const arguments_ = options.args as string[];
  const requestArgument = arguments_.find((item) => item.startsWith("--sly-native-ready-request-file="));
  expect(requestArgument).toBeDefined();
  const requestPath = requestArgument!.split("=", 2)[1]!;
  const request = JSON.parse(await readFile(requestPath, "utf8")) as {
    readyFile: string;
    nonce: string;
  };
  await writeFile(request.readyFile, JSON.stringify({
    schemaVersion: 1,
    kind: "slybrowser.native-ready",
    ready: true,
    nonce: request.nonce,
  }));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("framework adapters", () => {
  it("launches Playwright and persistent contexts with cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-browser-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    let lastOptions: Record<string, unknown> | undefined;
    const playwright = {
      chromium: {
        async launch(options: Record<string, unknown>) {
          lastOptions = options;
          await assertHandoff(options);
          return { kind: "browser" };
        },
        async launchPersistentContext(_userDataDir: string, options: Record<string, unknown>) {
          lastOptions = options;
          await assertHandoff(options);
          return { kind: "context" };
        },
      },
    };
    await expect(launchPlaywright(playwright, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "1.62.1",
      launchOptions: { headless: true, args: ["--no-first-run"] },
    })).resolves.toEqual({ kind: "browser" });
    expect((lastOptions!.args as string[]).at(-1)).toBe("--no-first-run");
    await expect(launchPlaywrightPersistent(
      playwright,
      join(directory, "profile"),
      executable,
      { lease: "secret" },
      { tempRoot: directory, frameworkVersion: "1.62.1" },
    )).resolves.toEqual({ kind: "context" });
  });

  it("launches Puppeteer with the same handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-browser-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const puppeteer = {
      async launch(options: Record<string, unknown>) {
        await assertHandoff(options);
        return { kind: "puppeteer" };
      },
    };
    await expect(launchPuppeteer(puppeteer, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "25.8.0",
    }))
      .resolves.toEqual({ kind: "puppeteer" });
    await expect(launchPuppeteerPersistent(
      puppeteer,
      join(directory, "profile"),
      executable,
      { lease: "secret" },
      { tempRoot: directory, frameworkVersion: "25.8.0" },
    )).resolves.toEqual({ kind: "puppeteer" });
  });

  it("passes runtime handoff files through framework launches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-browser-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    let lastArguments: string[] = [];
    const playwright = {
      chromium: {
        async launch(options: Record<string, unknown>) {
          lastArguments = await assertHandoff(options, 3);
          return { kind: "browser" };
        },
        async launchPersistentContext() { return { kind: "context" }; },
      },
    };
    await expect(launchPlaywright(playwright, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "1.62.1",
      runtimeHandoff: {
        schemaVersion: 2,
        serviceUrl: "https://api.slybrowser.com",
        state: "reserved",
        startupId: "st_abcdefghijklmnop",
        sessionId: "session-test",
        bootstrapToken: "bootstrap_token_abcdefghijklmnopqrstuvwxyz",
        heartbeatAfterSeconds: 300,
        expiresAt: 2000000300,
        browserVersion: "150.0.0.0",
        plan: "launch",
        concurrencyLimit: 5,
        activeSessions: 1,
        automationBackend: "playwright",
      },
    })).resolves.toEqual({ kind: "browser" });
    expect(lastArguments.some((argument) => argument.startsWith("--sly-runtime-file="))).toBe(true);
  });

  it("rejects unsupported framework versions and writes native Humanize control files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-browser-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    let lastArguments: string[] = [];
    const playwright = {
      chromium: {
        async launch(options: Record<string, unknown>) {
          lastArguments = await assertHandoff(options, 3);
          return {};
        },
        async launchPersistentContext() { return {}; },
      },
    };
    await expect(launchPlaywright(playwright, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "1.61.0",
    })).rejects.toMatchObject({ code: "framework_version_unsupported" });
    await expect(launchPlaywright(playwright, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "1.62.1",
      humanize: true,
      humanPreset: "careful",
      humanSeed: 42424,
    })).resolves.toEqual({});
    expect(lastArguments.some((argument) => argument.startsWith("--sly-humanize-config="))).toBe(true);
  });

  it("waits for native-ready before returning framework browser objects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-browser-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    const events: string[] = [];
    const playwright = {
      chromium: {
        async launch(options: Record<string, unknown>) {
          await assertHandoff(options, 3);
          events.push("launch-returned");
          setTimeout(() => {
            void writeNativeReady(options).then(() => events.push("native-ready"));
          }, 25);
          return { kind: "browser" };
        },
        async launchPersistentContext() { return { kind: "context" }; },
      },
    };
    await expect(launchPlaywright(playwright, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "1.62.1",
      nativeReady: true,
      nativeReadyTimeout: 1000,
    })).resolves.toEqual({ kind: "browser" });
    events.push("adapter-returned");
    expect(events).toEqual(["launch-returned", "native-ready", "adapter-returned"]);
    expect((await readdir(directory)).filter((name) => name.startsWith("sly-"))).toEqual([]);
  });

  it("closes framework browser objects when native-ready times out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sly-browser-test-"));
    directories.push(directory);
    const executable = join(directory, "browser.exe");
    await writeFile(executable, "test");
    let closed = false;
    const puppeteer = {
      async launch(options: Record<string, unknown>) {
        await assertHandoff(options, 3);
        return {
          kind: "puppeteer",
          async close() { closed = true; },
        };
      },
    };
    await expect(launchPuppeteer(puppeteer, executable, { lease: "secret" }, {
      tempRoot: directory,
      frameworkVersion: "25.8.0",
      nativeReady: true,
      nativeReadyTimeout: 20,
    })).rejects.toMatchObject({ code: "native_ready_timeout" });
    expect(closed).toBe(true);
  });
});

describe("Humanize", () => {
  it("uses a curved non-center mouse path and keyboard input", async () => {
    const events: string[] = [];
    const locator = {
      async boundingBox() { return { x: 400, y: 300, width: 500, height: 60 }; },
      async scrollIntoViewIfNeeded() { events.push("scroll"); },
      async click() { events.push("original-click"); },
      async fill() { events.push("original-fill"); },
      async type() { events.push("original-type"); },
    };
    const page = {
      mouse: {
        async move(x: number, y: number) { events.push(`move:${x},${y}`); },
        async down() { events.push("down"); },
        async up() { events.push("up"); },
      },
      keyboard: {
        async down() {}, async up() {},
        async press(key: string) { events.push(`press:${key}`); },
        async type(value: string) { events.push(`type:${value}`); },
      },
      locator() { return locator; },
      async click() {}, async fill() {}, async type() {},
    };
    humanizePage(page, {
      seed: 42424,
      config: {
        mouseStepsMin: 6, mouseStepsMax: 6,
        mouseStepDelayMin: 0, mouseStepDelayMax: 0,
        clickHoldMin: 0, clickHoldMax: 0,
        keyDelayMin: 0, keyDelayMax: 0,
        thinkDelayMin: 0, thinkDelayMax: 0,
      },
    });
    await page.click("button");
    await page.fill("input", "ab");
    expect(events.filter((event) => event.startsWith("move:"))).toHaveLength(12);
    expect(events).toContain("down");
    expect(events).toContain("up");
    expect(events).toContain("press:Control+A");
    expect(events).toContain("press:Backspace");
    expect(events).toContain("type:a");
    expect(events).toContain("type:b");
    expect(events).not.toContain("original-click");
    expect(events).not.toContain("original-fill");
  });

  it("validates the relationship between Humanize ranges", () => {
    expect(() => resolveHumanConfig({ config: { mouseStepsMin: 5 } })).toThrow(/at least six/);
    expect(() => resolveHumanConfig({ config: { keyDelayMin: -1 } })).toThrow(/keyDelayMin/);
  });
});
