#!/usr/bin/env node
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function usage() {
  return [
    "Usage: node scripts/license/New-SignedTestLease.mjs --lease FILE --metadata FILE [options]",
    "",
    "Options:",
    "  --key-id ID              Signing key id embedded in the envelope (default: local-test-v1)",
    "  --private-key-file FILE  Ed25519 PKCS#8 PEM test signing key; generated in-memory if omitted",
    "  --browser-min VERSION    Minimum browser version claim (default: 0.0.0.0)",
    "  --browser-max VERSION    Maximum browser version claim (default: 999.0.0.0)",
    "  --duration-seconds N     Lease lifetime; must be <= 86400 (default: 3600)",
    "  --feature NAME           Repeatable feature claim (default: browser)",
  ].join("\n");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function options(args) {
  const lease = option(args, "--lease");
  const metadata = option(args, "--metadata");
  if (!lease || !metadata || args.includes("--help") || args.includes("-h")) {
    throw new Error(usage());
  }
  const features = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--feature") features.push(args[index + 1]);
  }
  const durationSeconds = Number(option(args, "--duration-seconds") ?? "3600");
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 60 || durationSeconds > 86400) {
    throw new Error("--duration-seconds must be an integer between 60 and 86400");
  }
  return {
    lease: resolve(lease),
    metadata: resolve(metadata),
    keyId: option(args, "--key-id") ?? "local-test-v1",
    privateKeyFile: option(args, "--private-key-file") ? resolve(option(args, "--private-key-file")) : undefined,
    browserMin: option(args, "--browser-min") ?? "0.0.0.0",
    browserMax: option(args, "--browser-max") ?? "999.0.0.0",
    durationSeconds,
    features: features.length === 0 ? ["browser"] : features,
  };
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function publicKeyHex(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("hex");
}

async function signingKeys(privateKeyFile) {
  if (!privateKeyFile) return generateKeyPairSync("ed25519");
  const privateKey = createPrivateKey(await readFile(privateKeyFile));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("--private-key-file must contain an Ed25519 PKCS#8 PEM private key");
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

function validateIdentifier(value, name) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${name} contains unsupported characters`);
  }
}

function validateVersion(value, name) {
  if (!/^\d+(\.\d+){1,7}$/.test(value)) {
    throw new Error(`${name} must look like a Chromium version`);
  }
}

async function main() {
  const parsed = options(process.argv.slice(2));
  validateIdentifier(parsed.keyId, "--key-id");
  validateVersion(parsed.browserMin, "--browser-min");
  validateVersion(parsed.browserMax, "--browser-max");
  for (const feature of parsed.features) validateIdentifier(feature, "--feature");

  const { publicKey, privateKey } = await signingKeys(parsed.privateKeyFile);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    schemaVersion: 1,
    audience: "slybrowser",
    issuedAt: now,
    notBefore: now,
    expiresAt: now + parsed.durationSeconds,
    browserMin: parsed.browserMin,
    browserMax: parsed.browserMax,
    features: [...new Set(parsed.features)],
    licenseId: `license-test-${randomUUID()}`,
    sessionId: `session-test-${randomUUID()}`,
    nonce: randomUUID(),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, payloadBytes, privateKey);
  const envelope = {
    algorithm: "Ed25519",
    keyId: parsed.keyId,
    payload: base64url(payloadBytes),
    signature: base64url(signature),
  };
  const metadata = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    keyId: parsed.keyId,
    publicKeyHex: publicKeyHex(publicKey),
    gnArgs: {
      sly_license_enforcement_enabled: true,
      sly_license_key_id: parsed.keyId,
      sly_license_public_key_hex: publicKeyHex(publicKey),
    },
    leaseFile: parsed.lease,
    expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
    features: payload.features,
  };
  await mkdir(dirname(parsed.lease), { recursive: true });
  await mkdir(dirname(parsed.metadata), { recursive: true });
  await writeFile(parsed.lease, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await writeFile(parsed.metadata, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(metadata, null, 2));
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
