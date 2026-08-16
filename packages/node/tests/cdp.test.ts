import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { cdpDebuggerAddress, createAuthenticatedCdpAdapter, fetchCdpDiscovery } from "../src/cdp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function upstream(): Promise<{ capabilities: Record<string, unknown>; endpoint: string }> {
  let origin = "";
  const server = createServer((request, response) => {
    if (request.url === "/json/version") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ Browser: "SlyBrowser/148", webSocketDebuggerUrl: origin.replace("http:", "ws:") + "/devtools/browser/test" }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid test address");
  origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>((accept) => server.close(() => accept())));
  return {
    capabilities: { "goog:chromeOptions": { debuggerAddress: `127.0.0.1:${address.port}` } },
    endpoint: origin,
  };
}

describe("standard CDP discovery", () => {
  it("uses the project WebDriver debugger address and rejects non-loopback endpoints", async () => {
    const context = await upstream();
    expect(cdpDebuggerAddress(context.capabilities)).toMatch(/^127\.0\.0\.1:/);
    await expect(fetchCdpDiscovery(context.capabilities)).resolves.toMatchObject({ Browser: "SlyBrowser/148" });
    expect(() => cdpDebuggerAddress({ "goog:chromeOptions": { debuggerAddress: "192.0.2.10:9222" } }))
      .toThrowError(expect.objectContaining({ code: "cdp_address_unsafe" }));
  });

  it("provides authenticated standard discovery and rewrites WebSocket endpoints", async () => {
    const context = await upstream();
    const token = "test-token-".padEnd(40, "x");
    const adapter = await createAuthenticatedCdpAdapter(context.capabilities, { token });
    cleanups.push(() => adapter.close());
    expect((await fetch(`${adapter.endpoint}/json/version`)).status).toBe(401);
    const response = await fetch(`${adapter.endpoint}/json/version`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const discovery = await response.json() as { webSocketDebuggerUrl: string };
    expect(new URL(discovery.webSocketDebuggerUrl).host).toBe(new URL(adapter.endpoint).host);
  });
});
