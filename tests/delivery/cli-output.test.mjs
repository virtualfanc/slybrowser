import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { safeCliError } from "../../scripts/delivery/core.mjs";

test("CLI errors stay in English and redact local paths", () => {
  const value = safeCliError(new Error("cannot read C:\\private\\candidate.json"));
  assert.equal(value, "cannot read <redacted-path>");
  assert.doesNotMatch(value, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(value, /C:\\private/);
});

test("public delivery CLIs reject missing options in English", () => {
  const directory = fileURLToPath(new URL("../../scripts/delivery/", import.meta.url));
  for (const script of ["candidate.mjs", "docs-gate.mjs", "security-gate.mjs"]) {
    const result = spawnSync(process.execPath, [`${directory}${script}`], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required options/i);
    assert.doesNotMatch(result.stderr, /[\u4e00-\u9fff]/);
  }
});
