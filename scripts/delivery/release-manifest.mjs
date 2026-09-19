import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalJson, hashObject, sha256 } from "./core.mjs";

export function verifyReleaseManifest(manifestPath, publicKeyPath, expectedKeyId, candidateId) {
  const bytes = readFileSync(manifestPath);
  const document = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  const { signature, ...payload } = document;
  if (signature?.algorithm !== "ed25519" || signature.keyId !== expectedKeyId || typeof signature.value !== "string") {
    throw new Error("release manifest signature identity is invalid");
  }
  const publicKey = createPublicKey(readFileSync(publicKeyPath));
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(
    null,
    Buffer.from(canonicalJson(payload)),
    publicKey,
    Buffer.from(signature.value, "base64url"),
  )) throw new Error("release manifest signature verification failed");
  if (document.status !== "available" || !Array.isArray(document.artifacts) || document.artifacts.length === 0) {
    throw new Error("release manifest contains no available artifacts");
  }
  if (document.candidateId !== candidateId) {
    throw new Error("release manifest candidate does not match the staged candidate");
  }
  const platforms = {};
  for (const artifact of document.artifacts) {
    const platformId = `${artifact.platform}-${artifact.arch}`;
    const values = [artifact.sha256, artifact.browserSha256, artifact.driverSha256];
    if (!values.every((value) => /^[0-9a-f]{64}$/i.test(value ?? ""))) throw new Error(`release manifest artifact identity is invalid for ${platformId}`);
    const browserVersion = document.browserVersion;
    const driverVersion = document.driverVersion ?? browserVersion;
    platforms[platformId] = {
      packageSha256: `sha256:${artifact.sha256}`,
      browserSha256: `sha256:${artifact.browserSha256}`,
      driverSha256: `sha256:${artifact.driverSha256}`,
      pairingDigest: hashObject({ browserVersion, driverVersion, browserSha256: artifact.browserSha256, driverSha256: artifact.driverSha256 }),
      browserVersion,
      driverVersion,
    };
  }
  return {
    schemaVersion: 2,
    candidateId,
    manifestDigest: sha256(bytes),
    publicKeyDigest: sha256(readFileSync(publicKeyPath)),
    keyId: expectedKeyId,
    platforms,
  };
}
