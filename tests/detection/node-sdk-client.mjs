import { launchAuthorized } from "../../packages/node/dist/licensed.js";
import { SlyWebDriverElement, SlyWebDriverService } from "../../packages/node/dist/webdriver.js";

function delay(milliseconds) {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

/**
 * Detection-harness adapter for the public Node package. Browser creation and
 * every W3C command still flow through SlyWebDriverService/SlyWebDriverSession.
 */
class NodeSdkBenchmarkClient {
  constructor(session, { captureBrowserLogs = false, humanize = {} } = {}) {
    this.session = session;
    this.capabilities = session.capabilities;
    this.captureBrowserLogs = captureBrowserLogs;
    this.humanizeEnabled = humanize.enabled === true;
  }

  element(elementId) {
    return new SlyWebDriverElement(this.session, elementId);
  }

  elementReference(elementId) {
    return { "element-6066-11e4-a52e-4f735466cecf": elementId };
  }

  async navigate(url) { await this.session.get(url); }
  async currentUrl() { return this.session.currentUrl(); }
  async execute(script, args = []) {
    return this.session.executeScript(script, args.map((value) => {
      const id = value?.["element-6066-11e4-a52e-4f735466cecf"];
      return id ? this.element(id) : value;
    }));
  }
  async executeAsync(script, args = []) {
    return this.session.executeAsyncScript(script, args.map((value) => {
      const id = value?.["element-6066-11e4-a52e-4f735466cecf"];
      return id ? this.element(id) : value;
    }));
  }
  async findElement(using, value) { return (await this.session.findElement(value, using)).id; }
  async findElements(using, value) { return (await this.session.findElements(value, using)).map((element) => element.id); }

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
      if (info.visible && (!expectedLabel || info.label.toLowerCase().includes(expectedLabel.toLowerCase()))) return elementId;
    }
    throw new Error(`No visible ${using} element matched ${value}`);
  }

  async click(elementId) { await this.session.clickElement(elementId); }
  async clear(elementId) { await this.session.clearElement(elementId); }
  async sendKeys(elementId, value) { await this.session.sendKeysToElement(elementId, value); }
  async pressKey(value) {
    const key = String(value);
    await this.session.performActions([{
      type: "key",
      id: "benchmark-keyboard",
      actions: [{ type: "keyDown", value: key }, { type: "keyUp", value: key }],
    }]);
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
      return { deltaY: Math.max(-600, Math.min(600, Math.round(center.y - desiredCenter))) };
    `, [this.elementReference(elementId)]);
    if (!recovery || recovery.deltaY === 0) return false;
    await this.session.performActions([{
      type: "wheel",
      id: "sly-humanize-actionability-wheel",
      actions: [{ type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: recovery.deltaY, duration: 160, origin: "viewport" }],
    }]);
    await delay(120);
    return true;
  }

  async humanClick(elementId) {
    try {
      await this.click(elementId);
    } catch (error) {
      if (!/element click intercepted/i.test(String(error?.message ?? error)) ||
          !await this.recoverFromClickInterception(elementId)) throw error;
      await this.click(elementId);
    }
  }
  async humanType(elementId, value, options = {}) {
    if (options.clear !== false) await this.clear(elementId).catch(() => undefined);
    await this.sendKeys(elementId, value);
  }

  async screenshot() { return (await this.session.screenshot()).toString("base64"); }
  async browserLogs() { return this.captureBrowserLogs ? this.session.browserLogs() : []; }
  async setTimeouts(timeouts) { await this.session.setTimeouts(timeouts); }
  async setWindowRect(width, height) { return this.session.setWindowRect({ width, height }); }
  async currentWindowHandle() { return this.session.currentWindowHandle(); }
  async windowHandles() { return this.session.windowHandles(); }
  async switchToWindow(handle) { await this.session.switchToWindow(handle); }
  async switchToFrame(elementId) { await this.session.switchToFrame(elementId === null ? null : this.element(elementId)); }
  async switchToParentFrame() { await this.session.switchToParentFrame(); }
  async closeWindow() { return this.session.closeWindow(); }
  async performBasicInteraction() {
    await this.session.performActions([{
      type: "pointer",
      id: "benchmark-mouse",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", duration: 160, x: 120, y: 120, origin: "viewport" },
        { type: "pointerMove", duration: 220, x: 420, y: 260, origin: "viewport" },
        { type: "pause", duration: 80 },
      ],
    }]).catch(() => undefined);
    await this.session.performActions([{
      type: "wheel",
      id: "benchmark-wheel",
      actions: [{ type: "scroll", x: 0, y: 0, deltaX: 0, deltaY: 240, duration: 180, origin: "viewport" }],
    }]).catch(() => this.execute("window.scrollBy(0, 240)").catch(() => undefined));
  }
  async quit() { await this.session.close(); }
}

export async function startNodeSdkDriver(driverExecutable, options = {}) {
  const service = await SlyWebDriverService.start(driverExecutable, {
    ...(options.startTimeout == null ? {} : { startTimeout: options.startTimeout }),
    ...(options.commandTimeout == null ? {} : { commandTimeout: options.commandTimeout }),
    ...(options.licenseFile == null ? {} : { licenseFile: options.licenseFile }),
  });
  return {
    async createSession(browserExecutable, launchOptions = {}) {
      const session = await service.createSession(browserExecutable, {
        args: launchOptions.args,
        headless: launchOptions.headless,
        viewport: launchOptions.viewport,
        excludeSwitches: launchOptions.excludeSwitches,
        humanize: launchOptions.humanize?.enabled,
        humanPreset: launchOptions.humanize?.preset,
        humanConfig: launchOptions.humanize?.config,
        humanSeed: launchOptions.humanize?.seed,
        commandTimeout: launchOptions.humanize?.commandTimeout,
      });
      return new NodeSdkBenchmarkClient(session, {
        captureBrowserLogs: launchOptions.captureBrowserLogs,
        humanize: launchOptions.humanize,
      });
    },
    async close() { await service.close(); },
  };
}

export async function startAuthorizedNodeSdkDriver(authorizationFile, options = {}) {
  const sessions = new Set();
  return {
    async createSession(_browserExecutable, launchOptions = {}) {
      const session = await launchAuthorized(authorizationFile, {
        trust: options.trust,
        ...(options.cacheRoot == null ? {} : { install: { cacheRoot: options.cacheRoot } }),
        platform: "windows",
        arch: "x64",
        updateKernel: false,
        automationBackend: "project-webdriver",
        profile: launchOptions.profile,
        args: launchOptions.args,
        headless: launchOptions.headless,
        viewport: launchOptions.viewport,
        excludeSwitches: launchOptions.excludeSwitches,
        humanize: launchOptions.humanize?.enabled,
        humanPreset: launchOptions.humanize?.preset,
        humanConfig: launchOptions.humanize?.config,
        humanSeed: launchOptions.humanize?.seed,
        commandTimeout: launchOptions.humanize?.commandTimeout,
        nativeReady: true,
        nativeReadyTimeout: options.nativeReadyTimeout ?? 15_000,
      });
      sessions.add(session);
      session.addCloseCallback(() => {
        sessions.delete(session);
      });
      return new NodeSdkBenchmarkClient(session, {
        captureBrowserLogs: launchOptions.captureBrowserLogs,
        humanize: launchOptions.humanize,
      });
    },
    async close() {
      await Promise.allSettled([...sessions].map((session) => session.close()));
      sessions.clear();
    },
  };
}
