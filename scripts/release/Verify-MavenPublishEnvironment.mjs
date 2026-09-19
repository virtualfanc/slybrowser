#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const required = [
  "MAVEN_CENTRAL_USERNAME",
  "MAVEN_CENTRAL_TOKEN",
  "MAVEN_GPG_PASSPHRASE",
  "MAVEN_GPG_FINGERPRINT",
];

export function verifyMavenPublishEnvironment(environment) {
  for (const name of required) {
    if (typeof environment[name] !== "string" || environment[name].trim() === "") {
      throw new Error(`${name} is required`);
    }
  }
  if (!/^[0-9A-Fa-f]{40}$/u.test(environment.MAVEN_GPG_FINGERPRINT.trim())) {
    throw new Error("MAVEN_GPG_FINGERPRINT must be a full 40-character fingerprint");
  }
  if (typeof environment.MAVEN_GPG_PRIVATE_KEY === "string" && environment.MAVEN_GPG_PRIVATE_KEY !== "") {
    throw new Error("MAVEN_GPG_PRIVATE_KEY must remain scoped to the import step");
  }
  return { status: "VERIFIED", required };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(`${JSON.stringify(verifyMavenPublishEnvironment(process.env))}\n`);
  } catch (error) {
    process.stderr.write(`Maven publish environment: blocked (${error.message})\n`);
    process.exitCode = 1;
  }
}
