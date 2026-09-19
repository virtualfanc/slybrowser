import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { computeSdkSetId, expectedArtifactNames, verifySdkReleaseSet } from "../../scripts/release/Verify-SdkReleaseSet.mjs";

const version = "0.2.0";

async function makeReleaseSet(root) {
  const artifacts = [];
  for (const name of expectedArtifactNames(version)) {
    const bytes = Buffer.from(`slybrowser:${name}`);
    const path = join(root, ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    artifacts.push({ name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const unsigned = { schemaVersion: 1, version, sourceTree: "a".repeat(40), artifacts };
  return { ...unsigned, sdkSetId: computeSdkSetId(unsigned) };
}

test("0.2.0 release set contains exactly the eight canonical artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "slybrowser-sdk-020-"));
  try {
    const releaseSet = await makeReleaseSet(root);
    const result = await verifySdkReleaseSet(releaseSet, root, {
      expectedSdkSetId: releaseSet.sdkSetId,
      expectedSourceTree: releaseSet.sourceTree,
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.artifacts.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release-set verification rejects drift, extras and source mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "slybrowser-sdk-020-negative-"));
  try {
    const releaseSet = await makeReleaseSet(root);
    await writeFile(join(root, "unexpected.txt"), "unexpected");
    await assert.rejects(() => verifySdkReleaseSet(releaseSet, root), /unexpected file/i);
    await rm(join(root, "unexpected.txt"));
    await writeFile(join(root, "node", `slybrowser-${version}.tgz`), "drift");
    await assert.rejects(() => verifySdkReleaseSet(releaseSet, root), /size|SHA-256/i);
    await assert.rejects(
      () => verifySdkReleaseSet(releaseSet, root, { expectedSourceTree: "b".repeat(40) }),
      /source tree/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dedicated registry workflows use protected OIDC and exact release-set verification", async () => {
  const workflows = {
    npm: await readFile(".github/workflows/sdk-publish-npm.yml", "utf8"),
    pypi: await readFile(".github/workflows/sdk-publish-pypi.yml", "utf8"),
    maven: await readFile(".github/workflows/sdk-publish-maven.yml", "utf8"),
    nuget: await readFile(".github/workflows/sdk-publish-nuget.yml", "utf8"),
  };
  for (const [name, source] of Object.entries(workflows)) {
    assert.match(source, /workflow_dispatch:/);
    assert.match(source, /environment:\s*(npm|pypi|maven-central|nuget)/);
    assert.match(source, /Verify-SdkReleaseSet\.mjs/);
    assert.match(source, /Verify-SdkReleaseAuthorization\.mjs/);
    assert.match(source, /expected-sdk-set-id/);
    assert.match(source, /expected-source-tree/);
    assert.match(source, /SDK_RELEASE_AUTHORIZATION_SHA256/);
    assert.match(source, /uses:\s*[^\s]+@[a-f0-9]{40}/);
    assert.doesNotMatch(source, /NPM_TOKEN|TWINE_PASSWORD|NUGET_API_KEY:\s*\$\{\{\s*secrets\./);
    assert.doesNotMatch(source, /sdk_set_id:/);
    assert.doesNotMatch(source, /EXPECTED_SDK_SET_ID:\s*\$\{\{\s*inputs\./);
    assert.match(source, /sdk-v0\.2\.0/);
    assert.ok(source.includes("id-token: write") || name === "maven");
  }
  assert.match(workflows.npm, /node-version:\s*24/);
  assert.match(workflows.npm, /npm@11\.5\.1/);
  assert.match(workflows.pypi, /pypa\/gh-action-pypi-publish@[a-f0-9]{40}/);
  assert.match(workflows.nuget, /NuGet\/login@[a-f0-9]{40}/);
  assert.match(workflows.maven, /MAVEN_CENTRAL_TOKEN/);
  assert.match(workflows.maven, /MAVEN_GPG_PRIVATE_KEY/);
  const mavenJobPreamble = workflows.maven.split("\n    steps:")[0];
  assert.doesNotMatch(mavenJobPreamble, /secrets\./);
  const mavenPublisher = await readFile("scripts/release/Publish-FrozenMavenCentral.ps1", "utf8");
  assert.doesNotMatch(mavenPublisher, /MAVEN_GPG_PRIVATE_KEY/);
});

test("protected authorization receipt rejects a substituted candidate or SDK set", async () => {
  const { verifySdkReleaseAuthorization } = await import("../../scripts/release/Verify-SdkReleaseAuthorization.mjs");
  const receipt = {
    schemaVersion: 1,
    candidateId: `sha256:${"1".repeat(64)}`,
    releaseTag: "sdk-v0.2.0",
    version,
    sourceTree: "a".repeat(40),
    sdkSetId: `sha256:${"2".repeat(64)}`,
  };
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const expectedSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.deepEqual(verifySdkReleaseAuthorization(bytes, { expectedSha256, releaseTag: receipt.releaseTag }), receipt);

  const substituted = Buffer.from(`${JSON.stringify({ ...receipt, sdkSetId: `sha256:${"3".repeat(64)}` })}\n`);
  assert.throws(
    () => verifySdkReleaseAuthorization(substituted, { expectedSha256, releaseTag: receipt.releaseTag }),
    /authorization digest mismatch/i,
  );
  assert.throws(
    () => verifySdkReleaseAuthorization(bytes, { expectedSha256, releaseTag: "sdk-v0.2.1" }),
    /release tag mismatch/i,
  );
});

test("Maven publish step accepts only the four post-import secrets", async () => {
  const { verifyMavenPublishEnvironment } = await import("../../scripts/release/Verify-MavenPublishEnvironment.mjs");
  const environment = {
    MAVEN_CENTRAL_USERNAME: "publisher",
    MAVEN_CENTRAL_TOKEN: "token",
    MAVEN_GPG_PASSPHRASE: "passphrase",
    MAVEN_GPG_FINGERPRINT: "A".repeat(40),
  };
  assert.equal(verifyMavenPublishEnvironment(environment).status, "VERIFIED");
  assert.throws(
    () => verifyMavenPublishEnvironment({ ...environment, MAVEN_CENTRAL_TOKEN: "" }),
    /MAVEN_CENTRAL_TOKEN is required/,
  );
  assert.throws(
    () => verifyMavenPublishEnvironment({ ...environment, MAVEN_GPG_PRIVATE_KEY: "private" }),
    /must remain scoped to the import step/,
  );
});

test("native four-SDK E2E supports isolated canary trust roots", async () => {
  const files = [
    "scripts/browser/Test-NativeHumanizeSdkMatrix.ps1",
    "tests/integration/native-humanize-node-sdk.mjs",
    "tests/integration/native_humanize_python_sdk.py",
    "packages/java/src/test/java/com/slybrowser/NativeHumanizeRuntimeTest.java",
    "packages/dotnet/tests/SlyBrowser.Tests/NativeHumanizeRuntimeTests.cs",
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  for (const expected of [
    "CanaryLicenseKeyId",
    "CanaryLicensePublicKeyHex",
    "CanaryReleaseKeyId",
    "CanaryReleasePublicKeyBase64url",
  ]) {
    assert.match(combined, new RegExp(expected, "i"));
  }
  const dotnet = await readFile("packages/dotnet/tests/SlyBrowser.Tests/NativeHumanizeRuntimeTests.cs", "utf8");
  assert.match(dotnet, /RequestUri\?\.IsLoopback == true/);
  assert.match(dotnet, /SLYBROWSER_INTEGRATION_CANARY_TLS_THUMBPRINT/);
});

test("public documentation exposes all four 0.2.0 installation entry points", async () => {
  const files = [
    "README.md",
    "docs/user-api.md",
    "docs/wiki/Installation-and-SDKs.md",
    "packages/node/README.md",
    "packages/python/README.md",
    "packages/java/README.md",
    "packages/dotnet/README.md",
  ];
  const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  for (const expected of [
    "npm install slybrowser@0.2.0",
    "pip install slybrowser==0.2.0",
    "com.slybrowser:slybrowser:0.2.0",
    "dotnet add package SlyBrowser --version 0.2.0",
  ]) {
    assert.match(combined, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("the public workspace has no source-tree registry publication command", async () => {
  const workspace = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(Object.hasOwn(workspace.scripts, "sdk:publish"), false);
  const sourcePublisher = await readFile("scripts/release/Publish-SdkPackages.ps1", "utf8");
  assert.match(sourcePublisher, /Source-tree publication is disabled/);
});

test("NuGet packaging does not inherit a stale local Git commit", async () => {
  const builder = await readFile("scripts/release/Build-SdkReleaseSet.ps1", "utf8");
  assert.match(builder, /EnableSourceControlManagerQueries=false/);
});
