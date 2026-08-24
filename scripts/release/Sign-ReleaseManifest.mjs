#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function normalizedPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function assertReleaseSigningKeySeparated(keyPath, keyId) {
  const conflicts = [];
  for (const [name, label] of [
    ["SLY_LICENSE_SIGNING_KEY_FILE", "online lease signing key"],
    ["SLY_LICENSE_FILE_SIGNING_KEY_FILE", "license-file signing key"],
  ]) {
    const value = process.env[name];
    if (value && normalizedPath(value) === normalizedPath(keyPath)) {
      conflicts.push(label);
    }
  }
  for (const [name, label] of [
    ["SLY_LICENSE_KEY_ID", "online lease key ID"],
    ["SLY_LICENSE_FILE_SIGNING_KEY_ID", "license-file key ID"],
  ]) {
    const value = process.env[name];
    if (value && value === keyId) {
      conflicts.push(label);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`Release manifest signing key must be separate from ${conflicts.join(", ")}`);
  }
}

function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  throw new TypeError("Manifest contains a value that cannot be canonicalized");
}

const input = resolve(required("--input"));
const output = resolve(required("--output"));
const keyPath = resolve(required("--private-key"));
const keyId = required("--key-id");
if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("--key-id is invalid");
assertReleaseSigningKeySeparated(keyPath, keyId);
const document = JSON.parse((await readFile(input, "utf8")).replace(/^\uFEFF/, ""));
if (!document || typeof document !== "object" || Array.isArray(document) || document.signature !== undefined) {
  throw new Error("Input must be one unsigned release manifest object");
}
const privateKey = createPrivateKey(await readFile(keyPath));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Release signing key must be Ed25519");
const payload = Buffer.from(JSON.stringify(normalize(document)), "utf8");
const signed = {
  ...document,
  signature: {
    algorithm: "ed25519",
    keyId,
    value: sign(null, payload, privateKey).toString("base64url"),
  },
};
await writeFile(output, `${JSON.stringify(signed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(output);
