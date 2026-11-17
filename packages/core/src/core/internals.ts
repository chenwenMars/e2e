/**
 * What `@e2e-dev/core/agent` reads off a session it did not create: the attempt
 * behind it, the host's config, and the session's close hooks. Module-private
 * state behind a WeakMap, so a session object carries none of it.
 */

import { MODEL_UNREACHABLE_CODES } from '../agent/error.ts';
import type { AttemptSettlement, SurvivedFailure } from '../cache/context.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { TestError } from '../internal/errors.ts';
import type { StandaloneAttempt } from '../run/standalone-attempt.ts';
import type { StepProgress, StepRecorder } from '../run/steps.ts';

export interface SessionInternals {
  readonly attempt: StandaloneAttempt;
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  /** Run in order when the session closes, before its attempt ends: an agent settles its replay cache here. */
  readonly closers: (() => Promise<void>)[];
  /** How the session's steps went, as the replay cache settles what its agents recorded; undefined once it was cancelled. */
  readonly settlement: () => AttemptSettlement | undefined;
}

/**
 * Watches a session's steps for the agent steps that failed. A test ends at
 * its failure; a program may catch one and go on. So each failure settles
 * only the recordings it found unconfirmed, as a run's failure does: dropped,
 * unless only a missing model explains it. Recordings made after it are
 * confirmed by the checks that pass after them.
 */
export class FailureWatch {
  private steps: StepRecorder | undefined;
  private readonly failures: SurvivedFailure[] = [];

  /** The `onProgress` hook the session's attempt reports its steps to. */
  readonly onProgress = (progress: StepProgress): void => {
    // Only an agent step's failure implicates recordings: a program catches a locator's timeout on purpose, to branch.
    if (progress.phase !== 'end' || progress.kind !== 'agent' || progress.status === 'passed' || this.steps === undefined) return;
    const code = progress.error?.code;
    this.failures.push({
      from: this.steps.lastVerifiedStepIndex,
      through: progress.identity?.stepIndex ?? Number.MAX_SAFE_INTEGER,
      implicates: code === undefined || !MODEL_UNREACHABLE_CODES.has(code),
    });
  };

  watch(steps: StepRecorder): void {
    this.steps = steps;
  }

  /**
   * How the session's recordings settle when it closes. A close is not a
   * verdict: a program may end, or be interrupted, between a replay and the
   * check after it, so what no check confirmed is left as it was, neither
   * written nor evicted.
   */
  settlement(steps: StepRecorder): AttemptSettlement {
    return { lastVerifiedStepIndex: steps.lastVerifiedStepIndex, implicatesUnconfirmed: false, survived: this.failures };
  }
}

const sessions = new WeakMap<object, SessionInternals>();

/** Records the internals of a session `launch` created. */
export function registerSession(session: object, internals: SessionInternals): void {
  sessions.set(session, internals);
}

/** The internals of a session `launch` created; anything else is `INVALID_ARGUMENT`. */
export function sessionInternals(session: unknown, api: string): SessionInternals {
  const internals = typeof session === 'object' && session !== null ? sessions.get(session) : undefined;
  if (internals === undefined) throw new TestError('INVALID_ARGUMENT', `${api} takes a session from host.newSession()`);
  return internals;
}
