import { randomUUID } from "node:crypto";
import { Socket, createConnection } from "node:net";
import { TLSSocket, connect as tlsConnect } from "node:tls";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  /**
   * Attachment bytes are rendered directly from memory. File paths, remote URLs,
   * and streams are intentionally not supported so private license files are not
   * written to plaintext temporary files before SMTP delivery.
   */
  content: string | Buffer;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  text: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
}

export interface EmailSendResult {
  providerMessageId?: string;
}

export interface EmailTransport {
  readonly provider: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface SmtpEmailConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  username?: string;
  password?: string;
  startTls?: boolean;
  timeoutMilliseconds?: number;
  heloName?: string;
}

type SmtpSocket = Socket | TLSSocket;

function booleanEnvironment(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  throw new Error(`Invalid boolean environment value: ${value}`);
}

function boundedPort(value: string | undefined, fallback: number): number {
  const numeric = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65_535) {
    throw new Error("SMTP port must be an integer between 1 and 65535");
  }
  return numeric;
}

function envelopeAddress(value: string, name: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} contains an invalid newline`);
  const trimmed = value.trim();
  const bracketed = /<([^<>]+)>$/.exec(trimmed);
  const address = (bracketed?.[1] ?? trimmed).trim();
  if (address.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
    throw new Error(`${name} is not a valid email address`);
  }
  return address;
}

function headerValue(value: string, name: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${name} contains an invalid newline`);
  return value.trim();
}

function encodedHeader(value: string): string {
  const sanitized = headerValue(value, "Header");
  if (/^[\x20-\x7e]*$/.test(sanitized) && sanitized.length <= 120) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf8").toString("base64")}?=`;
}

