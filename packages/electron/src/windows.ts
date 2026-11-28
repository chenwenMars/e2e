/**
 * The running app's windows: the registry of the pages it opened, which one
 * `screen` and the agent read, and the node refs that name a node in one.
 */

import { pollCondition, TestError, type NodeRef, type OperationContext } from '@e2e-dev/core/engine';
import { invalidState, notActionable, stale } from './errors.ts';
import { answerWithin, Budget } from './budget.ts';
import type { WindowMatcher } from './fixtures.ts';
import type { PageTarget } from './page.ts';

/** How long a window gets to say its document's title. */
const TITLE_MS = 1_000;

/** The observation root's id: one surface, one root, whichever window it reads. */
export const ROOT_ID = 'window';

/** One open window of the app: its page and the serial its node ids carry. */
export interface AppWindow {
  readonly page: PageTarget;
  readonly serial: number;
}

/** Reads the OS window's title of a window's page; undefined for a view with no window of its own. */
export type WindowTitle = (page: PageTarget) => Promise<string | undefined>;

/**
 * The node id a window's node carries: the window's serial, which of its
 * documents the node was read in, and the node's backend id. `generation` is
 * the page's when the read began, not when the id is made: a navigation may
 * have landed in between.
 */
export function nodeId(window: AppWindow, generation: number, backendNodeId: number): string {
  return `${window.serial}.${generation}.${backendNodeId}`;
}

export class Windows {
  private readonly byPage = new Map<PageTarget, AppWindow>();
  private shownWindow: AppWindow | undefined;
  /** Told each time another window, or none, becomes the shown one. */
  onShown: ((window: AppWindow | undefined) => void) | undefined;
  /** The windows shown before the current one, oldest first: closing the shown window goes back to the latest still open, unless the window that opened it is. */
  private history: AppWindow[] = [];
  private nextSerial = 1;
  private readonly crashed = new Set<PageTarget>();

  private get shown(): AppWindow | undefined {
    return this.shownWindow;
  }

  private set shown(window: AppWindow | undefined) {
    if (window === this.shownWindow) return;
    this.shownWindow = window;
    this.onShown?.(window);
  }

  /** Registers a page the app opened, once; undefined when it is already known or closed. Its node ids get a serial of their own. */
  add(page: PageTarget): AppWindow | undefined {
    if (this.byPage.has(page) || page.isClosed()) return undefined;
    const window: AppWindow = { page, serial: this.nextSerial++ };
    this.byPage.set(page, window);
    this.shown ??= window;
    page.on('close', () => this.discard(page));
    return window;
  }

  /**
   * Forgets a window that closed. A read can fail on a closed window before
   * its close event arrives; it discards the window itself and reads again.
   */
  discard(page: PageTarget): void {
    const window = this.byPage.get(page);
    this.byPage.delete(page);
    if (window !== undefined && this.shown === window) this.shown = this.fallback(window);
  }

  /** Marks a window whose renderer crashed, until it loads a page again. */
  markCrashed(page: PageTarget): void {
    this.crashed.add(page);
  }

  markLoaded(page: PageTarget): void {
    this.crashed.delete(page);
  }

  isCrashed(window: AppWindow): boolean {
    return this.crashed.has(window.page);
  }

  /** Forgets every window: the app quit. */
  clear(): void {
    this.crashed.clear();
    this.byPage.clear();
    this.shown = undefined;
    this.history = [];
  }

  /** Makes `window` the shown one, remembering the one before it. */
  private showWindow(window: AppWindow): void {
    if (this.shown !== undefined && this.shown !== window) this.history = [...this.history.filter((each) => each !== this.shown && each !== window), this.shown];
    this.shown = window;
  }

  /** The window to show once `closed` is gone: the one that opened it, else the one shown before it that is still open, else the newest. */
  private fallback(closed: AppWindow | undefined): AppWindow | undefined {
    const open = this.open();
    const opener = closed?.page.opener === undefined ? undefined : open.find((window) => window.page === closed.page.opener);
    this.history = this.history.filter((window) => open.includes(window) && window !== opener);
    return opener ?? this.history.pop() ?? open.at(-1);
  }

  /** Whether a page is registered as a window. */
  has(page: PageTarget): boolean {
    return this.byPage.has(page);
  }

  /** Whether a page is the window `screen` and the agent read. */
  isShownPage(page: PageTarget): boolean {
    return this.shown?.page === page;
  }

  /** The open windows, in the order they opened. A `WebContentsView` is a page of its own and counts as a window. */
  open(): AppWindow[] {
    return [...this.byPage.values()].filter(isOpen).toSorted((a, b) => a.serial - b.serial);
  }

