import { execFile } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromRawHex(hex) {
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  });
}

test("signed test lease generator emits a verifiable lease without private key material", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-test-lease-"));
  try {
    const leasePath = join(root, "lease.json");
    const metadataPath = join(root, "metadata.json");
    await execFileAsync(process.execPath, [
      resolve("scripts/license/New-SignedTestLease.mjs"),
      "--lease",
      leasePath,
      "--metadata",
      metadataPath,
      "--key-id",
      "unit-test-v1",
      "--duration-seconds",
      "600",
      "--feature",
      "browser",
    ]);

    const envelope = JSON.parse(await readFile(leasePath, "utf8"));
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(envelope.algorithm, "Ed25519");
    assert.equal(envelope.keyId, "unit-test-v1");
    assert.equal(metadata.keyId, "unit-test-v1");
    assert.match(metadata.publicKeyHex, /^[0-9a-f]{64}$/);
    assert.deepEqual(metadata.gnArgs, {
      sly_license_enforcement_enabled: true,
      sly_license_key_id: "unit-test-v1",
      sly_license_public_key_hex: metadata.publicKeyHex,
    });
    assert.equal(JSON.stringify(metadata).includes("private"), false);

    const payload = Buffer.from(envelope.payload, "base64url");
    const signature = Buffer.from(envelope.signature, "base64url");
    assert.equal(verify(null, payload, publicKeyFromRawHex(metadata.publicKeyHex), signature), true);
    const claims = JSON.parse(payload.toString("utf8"));
    assert.equal(claims.audience, "slybrowser");
    assert.deepEqual(claims.features, ["browser"]);
    assert.ok(claims.expiresAt > claims.notBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signed test lease generator can use an external test signing key", async () => {
  const root = await mkdtemp(join(tmpdir(), "sly-test-lease-keyed-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = join(root, "lease-private.pem");
    await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const expectedPublicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const leasePath = join(root, "lease.json");
    const metadataPath = join(root, "metadata.json");
    await execFileAsync(process.execPath, [
      resolve("scripts/license/New-SignedTestLease.mjs"),
      "--lease",
      leasePath,
      "--metadata",
      metadataPath,
      "--private-key-file",
      privateKeyPath,
      "--key-id",
      "compiled-test-v1",
    ]);

    const envelope = JSON.parse(await readFile(leasePath, "utf8"));
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(metadata.publicKeyHex, expectedPublicKeyHex);
    assert.equal(metadata.gnArgs.sly_license_public_key_hex, expectedPublicKeyHex);
    assert.equal(metadata.gnArgs.sly_license_key_id, "compiled-test-v1");

    const payload = Buffer.from(envelope.payload, "base64url");
    const signature = Buffer.from(envelope.signature, "base64url");
    assert.equal(verify(null, payload, publicKeyFromRawHex(expectedPublicKeyHex), signature), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
