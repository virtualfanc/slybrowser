import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspect7zListingForExtraction, installGrantedBrowser } from "../src/installer.js";
import type { LicenseServiceClient, LicensedSessionGrant } from "../src/service.js";

const directories: string[] = [];
const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("browser installer archive extraction", () => {
  it("rejects oversized and unsafe 7z entries before extraction", () => {
    const listing = [
      "7-Zip listing",
      "----------",
      "Path = SlyBrowser.exe",
      "Size = 8",
      "Attributes = A",
      "",
      "Path = ../outside",
      "Size = 1",
      "Attributes = A",
      "",
    ].join("\n");
    expect(() => inspect7zListingForExtraction(listing, 8)).toThrowError(expect.objectContaining({ code: "artifact_layout_invalid" }));
    expect(() => inspect7zListingForExtraction(listing.replace("../outside", "chromedriver.exe"), 8))
      .toThrowError(expect.objectContaining({ code: "artifact_expanded_too_large" }));
  });

  it("rejects symbolic links in signed browser archives", async () => {
    const archive = zipStore([
      { name: "SlyBrowser.exe", content: "browser" },
      { name: "chromedriver.exe", content: "driver" },
      { name: "link-to-host", content: "C:/Users", externalAttributes: (0xa1ff << 16) >>> 0 },
    ]);
    const grant = grantForArchive(archive);
    const cacheRoot = await mkdtemp(join(tmpdir(), "sly-installer-test-"));
    directories.push(cacheRoot);

    await expect(installGrantedBrowser(clientForArchive(archive), grant, { cacheRoot }))
      .rejects.toMatchObject({ code: "artifact_layout_invalid" });
  });
});

function grantForArchive(archive: Buffer): LicensedSessionGrant {
  return {
    sessionId: "session-test",
    token: "session-token",
    plan: "basic",
    concurrencyLimit: 5,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    browserVersion: "150.0.8000.1",
    platform: "windows",
    arch: "x64",
    artifact: {
      url: "https://api.slybrowser.test/v1/releases/artifacts/test.zip",
      sha256: createHash("sha256").update(archive).digest("hex"),
      size: archive.length,
      archiveFormat: "zip",
      browserExecutable: "SlyBrowser.exe",
      driverExecutable: "chromedriver.exe",
      browserSha256: createHash("sha256").update("browser").digest("hex"),
      driverSha256: createHash("sha256").update("driver").digest("hex"),
    },
  };
}

function clientForArchive(archive: Buffer): LicenseServiceClient {
  return {
    async downloadArtifact() {
      return new Response(archive, {
        status: 200,
        headers: {
          "content-length": String(archive.length),
          "content-type": "application/zip",
        },
      });
    },
  } as LicenseServiceClient;
}

interface ZipEntry {
  name: string;
  content: string;
  externalAttributes?: number;
}

function zipStore(entries: ZipEntry[]): Buffer {
  const fileParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    fileParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.externalAttributes ?? 0x01800000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...fileParts, central, end]);
}

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