  /**
   * The window `screen` and the agent read: the one chosen, else the first the
   * app opened. Once that one closes, the window that opened it, else the
   * one shown before it that is still open, else the newest.
   */
  current(): AppWindow | undefined {
    if (this.shown !== undefined && isOpen(this.shown)) return this.shown;
    this.shown = this.fallback(this.shown);
    return this.shown;
  }

  /** The current window, or why there is none. */
  require(): AppWindow {
    const window = this.current();
    if (window === undefined) throw invalidState('the app has no open window');
    return window;
  }

  /** The window and backend node a ref names, or a stale error when it is gone or from another window. */
  bind(ref: NodeRef): { readonly window: AppWindow; readonly backendNodeId: number } {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(ref.id);
    if (match === null) throw stale(`node ${ref.id} is not a node of this app`);
    const window = this.current();
    if (window === undefined || window.serial !== Number(match[1])) throw stale(`node ${ref.id} is in a window that is not shown now`);
    if (window.page.generation !== Number(match[2])) throw stale(`node ${ref.id} is in a document the window no longer shows`);
    return { window, backendNodeId: Number(match[3]) };
  }

  /** Shows the open window at `index`. */
  show(index: number): AppWindow {
    const open = this.open();
    const window = open[index];
    if (window === undefined) throw notActionable(`no such window: the app has ${windowCount(open.length)} open`);
    this.showWindow(window);
    return window;
  }

  /** The open window at `index`, which closing leaves another open. */
  closable(index: number): AppWindow {
    const open = this.open();
    const window = open[index];
    if (window === undefined) throw notActionable(`no such window: the app has ${windowCount(open.length)} open`);
    // The contract keeps the last tab open; for most apps the last window closing quits the app.
    if (open.length === 1) throw notActionable('this is the app\'s only window; closing it would end the app');
    return window;
  }

  /** Makes an open window the shown one. */
  activate(window: AppWindow): void {
    if (!this.open().includes(window)) throw new TestError('ACTION_FAILED', 'the window has closed');
    this.showWindow(window);
  }

  /** The open windows with what a matcher reads of each, so a window that closes while the titles are read cannot shift a match onto another. */
  private async describe(windowTitle: WindowTitle): Promise<readonly Described[]> {
    return await Promise.all(
      this.open().map(async (window) => {
        // A window whose renderer crashed, or is busy, never answers: it is listed without a title rather than not at all.
        const [title = '', own] = await Promise.all([answerWithin(window.page.title(), TITLE_MS), windowTitle(window.page)]);
        return { window, title, ...(own === undefined || own === title ? {} : { windowTitle: own }), url: window.page.url() };
      }),
    );
  }

  /** The first open window `which` matches, waiting for it to open until a little before the operation's deadline. It is not shown: the caller activates it. */
  async find(which: WindowMatcher, windowTitle: WindowTitle, operation: OperationContext): Promise<AppWindow> {
    let described: readonly Described[] = [];
    let found: AppWindow | undefined;
    const budget = new Budget(operation, 'electron.window');
    await pollCondition({
      deadline: budget.waits,
      signal: operation.signal,
      negated: false,
      evaluate: async () => {
        described = await this.describe(windowTitle);
        // A match that closed while the titles were read is no match; the next read looks again.
        found = described.find((each) => matchesWindow(each, which) && this.open().includes(each.window))?.window;
        return found !== undefined;
      },
      onTimeout: () => notActionable(`no window matches ${describeMatcher(which)}; open: ${described.map(({ title }) => JSON.stringify(title)).join(', ') || 'none'}`),
    });
    if (found === undefined) throw notActionable(`no window matches ${describeMatcher(which)}`);
    return found;
  }
}

/** One open window as a matcher reads it. */
interface Described {
  readonly window: AppWindow;
  readonly title: string;
  readonly windowTitle?: string;
  readonly url: string;
}

function windowCount(count: number): string {
  return `${count} window${count === 1 ? '' : 's'}`;
}

/** Whether a window is one the app shows its user: open, and not an inspector the app's own DevTools opened. */
function isOpen(window: AppWindow): boolean {
  return !window.page.isClosed() && !window.page.url().startsWith('devtools://');
}

function matchesWindow(window: Described, which: WindowMatcher): boolean {
  const test = (pattern: string | RegExp | undefined, value: string): boolean =>
    pattern === undefined || (typeof pattern === 'string' ? value === pattern : new RegExp(pattern.source, pattern.flags).test(value));
  return (test(which.title, window.title) || (window.windowTitle !== undefined && test(which.title, window.windowTitle))) && test(which.url, window.url);
}

function describeMatcher(which: WindowMatcher): string {
  return [which.title === undefined ? '' : `title ${String(which.title)}`, which.url === undefined ? '' : `url ${String(which.url)}`].filter(Boolean).join(' and ') || 'any window';
}
