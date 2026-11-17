/**
 * `e2e` is an optional peer: a program on `@e2e-dev/core` alone imports
 * `web` from the main entry. Without `e2e` the entry still loads, and `test`
 * and the hooks throw `RUNNER_NOT_INSTALLED` when used.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** What `require.resolve('e2e')` throws in the next import of the entry; undefined resolves it. */
let resolveError: Error | undefined;

vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const real = actual.createRequire(from);
      return Object.assign((id: string) => real(id), {
        resolve: (id: string) => {
          if (id === 'e2e' && resolveError !== undefined) throw resolveError;
          return real.resolve(id);
        },
      });
    },
  };
});

afterEach(() => {
  resolveError = undefined;
  vi.resetModules();
});

/** The main entry, loaded afresh. */
async function entry(): Promise<typeof import('../../src/index.ts')> {
  vi.resetModules();
  return import('../../src/index.ts');
}

describe('the main entry without e2e', () => {
  it('loads web(), and test and the hooks throw RUNNER_NOT_INSTALLED', async () => {
    resolveError = Object.assign(new Error("Cannot find module 'e2e'"), { code: 'MODULE_NOT_FOUND' });
    const { web, test, describe: group, beforeEach } = await entry();
    expect(web().name).toBe('web');
    for (const use of [() => test('t', () => {}), () => test.skip('t', () => {}), () => group('g', () => {}), () => beforeEach(() => {})]) {
      expect(use).toThrow(expect.objectContaining({ code: 'RUNNER_NOT_INSTALLED', message: expect.stringContaining("'@e2e-dev/web/engine'") }));
    }
  });

  it('rethrows any other failure to resolve e2e', async () => {
    resolveError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(entry()).rejects.toThrow('EACCES');
  });

  it('rethrows a missing entry file of an installed e2e', async () => {
    resolveError = Object.assign(new Error("Cannot find module '/app/node_modules/e2e/dist/index.js'"), { code: 'MODULE_NOT_FOUND' });
    await expect(entry()).rejects.toThrow('e2e/dist/index.js');
  });

  it("is e2e's own test when e2e is installed", async () => {
    const { test } = await entry();
    expect(() => test('t', () => {})).toThrow(expect.objectContaining({ code: 'COLLECTION_ERROR' }));
  });
});
