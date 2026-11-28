import { describe, expect, it } from 'vitest';
import { Deadline, type OperationContext } from '@e2e-dev/core/engine';
import { withModifiers } from '../../src/actions.ts';
import { Budget } from '../../src/budget.ts';
import type { Session } from '../../src/cdp/connection.ts';
import { Keyboard } from '../../src/cdp/input.ts';
import { PageTarget } from '../../src/page.ts';
import type { AppWindow } from '../../src/windows.ts';

/** A window whose page answers each key event when the test lets it. */
function slowWindow(): { readonly window: AppWindow; readonly events: string[]; answer(): void } {
  const events: string[] = [];
  const waiting: (() => void)[] = [];
  const session = {
    send: (_method: string, params: { readonly type: string; readonly key: string }) => {
      events.push(`${params.type} ${params.key}`);
      return new Promise<object>((resolve) => void waiting.push(() => resolve({})));
    },
  } as unknown as Session;
  const window = { page: { keyboard: new Keyboard({ session }) } } as unknown as AppWindow;
  return { window, events, answer: () => waiting.shift()?.() };
}

function operation(signal: AbortSignal): OperationContext {
  return { signal, timeoutMs: 5000, runId: 'run', attemptId: 'attempt', origin: 'test' } as OperationContext;
}

describe('withModifiers', () => {
  it('holds the modifiers around the input and releases them in reverse', async () => {
    const { window, events, answer } = slowWindow();
    const answering = setInterval(answer, 1);
    await withModifiers(new Budget(operation(new AbortController().signal), 'press'), window, ['Control', 'Shift'], () => window.page.keyboard.press('Enter'));
    clearInterval(answering);
    expect(events).toEqual(['rawKeyDown Control', 'rawKeyDown Shift', 'rawKeyDown Enter', 'keyUp Enter', 'keyUp Shift', 'keyUp Control']);
  });

  it('sends no key after a modifier the app took too long to answer, and releases the modifier', async () => {
    const { window, events, answer } = slowWindow();
    const cancel = new AbortController();
    const pressed = withModifiers(new Budget(operation(cancel.signal), 'press'), window, ['Meta'], () => window.page.keyboard.press('Enter')).then(() => undefined, (error: unknown) => error);
    // The caller stops waiting while the modifier is unanswered; its answer arrives afterwards.
    cancel.abort();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    answer();
    expect(await pressed).toMatchObject({ code: 'CANCELLED' });
    expect(events).toEqual(['rawKeyDown Meta', 'keyUp Meta']);
  });

  it('starts the next gesture only once a cancelled one has released its modifier', async () => {
    const events: string[] = [];
    const waiting: (() => void)[] = [];
    const session = {
      send: (_method: string, params: { readonly type: string; readonly key?: string; readonly modifiers: number }) => {
        events.push(`${params.type} ${params.key ?? ''} ${params.modifiers}`);
        return new Promise<object>((resolve) => void waiting.push(() => resolve({})));
      },
    } as unknown as Session;
    const page = new PageTarget('target', session, 'about:blank');
    const window = { page } as unknown as AppWindow;
    const cancel = new AbortController();
    const chord = page.exclusive(() => withModifiers(new Budget(operation(cancel.signal), 'press'), window, ['Meta'], () => page.keyboard.press('Enter')), new Deadline(50)).catch(() => undefined);
    // The modifier is out, unanswered, when the caller stops waiting.
    await new Promise((resolve) => setTimeout(resolve, 1));
    cancel.abort();
    const tap = page.exclusive(() => page.mouse.move(1, 1), new Deadline(50));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['rawKeyDown Meta 4']);
    const answering = setInterval(() => waiting.shift()?.(), 1);
    await Promise.all([chord, tap]);
    clearInterval(answering);
    expect(events).toEqual(['rawKeyDown Meta 4', 'keyUp Meta 0', 'mouseMoved  0']);
  });

  it('lets the next gesture through, with nothing held, once the renderer that owed an answer crashed', async () => {
    const events: string[] = [];
    const waiting: (() => void)[] = [];
    const session = {
      send: (_method: string, params: { readonly type: string; readonly modifiers: number }) => {
        events.push(`${params.type} ${params.modifiers}`);
        return new Promise<object>((resolve) => void waiting.push(() => resolve({})));
      },
    } as unknown as Session;
    const page = new PageTarget('target', session, 'about:blank');
    // Never answered: the renderer is gone.
    void page.exclusive(() => page.keyboard.down('Meta'), new Deadline(50));
    await new Promise((resolve) => setTimeout(resolve, 1));
    page.crashed();
    const moved = page.exclusive(() => page.mouse.move(1, 1), new Deadline(50));
    await new Promise((resolve) => setTimeout(resolve, 1));
    waiting.at(-1)?.();
    await moved;
    expect(events).toEqual(['rawKeyDown 4', 'mouseMoved 0']);
    expect(page.generation).toBe(1);
  });

  it('gives up its turn a moment after its operation ended, when the page never answers it', async () => {
    const session = { send: () => new Promise<object>(() => undefined) } as unknown as Session;
    const page = new PageTarget('target', session, 'about:blank');
    void page.exclusive(() => page.keyboard.down('Shift'), new Deadline(1));
    let ran = false;
    const next = page.exclusive(() => {
      ran = true;
      return Promise.resolve();
    }, new Deadline(5000));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ran).toBe(false);
    await next;
    expect(ran).toBe(true);
  }, 5000);

  it('lets no gesture past one still holding input, however soon a gesture queued behind it gives up', async () => {
    const session = { send: () => new Promise<object>(() => undefined) } as unknown as Session;
    const page = new PageTarget('target', session, 'about:blank');
    let release: () => void = () => undefined;
    const order: string[] = [];
    const holding = page.exclusive(() => new Promise<void>((resolve) => void (release = resolve)).then(() => void order.push('first')), new Deadline(5000));
    const impatient = page.exclusive(() => Promise.resolve(void order.push('second')), new Deadline(1));
    const third = page.exclusive(() => Promise.resolve(void order.push('third')), new Deadline(5000));
    // Long past the second gesture's own deadline and grace: the first still holds its turn.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(order).toEqual([]);
    release();
    await Promise.all([holding, impatient, third]);
    expect(order).toEqual(['first', 'second', 'third']);
  }, 5000);
});
