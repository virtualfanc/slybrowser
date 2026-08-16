import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { platform } from "node:os";
import { resolve } from "node:path";

function delay(milliseconds) {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

async function findFreePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return address.port;
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;
  if (platform() === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((accept) => {
      const timer = setTimeout(accept, 3000);
      killer.once("exit", () => { clearTimeout(timer); accept(); });
      killer.once("error", () => { clearTimeout(timer); accept(); });
    });
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((accept) => child.once("exit", accept)),
    delay(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export function buildSessionPayload(browserExecutable, launchOptions = {}) {
  if (!browserExecutable) throw new Error("A browser executable is required");
  const args = [...(launchOptions.args ?? [])];
  if (launchOptions.headless && !args.some((argument) => argument.startsWith("--headless"))) {
    args.push("--headless=new");
  }
  if (!args.some((argument) => argument.startsWith("--window-size"))) {
    const viewport = launchOptions.viewport ?? { width: 1920, height: 947 };
    args.push(`--window-size=${viewport.width},${viewport.height}`);
  }
  const chromeOptions = { binary: browserExecutable, args };
  if (launchOptions.excludeSwitches?.length) chromeOptions.excludeSwitches = launchOptions.excludeSwitches;
  const alwaysMatch = {
    browserName: "chrome",
    acceptInsecureCerts: false,
    "goog:chromeOptions": chromeOptions,
  };
  if (launchOptions.humanize?.enabled) {
    alwaysMatch["sly:options"] = {
      humanize: {
        enabled: true,
        preset: launchOptions.humanize.preset ?? "default",
        ...(launchOptions.humanize.config === undefined ? {} : { config: launchOptions.humanize.config }),
        ...(launchOptions.humanize.seed === undefined ? {} : { seed: launchOptions.humanize.seed }),
      },
    };
  }
  // Browser logging is opt-in because enabling it changes the DevTools commands sent
  // by ChromeDriver and can therefore alter the very signals this harness measures.
  if (launchOptions.captureBrowserLogs) alwaysMatch["goog:loggingPrefs"] = { browser: "ALL" };
  return { capabilities: { alwaysMatch } };
}

export class WebDriverProtocolError extends Error {
  constructor(command, payload, status) {
    const value = payload?.value ?? payload;
    super(`${command} failed (${status}): ${value?.error ?? "webdriver error"}: ${value?.message ?? JSON.stringify(value)}`);
    this.name = "WebDriverProtocolError";
    this.command = command;
    this.status = status;
    this.payload = payload;
  }
}

export class WebDriverClient {
  constructor(origin, sessionId, capabilities, humanize = {}) {
    this.origin = origin;
    this.sessionId = sessionId;
    this.capabilities = capabilities;
    this.humanizeEnabled = Boolean(humanize.enabled);
    this.humanizePreset = humanize.preset ?? "default";
    this.commandTimeout = Number(humanize.commandTimeout ?? 60_000);
    if (this.humanizeEnabled) {
      const advertised = capabilities?.["sly:features"]?.humanize;
      if (advertised?.enabled !== true || advertised?.version !== 1) {
        throw new Error("Project WebDriver did not enable the requested native Humanize capability");
      }
    }
  }

  async request(method, path, body) {
    let response;
    try {
      response = await fetch(`${this.origin}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.commandTimeout),
      });
    } catch (error) {
      if (error?.name === "TimeoutError") {
        throw new Error(`${method} ${path} exceeded the ${this.commandTimeout} ms WebDriver command timeout`);
      }
      throw error;
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.value?.error) {
      throw new WebDriverProtocolError(`${method} ${path}`, payload, response.status);
    }
    return payload?.value;
  }

  sessionPath(suffix = "") {
    return `/session/${encodeURIComponent(this.sessionId)}${suffix}`;
  }

  async navigate(url) {
    await this.request("POST", this.sessionPath("/url"), { url });
  }

  async currentUrl() {
    return this.request("GET", this.sessionPath("/url"));
  }

  async execute(script, args = []) {
    return this.request("POST", this.sessionPath("/execute/sync"), { script, args });
  }

  async executeAsync(script, args = []) {
    return this.request("POST", this.sessionPath("/execute/async"), { script, args });
  }

  async findElement(using, value) {
    const result = await this.request("POST", this.sessionPath("/element"), { using, value });
    return result["element-6066-11e4-a52e-4f735466cecf"];
  }

  async findElements(using, value) {
    const results = await this.request("POST", this.sessionPath("/elements"), { using, value });
    return results.map((result) => result["element-6066-11e4-a52e-4f735466cecf"]);
  }

  async findVisibleElement(using, value, expectedLabel = null) {
    const candidates = await this.findElements(using, value);
    for (const elementId of candidates) {
      const info = await this.execute(`
        const element = arguments[0];
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
          label: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim(),
        };
      `, [this.elementReference(elementId)]);
      if (info.visible && (!expectedLabel || info.label.toLowerCase().includes(expectedLabel.toLowerCase()))) {
        return elementId;
      }
    }
    throw new Error(`No visible ${using} element matched ${value}`);
  }

  async click(elementId) {
    await this.request("POST", this.sessionPath(`/element/${encodeURIComponent(elementId)}/click`), {});
  }

  async clear(elementId) {
    await this.request("POST", this.sessionPath(`/element/${encodeURIComponent(elementId)}/clear`), {});
  }

  async sendKeys(elementId, value) {
    const text = String(value);
    await this.request("POST", this.sessionPath(`/element/${encodeURIComponent(elementId)}/value`), {
      text,
      value: [...text],
    });
  }

  async pressKey(value) {
    const key = String(value);
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [{
        type: "key",
        id: "benchmark-keyboard",
        actions: [
          { type: "keyDown", value: key },
          { type: "keyUp", value: key },
        ],
      }],
    });
  }

  elementReference(elementId) {
    return { "element-6066-11e4-a52e-4f735466cecf": elementId };
  }

  async recoverFromClickInterception(elementId) {
    const recovery = await this.execute(`
      const element = arguments[0];
      const rect = element.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const covering = document.elementFromPoint(center.x, center.y);
      if (!covering || covering === element || element.contains(covering)) return null;
      const coveringRect = covering.getBoundingClientRect();
      const margin = 24;
      const halfHeight = Math.max(1, rect.height / 2);
      const below = coveringRect.bottom + margin + halfHeight;
      const above = coveringRect.top - margin - halfHeight;
      let desiredCenter = null;
      if (below <= innerHeight) desiredCenter = below;
      else if (above >= 0) desiredCenter = above;
      if (desiredCenter === null) return null;
      return {
        deltaY: Math.max(-600, Math.min(600, Math.round(center.y - desiredCenter))),
        coveringTag: covering.tagName,
      };
    `, [this.elementReference(elementId)]);
    if (!recovery || recovery.deltaY === 0) return false;
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [{
        type: "wheel",
        id: "sly-humanize-actionability-wheel",
        actions: [{
          type: "scroll",
          x: 0,
          y: 0,
          deltaX: 0,
          deltaY: recovery.deltaY,
          duration: 160,
          origin: "viewport",
        }],
      }],
    });
    await delay(120);
    return true;
  }

  async humanClick(elementId) {
    try {
      await this.click(elementId);
    } catch (error) {
      if (!/element click intercepted/i.test(String(error?.message ?? error)) ||
          !await this.recoverFromClickInterception(elementId)) {
        throw error;
      }
      await this.click(elementId);
    }
  }

  async humanType(elementId, value, options = {}) {
    if (options.clear !== false) await this.clear(elementId).catch(() => undefined);
    // The W3C element-value command focuses and scrolls the target before the
    // project driver emits trusted per-character key events. A preparatory
    // click is redundant and can be intercepted by sticky page chrome even
    // when the text field itself remains keyboard-actionable.
    await this.sendKeys(elementId, value);
  }

  async screenshot() {
    return this.request("GET", this.sessionPath("/screenshot"));
  }

  async browserLogs() {
    return this.request("POST", this.sessionPath("/log"), { type: "browser" });
  }

  async setTimeouts(timeouts) {
    await this.request("POST", this.sessionPath("/timeouts"), timeouts);
  }

  async setWindowRect(width, height) {
    return this.request("POST", this.sessionPath("/window/rect"), { width, height });
  }

  async currentWindowHandle() {
    return this.request("GET", this.sessionPath("/window"));
  }

  async windowHandles() {
    return this.request("GET", this.sessionPath("/window/handles"));
  }

  async switchToWindow(handle) {
    await this.request("POST", this.sessionPath("/window"), { handle });
  }

  async switchToFrame(elementId) {
    await this.request("POST", this.sessionPath("/frame"), {
      id: elementId === null ? null : this.elementReference(elementId),
    });
  }

  async switchToParentFrame() {
    await this.request("POST", this.sessionPath("/frame/parent"), {});
  }

  async closeWindow() {
    return this.request("DELETE", this.sessionPath("/window"));
  }

  async performBasicInteraction() {
    const actions = [{
      type: "pointer",
      id: "benchmark-mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 160, x: 120, y: 120, origin: "viewport" },
        { type: "pointerMove", duration: 220, x: 420, y: 260, origin: "viewport" },
        { type: "pause", duration: 80 },
      ],
    }];
    await this.request("POST", this.sessionPath("/actions"), { actions }).catch(() => undefined);
    await this.request("POST", this.sessionPath("/actions"), {
      actions: [{
        type: "wheel",
        id: "benchmark-wheel",
        actions: [{ type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: 240, duration: 180, origin: "viewport" }],
      }],
    }).catch(() => this.execute("window.scrollBy(0, 240)").catch(() => undefined));
  }

  async quit() {
    await this.request("DELETE", this.sessionPath()).catch(() => undefined);
  }
}

export async function startChromeDriver(driverExecutable, options = {}) {
  if (!driverExecutable) throw new Error("A WebDriver executable is required");
  const port = await findFreePort();
  const stdout = [];
  const stderr = [];
  const process = spawn(driverExecutable, [
    `--port=${port}`,
    ...(options.verbose ? ["--verbose"] : ["--log-level=WARNING"]),
    ...(options.licenseFile ? [`--sly-license-file=${resolve(options.licenseFile)}`] : []),
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.on("data", (chunk) => { if (stdout.length < 200) stdout.push(String(chunk).slice(0, 4000)); });
  process.stderr.on("data", (chunk) => { if (stderr.length < 200) stderr.push(String(chunk).slice(0, 4000)); });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (options.startTimeout ?? 15_000);
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`ChromeDriver exited with ${process.exitCode}: ${stderr.join("") || stdout.join("")}`);
    }
    try {
      const response = await fetch(`${origin}/status`);
      const payload = await response.json();
      if (response.ok && payload?.value?.ready) {
        return {
          origin,
          process,
          logs: { stdout, stderr },
          async createSession(browserExecutable, launchOptions = {}) {
            const sessionResponse = await fetch(`${origin}/session`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(buildSessionPayload(browserExecutable, launchOptions)),
            });
            const payload = await sessionResponse.json().catch(() => null);
            if (!sessionResponse.ok || payload?.value?.error) {
              throw new WebDriverProtocolError("POST /session", payload, sessionResponse.status);
            }
            const value = payload.value;
            const sessionId = value.sessionId ?? payload.sessionId;
            const capabilities = value.capabilities ?? value;
            return new WebDriverClient(origin, sessionId, capabilities, launchOptions.humanize);
          },
          async close() {
            await terminateProcessTree(process);
            await new Promise((accept) => {
              if (process.exitCode !== null) accept();
              else {
                const timer = setTimeout(accept, 3000);
                process.once("exit", () => { clearTimeout(timer); accept(); });
              }
            });
          },
        };
      }
    } catch { /* driver may still be starting */ }
    await delay(100);
  }
  if (process.exitCode === null) process.kill();
  throw new Error(`ChromeDriver did not become ready: ${stderr.join("") || stdout.join("")}`);
}
