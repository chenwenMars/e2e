/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, Deadline, EngineError, pollCondition, stepTimeout, TestError, type EngineFixtureContext, type FixtureOperation, type OperationContext } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface, OpenWindow } from './surface.ts';

/** How long before a step's end a wait for a window gives up, at most. */
const WAIT_MARGIN_MS = 250;

/**
 * One window of the running app. The same window is the same object for as
 * long as it stays open. Its reads ask the OS, so each is a promise.
 */
export interface DesktopWindow {
  /** The window's current title. Rejects with `ACTION_FAILED` when it has closed. */
  title(): Promise<string>;
  /** Whether this is the active window, the one `screen`, `expect`, and the agent act on. */
  isActive(): Promise<boolean>;
  /** Whether the window has closed. */
  isClosed(): Promise<boolean>;
  /**
   * Makes this the active window, whichever window has focus, until it closes
   * or the app quits. Rejects with `ACTION_FAILED` when it has closed.
   */
  activate(): Promise<void>;
  /**
   * Closes the window as its close button does. When it was the active
   * window, `screen` reads the focused window again. Rejects with
   * `ACTION_FAILED` when the window has no close button or stays open, as
   * one that asks to save its changes does: its button was pressed.
   */
  close(): Promise<void>;
}

/** Which window `desktop.window` finds: the first whose title matches, a string exactly or a RegExp. */
export interface WindowMatcher {
  readonly title: string | RegExp;
}

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /** The OS the app runs on. */
  readonly platform: DesktopPlatform;
  /** The app's open windows. */
  windows(): Promise<readonly DesktopWindow[]>;
  /**
   * Runs a trigger and waits for the window it opens, then resolves with that
   * window once it is the active one. Rejects with `ACTION_FAILED` when no
   * window opens within `timeout` milliseconds, or else the action timeout.
   */
  waitForWindow(trigger: () => Promise<void>, options?: { readonly timeout?: number }): Promise<DesktopWindow>;
  /**
   * The first open window whose title matches, waiting for it to open up to
   * `timeout` milliseconds or else the action timeout. It does not become
   * active; call `activate()`.
   */
  window(which: WindowMatcher, options?: { readonly timeout?: number }): Promise<DesktopWindow>;
  /** The keyboard, for whatever has focus in the active window. */
  readonly keyboard: {
    /**
     * Presses one key, or a combo such as `ControlOrMeta+2`: for an app with
     * no control that takes keyboard focus. Without `physicalInput` the active
     * window must be the app's key window.
     */
    press(key: string): Promise<void>;
    /** Types text into the focused field, key by key. */
    type(text: string): Promise<void>;
  };
  /** Quits the app. `app.open()` launches it again; every test ends with it quit. */
  closeApp(): Promise<void>;
}

