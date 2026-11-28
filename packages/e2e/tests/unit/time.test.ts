import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  budgetText,
  checkStepTimeout,
  Deadline,
  stepTimeout,
  POLL_INTERVAL_MS,
  pollCondition,
  pollReads,
  ReadWindow,
  sleep,
  StepDeadline,
  withTimeout,
} from '@e2e-dev/core/lib/internal/time';
import { E2EError } from '@e2e-dev/core/lib/internal/errors';
import { EngineError } from '@e2e-dev/core/lib/engine/contract';

afterEach(() => {
  vi.useRealTimers();
});

describe('checkStepTimeout', () => {
  it('takes no timeout, 0, and finite positive milliseconds', () => {
    for (const timeout of [undefined, 0, 1, 2.5, 60_000]) expect(() => checkStepTimeout(timeout, 'tap')).not.toThrow();
  });

  it('refuses negative, NaN, infinite, and non-number timeouts as INVALID_ARGUMENT', () => {
    for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100', null]) {
      expect(() => checkStepTimeout(timeout, 'tap')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('tap timeout') }));
    }
  });

  it('gives withTimeout no timer for the infinite budget of 0', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>((resolve) => setTimeout(() => resolve('done'), 60_000)), stepTimeout(0, 'tap')!, () => new Error('timed out'));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toBe('done');
  });

  it('turns 0 into an infinite budget, which a phase deadline caps', () => {
    expect(stepTimeout(0, 'tap')).toBe(Number.POSITIVE_INFINITY);
    expect(stepTimeout(250, 'tap')).toBe(250);
    expect(stepTimeout(undefined, 'tap')).toBeUndefined();
    const phase = new Deadline(1000, 5000);
    expect(Deadline.min(new Deadline(stepTimeout(0, 'tap')!, 5000), phase)).toBe(phase);
  });
});

describe('Deadline', () => {
  it('computes remaining budget and never goes negative', () => {
    const deadline = new Deadline(1000, 5000);
    expect(deadline.endsAt).toBe(6000);
    expect(deadline.remaining(5000)).toBe(1000);
    expect(deadline.remaining(5900)).toBe(100);
    expect(deadline.remaining(7000)).toBe(0);
    expect(deadline.expired(5999)).toBe(false);
    expect(deadline.expired(6000)).toBe(true);
  });
});

describe('StepDeadline', () => {
  it('ends at its timeout or its cap, whichever is sooner, and counts elapsed time from its start either way', () => {
    const own = new StepDeadline(1000, new Deadline(9000, 0), 5000);
    expect(own.endsAt).toBe(6000);
    expect(own.elapsed(6000)).toBe(1000);
    const capped = new StepDeadline(1000, new Deadline(5400, 0), 5000);
    expect(capped.endsAt).toBe(5400);
    expect(capped.elapsed(5400)).toBe(400);
    const unbounded = new StepDeadline(Number.POSITIVE_INFINITY, new Deadline(5400, 0), 5000);
    expect(unbounded.endsAt).toBe(5400);
    const spent = new StepDeadline(1000, new Deadline(4000, 0), 5000);
    expect(spent.expired(5000)).toBe(true);
  });
});

describe('budgetText', () => {
  it('names a budget exactly, in the largest unit that divides it', () => {
    expect([50, 1000, 1499, 1500, 30_000, 60_000, 90_500, 300_000].map(budgetText)).toEqual(['50ms', '1s', '1499ms', '1500ms', '30s', '1m', '90500ms', '5m']);
  });
});

describe('sleep', () => {
  it('resolves after the given duration', async () => {
    vi.useFakeTimers();
    const promise = sleep(500);
    await vi.advanceTimersByTimeAsync(499);
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(10, controller.signal)).rejects.toMatchObject({
      category: 'infrastructure',
      code: 'CANCELLED',
    });
  });

  it('rejects mid-sleep on abort and clears the timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(10_000, controller.signal);
    const assertion = expect(promise).rejects.toBeInstanceOf(E2EError);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes its abort listener after resolving', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = sleep(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
});

