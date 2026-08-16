import { constants } from "node:fs";
import { open, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

function argumentsOf(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--browser") options.browser = resolve(values[++index]);
    else if (values[index] === "--output") options.output = resolve(values[++index]);
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  if (!options.browser) throw new Error("--browser is required");
  return options;
}

async function listen(server) {
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind to TCP");
  return address.port;
}

async function close(server) {
  await new Promise((accept) => server.close(() => accept()));
}

async function privateConfig(value) {
  const path = resolve(tmpdir(), `sly-proxy-route-${randomUUID()}.json`);
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  return path;
}

const options = argumentsOf(process.argv.slice(2));
if (!(await stat(options.browser)).isFile()) throw new Error(`Browser is missing: ${options.browser}`);
let sentinelHits = 0;
let proxyConnections = 0;
let workingProxyConnections = 0;
const workingProxyRequests = [];
const sentinel = createHttpServer((_request, response) => {
  sentinelHits += 1;
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("DIRECT ROUTE LEAK");
});
const proxy = createNetServer((socket) => {
  proxyConnections += 1;
  socket.once("data", () => {
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"sly-test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
});
const workingProxy = createNetServer((socket) => {
  workingProxyConnections += 1;
  socket.once("data", (chunk) => {
    const requestLine = String(chunk).split("\r\n", 1)[0];
    workingProxyRequests.push(requestLine);
    if (requestLine.startsWith("GET http://sly-egress.test:")) {
      const body = JSON.stringify({ ip: "198.51.100.77", via: "controlled-proxy" });
      socket.end([
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"));
    } else {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
  });
});
const [sentinelPort, proxyPort, workingProxyPort] = await Promise.all([
  listen(sentinel),
  listen(proxy),
  listen(workingProxy),
]);
const rejectedConfig = await privateConfig({
  proxy: {
    server: `http://127.0.0.1:${proxyPort}`,
    username: "rejected-user",
    password: "rejected-password",
    failClosed: true,
  },
  profile: { webrtc: "proxy" },
});
const workingConfig = await privateConfig({
  proxy: {
    server: `http://127.0.0.1:${workingProxyPort}`,
    failClosed: true,
  },
  profile: { webrtc: "proxy" },
});
let browser;
let navigationError = null;
let egressResponse = null;
let webrtcCandidates = [];
try {
  try {
    browser = await chromium.launch({
      executablePath: options.browser,
      headless: true,
      args: [
        `--sly-config-file=${rejectedConfig}`,
        "--host-resolver-rules=MAP sly-route-sentinel.test 127.0.0.1",
        "--proxy-bypass-list=<-loopback>",
      ],
    });
    const page = await browser.newPage();
    await page.goto(`http://sly-route-sentinel.test:${sentinelPort}/`, { waitUntil: "domcontentloaded", timeout: 10_000 });
  } catch (error) {
    navigationError = String(error?.message ?? error);
  }
  await browser?.close().catch(() => undefined);
  browser = await chromium.launch({
    executablePath: options.browser,
    headless: true,
    args: [
      `--sly-config-file=${workingConfig}`,
      "--host-resolver-rules=MAP sly-egress.test 127.0.0.1",
      "--proxy-bypass-list=<-loopback>",
    ],
  });
  const workingPage = await browser.newPage();
  await workingPage.goto(`http://sly-egress.test:${sentinelPort}/ip`, {
    waitUntil: "domcontentloaded",
    timeout: 10_000,
  });
  egressResponse = JSON.parse(await workingPage.locator("body").innerText());
  webrtcCandidates = await workingPage.evaluate(async () => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    const candidates = [];
    try {
      peer.createDataChannel("route-integrity");
      peer.addEventListener("icecandidate", (event) => {
        if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
      });
      await peer.setLocalDescription(await peer.createOffer());
      await Promise.race([
        new Promise((accept) => peer.addEventListener("icegatheringstatechange", () => {
          if (peer.iceGatheringState === "complete") accept();
        })),
        new Promise((accept) => setTimeout(accept, 3_000)),
      ]);
      return candidates;
    } finally {
      peer.close();
    }
  });
  await new Promise((accept) => setTimeout(accept, 250));
  const webrtcRawAddresses = webrtcCandidates
    .map((candidate) => candidate.split(/\s+/)[4] ?? "")
    .filter((address) => isIP(address) !== 0);
  const checks = {
    rejectedProxyWasUsed: proxyConnections > 0,
    noDirectSentinelRequest: sentinelHits === 0,
    launchOrNavigationFailedClosed: navigationError !== null,
    exitIpObservedThroughProxy: egressResponse?.ip === "198.51.100.77" && egressResponse?.via === "controlled-proxy",
    dnsHostnameReachedProxy: workingProxyRequests.some((line) => line.startsWith(`GET http://sly-egress.test:${sentinelPort}/ip `)),
    webrtcHasNoRawIpCandidate: webrtcRawAddresses.length === 0,
  };
  const result = {
    schemaVersion: 1,
    status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
    browser: options.browser,
    controlledTest: "rejected proxy must fail closed; working proxy must own HTTP egress and hostname resolution; WebRTC must expose no raw IP candidate",
    proxyConnections,
    workingProxyConnections,
    workingProxyRequests,
    sentinelHits,
    navigationError,
    egressResponse,
    webrtcCandidates,
    webrtcRawAddresses,
    checks,
  };
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await Promise.all([close(sentinel), close(proxy), close(workingProxy)]);
  await Promise.all([rm(rejectedConfig, { force: true }), rm(workingConfig, { force: true })]);
}
