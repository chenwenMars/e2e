import { describe, expect as vexpect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import type { AsyncExpectation } from '@e2e-dev/core/lib/types';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

let nextId = 0;
/** A node found by its test id, with the fields a case sets. */
function node(testId: string, fields: Omit<SemanticNode, 'ref' | 'testId'>): SemanticNode {
  nextId += 1;
  return { ref: { id: `node-${String(nextId)}`, revision: '' }, testId, ...fields };
}

const NODES: readonly SemanticNode[] = [
  node('secret', { role: 'textbox', name: 'Password', states: { secure: true } }),
  node('heading', { role: 'heading', name: 'Title', text: 'Title', level: 1 }),
  node('switch', { role: 'switch', name: 'Wi-Fi', states: { checked: true } }),
  node('logo', { role: 'image', name: 'Logo' }),
  node('unroled', { text: 'Plain' }),
  // A role outside the getByRole vocabulary, as a device engine reports some verbatim.
  node('verbatim', { role: 'text', text: 'Hi' }),
  node('twin', { role: 'button', name: 'One' }),
  node('twin', { role: 'button', name: 'Two' }),
];

const screen = createScreenFixture(NODES);
const at = (testId: string): AsyncExpectation => expectFixture(screen.getByTestId(testId));
const soon = { timeout: 100 };
const failsAssertion = { code: 'ASSERTION_FAILED' };
const invalidArgument = { code: 'INVALID_ARGUMENT' };
/** Options typed as the caller's own object, the way a JavaScript test reaches the matcher. */
const computed = (options: Record<string, unknown>): { timeout?: number } => ({ ...options });

describe('toHaveRole', () => {
  it('compares the role as a string', async () => {
    await at('heading').toHaveRole('heading');
    await at('switch').toHaveRole('switch');
    // The role hierarchy does not count: a switch is not a checkbox.
    await at('switch').not.toHaveRole('checkbox', soon);
    await vexpect(at('switch').toHaveRole('checkbox', soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: [
        'expect.toHaveRole failed',
        'locator: getByTestId("switch")',
        'expected: role "checkbox"',
        'observed: role "switch" (match count 1)',
      ].join('\n'),
    });
  });

  it('reads ARIA img as image, as getByRole does', async () => {
    await at('logo').toHaveRole('img');
    await at('logo').toHaveRole('image');
    await vexpect(at('heading').toHaveRole('img', soon)).rejects.toMatchObject({
      message: vexpect.stringContaining('expected: role "image"'),
    });
  });

  it('names the role it found when a negation fails', async () => {
    await vexpect(at('switch').not.toHaveRole('switch', soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringMatching(/^expect\.not\.toHaveRole failed\n[\s\S]*observed: role "switch"/),
    });
  });

  it('compares any other string from JavaScript as written', async () => {
    await at('verbatim').toHaveRole('text' as never);
    await at('unroled').not.toHaveRole('paragraph' as never, soon);
  });

  it('fails an ambiguous locator at once', async () => {
    await vexpect(at('twin').toHaveRole('button', soon)).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
  });

  it('fails on a node with no role, and passes its negation', async () => {
    await at('unroled').not.toHaveRole('button', soon);
    await vexpect(at('unroled').toHaveRole('button', soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('observed: no role'),
    });
  });

  it('answers on a secure field, whose role is never withheld', async () => {
    await at('secret').toHaveRole('textbox');
    await at('secret').not.toHaveRole('searchbox', soon);
  });

  it('keeps polling while nothing matches, negated or not', async () => {
    await vexpect(at('nowhere').not.toHaveRole('button', soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('observed: no node'),
    });
  });

  it('refuses a role that is not a non-empty string, and an option it does not take, before the first read', () => {
    for (const role of [/heading/, '']) {
      vexpect(() => at('heading').toHaveRole(role as never)).toThrow(
        vexpect.objectContaining({ ...invalidArgument, message: 'expect.toHaveRole role must be a non-empty string' }),
      );
    }
    vexpect(() => at('heading').not.toHaveRole('heading', computed({ ignoreCase: true }))).toThrow(
      vexpect.objectContaining({
        ...invalidArgument,
        message: 'expect.not.toHaveRole options has no key "ignoreCase"; it takes timeout',
      }),
    );
  });
});
