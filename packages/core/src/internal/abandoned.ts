/**
 * Work left running that nobody awaits: a test's steps and polls once its
 * phase returned, a test filter's call once its timeout passed or an
 * interrupt cut it short, and a reporter's `onRunFinished` once its timeout
 * passed or the run was forced to stop.
 */

import { abandonedRejectionsBrand } from './brands.ts';
import { realmSlot } from './realm-slot.ts';

/** Whether the process stopped waiting for work that may still hold it open. */
let workLeftBehind = false;

const abandonedSlot = realmSlot<WeakSet<object>>(abandonedRejectionsBrand);

/**
 * What abandoned work rejected with. The promise the test holds rejects with
 * the same value, and nobody awaits it. Held on `globalThis`: the step may
 * be one of a `launch()` session from another copy of this package than the
 * runner's, which is the copy that meets the rejection.
 */
function abandonedRejections(): WeakSet<object> {
  let known = abandonedSlot.get(globalThis);
  if (known === undefined) {
    known = new WeakSet();
    abandonedSlot.set(globalThis, known);
  }
  return known;
}

/** Records `cause` as the rejection of work already failed as not awaited. */
export function markAbandonedRejection(cause: unknown): void {
  if (typeof cause === 'object' && cause !== null) abandonedRejections().add(cause);
}

/**
 * Whether an unhandled rejection is abandoned work's: already recorded as
 * `STEP_NOT_AWAITED`, reaching the process only because the promise the
 * test did not await rejected with it. Such a rejection is not a fault.
 */
export function isAbandonedRejection(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && abandonedRejections().has(cause);
}

/** Points `error` at the frames of `stack`, keeping its own name and message as the first line. */
export function relocateStack(error: Error, stack: string | undefined): void {
  if (stack === undefined) return;
  const frames = stack.split('\n').slice(1).join('\n');
  error.stack = `${error.name}: ${error.message}\n${frames}`;
}

/**
 * Records that the process stopped waiting for work that may ignore its
 * signal, such as a test filter's call or a reporter's `onRunFinished` past
 * its timeout or one a watch key cancelled, so the CLI exits once its output
 * is out instead of waiting for that work to settle.
 */
export function leaveWorkBehind(): void {
  workLeftBehind = true;
}

/** Whether the process stopped waiting for work that may still hold it open. */
export function leftWorkBehind(): boolean {
  return workLeftBehind;
}
