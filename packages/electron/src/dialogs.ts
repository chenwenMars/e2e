/**
 * The `alert` and `confirm` dialogs of one attempt: each goes to the handler
 * `electron.onDialog` registered last. One nothing answers is dismissed, so
 * the app goes on, and is held as the failure of the test's next step.
 */

import { ConfigurationError, EngineError, InfrastructureError, TestError } from '@e2e-dev/core/engine';

/** An `alert` or `confirm` as a test's handler sees it. Electron has no `prompt`. */
export interface Dialog {
  readonly type: 'alert' | 'confirm';
  /** The dialog's text. */
  readonly message: string;
  /** Accepts the dialog once, as clicking OK does. */
  accept(): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);

/** A dialog the app opened, and how the engine answers it. */
export interface OpenDialog {
  readonly type: 'alert' | 'confirm';
  readonly message: string;
  answer(accept: boolean): Promise<void>;
}

/** An error a handler threw that already says what failed: a failed `expect`, a refusal. */
function classified(cause: unknown): cause is Error {
  return cause instanceof EngineError || cause instanceof TestError || cause instanceof ConfigurationError || cause instanceof InfrastructureError;
}

export class DialogRouter {
  private registrations: { readonly handler: DialogHandler }[] = [];
  private pending: Error | undefined;
  private readonly running = new Set<Promise<void>>();

  /** Registers a handler, the newest winning, and returns what removes it. */
  add(handler: DialogHandler): () => void {
    const registration = { handler };
    this.registrations.push(registration);
    return () => {
      this.registrations = this.registrations.filter((each) => each !== registration);
    };
  }

  /** Forgets the attempt's handlers and whatever it left unreported. */
  reset(): void {
    this.registrations = [];
    this.pending = undefined;
  }

  /** The failure a dialog left for the next step, once. */
  take(): Error | undefined {
    const { pending } = this;
    this.pending = undefined;
    return pending;
  }

  /** Resolves once the handlers running now have returned. */
  async settled(): Promise<void> {
    await Promise.all(this.running);
  }

  /** Answers one dialog through the newest handler. */
  dispatch(dialog: OpenDialog): void {
    const work = this.route(dialog).catch(() => undefined);
    this.running.add(work);
    void work.then(() => this.running.delete(work));
  }

  private async route(dialog: OpenDialog): Promise<void> {
    const handler = this.registrations.at(-1)?.handler;
    const { type, message } = dialog;
    // The first failure is the one to report: the app's later dialogs follow from it.
    const fail = (error: Error): void => {
      this.pending ??= error;
    };
    if (handler === undefined) {
      fail(new EngineError('INVALID_STATE', `unhandled ${type} dialog: ${message}; answer it with electron.onDialog('accept'), 'dismiss', or a handler`, { retryable: false }));
      await dialog.answer(false).catch(() => undefined);
      return;
    }
    if (typeof handler === 'string') {
      await dialog.answer(handler === 'accept').catch(() => undefined);
      return;
    }
    let decided = false;
    let answered = false;
    const answer = async (accept: boolean): Promise<void> => {
      decided = true;
      await dialog.answer(accept);
      answered = true;
    };
    try {
      await handler({ type, message, accept: () => answer(true), dismiss: () => answer(false) });
      if (decided) return;
      // Left open, it would block the page and surface later as an unrelated timeout.
      await dialog.answer(false).catch(() => undefined);
      fail(new EngineError('INVALID_STATE', `dialog handler returned without calling accept or dismiss for ${type} dialog: ${message}`, { retryable: false }));
    } catch (cause) {
      fail(classified(cause) ? cause : new EngineError('ENGINE_FAILURE', `dialog handler failed: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause }));
      if (!answered) await dialog.answer(false).catch(() => undefined);
    }
  }
}
