/**
 * `test.slow()` through the real runner: from a body or a `beforeEach` hook
 * it triples the attempt's timeout in force, counted from the attempt's
 * start, once per attempt as in Playwright; `test.slow(false)` leaves it;
 * a later `test.setTimeout` replaces it; from a `beforeAll` hook it triples
 * that hook's timeout, once; a retry starts from the test's own timeout again;
 * `afterEach` and `afterAll` hooks, a call outside a running test, and the
 * registration form `test.slow(title, fn)` are refused.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject } from '../helpers/run-project.ts';

const TESTS = `import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'e2e';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('outlasts its own timeout', { timeout: 300 }, async () => {
  test.slow();
  await sleep(600);
});

test('slows an attempt once', { timeout: 100 }, async () => {
  test.slow();
  test.slow();
  await sleep(10_000);
});

test('is replaced by a later setTimeout', { timeout: 30_000 }, async () => {
  test.slow();
  test.setTimeout(200);
  test.slow();
  await sleep(10_000);
});

describe('slowed twice from beforeAll', () => {
  beforeAll(async () => {
    test.slow();
    test.slow();
    // Past the once-tripled 1500 ms, inside a twice-tripled 4500 ms.
    await sleep(2_500);
  });

  test('never runs', async () => {});
});

describe('slowed from beforeEach and the body', () => {
  beforeEach(() => {
    test.slow();
  });

  test('is slowed once', { timeout: 100 }, async () => {
    test.slow();
    await sleep(10_000);
  });
});

test('times out without it', { timeout: 300 }, async () => {
  await sleep(10_000);
});

test('leaves the timeout on a false condition', { timeout: 300 }, async () => {
  test.slow(false, 'only on CI');
  await sleep(10_000);
});

test('takes a condition and a reason', { timeout: 300 }, async () => {
  test.slow(true, 'imports a large file');
  await sleep(600);
});

test('triples the timeout in force', { timeout: 30_000 }, async () => {
  test.setTimeout(100);
  test.slow();
  await sleep(10_000);
});

describe('slowed from beforeEach', () => {
  beforeEach(() => {
    test.slow();
  });

  test('outlasts its own timeout too', { timeout: 300 }, async () => {
    await sleep(600);
  });
});

describe('from afterEach', () => {
  afterEach(() => {
    test.slow();
  });

  test('is refused', async () => {});
});

describe('from afterEach after the body slowed', () => {
  afterEach(() => {
    test.slow();
  });

  test('is refused too', async () => {
    test.slow();
  });
});

const marker = new URL('./retried.marker', import.meta.url);
const slowedMarker = new URL('./slowed-retry.marker', import.meta.url);

test('slows a retry again', { timeout: 300, retries: 1 }, async () => {
  test.slow();
  if (!fs.existsSync(slowedMarker)) {
    fs.writeFileSync(slowedMarker, '');
    throw new Error('first attempt fails');
  }
  // Past the 300 ms option, inside the retry's own tripled 900 ms.
  await sleep(600);
});


test('starts a retry from its own timeout', { timeout: 300, retries: 1 }, async () => {
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, '');
    test.slow();
    throw new Error('first attempt fails');
  }
  await sleep(10_000);
});

describe('slowed from beforeAll', () => {
  beforeAll(async () => {
    test.slow();
    // Past the config's 500 ms, inside the tripled 1500 ms.
    await sleep(900);
  });

  test('runs after a beforeAll that outlasted the config timeout', async () => {});
});

describe('from afterAll', () => {
  afterAll(() => {
    test.slow();
  });

  test('runs before it', async () => {});
});
`;

describe('test.slow', () => {
  it(
    'triples the running attempt\'s timeout from a body or beforeEach hook, a beforeAll hook\'s own, resets on retry, and refuses afterEach and afterAll',
    async () => {
      // Every hook and test without its own timeout gets the config's 500 ms.
      const { outcome, project } = await runProject({ 'tests/slow.e2e.ts': TESTS }, { config: { timeout: 500 } });
      try {
        assertValidReport(outcome.report);
        const result = (title: string) => outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title)!;
        const error = (title: string, attempt = 0) => result(title).attempts[attempt]?.error;

        expect(result('outlasts its own timeout').status).toBe('passed');
        expect(result('takes a condition and a reason').status).toBe('passed');
        expect(result('outlasts its own timeout too').status).toBe('passed');
        // As in Playwright, a second call does nothing: 100 ms tripled once, not twice.
        for (const title of ['slows an attempt once', 'is slowed once']) {
          expect(result(title).status, title).toBe('timed-out');
          expect(error(title), title).toMatchObject({ code: 'TEST_TIMEOUT', message: expect.stringContaining('test timed out after 300 ms') });
        }

        expect(result('times out without it').status).toBe('timed-out');
        expect(result('leaves the timeout on a false condition').status).toBe('timed-out');
        expect(error('leaves the timeout on a false condition')).toMatchObject({
          code: 'TEST_TIMEOUT',
          message: expect.stringContaining('test timed out after 300 ms'),
        });

        // 100 ms from test.setTimeout, tripled: not the 30 s option tripled.
        expect(result('triples the timeout in force').status).toBe('timed-out');
        expect(error('triples the timeout in force')).toMatchObject({
          code: 'TEST_TIMEOUT',
          message: expect.stringContaining('test timed out after 300 ms'),
        });

        expect(error('is refused')).toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: expect.stringContaining('test.slow() cannot change the timeout from an afterEach hook'),
        });

        // Once the body slowed the attempt, a call from afterEach is still refused.
        expect(error('is refused too')).toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: expect.stringContaining('test.slow() cannot change the timeout from an afterEach hook'),
        });

        // A retry is a new attempt, so it can be slowed again.
        expect(result('slows a retry again').attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);

        const retried = result('starts a retry from its own timeout');
        expect(retried.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'timed-out']);
        expect(error('starts a retry from its own timeout', 1)).toMatchObject({
          code: 'TEST_TIMEOUT',
          message: expect.stringContaining('test timed out after 300 ms'),
        });

        // test.slow() after setTimeout(200) in the same attempt does nothing: 200 ms, not 600.
        expect(error('is replaced by a later setTimeout')).toMatchObject({ code: 'TEST_TIMEOUT', message: expect.stringContaining('test timed out after 200 ms') });

        expect(result('runs after a beforeAll that outlasted the config timeout').status).toBe('passed');
        // Slowed once, not twice: the hook times out at 1500 ms, before its 2500 ms sleep ends.
        expect(outcome.report.run.errors).toContainEqual(
          expect.objectContaining({ code: 'HOOK_FAILED', scopeId: 'slowed twice from beforeAll', message: 'beforeAll failed: beforeAll hook timed out' }),
        );
        expect(result('never runs')).toMatchObject({ status: 'skipped', skip: { cause: 'hook-failed' } });
        expect(result('runs before it').status).toBe('passed');
        expect(outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message }))).toContainEqual({
          code: 'HOOK_FAILED',
          phase: 'afterAll',
          message: expect.stringContaining('test.slow() cannot change the timeout from an afterAll hook'),
        });
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it.each([
    ['a call outside a running test', 'test.slow();\ntest(\'never registered\', async () => {});\n', /test\.slow\(\) triples the running test's timeout and must be called inside a test body/],
    ['test.slow(false) outside a running test', 'test.slow(false);\ntest(\'never registered\', async () => {});\n', /must be called inside a test body/],
    ['the registration form', 'test.slow(\'never registered\', async () => {});\n', /test\.slow\(\) takes no test/],
  ])(
    'rejects %s at collection',
    async (_name, body, message) => {
      const { outcome, project } = await runProject({ 'tests/outside.e2e.ts': `import { test } from 'e2e';\n\n${body}` }, {});
      try {
        expect(outcome.exitCode).toBe(2);
        expect(outcome.report.run.errors.map((entry) => entry.code)).toEqual(['COLLECTION_ERROR']);
        expect(outcome.report.run.errors[0]?.message).toMatch(message);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});
