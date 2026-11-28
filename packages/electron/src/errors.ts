/** The engine errors this surface raises, and the translation of a protocol failure into them. */

import { ConfigurationError, EngineError, TestError } from '@e2e-dev/core/engine';

export function stale(message: string, cause?: unknown): EngineError {
  return new EngineError('NODE_STALE', message, { retryable: true, ...(cause === undefined ? {} : { cause }) });
}

export function notActionable(message: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', message, { retryable: false });
}

export function invalidState(message: string): EngineError {
  return new EngineError('INVALID_STATE', message, { retryable: false });
}

export function unsupported(message: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', message, { retryable: false });
}

export function lostFocus(): EngineError {
  return notActionable('the element did not keep keyboard focus (the app moved it), so the input would reach another element');
}

/** Protocol failures that mean the node, or the document it was in, is gone. */
export const GONE = /No node found|Could not find node|Node is detached|No node with given id|Cannot find context with specified id|Execution context was destroyed|Cannot find object with id|Node is not an element|does not belong to the document|frame was detached/i;
/** Failures that mean the window, or the whole app, closed. */
const CLOSED = /session detached|connection closed|Target closed|No target with given id|Session with given id not found|No session with given id/i;

/** Whether a failure means the window, or the whole app, closed. */
export function closedWindow(cause: unknown): boolean {
  return CLOSED.test(cause instanceof Error ? cause.message : String(cause));
}

/**
 * Translates a failure into the engine error taxonomy. `committed` says
 * input may already have reached the app: then a timeout or a vanished node
 * is `ACTION_MAY_HAVE_COMMITTED`, never something the harness retries.
 */
export function translate(cause: unknown, label: string, committed: boolean): Error {
  // A refusal by policy (a screenshot it cannot mask) or of the test's own input is the harness's to report as it is.
  if (cause instanceof ConfigurationError || cause instanceof TestError) return cause;
  if (cause instanceof EngineError) {
    if (committed && (cause.code === 'OPERATION_TIMEOUT' || cause.code === 'CANCELLED' || cause.retryable)) {
      return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: ${cause.message}; its input may have reached the app`, { retryable: false, cause });
    }
    return cause;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  if (CLOSED.test(message)) {
    // A window that closes because of the input (a "Close" or "Sign out" button) is a committed action, as a node that goes away is.
    if (committed) return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: the window closed while the input was sent`, { retryable: false, cause });
    return new EngineError('INVALID_STATE', `${label}: the window closed (${message.split('\n')[0]})`, { retryable: false, cause });
  }
  if (GONE.test(message)) {
    if (committed) return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: the node went away while the input was sent`, { retryable: false, cause });
    return stale(`${label}: the node is no longer in the window`, cause);
  }
  return new EngineError(committed ? 'ACTION_MAY_HAVE_COMMITTED' : 'ENGINE_FAILURE', `${label} failed: ${message.split('\n')[0]}`, { retryable: false, cause });
}
