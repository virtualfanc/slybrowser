import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { launchPlaywright, launchPlaywrightPersistent, launchPuppeteer } from "../src/browser.js";
import { humanizePage, resolveHumanConfig } from "../src/humanize.js";

const directories: string[] = [];

async function assertHandoff(options: Record<string, unknown>): Promise<void> {
  const arguments_ = options.args as string[];
  const paths = arguments_.filter((item) => item.startsWith("--sly-")).map((item) => item.split("=", 2)[1]!);
  expect(paths).toHaveLength(2);
  await Promise.all(paths.map((path) => expect(access(path)).resolves.toBeUndefined()));
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
      launchOptions: { headless: true, args: ["--no-first-run"] },
    })).resolves.toEqual({ kind: "browser" });
    expect((lastOptions!.args as string[]).at(-1)).toBe("--no-first-run");
    await expect(launchPlaywrightPersistent(
      playwright,
      join(directory, "profile"),
      executable,
      { lease: "secret" },
      { tempRoot: directory },
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
    await expect(launchPuppeteer(puppeteer, executable, { lease: "secret" }, { tempRoot: directory }))
      .resolves.toEqual({ kind: "puppeteer" });
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