describe('pollCondition', () => {
  function makeOptions(overrides: {
    negated?: boolean;
    timeoutMs?: number;
    evaluate: () => Promise<boolean | undefined>;
  }) {
    return {
      deadline: new Deadline(overrides.timeoutMs ?? 5000),
      signal: new AbortController().signal,
      negated: overrides.negated ?? false,
      evaluate: overrides.evaluate,
      onTimeout: () => new Error('poll timed out'),
    };
  }

  it('returns once the positive condition holds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = pollCondition(
      makeOptions({
        evaluate: async () => {
          calls += 1;
          return calls >= 3;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await promise;
    expect(calls).toBe(3);
  });

  it('sees a state that arrives between poll ticks no later than a poll every tick would', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readsAt: number[] = [];
    const promise = pollCondition(
      makeOptions({
        evaluate: async () => {
          readsAt.push(Date.now() - startedAt);
          return Date.now() - startedAt >= 290;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(readsAt).toEqual([0, 20, 50, 100, 200, 300]);
  });

  it('reads a poll tick apart when every read outlasts the early reads', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readsAt: number[] = [];
    const promise = pollCondition(
      makeOptions({
        evaluate: async () => {
          readsAt.push(Date.now() - startedAt);
          await new Promise((resolve) => setTimeout(resolve, 300));
          return readsAt.length === 3;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(readsAt).toEqual([0, 400, 800]);
  });

  it('throws the caller error at the deadline', async () => {
    vi.useFakeTimers();
    const promise = pollCondition(
      makeOptions({ timeoutMs: 350, evaluate: async () => false }),
    );
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('takes its last read at the deadline, not a poll tick past it', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readsAt: number[] = [];
    const promise = pollCondition(
      makeOptions({
        timeoutMs: 350,
        evaluate: async () => {
          readsAt.push(Date.now() - startedAt);
          return Date.now() - startedAt > 350;
        },
      }),
    );
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    // Early reads at 20 and 50 ms, then every poll tick from the start.
    expect(readsAt).toEqual([0, 20, 50, 100, 200, 300, 350]);
  });

  it('negated: passes on the first read that sees the negation', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let calls = 0;
    await pollCondition(
      makeOptions({
        negated: true,
        evaluate: async () => {
          calls += 1;
          return false;
        },
      }),
    );
    expect(calls).toBe(1);
    expect(Date.now() - startedAt).toBe(0);
  });

  it('negated: reads while the condition holds and passes on the read that sees it gone', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readsAt: number[] = [];
    let resolvedAt: number | undefined;
    const promise = pollCondition(
      makeOptions({
        negated: true,
        evaluate: async () => {
          readsAt.push(Date.now() - startedAt);
          return Date.now() - startedAt < 290;
        },
      }),
    ).then(() => {
      resolvedAt = Date.now() - startedAt;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(readsAt).toEqual([0, 20, 50, 100, 200, 300]);
    expect(resolvedAt).toBe(300);
  });

  it('negated: an evaluation that cannot answer keeps the poll waiting', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = pollCondition(
      makeOptions({
        negated: true,
        evaluate: async () => {
          calls += 1;
          return calls < 3 ? undefined : false;
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await promise;
    expect(calls).toBe(3);
  });

  it('negated: fails at the deadline while the condition holds, its last read at the deadline', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const readsAt: number[] = [];
    const promise = pollCondition(
      makeOptions({
        negated: true,
        timeoutMs: 350,
        evaluate: async () => {
          readsAt.push(Date.now() - startedAt);
          return true;
        },
      }),
    );
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(readsAt).toEqual([0, 20, 50, 100, 200, 300, 350]);
  });

  it('stops polling when the signal aborts between evaluations', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const promise = pollCondition({
      deadline: new Deadline(60_000),
      signal: controller.signal,
      negated: false,
      evaluate: async () => false,
      onTimeout: () => new Error('unused'),
    });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS / 2);
    controller.abort();
    await assertion;
  });

  it('ends on the last sample when the deadline cuts a read off, and fails on a read the deadline did not cut', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const deadline = new Deadline(350);
    let calls = 0;
    const promise = pollCondition({
      deadline,
      signal: new AbortController().signal,
      negated: false,
      evaluate: async () => {
        calls += 1;
        if (deadline.remaining() > 0) return false;
        throw cut;
      },
      onTimeout: () => new Error('poll timed out'),
    });
    const assertion = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(calls).toBeGreaterThan(1);

    const early = pollCondition({
      deadline: new Deadline(5_000),
      signal: new AbortController().signal,
      negated: false,
      evaluate: async () => { throw cut; },
      onTimeout: () => new Error('poll timed out'),
    });
    await expect(early).rejects.toBe(cut);
  });

  it('lets the last read run past the deadline by the longest read the poll finished, up to the window cap', async () => {
    vi.useFakeTimers();
    const deadline = new Deadline(350);
    const timeouts: number[] = [];
    let calls = 0;
    const promise = pollReads({
      deadline,
      reads: new ReadWindow(deadline, new Deadline(400)),
      signal: new AbortController().signal,
      negated: false,
      evaluate: (reads) =>
        reads.read(async (timeoutMs) => {
          timeouts.push(timeoutMs);
          calls += 1;
          const readDuration = calls === 1 ? 200 : 50;
          await withTimeout(sleep(readDuration), timeoutMs, () => new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false }));
          return calls === 2;
        }),
      onTimeout: () => new Error('poll timed out'),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeUndefined();
    expect(timeouts).toEqual([350, 100]);
  });

  it('shares the extra time past the deadline across the reads that run in it', async () => {
    vi.useFakeTimers();
    const deadline = new Deadline(100);
    const reads = new ReadWindow(deadline, new Deadline(10_000));
    const slow = reads.read(() => sleep(300));
    await vi.advanceTimersByTimeAsync(300);
    await slow;
    expect(reads.timeoutMs()).toBe(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(reads.timeoutMs()).toBe(50);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads.timeoutMs()).toBe(1);
  });

  it('judges a cut-off read by when that read started, not when its sample did', async () => {
    vi.useFakeTimers();
    const deadline = new Deadline(1_000);
    const timedOut = () => new EngineError('OPERATION_TIMEOUT', 'read timed out', { retryable: false });
    let samples = 0;
    const promise = pollReads({
      deadline,
      reads: new ReadWindow(deadline, new Deadline(10_000)),
      signal: new AbortController().signal,
      negated: false,
      evaluate: async (reads) => {
        samples += 1;
        if (samples === 1) {
          await reads.read(() => sleep(300));
          return false;
        }
        // The sample starts with 600 ms left; its second read starts with 100.
        await reads.read(() => sleep(500));
        await reads.read((timeoutMs) => withTimeout(sleep(10_000), timeoutMs, timedOut));
        return true;
      },
      onTimeout: () => new Error('poll timed out'),
    });
    const settled = expect(promise).rejects.toThrow('poll timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
  });

  it('negated: passes on a last read the window let run past the deadline', async () => {
    vi.useFakeTimers();
    const deadline = new Deadline(3_000);
    let samples = 0;
    const promise = pollReads({
      deadline,
      reads: new ReadWindow(deadline, new Deadline(10_000)),
      signal: new AbortController().signal,
      negated: true,
      evaluate: async (reads) => {
        samples += 1;
        // The first read sees the condition; the second starts 400 ms before the deadline and ends 1.1 s past it.
        await reads.read(() => sleep(samples === 1 ? 2_500 : 1_500));
        return samples === 1;
      },
      onTimeout: () => new Error('negation timed out'),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();
    expect(samples).toBe(2);
  });

  it('ends on a read cut off within the longest read time of the deadline, and fails on one that hung with more left', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const poll = (timeoutMs: number) => {
      const deadline = new Deadline(timeoutMs);
      let calls = 0;
      return pollReads({
        deadline,
        reads: new ReadWindow(deadline),
        signal: new AbortController().signal,
        negated: false,
        evaluate: (reads) =>
          reads.read(async () => {
            calls += 1;
            await sleep(300);
            if (calls === 1) return false;
            throw cut;
          }),
        onTimeout: () => new Error('poll timed out'),
      });
    };
    // The second read starts with 200 ms left: under the 300 ms the first took, so the deadline cut it.
    const within = expect(poll(600)).rejects.toThrow('poll timed out');
    // With 600 ms left, more than any read took, the read hung.
    const hung = expect(poll(1_000)).rejects.toBe(cut);
    await vi.advanceTimersByTimeAsync(2_000);
    await within;
    await hung;
  });

  it('negated: keeps a read that hung most of the wait a failure', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const deadline = new Deadline(2_000);
    let calls = 0;
    const promise = pollCondition({
      deadline,
      signal: new AbortController().signal,
      negated: true,
      evaluate: async () => {
        calls += 1;
        if (calls === 1) return true;
        // The page froze: this read takes the rest of the wait and is cut at its deadline.
        await sleep(deadline.remaining());
        throw cut;
      },
      onTimeout: () => new Error('poll timed out'),
    });
    const assertion = expect(promise).rejects.toBe(cut);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('negated: a read the deadline cut off ends the poll as a timeout, the read its cause', async () => {
    vi.useFakeTimers();
    const cut = new EngineError('OPERATION_TIMEOUT', 'locate timed out', { retryable: false });
    const deadline = new Deadline(1_950);
    const promise = pollCondition({
      deadline,
      signal: new AbortController().signal,
      negated: true,
      // Still there on every read; the read that starts with under a poll tick left is cut.
      evaluate: async () => {
        if (deadline.remaining() < POLL_INTERVAL_MS) throw cut;
        return true;
      },
      onTimeout: (cause) => Object.assign(new Error('poll timed out'), { cause }),
    });
    const assertion = expect(promise).rejects.toMatchObject({ message: 'poll timed out', cause: cut });
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });
});

describe('withTimeout', () => {
  it('returns the resolved value and clears the timer', async () => {
    vi.useFakeTimers();
    const value = await withTimeout(Promise.resolve(7), 1000, () => new Error('unused'));
    expect(value).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('throws the built error when the promise does not settle in time', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const promise = withTimeout(never, 250, () => new Error('too slow'));
    const assertion = expect(promise).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});
