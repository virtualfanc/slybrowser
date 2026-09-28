#!/usr/bin/env node

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const output = resolve(required("--output"));
const keyId = required("--key-id");
if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error("--key-id is invalid");
const force = process.argv.includes("--force");

await mkdir(output, { recursive: true });
if (!(await stat(output)).isDirectory()) throw new Error(`Output is not a directory: ${output}`);

const privateKeyPath = join(output, "release-private.pem");
const publicKeyPath = join(output, "release-public.pem");
const metadataPath = join(output, "metadata.json");
if (!force && (await exists(privateKeyPath) || await exists(publicKeyPath) || await exists(metadataPath))) {
  throw new Error("Release signing key files already exist. Pass --force only when intentionally rotating this local candidate key.");
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "w" });
await writeFile(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), { mode: 0o644, flag: "w" });
await chmod(privateKeyPath, 0o600).catch(() => undefined);

const jwk = createPublicKey(privateKey).export({ format: "jwk" });
await writeFile(metadataPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  keyId,
  privateKeyFile: basename(privateKeyPath),
  publicKeyFile: basename(publicKeyPath),
  publicKeyJwk: jwk,
}, null, 2)}\n`, { mode: 0o644, flag: "w" });

console.log(JSON.stringify({
  keyId,
  output,
  privateKeyFile: privateKeyPath,
  publicKeyFile: publicKeyPath,
  metadataFile: metadataPath,
}, null, 2));
