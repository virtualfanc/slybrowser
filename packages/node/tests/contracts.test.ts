import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

describe("shared contracts", () => {
  it("accepts valid launch fixtures and rejects unknown properties", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(await json("contracts/launch-options.schema.json"));
    expect(validate(await json("tests/fixtures/launch/valid-minimal.json")), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(await json("tests/fixtures/launch/valid-full.json")), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(await json("tests/fixtures/launch/invalid-unknown-property.json"))).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === "additionalProperties")).toBe(true);
  });

  it("compiles every JSON schema", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    for (const file of [
      "contracts/launch-options.schema.json",
      "contracts/license-lease.schema.json",
      "contracts/release-manifest.schema.json",
    ]) {
      const schema = await json(file);
      expect(() => ajv.compile(schema)).not.toThrow();
    }
  });

  it("parses GitHub issue forms as YAML", async () => {
    for (const file of [
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/feature.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
    ]) {
      const value = YAML.parse(await readFile(resolve(repositoryRoot, file), "utf8"));
      expect(value).toBeTypeOf("object");
    }
  });
});
