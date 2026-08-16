function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) throw new TypeError("undefined is not valid canonical JSON");
      result[key] = normalize(member);
    }
    return result;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(normalize(value)), "utf8");
}

export function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function decodeBase64Url(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("value is not unpadded base64url");
  }
  if (value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new RangeError("decoded value exceeds size limit");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length > maxBytes || decoded.toString("base64url") !== value) {
    throw new TypeError("invalid base64url value");
  }
  return decoded;
}
