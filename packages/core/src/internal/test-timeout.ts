/** Changing the running test's timeout from inside it: `test.setTimeout(timeout)` and `test.slow()`. */

import { currentAttempt, type PublishedAttempt } from '../expect/attempt.ts';
import type { AttemptBudget } from '../run/budget.ts';
import type { PassOptions } from '../types.ts';
import { slowedBrand, suiteHookBrand } from './brands.ts';
import { CollectionError, TestError } from './errors.ts';
import { realmSlot } from './realm-slot.ts';
import { MAX_TIMER_MS } from './time.ts';

/** The calls that change a running test's or hook's timeout, as their errors name them. */
type TimeoutApi = 'test.setTimeout()' | 'test.slow()';

/** The next timeout from the one in force, in milliseconds. */
export type TimeoutUpdate = (currentMs: number) => number;

/**
 * What a published timeout setter did with an update: `set` moved the
 * timeout; `ended` changed nothing, because the timeout race of the test or
 * hook already settled; `teardown` changed nothing, because the code runs on
 * `cleanupTimeout`. Core words the refusals, naming the call that was made.
 */
export type TimeoutChange = 'set' | 'ended' | 'teardown';

/**
 * Code outside any test running now: a `beforeAll` or `afterAll` hook, or a
 * worker fixture's teardown. Only a `beforeAll` can have its timeout changed.
 */
export interface RunningSuiteHook {
  /** What runs, as a refusal names it: `an afterAll hook`. */
  readonly name: string;
  readonly budget: AttemptBudget;
  readonly assertionTimeout: number;
  readonly toPass: Readonly<Required<PassOptions>>;
  readonly recordSecondaryError?: (error: TestError) => void;
  /** Moves the hook's timeout to what `update` makes of it, and says what it did; core words any refusal. */
  readonly setTimeout?: (update: TimeoutUpdate) => TimeoutChange;
}

/** On `globalThis`, as the published attempt is: test modules share nothing else with the runner. */
const suiteHookSlot = realmSlot<RunningSuiteHook>(suiteHookBrand);

/** Returns the suite hook running outside a test attempt. */
export function runningSuiteHook(): RunningSuiteHook | undefined {
  return suiteHookSlot.get(globalThis);
}

/** Names `hook` as the running suite hook while `run` runs; one runs at a time per process. */
export async function inSuiteHook<T>(hook: RunningSuiteHook, run: () => Promise<T>): Promise<T> {
  suiteHookSlot.set(globalThis, hook);
  try {
    return await run();
  } finally {
    if (suiteHookSlot.get(globalThis) === hook) suiteHookSlot.delete(globalThis);
  }
}

/** The code running now whose timeout can change: a suite hook, else the published attempt. */
type RunningCode = { readonly hook: RunningSuiteHook; readonly attempt?: undefined } | { readonly hook?: undefined; readonly attempt: PublishedAttempt };

/** The running suite hook or attempt; outside both the call is a collection error saying what to use instead. */
function runningCode(outside: string): RunningCode {
  const hook = runningSuiteHook();
  if (hook !== undefined) return { hook };
  const attempt = currentAttempt();
  if (attempt === undefined) throw new CollectionError(outside);
  return { attempt };
}

/**
 * Moves the running code's timeout to what `update` makes of the one in
 * force. Where the attempt or hook publishes no way to change it (teardown
 * on `cleanupTimeout`, or a hosted session that runs no e2e test), or its
 * timeout race already settled, it is a test error naming `api`.
 */
function changeTimeout(code: RunningCode, update: TimeoutUpdate, api: TimeoutApi): void {
  const set = code.hook === undefined ? code.attempt.setTimeout : code.hook.setTimeout;
  const change = set?.(update) ?? (code.hook === undefined ? 'hosted' : 'teardown');
  if (change === 'set') return;
  if (change === 'ended') {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${api} cannot change the timeout from code left running after its test or hook ended: await the work the test or hook starts`,
    );
  }
  if (change === 'teardown') {
    const from = code.hook?.name ?? 'an afterEach hook or a fixture teardown';
    throw new TestError('INVALID_ARGUMENT', `${api} cannot change the timeout from ${from}: teardown runs on cleanupTimeout, not the test timeout`);
  }
  throw new TestError(
    'INVALID_ARGUMENT',
    `${api} changes an e2e test's timeout, and a hosted session runs none: your test runner owns the test timeout, and host.openSession({ timeout }) sets the session deadline`,
  );
}

/**
 * Gives the running test a timeout of `timeout` ms, counted from the start of
 * its attempt, the way a `{ timeout }` option is; in a `beforeAll` hook,
 * gives that hook a timeout counted from its start. Outside a test or hook
 * the call is a collection error pointing at the option.
 */
export function setRunningTestTimeout(timeout: unknown): void {
  const code = runningCode(
    'test.setTimeout(timeout) must be called inside a test body or a beforeEach or beforeAll hook; to set a test\'s timeout ahead of time, pass { timeout } as the test or describe option',
  );
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TestError('INVALID_ARGUMENT', `test.setTimeout() timeout must be a positive safe integer of milliseconds, got ${String(timeout)}`);
  }
  if (timeout > MAX_TIMER_MS) {
    throw new TestError('INVALID_ARGUMENT', `test.setTimeout() timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${timeout}`);
  }
  changeTimeout(code, () => timeout, 'test.setTimeout()');
}

/** How much `test.slow()` multiplies the timeout in force by, as Playwright's does. */
export const SLOW_FACTOR = 3;

/** The attempts and suite hooks already slowed, on `globalThis` so a second copy of the package sees them too. */
const slowedSlot = realmSlot<WeakSet<object>>(slowedBrand);

function slowed(): WeakSet<object> {
  let set = slowedSlot.get(globalThis);
  if (set === undefined) {
    set = new WeakSet();
    slowedSlot.set(globalThis, set);
  }
  return set;
}

/**
 * Triples the running test's timeout when `condition` holds, as
 * `test.slow()` does in Playwright: the timeout in force, so after
 * `test.setTimeout(10_000)` it is 30 s. Like Playwright's, it slows an
 * attempt once: a later call, from a `beforeEach` hook or the body, does
 * nothing, and a retry is a new attempt. In a `beforeAll` hook it triples
 * that hook's timeout, once. The result is capped at the longest timer Node
 * keeps. Outside a test or hook the call is a collection error, checked
 * before the condition so a misplaced `test.slow(false)` is caught too.
 */
export function slowRunningTest(condition: boolean): void {
  const code = runningCode(
    'test.slow() triples the running test\'s timeout and must be called inside a test body or a beforeEach or beforeAll hook; to give every test in a group more time, call test.slow() in a beforeEach hook, or pass { timeout } as the test or describe option',
  );
  if (!condition) return;
  const owner = code.hook ?? code.attempt;
  const done = slowed();
  if (done.has(owner)) {
    // Slowed already: change nothing, but still refuse where the timeout cannot change (teardown, a test that ended).
    changeTimeout(code, (currentMs) => currentMs, 'test.slow()');
    return;
  }
  changeTimeout(code, (currentMs) => Math.min(currentMs * SLOW_FACTOR, MAX_TIMER_MS), 'test.slow()');
  done.add(owner);
}
