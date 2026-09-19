import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  launchPlaywright: vi.fn(),
  launchPlaywrightPersistent: vi.fn(),
  launchPuppeteer: vi.fn(),
  launchPuppeteerPersistent: vi.fn(),
}));

vi.mock("../src/licensed.js", () => ({
  launchLatest: mocks.launch,
  launchLatestPlaywright: mocks.launchPlaywright,
  launchLatestPlaywrightPersistent: mocks.launchPlaywrightPersistent,
  launchLatestPuppeteer: mocks.launchPuppeteer,
  launchLatestPuppeteerPersistent: mocks.launchPuppeteerPersistent,
}));

vi.mock("../src/official-trust.js", () => ({
  officialTrust: () => ({ official: true }),
}));

import { launch } from "../src/user-api.js";

describe("public user API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps only profile, launch, and Humanize options behind the authorization file", async () => {
    mocks.launch.mockResolvedValue({});
    await launch("account.authorization.json", {
      profile: { locale: "en-US" },
      launch: { headless: false, profileMode: "persistent", profileDirectory: "profile", updateKernel: false },
      humanize: { enabled: true, preset: "careful", seed: 42, config: { keyDelayMin: 40 } },
    });

    expect(mocks.launch).toHaveBeenCalledWith("account.authorization.json", {
      trust: { official: true },
      profile: { locale: "en-US" },
      headless: false,
      profileMode: "persistent",
      profileDir: "profile",
      updateKernel: false,
      humanize: true,
      humanPreset: "careful",
      humanSeed: 42,
      humanConfig: { keyDelayMin: 40 },
    });
  });

  it("rejects unknown and unsupported options before launch", async () => {
    await expect(launch("account.authorization.json", { extra: true } as never))
      .rejects.toMatchObject({ code: "launch_options_invalid" });
    await expect(launch("account.authorization.json", { humanize: { preset: "fast" } } as never))
      .rejects.toMatchObject({ code: "humanize_preset_invalid" });
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
