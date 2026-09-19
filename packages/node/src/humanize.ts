export type HumanPreset = "default" | "careful";

export interface HumanConfig {
  mouseStepsMin: number;
  mouseStepsMax: number;
  mouseStepDelayMin: number;
  mouseStepDelayMax: number;
  clickHoldMin: number;
  clickHoldMax: number;
  keyDelayMin: number;
  keyDelayMax: number;
  thinkDelayMin: number;
  thinkDelayMax: number;
}

export interface HumanizeOptions {
  preset?: HumanPreset;
  config?: Partial<HumanConfig>;
  seed?: number;
}

interface Rectangle { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

interface MouseLike {
  move(x: number, y: number, options?: { steps?: number }): Promise<unknown>;
  down(options?: { button?: "left" | "middle" | "right" }): Promise<unknown>;
  up(options?: { button?: "left" | "middle" | "right" }): Promise<unknown>;
}

interface KeyboardLike {
  down(key: string): Promise<unknown>;
  up(key: string): Promise<unknown>;
  press(key: string): Promise<unknown>;
  type(text: string, options?: { delay?: number }): Promise<unknown>;
}

interface LocatorLike {
  boundingBox(): Promise<Rectangle | null>;
  scrollIntoViewIfNeeded?(): Promise<unknown>;
  click?(options?: Record<string, unknown>): Promise<unknown>;
  fill?(value: string, options?: Record<string, unknown>): Promise<unknown>;
  type?(value: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface PageLike {
  mouse: MouseLike;
  keyboard: KeyboardLike;
  locator?(selector: string, options?: Record<string, unknown>): LocatorLike;
  click?(selector: string, options?: Record<string, unknown>): Promise<unknown>;
  fill?(selector: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  type?(selector: string, value: string, options?: Record<string, unknown>): Promise<unknown>;
  $(selector: string): Promise<LocatorLike | null>;
}

interface ContextLike {
  pages?(): PageLike[];
  on?(event: "page", listener: (page: PageLike) => void): unknown;
  newPage?(): Promise<PageLike>;
}

interface BrowserLike {
  contexts?(): ContextLike[];
  newContext?(options?: Record<string, unknown>): Promise<ContextLike>;
  pages?(): Promise<PageLike[]>;
  newPage?(): Promise<PageLike>;
}

const DEFAULTS: Record<HumanPreset, Readonly<HumanConfig>> = {
  default: Object.freeze({
    mouseStepsMin: 10, mouseStepsMax: 16,
    mouseStepDelayMin: 7, mouseStepDelayMax: 18,
    clickHoldMin: 45, clickHoldMax: 105,
    keyDelayMin: 35, keyDelayMax: 115,
    thinkDelayMin: 120, thinkDelayMax: 360,
  }),
  careful: Object.freeze({
    mouseStepsMin: 10, mouseStepsMax: 16,
    mouseStepDelayMin: 8, mouseStepDelayMax: 24,
    clickHoldMin: 65, clickHoldMax: 145,
    keyDelayMin: 55, keyDelayMax: 155,
    thinkDelayMin: 220, thinkDelayMax: 620,
  }),
};

const PAGE_PATCHED = Symbol("slybrowser.humanize.page");
const CONTEXT_PATCHED = Symbol("slybrowser.humanize.context");
const BROWSER_PATCHED = Symbol("slybrowser.humanize.browser");
const LOCATOR_PATCHED = Symbol("slybrowser.humanize.locator");

function delay(milliseconds: number): Promise<void> {
  return new Promise((accept) => setTimeout(accept, milliseconds));
}

function randomFactory(seed = Date.now()): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function integer(random: () => number, minimum: number, maximum: number): number {
  return Math.floor(minimum + random() * (maximum - minimum + 1));
}

export function resolveHumanConfig(options: HumanizeOptions = {}): Readonly<HumanConfig> {
  const preset = options.preset ?? "default";
  const config = { ...DEFAULTS[preset], ...(options.config ?? {}) };
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`Invalid Humanize value for ${name}`);
  }
  if (config.mouseStepsMin < 6 || config.mouseStepsMax < config.mouseStepsMin) {
    throw new TypeError("Humanize requires at least six mouse moves");
  }
  return Object.freeze(config);
}

class Humanizer {
  readonly config: Readonly<HumanConfig>;
  readonly random: () => number;
  pointer: Point = { x: 48, y: 72 };

