/**
 * The trace cache on a one-time code split over one box per digit: the page
 * issues a new code on every load, so no digit of it may replay. The first
 * run records the step as gaps from its first box on, and the second hands
 * the whole code to the executor without typing the last run's digits. The
 * same holds when each digit is typed into the focused box (`typeText`, which
 * names no field) on a screen that listed a one-time-code field; unmarked
 * boxes keep today's rules.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import type { StepExecutor, StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';

const CODE_SUITE = `import { test, expect } from 'e2e';

test('confirms with the code', async ({ app, agent, screen }) => {
  await app.open('/one-time-code');
  await agent.act('type the code shown on the page into the code boxes');
  await expect(screen.getByRole('status')).toHaveText('Code verified');
});
`;

interface CodeRecord {
  calls: number;
  /** Whether the executor's first look found a verdict on a wrong code: a replay typed one. */
  sawIncorrect: boolean;
}

/**
 * As `codeExecutor`, but taps each box and types its digit into the focused
 * field, as a model does with `type` and no target after `tap`, or a custom
 * executor that types at the caret. No model.
 */
function focusedCodeExecutor(record: CodeRecord): StepExecutor {
  return {
    name: 'focused-code-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      let observation = await context.observe();
      record.sawIncorrect ||= observation.text.includes('Incorrect code');
      const code = /Your code is (\d{6})/.exec(observation.text)?.[1];
      if (code === undefined) return { status: 'failed' as const, summary: 'no code on the page' };
      for (const [index, digit] of [...code].entries()) {
        await context.actions.tap({ id: nodeIdFor(observation.text, new RegExp(`textbox "Digit ${String(index + 1)}"`)) });
        await context.actions.typeText(digit, { replace: false });
      }
      observation = await context.observe();
      if (!observation.text.includes('Code verified')) return { status: 'failed' as const, summary: 'the code was not accepted' };
      return { status: 'passed' as const, summary: 'typed the code' };
    },
  };
}

/** Reads the code off the page and types it one digit per box, as a model does. No model. */
function codeExecutor(record: CodeRecord): StepExecutor {
  return {
    name: 'code-executor',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      record.calls += 1;
      let observation = await context.observe();
      record.sawIncorrect ||= observation.text.includes('Incorrect code');
      const code = /Your code is (\d{6})/.exec(observation.text)?.[1];
      if (code === undefined) return { status: 'failed' as const, summary: 'no code on the page' };
      for (const [index, digit] of [...code].entries()) {
        await context.actions.type({ id: nodeIdFor(observation.text, new RegExp(`textbox "Digit ${String(index + 1)}"`)) }, digit);
      }
      observation = await context.observe();
      if (!observation.text.includes('Code verified')) return { status: 'failed' as const, summary: 'the code was not accepted' };
      return { status: 'passed' as const, summary: 'typed the code' };
    },
  };
}

describe('trace cache: a one-time code typed one digit per box', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const records: CodeRecord[] = [];

  const options = () => {
    const record: CodeRecord = { calls: 0, sawIncorrect: false };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: codeExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/code.e2e.ts': CODE_SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('records every box as a gap and never types the last run\'s code', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const entries = readEntries(project);
    expect(entries).toHaveLength(1);
    const { actions } = entries[0]!.entry.payload;
    // A lone digit is no word of the sentence that shows the code; only the field's
    // purpose makes each fill this run's data.
    expect(actions).toHaveLength(6);
    for (const action of actions) {
      expect(action).toEqual({ name: 'tool', summary: 'tool type (run-time value)', derived: 'minted-token' });
    }

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(1);
    expect(records.at(-1)!.sawIncorrect).toBe(false);
    const step = resultByTitle(second, 'confirms with the code').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toMatchObject({ mode: 'missed', reason: 'gap', totalActions: 6 });
  }, 240_000);
});

/** The code suite on another page: `/one-time-code` or its unmarked twin. */
const suiteOn = (pathname: string): string => CODE_SUITE.replace("'/one-time-code'", `'${pathname}'`);

describe('trace cache: a one-time code typed into each focused box', () => {
  let app: FixtureApp;
  let marked: FixtureProject;
  let plain: FixtureProject;
  const records: CodeRecord[] = [];

  const options = () => {
    const record: CodeRecord = { calls: 0, sawIncorrect: false };
    records.push(record);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        agents: { default: { executor: focusedCodeExecutor(record) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    marked = createProject({ 'tests/code.e2e.ts': CODE_SUITE });
    plain = createProject({ 'tests/code.e2e.ts': suiteOn('/one-time-code-plain') });
  }, 60_000);

  afterAll(async () => {
    marked?.cleanup();
    plain?.cleanup();
    await app?.close();
  });

  it('records every focused digit as a gap on a screen that listed a one-time-code field', async () => {
    const first = await runExisting(marked, options());
    expect(first.exitCode).toBe(0);
    const entries = readEntries(marked);
    expect(entries).toHaveLength(1);
    const { actions } = entries[0]!.entry.payload;
    // Each tap names its box and replays; each digit typed after it is this run's data.
    expect(actions.filter((action) => action.name === 'typeText')).toEqual([]);
    const gaps = actions.filter((action) => action.name === 'tool');
    expect(gaps).toHaveLength(6);
    for (const gap of gaps) {
      expect(gap).toEqual({ name: 'tool', summary: 'tool type (run-time value)', derived: 'minted-token' });
    }

    const second = await runExisting(marked, options());
    expect(second.exitCode).toBe(0);
    expect(records.at(-1)!.calls).toBe(1);
    expect(records.at(-1)!.sawIncorrect).toBe(false);
    const step = resultByTitle(second, 'confirms with the code').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    // The first tap names its box and replays; replay hands off at the first digit.
    expect(step.cache).toMatchObject({ mode: 'agent-concluded', reason: 'gap', derived: 'minted-token', replayedActions: 1 });
  }, 240_000);

  it('keeps recording focused digits on boxes that declare no purpose', async () => {
    const first = await runExisting(plain, options());
    expect(first.exitCode).toBe(0);
    const { actions } = readEntries(plain)[0]!.entry.payload;
    expect(actions.filter((action) => action.name === 'tool')).toEqual([]);
    expect(actions.filter((action) => action.name === 'typeText')).toHaveLength(6);
  }, 240_000);
});
