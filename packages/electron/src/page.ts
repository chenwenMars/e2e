/**
 * One page target of the app: a window's or a view's web contents, its
 * DevTools session, the isolated world the engine's page-side code runs in,
 * and its keyboard and mouse.
 */

import type { Deadline } from '@e2e-dev/core/engine';
import type { Session } from './cdp/connection.ts';
import { Keyboard, Mouse, type InputTarget } from './cdp/input.ts';

/** How long past its operation's end a gesture may still hold the page's input, to release what it pressed. */
const RELEASE_MS = 1_000;

/** The isolated world the engine's own page-side reads run in, apart from the app's globals. */
export const WORLD_NAME = '__e2e_electron__';

type PageEvent = 'close' | 'crash' | 'load';

/** What a page function threw, as the protocol reports it. */
export function thrown(details: { readonly text: string; readonly exception?: { readonly description?: string } }): string {
  return details.exception?.description ?? details.text;
}

export class PageTarget implements InputTarget {
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  private address: string;
  private closed = false;
  private isolated: Promise<number> | undefined;
  private documents = 0;
  private gestures: Promise<unknown> = Promise.resolve();
  private readonly handlers = new Map<PageEvent, Set<() => void>>();

  constructor(
    readonly targetId: string,
    readonly session: Session,
    url: string,
    /** The window whose page opened this one with `window.open` or a link, when one did. */
    readonly opener?: PageTarget,
  ) {
    this.address = url;
    this.keyboard = new Keyboard(this);
    this.mouse = new Mouse(this, this.keyboard);
  }

  url(): string {
    return this.address;
  }

  navigated(url: string): void {
    this.address = url;
  }

  isClosed(): boolean {
    return this.closed;
  }

  on(event: PageEvent, handler: () => void): () => void {
    let handlers = this.handlers.get(event);
    if (handlers === undefined) {
      handlers = new Set();
      this.handlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => void handlers.delete(handler);
  }

  /** Resolves at the page's next `event`. */
  next(event: PageEvent): Promise<void> {
    return new Promise((resolve) => {
      const stop = this.on(event, () => {
        stop();
        resolve();
      });
    });
  }

  emit(event: PageEvent): void {
    if (event === 'close') {
      if (this.closed) return;
      this.closed = true;
    }
    for (const handler of this.handlers.get(event) ?? []) handler();
  }

  /** The document's title; empty while the page has no document to ask. */
  async title(): Promise<string> {
    const { result } = await this.session.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    return typeof result.value === 'string' ? result.value : '';
  }

  async bringToFront(): Promise<void> {
    await this.session.send('Page.bringToFront');
  }

  /**
   * How many documents the page has left behind. A node id carries it: the
   * renderer a navigation or a crash starts numbers its nodes from the start
   * again, so a number alone could name another node in the next document.
   */
  get generation(): number {
    return this.documents;
  }

  /** The page has another document: the isolated world of the last one is dropped, and its nodes are no longer this page's. */
  documentChanged(): void {
    this.isolated = undefined;
    this.documents += 1;
  }

  /**
   * The renderer crashed: its document is gone, and so is every answer it
   * owed. A gesture still waiting for one would hold the next back for good,
   * and nothing it pressed is held in the renderer that comes next.
   */
  crashed(): void {
    this.documentChanged();
    this.gestures = Promise.resolve();
    this.keyboard.reset();
    this.mouse.reset();
  }

  /**
   * Runs one gesture after the ones before it have let go. A gesture its
   * caller stopped waiting for still has keys and buttons to release once
   * the page answers; the next one starts with none held. One that never
   * lets go (a page that stopped drawing frames answers no wait for one)
   * holds its turn only a moment past `deadline`, its operation's end. Its
   * turn starts when the one before it ends, however long it waited: a
   * gesture that gave up waiting lets none past the one still holding input.
   */
  exclusive<T>(gesture: () => Promise<T>, deadline: Deadline): Promise<T> {
    const before = this.gestures;
    const run = before.then(gesture);
    const settled = run.then(() => undefined, () => undefined);
    this.gestures = before.then(
      () =>
        new Promise<void>((resolve) => {
          const lapsed = setTimeout(resolve, Math.max(0, deadline.remaining()) + RELEASE_MS);
          lapsed.unref();
          void settled.then(() => {
            clearTimeout(lapsed);
            resolve();
          });
        }),
    );
    return run;
  }

  /** Set while a recording's screencast runs on the page: a capture then leaves the screencast alone. */
  recording = false;
  private captures = 0;

  /**
   * Runs a capture with the page counted as being captured. Chromium draws
   * nothing of a window that is hidden or minimized, and a screenshot of one
   * never returns, unless something captures it: a screencast is the
   * protocol's way to say so. Its frames are not read.
   */
  async captured<T>(capture: () => Promise<T>): Promise<T> {
    this.captures += 1;
    if (!this.recording && this.captures === 1) await this.session.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16 }).catch(() => undefined);
    try {
      return await capture();
    } finally {
      this.captures -= 1;
      if (!this.recording && this.captures === 0) await this.session.send('Page.stopScreencast').catch(() => undefined);
    }
  }

  /** The execution context of the engine's isolated world in the page's main frame, made once per document. */
  world(): Promise<number> {
    if (this.isolated === undefined) {
      const session = this.session;
      const world = (async () => {
        const { frameTree } = await session.send('Page.getFrameTree');
        const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD_NAME, grantUniveralAccess: false });
        return executionContextId;
      })();
      this.isolated = world;
      world.catch(() => {
        if (this.isolated === world) this.isolated = undefined;
      });
    }
    return this.isolated;
  }

  /** Calls a self-contained page function in the isolated world with JSON arguments and returns its JSON result. */
  async evaluate<A extends readonly unknown[], R>(fn: (...args: A) => R | Promise<R>, ...args: A): Promise<R> {
    const session = this.session;
    const contextId = await this.world();
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(thrown(exceptionDetails));
    return result.value as R;
  }
}
