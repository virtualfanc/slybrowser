import { describe, expect, it } from "vitest";

import { automationCapability, validateFrameworkVersion } from "../src/automation.js";

describe("automation backend policy", () => {
  it("keeps project WebDriver as the default backend", () => {
    expect(automationCapability()).toEqual({
      backend: "project-webdriver",
      language: "node",
      nativeHumanize: true,
      persistentContext: true,
    });
  });

  it("accepts only validated framework lines", () => {
    expect(validateFrameworkVersion("playwright", "1.62.1")).toBe("1.62.1");
    expect(validateFrameworkVersion("puppeteer", "25.8.0")).toBe("25.8.0");
    expect(() => validateFrameworkVersion("playwright", "1.63.0"))
      .toThrowError(expect.objectContaining({ code: "framework_version_unsupported" }));
    expect(() => validateFrameworkVersion("puppeteer", "24.43.1"))
      .toThrowError(expect.objectContaining({ code: "framework_version_unsupported" }));
  });

  it("advertises native Humanize for framework control-plane launches", () => {
    expect(automationCapability("playwright", "1.62.1")).toMatchObject({
      backend: "playwright",
      nativeHumanize: true,
      persistentContext: true,
    });
    expect(automationCapability("puppeteer", "25.8.0")).toMatchObject({
      backend: "puppeteer",
      nativeHumanize: true,
      persistentContext: true,
    });
  });
});
