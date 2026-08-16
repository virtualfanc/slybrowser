import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ServiceError } from "./errors.js";
import type { PayNowWebhookReceiver } from "./paynow.js";

const MAX_BODY_BYTES = 64 * 1024;

function headers(): Record<string, string> {
  return {
    "cache-control": "no-store, private, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { ...headers(), "content-length": String(body.length) });
  response.end(body);
}

async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ServiceError("request_too_large", "Request body is too large", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createPayNowBillingHttpServer(receiver: PayNowWebhookReceiver): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://billing.invalid");
      if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/v1/billing/healthz")) {
        sendJson(response, 200, { status: "ok", service: "slybrowser-billing" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/billing/paynow/webhook") {
        const result = receiver.receive(
          await readRaw(request),
          header(request, "paynow-timestamp"),
          header(request, "paynow-signature"),
        );
        sendJson(response, 200, result);
        return;
      }
      throw new ServiceError("not_found", "Route does not exist", 404);
    } catch (error) {
      const serviceError = error instanceof ServiceError
        ? error
        : new ServiceError("internal_error", "The billing service could not complete the request", 500);
      sendJson(response, serviceError.status, {
        error: { code: serviceError.code, message: serviceError.message },
      });
    }
  });
}
