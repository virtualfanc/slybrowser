import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { ReleaseCatalog } from "./catalog.js";
import { ServiceError } from "./errors.js";
import type { PlanId } from "./plans.js";
import type { EntitlementService } from "./service.js";

const MAX_BODY_BYTES = 64 * 1024;

function responseHeaders(contentType = "application/json; charset=utf-8"): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { ...responseHeaders(), "content-length": String(body.length) });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.from(value);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ServiceError("request_too_large", "Request body is too large", 413);
    chunks.push(chunk);
  }
  if (!length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_json", "Request body is not valid JSON", 400);
  }
}

function authorization(request: IncomingMessage, scheme: "License" | "Session" | "Bearer"): string {
  const value = request.headers.authorization;
  const prefix = `${scheme} `;
  if (!value?.startsWith(prefix) || value.length <= prefix.length) {
    throw new ServiceError("authorization_required", `${scheme} authorization is required`, 401);
  }
  return value.slice(prefix.length);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError("invalid_request", "Request body must be an object", 400);
  }
  return value as Record<string, unknown>;
}

function equalSecret(actual: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface LicenseHttpServerOptions {
  service: EntitlementService;
  catalog: ReleaseCatalog;
  artifactRoot: string;
  adminToken?: string;
}

export function createLicenseHttpServer(options: LicenseHttpServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://license.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/plans") {
        sendJson(response, 200, options.service.plans());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/licenses/sessions") {
        const licenseKey = authorization(request, "License");
        const grant = options.service.createSession(licenseKey, await readJson(request));
        sendJson(response, 201, grant);
        return;
      }
      const sessionMatch = /^\/v1\/licenses\/sessions\/([0-9a-f-]{36})$/.exec(url.pathname);
      const heartbeatMatch = /^\/v1\/licenses\/sessions\/([0-9a-f-]{36})\/heartbeat$/.exec(url.pathname);
      if (request.method === "POST" && heartbeatMatch) {
        const token = authorization(request, "Session");
        sendJson(response, 200, options.service.heartbeat(heartbeatMatch[1]!, token));
        return;
      }
      if (request.method === "DELETE" && sessionMatch) {
        const token = authorization(request, "Session");
        options.service.release(sessionMatch[1]!, token);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/releases/artifacts/")) {
        const token = authorization(request, "Session");
        const artifact = options.catalog.findArtifactByPath(url.pathname);
        if (!artifact) throw new ServiceError("artifact_not_found", "Release artifact does not exist", 404);
        options.service.authorizeArtifact(token, artifact);
        const path = options.catalog.artifactPath(options.artifactRoot, artifact);
        const info = await stat(path);
        if (!info.isFile() || info.size !== artifact.size) {
          throw new ServiceError("artifact_unavailable", "Release artifact is unavailable", 503);
        }
        response.writeHead(200, {
          ...responseHeaders("application/zip"),
          "content-length": String(info.size),
          "content-disposition": `attachment; filename="${new URL(artifact.url).pathname.split("/").at(-1)}"`,
        });
        createReadStream(path).on("error", () => response.destroy()).pipe(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/licenses") {
        if (!equalSecret(authorization(request, "Bearer"), options.adminToken)) {
          throw new ServiceError("admin_authorization_invalid", "Admin authorization is invalid", 401);
        }
        const body = objectBody(await readJson(request));
        const paidThrough = body.paidThrough === undefined ? undefined : body.paidThrough as number | null;
        const issued = options.service.issueAuthorization({
          accountId: String(body.accountId ?? ""),
          plan: body.plan as PlanId,
          ...(paidThrough === undefined ? {} : { paidThrough }),
          serviceUrl: String(body.serviceUrl ?? ""),
        });
        sendJson(response, 201, issued);
        return;
      }
      const adminLicenseMatch = /^\/v1\/admin\/licenses\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (request.method === "PATCH" && adminLicenseMatch) {
        if (!equalSecret(authorization(request, "Bearer"), options.adminToken)) {
          throw new ServiceError("admin_authorization_invalid", "Admin authorization is invalid", 401);
        }
        options.service.updateAuthorization(adminLicenseMatch[1]!, objectBody(await readJson(request)));
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      throw new ServiceError("not_found", "Route does not exist", 404);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const serviceError = error instanceof ServiceError
        ? error
        : new ServiceError("internal_error", "The license service could not complete the request", 500);
      sendJson(response, serviceError.status, {
        error: { code: serviceError.code, message: serviceError.message },
      });
    }
  });
}
