import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const RECEIPT_STATUSES = new Set(["pass", "fail", "blocked", "not_evaluated", "not_applicable"]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashObject(value) {
  return sha256(canonicalJson(value));
}

export function normalizeRepositoryPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error("repository path must be relative");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("repository path contains an invalid segment");
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error("repository path contains a control character");
  return normalized;
}

export function matchGlob(path, pattern) {
  const value = normalizeRepositoryPath(path);
  const glob = normalizeRepositoryPath(pattern);
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(value);
}

export function parseArgs(argv, { boolean = [] } = {}) {
  const booleans = new Set(boolean);
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error("unexpected positional argument");
    const key = token.slice(2);
    if (!key) throw new Error("empty option name");
    if (booleans.has(key)) {
      result[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

export function requireOptions(options, names) {
  const missing = names.filter((name) => options[name] === undefined);
  if (missing.length) throw new Error(`missing required options: ${missing.map((name) => `--${name}`).join(", ")}`);
}

export function requireOnlyOptions(options, names) {
  const allowed = new Set(names);
  const unknown = Object.keys(options).filter((name) => !allowed.has(name));
  if (unknown.length) throw new Error(`unsupported options: ${unknown.map((name) => `--${name}`).join(", ")}`);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

export function readJsonDirectory(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => readJson(resolve(path, entry.name)));
}

export function validDate(value) {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

export function validateFreshReceipt(receipt, candidateId, { now = new Date(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const errors = [];
  if (!receipt || typeof receipt !== "object") return ["receipt is not an object"];
  if (!/^git-tree:[0-9a-f]{40,64}$/i.test(candidateId ?? "")) errors.push("expected candidate identity is invalid");
  if (receipt.candidateId !== candidateId) errors.push("receipt candidate does not match the exact candidate");
  if (!RECEIPT_STATUSES.has(receipt.status)) errors.push("receipt status is invalid");
  const observed = validDate(receipt.observedAt);
  if (observed === null) errors.push("receipt observedAt is invalid");
  else {
    const age = now.getTime() - observed;
    if (age < -5 * 60 * 1000) errors.push("receipt is dated in the future");
    if (age > maxAgeMs) errors.push("receipt is stale");
  }
  return errors;
}

export function safeCliError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<redacted-path>")
    .replace(/\/(?:Users|home)\/[^\s"']+/g, "<redacted-path>");
}
