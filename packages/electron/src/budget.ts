/**
 * One operation's budget: its deadline, the check every input passes, and
 * whether any input went out, which decides how a failure is reported.
 */

import { Deadline, EngineError, raceAbort, withTimeout, type OperationContext } from '@e2e-dev/core/engine';
import { translate } from './errors.ts';

/** How long before the operation's end a wait inside it gives up, at most. */
const WAIT_MARGIN_MS = 250;

export class Budget {
  readonly operation: OperationContext;
  readonly label: string;
  /** The operation's end. */
  readonly deadline: Deadline;
  /**
   * The deadline a wait inside the operation gives up at: a little before
   * the operation's own, so the wait reports what it waited for rather than a
   * bare timeout.
   */
  readonly waits: Deadline;
  private sent = false;

  constructor(operation: OperationContext, label: string) {
    this.operation = operation;
    this.label = label;
    this.deadline = new Deadline(operation.timeoutMs);
    this.waits = new Deadline(Math.max(0, operation.timeoutMs - Math.min(WAIT_MARGIN_MS, operation.timeoutMs / 10)));
  }

  /** Throws once the operation ended: its caller stopped waiting, and nothing more may reach the app. */
  check(): void {
    if (this.operation.signal.aborted) throw new EngineError('CANCELLED', `${this.label} was cancelled`, { retryable: false });
    if (this.deadline.expired()) throw this.timedOut();
  }

  /**
   * Sends one input, through the check. From here on a timeout or a vanished
   * node is `ACTION_MAY_HAVE_COMMITTED`, which the harness never retries.
   */
  send<T>(input: () => Promise<T>): Promise<T> {
    this.check();
    this.sent = true;
    return input();
  }

  /** Runs `work` within the budget and the operation's signal, its failures translated into engine errors. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await raceAbort(() => withTimeout(work(), Math.max(1, this.deadline.remaining()), () => this.timedOut()), this.operation.signal, this.label);
    } catch (cause) {
      throw translate(cause, this.label, this.sent);
    }
  }

  private timedOut(): EngineError {
    return new EngineError('OPERATION_TIMEOUT', `${this.label} timed out after ${this.operation.timeoutMs}ms`, { retryable: false });
  }
}

/** Runs `work` on a budget of the operation's own. */
export function withBudget<T>(operation: OperationContext, label: string, work: (budget: Budget) => Promise<T>): Promise<T> {
  const budget = new Budget(operation, label);
  return budget.run(() => work(budget));
}

/** A promise's answer, or undefined when it fails or takes longer than `ms`: for a question the caller can do without. */
export function answerWithin<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  return withTimeout(pending, Math.max(1, ms), () => new Error('no answer in time')).catch(() => undefined);
}
