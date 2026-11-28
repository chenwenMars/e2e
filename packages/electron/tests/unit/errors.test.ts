import { ConfigurationError, EngineError, TestError } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { closedWindow, translate } from '../../src/errors.ts';

function code(cause: unknown, committed: boolean): string {
  return (translate(cause, 'tap', committed) as EngineError).code;
}

describe('translate', () => {
  it('leaves a refusal by policy or of the test\'s own input as it is', () => {
    const denied = new ConfigurationError('POLICY_DENIED', 'withheld');
    const invalid = new TestError('INVALID_ARGUMENT', 'no file');
    expect(translate(denied, 'screenshot', true)).toBe(denied);
    expect(translate(invalid, 'setInputFiles', true)).toBe(invalid);
  });

  it('maps a protocol failure by what went away', () => {
    expect(code(new Error('Accessibility.getFullAXTree: session detached'), false)).toBe('INVALID_STATE');
    expect(code(new Error('DOM.resolveNode: No node with given id found'), false)).toBe('NODE_STALE');
    expect(code(new Error('Node is detached: it is no longer in the document'), false)).toBe('NODE_STALE');
    expect(code(new Error('something else'), false)).toBe('ENGINE_FAILURE');
  });

  it('never reports a failure after input as retryable', () => {
    for (const cause of [
      new Error('Target closed'),
      new Error('No node with given id found'),
      new Error('something else'),
      new EngineError('OPERATION_TIMEOUT', 'timed out', { retryable: false }),
      new EngineError('CANCELLED', 'cancelled', { retryable: false }),
      new EngineError('NODE_STALE', 'gone', { retryable: true }),
    ]) {
      const translated = translate(cause, 'tap', true) as EngineError;
      expect(translated.code).toBe('ACTION_MAY_HAVE_COMMITTED');
      expect(translated.retryable).toBe(false);
    }
  });

  it('keeps an engine error that is no timeout and not retryable, input sent or not', () => {
    const refused = new EngineError('NOT_ACTIONABLE', 'it is disabled', { retryable: false });
    expect(translate(refused, 'tap', true)).toBe(refused);
    expect(translate(refused, 'tap', false)).toBe(refused);
  });
});

describe('closedWindow', () => {
  it('tells a closed window or app from any other failure', () => {
    expect(closedWindow(new Error('Accessibility.getFullAXTree: session detached'))).toBe(true);
    expect(closedWindow(new Error('Runtime.evaluate: connection closed'))).toBe(true);
    expect(closedWindow(new Error('No node with given id found'))).toBe(false);
  });
});
