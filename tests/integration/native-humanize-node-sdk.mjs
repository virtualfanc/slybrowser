import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { installLatestAuthorizedBrowser, launchAuthorized } from "../../packages/node/dist/licensed.js";
import { SlyWebDriverService } from "../../packages/node/dist/webdriver.js";

const execFileAsync = promisify(execFile);

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--browser") options.browser = resolve(values[++index]);
    else if (value === "--driver") options.driver = resolve(values[++index]);
    else if (value === "--output") options.output = resolve(values[++index]);
    else if (value === "--license") options.license = resolve(values[++index]);
    else if (value === "--authorization-file") options.authorizationFile = resolve(values[++index]);
    else if (value === "--cache-root") options.cacheRoot = resolve(values[++index]);
    else if (value === "--license-key-id") options.licenseKeyId = values[++index];
    else if (value === "--license-public-key-hex") options.licensePublicKeyHex = values[++index];
    else if (value === "--release-key-id") options.releaseKeyId = values[++index];
    else if (value === "--release-public-key-base64url") options.releasePublicKeyBase64url = values[++index];
    else if (value === "--trusted-service-url") options.trustedServiceUrl = values[++index];
    else if (value === "--canary-authorization-file") options.canaryAuthorizationFile = resolve(values[++index]);
    else if (value === "--canary-cache-root") options.canaryCacheRoot = resolve(values[++index]);
    else if (value === "--canary-trusted-service-url") options.canaryTrustedServiceUrl = values[++index];
    else if (value === "--canary-license-key-id") options.canaryLicenseKeyId = values[++index];
    else if (value === "--canary-license-public-key-hex") options.canaryLicensePublicKeyHex = values[++index];
    else if (value === "--canary-release-key-id") options.canaryReleaseKeyId = values[++index];
    else if (value === "--canary-release-public-key-base64url") options.canaryReleasePublicKeyBase64url = values[++index];
    else if (value === "--allow-insecure-localhost") options.allowInsecureLocalhost = true;
    else if (value === "--headed") options.headed = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.output) throw new Error("--output is required");
  if (options.authorizationFile) {
    for (const name of ["cacheRoot", "licenseKeyId", "licensePublicKeyHex", "releaseKeyId", "releasePublicKeyBase64url", "trustedServiceUrl", "canaryAuthorizationFile", "canaryCacheRoot", "canaryTrustedServiceUrl"]) {
      if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required with --authorization-file`);
    }
    options.canaryLicenseKeyId ??= options.licenseKeyId;
    options.canaryLicensePublicKeyHex ??= options.licensePublicKeyHex;
    options.canaryReleaseKeyId ??= options.releaseKeyId;
    options.canaryReleasePublicKeyBase64url ??= options.releasePublicKeyBase64url;
  } else if (!options.browser || !options.driver || !options.license) {
    throw new Error("--browser, --driver, --output and --license are required unless --authorization-file is used");
  }
  return options;
}

function dataUrl(markup) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = performance.now();
  const handoffRoot = await mkdtemp(join(tmpdir(), "sly-node-humanize-"));
  let service;
  let session;
  try {
    if (options.authorizationFile) {
      session = await launchAuthorized(options.authorizationFile, {
        trust: {
          licenseTrustedKeys: { [options.licenseKeyId]: Buffer.from(options.licensePublicKeyHex, "hex") },
          releaseTrustedKeys: { [options.releaseKeyId]: Buffer.from(options.releasePublicKeyBase64url, "base64url") },
          allowInsecureLocalhost: options.allowInsecureLocalhost === true,
          trustedServiceUrls: [options.trustedServiceUrl],
        },
        install: { cacheRoot: options.cacheRoot },
        platform: "windows",
        arch: "x64",
        updateKernel: false,
        headless: !options.headed,
        viewport: { width: 800, height: 600 },
        args: ["--force-device-scale-factor=1.25"],
        humanize: true,
        humanPreset: "careful",
        humanSeed: 42424,
        driverStartTimeout: 60_000,
        nativeReady: true,
      });
    } else {
      const lease = await readFile(options.license);
      if (lease.length < 1 || lease.length > 65_536) throw new Error("Signed test lease must contain between 1 and 65536 bytes");
      const browserLicense = join(handoffRoot, "browser-license.json");
      const driverLicense = join(handoffRoot, "driver-license.json");
      await Promise.all([writeFile(browserLicense, lease, { mode: 0o600 }), writeFile(driverLicense, lease, { mode: 0o600 })]);
      await Promise.all([protectWindowsHandoffFile(browserLicense), protectWindowsHandoffFile(driverLicense)]);
      service = await SlyWebDriverService.start(options.driver, { commandTimeout: 3_000, licenseFile: driverLicense });
      session = await service.createSession(options.browser, {
        headless: !options.headed,
        viewport: { width: 800, height: 600 },
        args: [`--sly-license-file=${browserLicense}`, "--force-device-scale-factor=1.25"],
        humanize: true,
        humanPreset: "careful",
        humanSeed: 42424,
      });
    }
    await session.setTimeouts({ script: 3_000, pageLoad: 10_000, implicit: 0 });
    await session.get(dataUrl(`
      <input id="name" style="position:absolute;left:40px;top:40px;width:240px;height:40px" onclick="window.inputClicks=(window.inputClicks||0)+1">
      <button id="target" style="position:absolute;left:420px;top:260px;width:220px;height:90px" onclick="window.clicked=(window.clicked||0)+1">Target</button>
      <iframe id="test-frame" style="position:absolute;left:80px;top:380px;width:500px;height:180px"
        srcdoc="<button id='frame-target' style='position:absolute;left:120px;top:40px;width:180px;height:70px' onclick='window.clicked=(window.clicked||0)+1'>Frame target</button>"></iframe>
    `));

    const input = await session.findElement("#name");
    await input.type("node-humanize");
    const target = await session.findElement("#target");
    await target.click();
    const geometry = await session.executeScript(`
      const target = document.querySelector('#target');
      const bounding = target.getBoundingClientRect();
      const client = target.getClientRects()[0];
      return {
        dpr: devicePixelRatio,
        bounding: {x: bounding.x, y: bounding.y, width: bounding.width, height: bounding.height},
        client: {x: client.x, y: client.y, width: client.width, height: client.height},
        clicked: window.clicked || 0,
        inputClicks: window.inputClicks || 0,
        typed: document.querySelector('#name').value,
      };
    `);

    const frame = await session.findElement("#test-frame");
    await session.switchToFrame(frame);
    const frameTarget = await session.findElement("#frame-target");
    await frameTarget.click();
    const frameClicked = await session.executeScript("return window.clicked || 0");
    await session.switchToParentFrame();
    await session.performActions([{
      type: "pointer",
      id: "node-sdk-pointer",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 20, x: 40, y: 40, origin: "viewport" },
        { type: "pointerMove", duration: 20, x: 180, y: 120, origin: "viewport" },
      ],
    }]);

    const consistent = ["x", "y", "width", "height"].every(
      (name) => Math.abs(geometry.bounding[name] - geometry.client[name]) <= 0.01,
    );
    const checks = {
      page: true,
      frame: frameClicked === 1,
      elementClick: geometry.clicked === 1,
      elementType: geometry.typed === "node-humanize",
      noPreparatoryClickForTyping: geometry.inputClicks === 0,
      dpi: geometry.dpr === 1.25,
      geometry: consistent,
    };
    const score = Object.values(checks).filter(Boolean).length / Object.keys(checks).length * 100;
    if (score !== 100) {
      throw new Error(`Node SDK Humanize matrix mismatch: ${JSON.stringify({ geometry, frameClicked })}`);
    }
    await session.close();
    session = undefined;
    const negativeCanary = await assertArtifactMismatchCanary(options);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: "PASS",
      score,
      checks,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      matrix: { sdk: "node", headed: options.headed === true, page: true, frame: true, elementClick: true, elementType: true, dpi: 1.25, commandTimeoutMs: 3_000 },
      geometry,
      frameClicked,
      negativeCanary,
      durationMs: Math.round(performance.now() - started),
    };
    await mkdir(resolve(options.output, ".."), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS Node SDK Native Humanize (${report.durationMs} ms)`);
    console.log(`artifact: ${options.output}`);
  } finally {
    if (session) await session.close();
    else if (service) await service.close();
    await rm(handoffRoot, { recursive: true, force: true });
  }
}

