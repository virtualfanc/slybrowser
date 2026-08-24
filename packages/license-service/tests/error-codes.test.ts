import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LICENSE_SERVICE_ERROR_CODES } from "../src/errors.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

interface ErrorCodesContract {
  codes: { code: string; httpStatuses: number[] }[];
}

async function contractCodes(): Promise<string[]> {
  const contract = JSON.parse(
    await readFile(resolve(repositoryRoot, "contracts/error-codes.json"), "utf8"),
  ) as ErrorCodesContract;
  return contract.codes.map((entry) => entry.code);
}

describe("stable service error-code contract", () => {
  it("matches the exported TypeScript union", async () => {
    expect([...LICENSE_SERVICE_ERROR_CODES]).toEqual(await contractCodes());
  });

  it("registers every literal ServiceError code used by service sources", async () => {
    const sourceRoot = resolve(packageRoot, "src");
    const sourceFiles = [
      "catalog.ts",
      "errors.ts",
      "license-file.ts",
      "paynow-management.ts",
      "paynow-postgres.ts",
      "paynow-server.ts",
      "paynow.ts",
      "postgres-store.ts",
      "server.ts",
      "store.ts",
    ];
    const used = new Set<string>();
    for (const file of sourceFiles) {
      const text = await readFile(resolve(sourceRoot, file), "utf8");
      for (const match of text.matchAll(/ServiceError\(\s*"([a-z0-9_]+)"/g)) used.add(match[1]!);
      for (const match of text.matchAll(/fail\(\s*"([a-z0-9_]+)"/g)) used.add(match[1]!);
    }
    const contract = new Set(await contractCodes());
    expect([...used].sort().filter((code) => !contract.has(code))).toEqual([]);
  });
});
