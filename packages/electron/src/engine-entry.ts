/**
 * `@e2e-dev/electron/engine`: the `electron()` factory and its types, without
 * `test`, so a program that drives an Electron app with `@e2e-dev/core`
 * never loads the test runner. The main entry re-exports all of it beside
 * `test`.
 */

export { electron } from './engine.ts';
export type { ElectronEngine } from './engine.ts';
/** The engine factory again, as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { electron as default } from './engine.ts';
export type { ElectronOptions } from './options.ts';
export type { Dialog, DialogHandler } from './dialogs.ts';
export type { Electron, ElectronFixtures, ElectronMainModule, ElectronWindow, WindowMatcher } from './fixtures.ts';
