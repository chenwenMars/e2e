/**
 * A test that opens a second session with `launch()` from `@e2e-dev/core`:
 * the run and the host each know secrets the other was never given, and
 * neither prints the other's, a value the test's own session resolved from
 * a provider included.
 */

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOutcome } from '../../src/run/runner.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { contentsUnder, resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const HOST_VALUE = 'host-only-secret-7731';
const RUN_VALUE = 'run-only-secret-4096';
const CODE_VALUE = 'one-time-code-558201';

// The values are spelled in parts, so the test file's own text never holds them.
const SUITE = `import { test, expect, secrets } from 'e2e';
import { launch } from '@e2e-dev/core';
import { createFakeEngine, FAKE_APP } from '../../../helpers/fake-engine.ts';

const HOST_VALUE = ['host', 'only', 'secret', '7731'].join('-');
const RUN_VALUE = ['run', 'only', 'secret', '4096'].join('-');
const CODE_VALUE = ['one', 'time', 'code', '558201'].join('-');

const second = () => createFakeEngine({
  scene: () => [
    { id: 'echo', role: 'paragraph', name: '', text: 'the run sent ' + RUN_VALUE },
    { id: 'sms', role: 'paragraph', name: '', text: 'your code is ' + CODE_VALUE },
    { id: 'code', role: 'textbox', name: 'Code', value: '' },
  ],
}).engine;

test('the test session shows a value only the host was given', async ({ app, screen }) => {
  await app.open();
  const host = await launch(second(), { app: FAKE_APP, secrets: { INVITE: HOST_VALUE }, handleSignals: false });
  // Closed before the failure: the screen still shows the value, and the test that launched the host still redacts it.
  await host.close();
  await expect(screen.getByText('never on the screen')).toBeVisible();
});

test('an assertion fails on a value read from the host session, in a test that never uses its own', async () => {
  const host = await launch(second(), { app: FAKE_APP, secrets: { INVITE: HOST_VALUE }, handleSignals: false });
  try {
    const session = await host.newSession();
    await session.app.open('/');
    await session.screen.getByLabel('Code').fill(host.secret('INVITE'));
    expect(await session.screen.getByLabel('Code').inputValue()).toBe('another value');
  } finally {
    await host.close();
  }
});

test('the test session names a locator with the value', async ({ app, screen }) => {
  await app.open();
  const host = await launch(second(), { app: FAKE_APP, secrets: { INVITE: HOST_VALUE }, handleSignals: false });
  try {
    await screen.getByText(HOST_VALUE).tap();
  } finally {
    await host.close();
  }
});

test('the host session, opened after the test session resolved a provider value, redacts it', async ({ app, screen }) => {
  await app.open();
  await screen.getByLabel('Code').fill(secrets.get('CODE'));
  const host = await launch(second(), { app: FAKE_APP, secrets: { INVITE: HOST_VALUE }, handleSignals: false, timeout: 300 });
  try {
    const session = await host.newSession();
    await session.app.open('/');
    expect(await session.screen.tree()).toContain('your code is <secret:CODE>');
    // Fails with the value in its label and on the session's screen: both reach the test's report through the session.
    await session.screen.getByRole('button', CODE_VALUE).tap();
  } finally {
    await host.close();
  }
});

test('the host session redacts what the run declared', async ({ app }) => {
  await app.open();
  const host = await launch(second(), { app: FAKE_APP, handleSignals: false });
  try {
    const session = await host.newSession();
    await session.app.open('/');
    expect(await session.screen.tree()).toContain('the run sent <secret:RUN_ONLY>');
  } finally {
    await host.close();
  }
});
`;

describe('secrets of a launch() host opened inside a test', { timeout: 120_000 }, () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    const fake = createFakeEngine({
      scene: () => [
        { id: 'echo', role: 'paragraph', name: '', text: `the host sent ${HOST_VALUE}` },
        { id: 'code', role: 'textbox', name: 'Code', value: '' },
      ],
    });
    ({ outcome, project } = await runProject(
      { 'tests/two-sessions.e2e.ts': SUITE },
      { config: engineConfig(fake.engine, { secrets: { RUN_ONLY: RUN_VALUE, CODE: () => CODE_VALUE }, trace: 'on', actionTimeout: 300, assertionTimeout: 200 }) },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  it('fails the three tests for their own reasons', () => {
    expect(resultByTitle(outcome, 'the test session shows a value only the host was given').attempts[0]?.error?.code).toBe('ASSERTION_FAILED');
    expect(resultByTitle(outcome, 'an assertion fails on a value read from the host session, in a test that never uses its own').attempts[0]?.error).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('<secret:INVITE>'),
    });
    expect(resultByTitle(outcome, 'the test session names a locator with the value').attempts[0]?.error).toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('<secret:INVITE>'),
    });
  });

  it('keeps the host\'s value out of the report and of every file the run wrote', () => {
    expect(JSON.stringify(outcome)).not.toContain(HOST_VALUE);
    const written = contentsUnder(path.join(project.dir, '.e2e'));
    expect(written.length).toBeGreaterThan(0);
    for (const [file, content] of written) expect(content, file).not.toContain(HOST_VALUE);
    // The test session did see the value: its failure evidence names the secret in its place.
    expect(written.some(([, content]) => content.includes('the host sent <secret:INVITE>'))).toBe(true);
  });

  it('redacts a value the test session resolved from a provider in a host session opened after it, and in what that session reports', () => {
    const attempt = resultByTitle(outcome, 'the host session, opened after the test session resolved a provider value, redacts it').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'LOCATOR_NOT_FOUND', message: expect.stringContaining('<secret:CODE>') });
    expect(attempt.steps.at(-1)).toMatchObject({ actor: 'launch-1', label: expect.stringContaining('<secret:CODE>') });
    expect(JSON.stringify(outcome)).not.toContain(CODE_VALUE);
    for (const [file, content] of contentsUnder(path.join(project.dir, '.e2e'))) expect(content, file).not.toContain(CODE_VALUE);
  });

  it('redacts the run\'s value in the host session', () => {
    const result = resultByTitle(outcome, 'the host session redacts what the run declared');
    expect(result.status, JSON.stringify(result.attempts[0]?.error)).toBe('passed');
  });
});