  constructor(options: HumanizeOptions) {
    this.config = resolveHumanConfig(options);
    this.random = randomFactory(options.seed);
  }

  private duration(kind: "key" | "think" | "click"): number {
    if (kind === "key") return integer(this.random, this.config.keyDelayMin, this.config.keyDelayMax);
    if (kind === "click") return integer(this.random, this.config.clickHoldMin, this.config.clickHoldMax);
    return integer(this.random, this.config.thinkDelayMin, this.config.thinkDelayMax);
  }

  private target(rectangle: Rectangle): Point {
    if (rectangle.width <= 1 || rectangle.height <= 1) throw new Error("Cannot Humanize an empty element rectangle");
    return {
      x: Math.round(rectangle.x + rectangle.width * (0.22 + this.random() * 0.56)),
      y: Math.round(rectangle.y + rectangle.height * (0.28 + this.random() * 0.44)),
    };
  }

  async move(mouse: MouseLike, target: Point): Promise<void> {
    const steps = integer(this.random, this.config.mouseStepsMin, this.config.mouseStepsMax);
    const distance = Math.hypot(target.x - this.pointer.x, target.y - this.pointer.y);
    const bend = Math.max(18, Math.min(140, distance * 0.22));
    const direction = this.random() < 0.5 ? -1 : 1;
    const start = this.pointer;
    const first = {
      x: start.x + (target.x - start.x) * 0.32 + direction * bend,
      y: start.y + (target.y - start.y) * 0.18 - direction * bend * 0.35,
    };
    const second = {
      x: start.x + (target.x - start.x) * 0.72 - direction * bend * 0.65,
      y: start.y + (target.y - start.y) * 0.82 + direction * bend * 0.28,
    };
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const inverse = 1 - t;
      const wobble = Math.sin(t * Math.PI * 4) * (1 - t) * 1.35;
      const x = inverse ** 3 * start.x + 3 * inverse ** 2 * t * first.x + 3 * inverse * t ** 2 * second.x + t ** 3 * target.x + wobble;
      const y = inverse ** 3 * start.y + 3 * inverse ** 2 * t * first.y + 3 * inverse * t ** 2 * second.y + t ** 3 * target.y - wobble;
      await mouse.move(Math.round(x), Math.round(y));
      await delay(integer(this.random, this.config.mouseStepDelayMin, this.config.mouseStepDelayMax));
    }
    this.pointer = target;
  }

  async click(page: PageLike, locator: LocatorLike): Promise<void> {
    await locator.scrollIntoViewIfNeeded?.();
    const rectangle = await locator.boundingBox();
    if (!rectangle) throw new Error("Cannot Humanize a hidden or detached element");
    await this.move(page.mouse, this.target(rectangle));
    await delay(integer(this.random, 25, 90));
    await page.mouse.down({ button: "left" });
    await delay(this.duration("click"));
    await page.mouse.up({ button: "left" });
    await delay(this.duration("think"));
  }

  async type(page: PageLike, locator: LocatorLike, value: string, clear: boolean): Promise<void> {
    await this.click(page, locator);
    if (clear) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    }
    for (const character of value) {
      await page.keyboard.type(character, { delay: this.duration("key") });
      if (this.random() < 0.08) await delay(this.duration("think"));
    }
  }
}

function flag(object: object, symbol: symbol): void {
  Object.defineProperty(object, symbol, { value: true, configurable: false, enumerable: false });
}

function flagged(object: object, symbol: symbol): boolean {
  return Boolean((object as Record<symbol, unknown>)[symbol]);
}