function safeFilename(value: string): string {
  const sanitized = headerValue(value, "Attachment filename").replace(/[\\"]/g, "_").trim();
  if (!sanitized || sanitized.length > 180) throw new Error("Attachment filename is invalid");
  return sanitized;
}

function foldBase64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function dotStuff(data: string): string {
  return data.replace(/^\./gm, "..");
}

function buildMimeMessage(config: SmtpEmailConfig, message: EmailMessage, recipients: string[]): string {
  const attachments = message.attachments ?? [];
  const headers = [
    `From: ${headerValue(config.from, "From")}`,
    `To: ${recipients.map((recipient) => headerValue(recipient, "To")).join(", ")}`,
    ...(message.replyTo === undefined ? [] : [`Reply-To: ${headerValue(message.replyTo, "Reply-To")}`]),
    `Subject: ${encodedHeader(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@slybrowser.local>`,
    "MIME-Version: 1.0",
  ];

  if (attachments.length === 0) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      foldBase64(message.text),
    ].join("\r\n");
  }

  const boundary = `slybrowser-${randomUUID()}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(message.text),
  ];

  for (const attachment of attachments) {
    const filename = safeFilename(attachment.filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${headerValue(attachment.contentType, "Attachment content type")}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      foldBase64(attachment.content),
    );
  }

  parts.push(`--${boundary}--`);
  return parts.join("\r\n");
}

class SmtpLineReader {
  #buffer = "";
  #lines: string[] = [];
  #pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  #ended = false;
  #error: Error | undefined;

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer += chunk.toString("utf8");
    for (;;) {
      const index = this.#buffer.indexOf("\r\n");
      if (index < 0) break;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 2);
      const pending = this.#pending;
      if (pending) {
        this.#pending = undefined;
        pending.resolve(line);
      } else {
        this.#lines.push(line);
      }
    }
  };

  readonly #onError = (error: Error): void => {
    this.#error = error;
    const pending = this.#pending;
    if (pending) {
      this.#pending = undefined;
      pending.reject(error);
    }
  };

  readonly #onEnd = (): void => {
    this.#ended = true;
    const pending = this.#pending;
    if (pending) {
      this.#pending = undefined;
      pending.reject(new Error("SMTP connection ended unexpectedly"));
    }
  };

  constructor(readonly socket: SmtpSocket) {
    socket.on("data", this.#onData);
    socket.once("error", this.#onError);
    socket.once("end", this.#onEnd);
  }

  dispose(): void {
    this.socket.off("data", this.#onData);
    this.socket.off("error", this.#onError);
    this.socket.off("end", this.#onEnd);
  }

  readLine(): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#error) return Promise.reject(this.#error);
    if (this.#ended) return Promise.reject(new Error("SMTP connection ended unexpectedly"));
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
  }
}

async function readResponse(reader: SmtpLineReader): Promise<{ code: number; message: string }> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.readLine();
    lines.push(line);
    const match = /^(\d{3})([ -])/.exec(line);
    if (!match) throw new Error(`Invalid SMTP response: ${line}`);
    if (match[2] === " ") {
      return { code: Number(match[1]), message: lines.join("\n") };
    }
  }
}

async function expectResponse(reader: SmtpLineReader, expected: number | number[]): Promise<{ code: number; message: string }> {
  const response = await readResponse(reader);
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`Unexpected SMTP response ${response.code}`);
  }
  return response;
}

async function writeCommand(socket: SmtpSocket, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(`${command}\r\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeData(socket: SmtpSocket, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function connectSocket(config: SmtpEmailConfig): Promise<SmtpSocket> {
  const timeout = config.timeoutMilliseconds ?? 15_000;
  if (config.secure) {
    const socket = tlsConnect({
      host: config.host,
      port: config.port,
      servername: config.host,
      timeout,
    });
    socket.setTimeout(timeout, () => socket.destroy(new Error("SMTP connection timed out")));
    await new Promise<void>((resolve, reject) => {
      socket.once("secureConnect", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  const socket = createConnection({ host: config.host, port: config.port, timeout });
  socket.setTimeout(timeout, () => socket.destroy(new Error("SMTP connection timed out")));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function upgradeToTls(socket: SmtpSocket, host: string, timeoutMilliseconds: number): Promise<TLSSocket> {
  const tlsSocket = tlsConnect({
    socket,
    servername: host,
    timeout: timeoutMilliseconds,
  });
  tlsSocket.setTimeout(timeoutMilliseconds, () => tlsSocket.destroy(new Error("SMTP TLS upgrade timed out")));
  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });
  return tlsSocket;
}

export class SmtpEmailTransport implements EmailTransport {
  readonly provider = "smtp";
  readonly #config: SmtpEmailConfig;

  constructor(config: SmtpEmailConfig) {
    if (!config.host.trim()) throw new Error("SMTP host is required");
    if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
      throw new Error("SMTP port must be an integer between 1 and 65535");
    }
    envelopeAddress(config.from, "From");
    if ((config.username && !config.password) || (!config.username && config.password)) {
      throw new Error("SMTP username and password must be configured together");
    }
    this.#config = {
      ...config,
      host: config.host.trim(),
      from: config.from.trim(),
      timeoutMilliseconds: config.timeoutMilliseconds ?? 15_000,
      heloName: config.heloName ?? "slybrowser.local",
    };
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const recipients = (Array.isArray(message.to) ? message.to : [message.to])
      .map((recipient) => envelopeAddress(recipient, "Recipient"));
    if (recipients.length === 0) throw new Error("At least one recipient is required");
    const sender = envelopeAddress(this.#config.from, "From");
    const timeoutMilliseconds = this.#config.timeoutMilliseconds ?? 15_000;
    let socket = await connectSocket(this.#config);
    let reader = new SmtpLineReader(socket);
    try {
      await expectResponse(reader, 220);
      await writeCommand(socket, `EHLO ${this.#config.heloName}`);
      await expectResponse(reader, 250);

      if (!this.#config.secure && this.#config.startTls) {
        await writeCommand(socket, "STARTTLS");
        await expectResponse(reader, 220);
        reader.dispose();
        socket = await upgradeToTls(socket, this.#config.host, timeoutMilliseconds);
        reader = new SmtpLineReader(socket);
        await writeCommand(socket, `EHLO ${this.#config.heloName}`);
        await expectResponse(reader, 250);
      }

      if (this.#config.username && this.#config.password) {
        const credential = Buffer.from(`\u0000${this.#config.username}\u0000${this.#config.password}`, "utf8").toString("base64");
        await writeCommand(socket, `AUTH PLAIN ${credential}`);
        await expectResponse(reader, [235, 503]);
      }

      await writeCommand(socket, `MAIL FROM:<${sender}>`);
      await expectResponse(reader, 250);
      for (const recipient of recipients) {
        await writeCommand(socket, `RCPT TO:<${recipient}>`);
        await expectResponse(reader, [250, 251]);
      }
      await writeCommand(socket, "DATA");
      await expectResponse(reader, 354);
      const mime = buildMimeMessage(this.#config, message, recipients);
      await writeData(socket, `${dotStuff(mime)}\r\n.\r\n`);
      const queued = await expectResponse(reader, 250);
      await writeCommand(socket, "QUIT").catch(() => undefined);
      await expectResponse(reader, 221).catch(() => undefined);
      const providerMessageId = queued.message.split(/\s+/).find((part) => /[A-Za-z0-9_-]{8,}/.test(part));
      return providerMessageId === undefined ? {} : { providerMessageId };
    } finally {
      reader.dispose();
      if (!socket.destroyed) socket.end();
    }
  }
}

export class MemoryEmailTransport implements EmailTransport {
  readonly provider = "memory";
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    return { providerMessageId: `memory-${this.sent.length}` };
  }
}

export function loadSmtpEmailTransportFromEnv(environment: NodeJS.ProcessEnv = process.env): SmtpEmailTransport | undefined {
  const host = environment.SLY_EMAIL_SMTP_HOST?.trim();
  if (!host) return undefined;
  const secure = booleanEnvironment(environment.SLY_EMAIL_SMTP_SECURE, false);
  const startTls = booleanEnvironment(environment.SLY_EMAIL_SMTP_STARTTLS, !secure);
  const port = boundedPort(environment.SLY_EMAIL_SMTP_PORT, secure ? 465 : 587);
  const from = environment.SLY_EMAIL_FROM?.trim();
  if (!from) throw new Error("SLY_EMAIL_FROM is required when SLY_EMAIL_SMTP_HOST is configured");
  const timeoutMilliseconds = environment.SLY_EMAIL_SMTP_TIMEOUT_MS === undefined || environment.SLY_EMAIL_SMTP_TIMEOUT_MS === ""
    ? undefined
    : Number(environment.SLY_EMAIL_SMTP_TIMEOUT_MS);
  if (timeoutMilliseconds !== undefined && (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 120_000)) {
    throw new Error("SLY_EMAIL_SMTP_TIMEOUT_MS must be an integer between 1000 and 120000");
  }
  return new SmtpEmailTransport({
    host,
    port,
    secure,
    startTls,
    from,
    ...(environment.SLY_EMAIL_SMTP_USER === undefined || environment.SLY_EMAIL_SMTP_USER === "" ? {} : { username: environment.SLY_EMAIL_SMTP_USER }),
    ...(environment.SLY_EMAIL_SMTP_PASSWORD === undefined || environment.SLY_EMAIL_SMTP_PASSWORD === "" ? {} : { password: environment.SLY_EMAIL_SMTP_PASSWORD }),
    ...(environment.SLY_EMAIL_SMTP_HELO === undefined || environment.SLY_EMAIL_SMTP_HELO === "" ? {} : { heloName: environment.SLY_EMAIL_SMTP_HELO }),
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
}
