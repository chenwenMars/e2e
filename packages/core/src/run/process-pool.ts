/**
 * Who starts the app processes an attempt declares. `UNSHARED` starts each
 * one for the attempt alone, as a run does; `SharedProcesses` hands every
 * attempt that declares the same process one instance of it, so live
 * sessions on one dev server share it. Either way the attempt starts and
 * stops through `startDeclaredProcesses`: the pool only decides whether a
 * process is started or reused. `e2e mcp` also uses a separate
 * `SharedProcesses` to share services across sessions.
 */

import { InfrastructureError } from '../internal/errors.ts';
import type { AppProcesses } from './managed-process.ts';

export interface ProcessPool {
  /**
   * One hold on the process `key` names, released by the returned `stop`.
   * `start` starts a fresh instance under the signal it is given: the
   * attempt's `signal`, or for a shared process one that aborts once no
   * attempt waits on the start any more.
   */
  acquire(key: string, start: (signal: AbortSignal) => Promise<AppProcesses>, signal: AbortSignal): Promise<AppProcesses>;
}

/** Every attempt starts its own processes, under its own signal. */
export const UNSHARED: ProcessPool = { acquire: (_key, start, signal) => start(signal) };

interface SharedEntry<Held extends AppProcesses> {
  users: number;
  /** Set once `start` has actually been called after any earlier stop finished draining. */
  startedWork: boolean;
  /** Set once the start settled: from then on an attempt giving up abandons nothing. */
  settled: boolean;
  /** Attempts still waiting on the start whose own signal has not aborted. */
  waiting: number;
  /** Aborts the start once no attempt waits on it any more. */
  readonly abandon: AbortController;
  readonly started: Promise<Held>;
}

/**
 * One instance per process across attempts: the first attempt that declares
 * one starts it, and it stops when the last attempt holding it releases it,
 * so closing one live session never takes the dev server out from under
 * another. A shared start outlives the attempt that began it while another
 * still waits on it, and is aborted once every attempt waiting on it gave up
 * (a cancelled request, a server shutting down), so a hung start never
 * leaves what it started behind; the next attempt starts it afresh. Its
 * notices and trace spans still go to the attempt that started it. An
 * attempt that arrives while a process stops starts a fresh one once the
 * stop is done.
 */
export class SharedProcesses<Held extends AppProcesses = AppProcesses> implements ProcessPool {
  private readonly entries = new Map<string, SharedEntry<Held>>();
  /** Stops still running, and starts abandoned, by key. */
  private readonly draining = new Map<string, Promise<unknown>>();

  /** Wait on cancellation when the caller still holds dependencies of the process it abandons. */
  constructor(private readonly options: { readonly waitForAbandonedStart?: boolean } = {}) {}

  async acquire(key: string, start: (signal: AbortSignal) => Promise<Held>, signal: AbortSignal): Promise<Held> {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      // A stop that failed has still ended its process: the fresh start goes ahead.
      const drained = (this.draining.get(key) ?? Promise.resolve()).catch(() => undefined);
      const abandon = new AbortController();
      const created: SharedEntry<Held> = {
        users: 0,
        startedWork: false,
        settled: false,
        waiting: 0,
        abandon,
        started: drained.then(async () => {
          if (abandon.signal.aborted) {
            throw new InfrastructureError('CANCELLED', 'gave up waiting on a shared process start');
          }
          created.startedWork = true;
          try {
            const held = await start(abandon.signal);
            created.settled = true;
            return held;
          } catch (cause) {
            created.settled = true;
            this.forget(key, created);
            throw cause;
          }
        }),
      };
      // An abandoned start settles without callers; keep the rejection handled.
      created.started.catch(() => undefined);
      this.entries.set(key, created);
      entry = created;
    }
    const shared = entry;
    shared.users += 1;
    shared.waiting += 1;
    let abandoned: Promise<void> | undefined;
    const giveUp = (): void => {
      shared.waiting -= 1;
      if (shared.waiting > 0 || shared.settled) return;
      shared.abandon.abort();
      this.forget(key, shared);
      // Nothing was started yet while waiting on an earlier drain: keep the prior drain entry intact.
      if (!shared.startedWork) return;
      // A start that completes despite the abort has nobody left to stop it: it stops here.
      const cleanup = shared.started.then(
        (started) => started.stop(() => undefined),
        () => undefined,
      );
      const tracked = cleanup.finally(() => {
        if (this.draining.get(key) === tracked) {
          this.draining.delete(key);
        }
      });
      abandoned = tracked;
      this.draining.set(key, tracked);
    };
    if (signal.aborted) giveUp();
    else signal.addEventListener('abort', giveUp, { once: true });

    let processes: Held;

    try {
      processes = await Promise.race([shared.started, cancelled(signal, shared.started)]);
      if (abandoned !== undefined || shared.abandon.signal.aborted) {
        throw new InfrastructureError('CANCELLED', 'gave up waiting on a shared process start');
      }
    } catch (cause) {
      if (abandoned !== undefined) {
        shared.users -= 1;
        if (this.options.waitForAbandonedStart) {
          await abandoned.catch(() => undefined);
        }
        throw cause;
      }
      // The start can settle a tick before this attempt's abort wins the race: nothing was
      // abandoned then, so the attempt gives back its hold like any other, or nobody stops the process.
      const held = shared.settled && !shared.abandon.signal.aborted ? await shared.started.catch(() => undefined) : undefined;
      if (held === undefined) {
        shared.users -= 1;
        throw cause;
      }
      const released = this.release(key, shared, held, () => undefined).catch(() => undefined);
      if (this.options.waitForAbandonedStart) {
        await released;
      }
      throw cause;
    } finally {
      signal.removeEventListener('abort', giveUp);
      if (!signal.aborted) shared.waiting -= 1;
    }

    return { ...processes, stop: (onFailure) => this.release(key, shared, processes, onFailure) };
  }

  /** Gives back one hold on `entry`; the last one stops the process and keeps the stop in `draining` until it is done. */
  private async release(key: string, entry: SharedEntry<Held>, processes: Held, onFailure: Parameters<Held['stop']>[0]): Promise<void> {
    entry.users -= 1;

    if (entry.users > 0) {
      return;
    }

    this.forget(key, entry);

    const stopping = processes.stop(onFailure);

    this.draining.set(key, stopping);

    try {
      await stopping;
    } finally {
      if (this.draining.get(key) === stopping) {
        this.draining.delete(key);
      }
    }
  }

  /**
   * Resolves once every stop still running, and every abandoned start's
   * cleanup, has finished, including ones that begin while it waits. A
   * server that is shutting down waits here so it doesn't exit while a
   * process or service is still being stopped.
   */
  async drained(): Promise<void> {
    const waited = new Set<Promise<unknown>>();

    for (;;) {
      const pending = [...this.draining.values()].filter((stopping) => !waited.has(stopping));

      if (pending.length === 0) {
        return;
      }

      await Promise.allSettled(pending);

      for (const stopping of pending) {
        waited.add(stopping);
      }
    }
  }

  /** Drops `entry` from the pool, unless a fresh start already took its key. */
  private forget(key: string, entry: SharedEntry<Held>): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}

/** Rejects with `CANCELLED` once `signal` aborts; settles nothing otherwise, and stops listening once `started` settles. */
function cancelled(signal: AbortSignal, started: Promise<unknown>): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => reject(new InfrastructureError('CANCELLED', 'gave up waiting on a shared process start'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    const forget = (): void => signal.removeEventListener('abort', abort);
    started.then(forget, forget);
  });
}
