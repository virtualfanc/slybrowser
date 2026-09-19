import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";

import { WebDriverError } from "./webdriver.js";

type JsonObject = Record<string, unknown>;

export interface CdpDiscovery {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
  [name: string]: unknown;
}

function loopback(hostname: string): boolean {
  return new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(hostname.toLowerCase());
}

export function cdpDebuggerAddress(capabilities: JsonObject): string {
  const chromeOptions = capabilities["goog:chromeOptions"] as JsonObject | undefined;
  const address = chromeOptions?.debuggerAddress;
  if (typeof address !== "string" || !address) {
    throw new WebDriverError("Project WebDriver did not advertise a CDP debugger address", "cdp_address_missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${address}`);
  } catch {
    throw new WebDriverError("Project WebDriver returned an invalid CDP debugger address", "cdp_address_invalid");
  }
  if (!loopback(parsed.hostname) || !parsed.port || parsed.pathname !== "/") {
    throw new WebDriverError("CDP debugger address must be loopback-only", "cdp_address_unsafe");
  }
  return parsed.host;
}

export async function fetchCdpDiscovery(
  capabilities: JsonObject,
  fetchImplementation: typeof fetch = fetch,
): Promise<CdpDiscovery> {
  const address = cdpDebuggerAddress(capabilities);
  const response = await fetchImplementation(`http://${address}/json/version`, { redirect: "error" });
  if (!response.ok) throw new WebDriverError(`CDP discovery failed with HTTP ${response.status}`, "cdp_discovery_failed");
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebDriverError("CDP discovery returned an invalid document", "cdp_discovery_invalid");
  }
  return value as CdpDiscovery;
}

function authorized(request: IncomingMessage, token: Buffer): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(value.slice(7), "utf8");
  return provided.length === token.length && timingSafeEqual(provided, token);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function rewriteDiscovery(value: unknown, adapterHost: string): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteDiscovery(item, adapterHost));
  if (!value || typeof value !== "object") return value;
  const result = { ...(value as JsonObject) };
  if (typeof result.webSocketDebuggerUrl === "string") {
    const websocket = new URL(result.webSocketDebuggerUrl);
    websocket.protocol = "ws:";
    websocket.host = adapterHost;
    result.webSocketDebuggerUrl = websocket.toString();
  }
  return result;
}

export interface AuthenticatedCdpAdapter {
  endpoint: string;
  close(): Promise<void>;
}

export async function createAuthenticatedCdpAdapter(
  capabilities: JsonObject,
  options: { token: string; host?: string; port?: number; fetch?: typeof fetch },
): Promise<AuthenticatedCdpAdapter> {
  const host = options.host ?? "127.0.0.1";
  if (!loopback(host)) throw new WebDriverError("Authenticated CDP adapter must bind to loopback", "cdp_adapter_unsafe_bind");
  const token = Buffer.from(options.token, "utf8");
  if (token.length < 32 || token.length > 4096) {
    throw new WebDriverError("CDP adapter token must contain 32 to 4096 bytes", "cdp_adapter_token_invalid");
  }
  const upstream = new URL(`http://${cdpDebuggerAddress(capabilities)}`);
  let adapterHost = "";
  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: { code: "cdp_authorization_required", message: "Bearer authorization is required" } });
        return;
      }
      const path = new URL(request.url ?? "/", "http://adapter.invalid").pathname;
      if (request.method !== "GET" || !new Set(["/json/version", "/json/list", "/json"]).has(path)) {
        sendJson(response, 404, { error: { code: "cdp_route_not_found", message: "CDP route does not exist" } });
        return;
      }
      const upstreamResponse = await (options.fetch ?? fetch)(new URL(path, upstream), { redirect: "error" });
      if (!upstreamResponse.ok) {
        sendJson(response, 502, { error: { code: "cdp_upstream_failed", message: `CDP upstream returned ${upstreamResponse.status}` } });
        return;
      }
      sendJson(response, 200, rewriteDiscovery(await upstreamResponse.json(), adapterHost));
    } catch {
      sendJson(response, 502, { error: { code: "cdp_upstream_failed", message: "CDP upstream request failed" } });
    }
  });
  server.on("upgrade", (request, socket, head) => {
    if (!authorized(request, token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstreamSocket = connect(Number(upstream.port), upstream.hostname);
    upstreamSocket.once("connect", () => {
      const headers = Object.entries(request.headers)
        .filter(([name]) => !new Set(["authorization", "host"]).has(name.toLowerCase()))
        .flatMap(([name, value]) => value === undefined ? [] : [`${name}: ${Array.isArray(value) ? value.join(", ") : value}`]);
      upstreamSocket.write([
        `GET ${request.url ?? "/"} HTTP/1.1`,
        `host: ${upstream.host}`,
        ...headers,
        "",
        "",
      ].join("\r\n"));
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstreamSocket.once("error", () => socket.destroy());
    socket.once("error", () => upstreamSocket.destroy());
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((accept) => server.close(() => accept()));
    throw new WebDriverError("CDP adapter did not allocate a TCP port", "cdp_adapter_start_failed");
  }
  adapterHost = `${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return {
    endpoint: `http://${adapterHost}`,
    close: () => new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept())),
  };
}
