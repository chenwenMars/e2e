/**
 * `@e2e-dev/electron` public surface: the `electron()` engine factory, the
 * `electron` fixture types, and `test`, `describe`, and the hooks typed with
 * that fixture. `expect`, `credentials`, and `secrets` still come from
 * `e2e`. Without `e2e` installed, `electron()` still loads and `test` throws
 * when used.
 */

import type { ElectronFixtures } from './fixtures.ts';
import { runnerTest } from './runner-test.ts';

export * from './engine-entry.ts';
/** The engine factory as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { default } from './engine-entry.ts';

/**
 * `test` typed with this engine's contributed `electron` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = runnerTest().extend<ElectronFixtures>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `electron` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