async function assertArtifactMismatchCanary(options) {
  if (!options.authorizationFile) return { id: "not-configured", status: "NOT_EVALUATED" };
  let installed;
  try {
    installed = await installLatestAuthorizedBrowser(options.canaryAuthorizationFile, {
      trust: {
        licenseTrustedKeys: { [options.canaryLicenseKeyId]: Buffer.from(options.canaryLicensePublicKeyHex, "hex") },
        releaseTrustedKeys: { [options.canaryReleaseKeyId]: Buffer.from(options.canaryReleasePublicKeyBase64url, "base64url") },
        allowInsecureLocalhost: options.allowInsecureLocalhost === true,
        trustedServiceUrls: [options.canaryTrustedServiceUrl],
      },
      install: { cacheRoot: join(options.canaryCacheRoot, "node") },
      platform: "windows",
      arch: "x64",
      updateKernel: false,
    });
  } catch (error) {
    if (error?.code !== "artifact_runtime_hash_mismatch") throw error;
    return { id: "reject-mismatched-browser-driver", status: "PASS", observedCode: error.code };
  }
  await installed.release();
  throw new Error("Node SDK accepted the mismatched Browser/Driver canary");
}

async function protectWindowsHandoffFile(path) {
  if (process.platform !== "win32") return;
  const { stdout } = await execFileAsync("whoami", [], { windowsHide: true });
  const identity = stdout.trim();
  if (!identity) throw new Error("Unable to determine current Windows identity for handoff ACL");
  await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`], { windowsHide: true });
}

await main();
