import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { PageTarget } from '../../src/page.ts';
import { inDocument } from '../../src/locate.ts';
import { nodeId, Windows, type AppWindow } from '../../src/windows.ts';

/** The part of a page target the registry reads: its URL, whether it closed, and its close event. */
class FakePage extends EventEmitter {
  private closed = false;
  readonly address: string;
  generation = 0;

  constructor(address = 'file:///app/index.html') {
    super();
    this.address = address;
  }

  url(): string {
    return this.address;
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }
}

function open(windows: Windows, address?: string): { readonly page: FakePage; readonly serial: number } {
  const page = new FakePage(address);
  const window = windows.add(page as unknown as PageTarget);
  if (window === undefined) throw new Error('the page was not registered');
  return { page, serial: window.serial };
}

describe('Windows', () => {
  it('shows the first window the app opened, and one a later window does not take over', () => {
    const windows = new Windows();
    const first = open(windows);
    open(windows);
    expect(windows.current()?.serial).toBe(first.serial);
    expect(windows.open()).toHaveLength(2);
  });

  it('registers a page once, and never a closed one', () => {
    const windows = new Windows();
    const { page } = open(windows);
    expect(windows.add(page as unknown as PageTarget)).toBeUndefined();
    const closed = new FakePage();
    closed.close();
    expect(windows.add(closed as unknown as PageTarget)).toBeUndefined();
  });

  it('goes back to the window shown before when the shown one closes, else to the newest', () => {
    const windows = new Windows();
    const first = open(windows);
    const second = open(windows);
    const third = open(windows);
    windows.show(2);
    windows.show(1);
    second.page.close();
    expect(windows.current()?.serial).toBe(third.serial);
    third.page.close();
    expect(windows.current()?.serial).toBe(first.serial);
    first.page.close();
    expect(windows.current()).toBeUndefined();
    expect(() => windows.require()).toThrow(/no open window/);
  });

  it('leaves an inspector the app opened out of its windows', () => {
    const windows = new Windows();
    open(windows);
    open(windows, 'devtools://devtools/bundled/devtools_app.html');
    expect(windows.open()).toHaveLength(1);
  });

  it('binds a ref to the shown window only, so a node of another window is stale', () => {
    const windows = new Windows();
    const first = open(windows);
    const second = open(windows);
    const shown = windows.current()!;
    expect(windows.bind({ id: nodeId(shown, 0, 42), revision: '' })).toEqual({ window: shown, backendNodeId: 42 });
    expect(() => windows.bind({ id: `${second.serial}.0.42`, revision: '' })).toThrow(/not shown now/);
    expect(() => windows.bind({ id: 'window', revision: '' })).toThrow(/not a node of this app/);
    expect(first.serial).not.toBe(second.serial);
  });

  it('refuses a ref from a document the window has left, whose node numbers the next document reuses', () => {
    const windows = new Windows();
    const { page } = open(windows);
    const shown = windows.current()!;
    const before = nodeId(shown, page.generation, 7);
    page.generation += 1;
    expect(() => windows.bind({ id: before, revision: '' })).toThrow(/a document the window no longer shows/);
    expect(windows.bind({ id: nodeId(shown, page.generation, 7), revision: '' })).toEqual({ window: shown, backendNodeId: 7 });
  });

  it('refuses to close the only window, and a window that is not there', () => {
    const windows = new Windows();
    open(windows);
    expect(() => windows.closable(0)).toThrow(/only window/);
    expect(() => windows.closable(3)).toThrow(/has 1 window open/);
    open(windows);
    expect(windows.closable(1).serial).toBe(2);
  });

  it('keeps a crashed window marked until it loads again, and forgets everything when the app quits', () => {
    const windows = new Windows();
    const { page } = open(windows);
    const shown = windows.current()!;
    windows.markCrashed(page as unknown as PageTarget);
    expect(windows.isCrashed(shown)).toBe(true);
    windows.markLoaded(page as unknown as PageTarget);
    expect(windows.isCrashed(shown)).toBe(false);
    windows.clear();
    expect(windows.open()).toEqual([]);
    expect(windows.current()).toBeUndefined();
  });
});

describe('inDocument', () => {
  const windowAt = (page: { generation: number }): AppWindow => ({ page, serial: 1 }) as unknown as AppWindow;

  it('answers a read the document stayed under, and passes on its own failure', async () => {
    const page = { generation: 3 };
    expect(await inDocument(windowAt(page), 3, () => Promise.resolve('read'))).toBe('read');
    await expect(inDocument(windowAt(page), 3, () => Promise.reject(new Error('its own')))).rejects.toThrow('its own');
  });

  it('makes a read stale when the document changed under it, whether it answered or failed', async () => {
    const page = { generation: 3 };
    const navigate = <T>(outcome: () => Promise<T>) => (): Promise<T> => {
      page.generation += 1;
      return outcome();
    };
    await expect(inDocument(windowAt(page), 3, navigate(() => Promise.resolve('mixed')))).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    await expect(inDocument(windowAt(page), 4, navigate(() => Promise.reject(new Error('Cannot find context with specified id'))))).rejects.toMatchObject({ code: 'NODE_STALE' });
  });
});
