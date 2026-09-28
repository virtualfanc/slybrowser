#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!name || !value) throw new Error("Expected --target, --release-set and --artifact-root");
    values[name] = value;
  }
  return values;
}

async function fetchWithRetry(url, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "slybrowser-release-verifier/0.2.0" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      await wait(10_000);
    }
  }
  throw new Error(`registry readback timed out for ${url}: ${lastError?.message}`);
}

async function assertRemote(url, artifact, timeoutSeconds) {
  const bytes = Buffer.from(await (await fetchWithRetry(url, timeoutSeconds)).arrayBuffer());
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error(`registry identity mismatch for ${artifact.name}`);
  return { name: artifact.name, url, size: bytes.length, sha256: artifact.sha256 };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const document = JSON.parse(await readFile(resolve(options["release-set"]), "utf8"));
  const timeout = Number.parseInt(options["timeout-seconds"] ?? "900", 10);
  const artifacts = document.artifacts;
  let verified = [];
  if (options.target === "node") {
    const metadata = await (await fetchWithRetry(`https://registry.npmjs.org/slybrowser/${document.version}`, timeout)).json();
    const artifact = artifacts.find(({ name }) => name.startsWith("node/"));
    verified = [await assertRemote(metadata.dist.tarball, artifact, timeout)];
  } else if (options.target === "python") {
    const metadata = await (await fetchWithRetry(`https://pypi.org/pypi/slybrowser/${document.version}/json`, timeout)).json();
    for (const artifact of artifacts.filter(({ name }) => name.startsWith("python/"))) {
      const remote = metadata.urls.filter(({ filename }) => filename === basename(artifact.name));
      if (remote.length !== 1 || remote[0].digests.sha256 !== artifact.sha256) throw new Error(`PyPI metadata mismatch for ${artifact.name}`);
      verified.push(await assertRemote(remote[0].url, artifact, timeout));
    }
  } else if (options.target === "java") {
    for (const artifact of artifacts.filter(({ name }) => name.startsWith("java/"))) {
      verified.push(await assertRemote(`https://repo1.maven.org/maven2/com/slybrowser/slybrowser/${document.version}/${basename(artifact.name)}`, artifact, timeout));
    }
  } else {
    throw new Error("target must be node, python or java");
  }
  process.stdout.write(`${JSON.stringify({ status: "VERIFIED", sdkSetId: document.sdkSetId, target: options.target, artifacts: verified }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Published SDK verification: blocked (${error.message})\n`);
  process.exitCode = 1;
});
