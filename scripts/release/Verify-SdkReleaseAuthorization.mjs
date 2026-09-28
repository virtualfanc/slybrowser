#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sourceTreePattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const allowedFields = ["candidateId", "releaseTag", "schemaVersion", "sdkSetId", "sourceTree", "version"];

export function verifySdkReleaseAuthorization(bytes, { expectedSha256, releaseTag }) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new Error("Authorization bytes are required");
  if (!digestPattern.test(expectedSha256 ?? "")) throw new Error("Expected authorization SHA-256 is invalid");
  if (typeof releaseTag !== "string" || !releaseTag) throw new Error("Expected release tag is required");

  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== expectedSha256) throw new Error("SDK release authorization digest mismatch");

  let document;
  try {
    document = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("SDK release authorization is not valid JSON");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("SDK release authorization must be an object");
  }
  const fields = Object.keys(document).sort();
  if (JSON.stringify(fields) !== JSON.stringify(allowedFields)) {
    throw new Error("SDK release authorization fields are not exact");
  }
  if (document.schemaVersion !== 1) throw new Error("SDK release authorization schemaVersion must be 1");
  if (!digestPattern.test(document.candidateId ?? "")) throw new Error("SDK release candidate ID is invalid");
  if (!digestPattern.test(document.sdkSetId ?? "")) throw new Error("SDK release set ID is invalid");
  if (!sourceTreePattern.test(document.sourceTree ?? "")) throw new Error("SDK release source tree is invalid");
  if (!versionPattern.test(document.version ?? "")) throw new Error("SDK release version is invalid");
  if (document.releaseTag !== releaseTag) throw new Error("SDK release authorization release tag mismatch");
  if (document.releaseTag !== `sdk-v${document.version}`) throw new Error("SDK release authorization tag/version mismatch");
  return document;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]?.replace(/^--/, "");
    if (!name) throw new Error("Arguments must use --name syntax");
    const value = argv[++index];
    if (!value) throw new Error(`--${name} requires a value`);
    values[name] = value;
  }
  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const name of ["authorization", "expected-sha256", "release-tag", "github-env"]) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  const bytes = await readFile(resolve(options.authorization));
  const document = verifySdkReleaseAuthorization(bytes, {
    expectedSha256: options["expected-sha256"],
    releaseTag: options["release-tag"],
  });
  const output = [
    `EXPECTED_CANDIDATE_ID=${document.candidateId}`,
    `EXPECTED_SDK_SET_ID=${document.sdkSetId}`,
    `EXPECTED_SOURCE_TREE=${document.sourceTree}`,
    `EXPECTED_SDK_VERSION=${document.version}`,
  ].join("\n");
  await appendFile(resolve(options["github-env"]), `${output}\n`, { encoding: "utf8" });
  process.stdout.write(`${JSON.stringify({ status: "AUTHORIZED", ...document })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`SDK release authorization: blocked (${error.message})\n`);
    process.exitCode = 1;
  });
}
