import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { hashObject, parseArgs, requireOptions, safeCliError, sha256, writeJson } from "./core.mjs";

try {
  const options = parseArgs(process.argv.slice(2), { boolean: ["dry-run", "publish"] });
  requireOptions(options, ["source"]);
  if (options.publish) {
    throw new Error("remote Wiki publication adapter is intentionally unavailable; supply an approved repository-specific publisher in an authorized change");
  }
  if (!options["dry-run"]) throw new Error("Wiki publisher requires --dry-run unless an authorized remote adapter exists");
  const source = resolve(options.source);
  if (!existsSync(source)) throw new Error("Wiki source directory is unavailable");
  const files = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  if (!files.includes("Home.md")) throw new Error("Wiki source must contain Home.md");
  if (options.export) {
    const destination = resolve(options.export);
    if (existsSync(destination) && readdirSync(destination).length > 0) throw new Error("Wiki export destination must be empty");
    mkdirSync(destination, { recursive: true });
    for (const file of files) cpSync(resolve(source, file), resolve(destination, basename(file)), { errorOnExist: true, force: false });
  }
  const sourceDigest = hashObject(files.map((file) => ({ file, digest: sha256(readFileSync(resolve(source, file))) })));
  const receipt = {
    schemaVersion: 1,
    gateId: "remote-wiki-publication",
    candidateId: options["candidate-id"] ?? null,
    status: "not_evaluated",
    observedAt: new Date().toISOString(),
    subject: "remote-github-wiki",
    dryRun: true,
    sourceDigest,
    fileCount: files.length,
    remotePublished: false,
    reason: "Dry-run validated version-controlled source only; no remote action was authorized or performed.",
  };
  if (options.output) writeJson(options.output, receipt);
  process.stdout.write(`wiki-publisher: dry-run; files=${files.length}; remotePublished=false\n`);
} catch (error) {
  process.stderr.write(`wiki-publisher: blocked (${safeCliError(error)})\n`);
  process.exitCode = 2;
}
