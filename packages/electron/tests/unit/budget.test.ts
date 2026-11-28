import { EngineError, sleep, type OperationContext } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { answerWithin, Budget, withBudget } from '../../src/budget.ts';

function operation(timeoutMs: number, signal: AbortSignal = new AbortController().signal): OperationContext {
  return { signal, timeoutMs, runId: 'run', attemptId: 'attempt' } as OperationContext;
}

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  const error = await work.then(() => undefined, (cause: unknown) => cause);
  return error instanceof EngineError ? error.code : undefined;
}

describe('Budget', () => {
  it('reports a timeout before any input as one the harness may retry around', async () => {
    expect(await codeOf(withBudget(operation(20), 'tap', () => sleep(200)))).toBe('OPERATION_TIMEOUT');
  });

  it('reports a timeout after an input was sent as one that may have reached the app', async () => {
    const work = withBudget(operation(20), 'tap', async (budget) => {
      await budget.send(() => Promise.resolve());
      await sleep(200);
    });
    expect(await codeOf(work)).toBe('ACTION_MAY_HAVE_COMMITTED');
  });

  it('sends nothing once its time ran out or the caller cancelled', async () => {
    const spent = new Budget(operation(0), 'type');
    let sent = false;
    expect(() => spent.send(async () => { sent = true; })).toThrow(/timed out after 0ms/);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(() => new Budget(operation(1000, cancelled.signal), 'type').send(async () => { sent = true; })).toThrow(/was cancelled/);
    expect(sent).toBe(false);
  });

  it('ends its waits a little before its own end, so a wait says what it waited for', () => {
    const budget = new Budget(operation(5000), 'tap');
    expect(budget.deadline.remaining() - budget.waits.remaining()).toBeGreaterThanOrEqual(249);
    const short = new Budget(operation(100), 'tap');
    expect(short.deadline.remaining() - short.waits.remaining()).toBeLessThanOrEqual(11);
  });

  it('translates a vanished node by whether input went out', async () => {
    const gone = (): Promise<never> => Promise.reject(new Error('No node with given id found'));
    expect(await codeOf(withBudget(operation(1000), 'fill', gone))).toBe('NODE_STALE');
    expect(await codeOf(withBudget(operation(1000), 'fill', (budget) => budget.send(gone)))).toBe('ACTION_MAY_HAVE_COMMITTED');
  });
});

describe('answerWithin', () => {
  it('answers undefined for a failure or a late answer, and the value otherwise', async () => {
    expect(await answerWithin(Promise.resolve(7), 50)).toBe(7);
    expect(await answerWithin(Promise.reject(new Error('gone')), 50)).toBeUndefined();
    expect(await answerWithin(sleep(200).then(() => 7), 10)).toBeUndefined();
  });
});
