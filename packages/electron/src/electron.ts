/**
 * The `electron` fixture: what a test asks of the Electron app itself rather
 * than of a control in a window. The harness records each call as an
 * `electron.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, isSecret, stepTimeout, type EngineFixtureContext, type FixtureOperation } from '@e2e-dev/core/engine';
import type { Electron, ElectronMainModule, ElectronWindow } from './fixtures.ts';
import type { ElectronSurface } from './surface.ts';
import type { AppWindow } from './windows.ts';

export function createElectronFixture(surface: ElectronSurface, context: EngineFixtureContext): Electron {
  /** One handle per window, so the same window is the same object for as long as the app runs. */
  const handles = new WeakMap<AppWindow, ElectronWindow>();
  const windowAction: FixtureOperation = { kind: 'resource' };
  const handle = (window: AppWindow): ElectronWindow => {
    const known = handles.get(window);
    if (known !== undefined) return known;
    const made = context.fixture<ElectronWindow>('window', {
      title: () => surface.windowTitle(window, context.operation()),
      url: () => Promise.resolve(window.page.url()),
      isActive: () => surface.isActiveWindow(window),
      isClosed: () => window.page.isClosed(),
      activate: () => surface.activateWindow(window, context.operation()),
      close: () => surface.closeWindow(window, context.operation()),
    }, { title: windowAction, url: windowAction, activate: windowAction, close: windowAction });
    handles.set(window, made);
    return made;
  };
  const electron: Electron = {
    async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
      // A secret handle would reach the main process as its name and purpose, never its value: refused, as every JSON sink refuses one.
      if (holdsSecret(arg)) throw new ConfigurationError('POLICY_DENIED', 'electron.evaluate cannot take a secret as its argument: resolve the value in the test and pass a string, or keep it out of the main process');
      return await surface.evaluate(fn, arg as A, context.operation());
    },
    windows: () => surface.openWindows().map(handle),
    async waitForWindow(trigger, options) {
      if (typeof trigger !== 'function') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.waitForWindow() takes the function that opens the window');
      return handle(await surface.waitForWindow(trigger, context.operation(stepTimeout(options?.timeout, 'electron.waitForWindow'))));
    },
    async window(which, options) {
      if (typeof which !== 'object' || which === null || (which.title === undefined && which.url === undefined)) {
        throw new ConfigurationError('INVALID_ARGUMENT', 'electron.window() takes { title } or { url }; electron.windows() lists every window');
      }
      return handle(await surface.findWindow(which, context.operation(stepTimeout(options?.timeout, 'electron.window'))));
    },
    async waitForDownload(trigger, options) {
      if (typeof trigger !== 'function') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.waitForDownload() takes the function that starts the download');
      const file = await surface.waitForDownload(trigger, context.operation(stepTimeout(options?.timeout, 'electron.waitForDownload')));
      context.attachArtifact('download', file.path);
      return file;
    },
    // Async so the harness records the registration as an `electron.onDialog` step.
    async onDialog(handler) {
      if (handler !== 'accept' && handler !== 'dismiss' && typeof handler !== 'function') {
        throw new ConfigurationError('INVALID_ARGUMENT', "electron.onDialog() takes 'accept', 'dismiss', or a function that answers the dialog");
      }
      const off = surface.onDialog(handler);
      return () => {
        off();
        return Promise.resolve();
      };
    },
    locator(selector) {
      if (typeof selector !== 'string' || selector.trim() === '') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.locator() takes a CSS selector string');
      return context.locator({ kind: 'selector', selector });
    },
  };
  return context.fixture('electron', electron, {
    evaluate: { kind: 'resource' },
    waitForWindow: { kind: 'resource', timeout: false },
    window: { kind: 'resource', timeout: (_which, options) => options?.timeout, label: (which) => JSON.stringify({ title: which.title?.toString(), url: which.url?.toString() }) },
    waitForDownload: { kind: 'resource', timeout: false },
    onDialog: { kind: 'resource' },
  });
}

/** Whether a value is a secret handle or holds one in an array or a plain object, at any depth. */
function holdsSecret(value: unknown, seen = new Set<unknown>()): boolean {
  if (isSecret(value)) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) => holdsSecret(item, seen));
}