export function createDesktopFixture(surface: DesktopSurface, context: EngineFixtureContext): Desktop {
  /** One handle per window id, which the window server gives to no other window while this one is open. */
  const handles = new Map<string, DesktopWindow>();
  const windowAction: FixtureOperation = { kind: 'resource' };
  const read = async (id: string): Promise<OpenWindow | undefined> => (await surface.windows(context.operation())).find((window) => window.id === id);
  const handle = ({ id }: OpenWindow): DesktopWindow => {
    const known = handles.get(id);
    if (known !== undefined) return known;
    const made = context.fixture<DesktopWindow>('window', {
      async title() {
        const window = await read(id);
        if (window === undefined) throw new TestError('ACTION_FAILED', 'the window has closed; desktop.windows() lists the open ones');
        return window.title;
      },
      isActive: async () => (await read(id))?.active === true,
      isClosed: async () => (await read(id)) === undefined,
      activate: () => surface.activateWindow(id, context.operation()),
      close: () => surface.closeWindow(id, context.operation()),
    }, { title: windowAction, isActive: windowAction, isClosed: windowAction, activate: windowAction, close: windowAction });
    handles.set(id, made);
    return made;
  };
  /**
   * Reads the open windows until `pick` finds one, or `waitMs` ends. Each
   * read keeps the operation's own budget, so a wait with little time left
   * still looks once.
   */
  const waitFor = async (pick: (windows: readonly OpenWindow[]) => OpenWindow | undefined, operation: OperationContext, waitMs: number, timedOut: (windows: readonly OpenWindow[]) => string): Promise<OpenWindow> => {
    let windows: readonly OpenWindow[] = [];
    let found: OpenWindow | undefined;
    await pollCondition({
      // A little before the step's own end, so the wait reports what it waited for rather than a bare timeout.
      deadline: new Deadline(Math.max(1, waitMs - Math.min(WAIT_MARGIN_MS, waitMs / 10))),
      signal: operation.signal,
      negated: false,
      evaluate: async () => {
        try {
          windows = await surface.windows(operation);
        } catch (cause) {
          // An app busy opening its window does not answer its list in time: the next read may.
          if (cause instanceof EngineError && cause.retryable) return false;
          throw cause;
        }
        found = pick(windows);
        return found !== undefined;
      },
      onTimeout: () => new TestError('ACTION_FAILED', timedOut(windows)),
    });
    if (found === undefined) throw new TestError('ACTION_FAILED', timedOut(windows));
    return found;
  };
  const desktop: Desktop = {
    platform: surface.platform,
    windows: async () => (await surface.windows(context.operation())).map(handle),
    async waitForWindow(trigger, options) {
      if (typeof trigger !== 'function') throw new ConfigurationError('INVALID_ARGUMENT', 'desktop.waitForWindow() takes the function that opens the window');
      const operation = context.operation(stepTimeout(options?.timeout, 'desktop.waitForWindow'));
      const waitMs = operation.timeoutMs;
      const before = new Set((await surface.windows(operation)).map((window) => window.id));
      const started = Date.now();
      // The trigger is test code: its error is reported as it is.
      await trigger();
      const triggerMs = Date.now() - started;
      const opened = await waitFor(
        // Not a dialog macOS put over the app, which `screen` never reads on its own either.
        (windows) => windows.find((window) => window.readable && !before.has(window.id)),
        operation,
        waitMs - triggerMs,
        () => `no window opened within ${waitMs}ms; the trigger resolved after ${triggerMs}ms`,
      );
      await surface.activateWindow(opened.id, operation);
      return handle(opened);
    },
    async window(which, options) {
      if (typeof which !== 'object' || which === null || (typeof which.title !== 'string' && !(which.title instanceof RegExp))) {
        throw new ConfigurationError('INVALID_ARGUMENT', 'desktop.window() takes { title }, a string or a RegExp; desktop.windows() lists every window');
      }
      const { title } = which;
      // Without the flags that make a RegExp remember where its last match ended.
      const pattern = typeof title === 'string' ? undefined : new RegExp(title.source, title.flags.replace(/[gy]/g, ''));
      const matches = (window: OpenWindow): boolean => (pattern === undefined ? window.title === title : pattern.test(window.title));
      const operation = context.operation(stepTimeout(options?.timeout, 'desktop.window'));
      return handle(
        await waitFor(
          (windows) => windows.find(matches),
          operation,
          operation.timeoutMs,
          (windows) => `no window has the title ${String(title instanceof RegExp ? title : JSON.stringify(title))}; open: ${windows.map((window) => JSON.stringify(window.title)).join(', ') || 'none'}`,
        ),
      );
    },
    keyboard: {
      async press(key) {
        await surface.pressKey(key, context.operation());
      },
      async type(text) {
        if (typeof text !== 'string') throw new ConfigurationError('INVALID_ARGUMENT', 'desktop.keyboard.type() takes the text to type');
        await surface.typeText(text, { replace: false }, context.operation());
      },
    },
    async closeApp() {
      const operation = context.operation();
      await surface.closeApp(operation.signal, operation.timeoutMs);
    },
  };
  return context.fixture('desktop', desktop, {
    windows: { kind: 'resource' },
    waitForWindow: { kind: 'resource', timeout: false },
    window: { kind: 'resource', timeout: (_which, options) => options?.timeout, label: (which) => String(which?.title) },
    keyboard: { press: { kind: 'resource', label: (key) => key }, type: { kind: 'resource', label: (text) => (typeof text === 'string' ? `${text.length} chars` : '') } },
    closeApp: { kind: 'resource' },
  });
}
