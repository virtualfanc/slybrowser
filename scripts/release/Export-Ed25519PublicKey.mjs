#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const index = process.argv.indexOf("--key");
const path = index < 0 ? undefined : process.argv[index + 1];
if (!path) throw new Error("--key is required");
const key = createPublicKey(await readFile(resolve(path)));
if (key.asymmetricKeyType !== "ed25519") throw new Error("Key must be Ed25519");
const der = Buffer.from(key.export({ format: "der", type: "spki" }));
const raw = der.subarray(-32);
if (raw.length !== 32) throw new Error("Unable to export raw Ed25519 public key");
console.log(raw.toString("base64url"));