function patchLocator(page: PageLike, locator: LocatorLike, humanizer: Humanizer): LocatorLike {
  if (flagged(locator, LOCATOR_PATCHED)) return locator;
  const originalClick = locator.click?.bind(locator);
  const originalFill = locator.fill?.bind(locator);
  const originalType = locator.type?.bind(locator);
  if (originalClick) locator.click = async (options = {}) => {
    if (options.force || options.button && options.button !== "left" || options.modifiers || options.position) return originalClick(options);
    await humanizer.click(page, locator);
  };
  if (originalFill) locator.fill = async (value, options = {}) => {
    if (options.force) return originalFill(value, options);
    await humanizer.type(page, locator, value, true);
  };
  if (originalType) locator.type = async (value, options = {}) => {
    if (options.delay !== undefined) return originalType(value, options);
    await humanizer.type(page, locator, value, false);
  };
  const locatorRecord = locator as unknown as Record<string, unknown>;
  for (const factoryName of ["locator", "filter", "nth", "first", "last", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId"]) {
    const factory = locatorRecord[factoryName];
    if (typeof factory !== "function") continue;
    locatorRecord[factoryName] = (...args: unknown[]) =>
      patchLocator(page, Reflect.apply(factory, locator, args) as LocatorLike, humanizer);
  }
  flag(locator, LOCATOR_PATCHED);
  return locator;
}

export function humanizePage<TPage>(pageValue: TPage, options: HumanizeOptions = {}): TPage {
  const page = pageValue as PageLike;
  if (flagged(page, PAGE_PATCHED)) return pageValue;
  if (!page.mouse || !page.keyboard) throw new TypeError("Humanize requires a Playwright- or Puppeteer-compatible page");
  const humanizer = new Humanizer(options);
  const originalLocator = page.locator?.bind(page);
  if (originalLocator) {
    page.locator = (selector, locatorOptions) => patchLocator(page, originalLocator(selector, locatorOptions), humanizer);
    page.click = async (selector, clickOptions = {}) => page.locator!(selector).click!(clickOptions);
    page.fill = async (selector, value, fillOptions = {}) => page.locator!(selector).fill!(value, fillOptions);
    page.type = async (selector, value, typeOptions = {}) => page.locator!(selector).type!(value, typeOptions);
  }
  const pageRecord = page as unknown as Record<string, unknown>;
  for (const factoryName of ["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId"]) {
    const factory = pageRecord[factoryName];
    if (typeof factory !== "function") continue;
    pageRecord[factoryName] = (...args: unknown[]) =>
      patchLocator(page, Reflect.apply(factory, page, args) as LocatorLike, humanizer);
  }
  const originalDollar = typeof pageRecord.$ === "function" ? pageRecord.$ : undefined;
  if (!originalLocator && originalDollar) {
    pageRecord.$ = async (...args: unknown[]) => {
      const handle = await Reflect.apply(originalDollar, page, args) as LocatorLike | null;
      return handle ? patchLocator(page, handle, humanizer) : null;
    };
    const originalClick = page.click?.bind(page);
    const originalType = page.type?.bind(page);
    page.click = async (selector, clickOptions = {}) => {
      if (clickOptions.button && clickOptions.button !== "left" || clickOptions.offset) {
        if (!originalClick) throw new Error("Page does not support click");
        return originalClick(selector, clickOptions);
      }
      const handle = await page.$(selector);
      if (!handle) throw new Error(`No element matched ${selector}`);
      await humanizer.click(page, handle);
    };
    page.type = async (selector, value, typeOptions = {}) => {
      if (typeOptions.delay !== undefined) {
        if (!originalType) throw new Error("Page does not support type");
        return originalType(selector, value, typeOptions);
      }
      const handle = await page.$(selector);
      if (!handle) throw new Error(`No element matched ${selector}`);
      await humanizer.type(page, handle, value, false);
    };
  }
  flag(page, PAGE_PATCHED);
  return pageValue;
}

export function humanizeContext<TContext>(contextValue: TContext, options: HumanizeOptions = {}): TContext {
  const context = contextValue as ContextLike;
  if (flagged(context, CONTEXT_PATCHED)) return contextValue;
  for (const page of context.pages?.() ?? []) humanizePage(page, options);
  context.on?.("page", (page) => { humanizePage(page, options); });
  const originalNewPage = context.newPage?.bind(context);
  if (originalNewPage) context.newPage = async () => humanizePage(await originalNewPage(), options);
  flag(context, CONTEXT_PATCHED);
  return contextValue;
}

export async function humanizeBrowser<TBrowser>(browserValue: TBrowser, options: HumanizeOptions = {}): Promise<TBrowser> {
  const browser = browserValue as BrowserLike;
  if (flagged(browser, BROWSER_PATCHED)) return browserValue;
  for (const context of browser.contexts?.() ?? []) humanizeContext(context, options);
  const originalNewContext = browser.newContext?.bind(browser);
  if (originalNewContext) browser.newContext = async (contextOptions) => humanizeContext(await originalNewContext(contextOptions), options);
  for (const page of await browser.pages?.() ?? []) humanizePage(page, options);
  const originalNewPage = browser.newPage?.bind(browser);
  if (originalNewPage) browser.newPage = async () => humanizePage(await originalNewPage(), options);
  flag(browser, BROWSER_PATCHED);
  return browserValue;
}
