/**
 * The Electron engine for e2e: an Electron app's body built with the public
 * `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here, and this
 * package imports nothing from another engine and no automation library: the
 * contract comes from `@e2e-dev/core/engine`, and it speaks the DevTools
 * protocol itself. It contributes the `electron` fixture the way the browser
 * engine contributes `browser`.
 */

import { createRequire } from 'node:module';
import {
  ConfigurationError,
  defineEngine,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
  type EngineHandle,
} from '@e2e-dev/core/engine';
import { createElectronFixture } from './electron.ts';
import type { ElectronFixtures } from './fixtures.ts';
import { ownedArgument, resolveOptions, type ElectronOptions } from './options.ts';
import { ElectronSurface } from './surface.ts';

/**
 * The handle `electron()` returns. Declared here so a config's inferred type
 * names this package: a project sees `@e2e-dev/core` only through its
 * dependencies, and TypeScript cannot write that path in a declaration.
 */
export interface ElectronEngine extends EngineHandle<ElectronFixtures> {}

/**
 * Creates one Electron engine. A test launches the app with `app.open()`, on
 * an empty user-data directory of its attempt's own; `app.restart()`
 * relaunches it on the same data, `app.clearState()` on empty data, and every
 * test ends with the app quit. Its windows are the tabs the agent and
 * a window's `activate()` switch between.
 */
export function electron(options: ElectronOptions = {}): ElectronEngine {
  const resolved = resolveOptions(options);
  const surface = new ElectronSurface(resolved);
  return defineEngine<ElectronFixtures>({
    name: 'electron',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'electron',
    prepare: (info) => surface.prepare(info),
    doctor: (info) => surface.doctor(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    readStyle: (ref, properties, operation) => surface.readStyle(ref, properties, operation),
    viewportIntersection: (ref, operation) => surface.viewportIntersection(ref, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    actions: [...LOCATOR_ACTION_KINDS, 'blur', 'multiTap', 'setInputFilePayloads'],
    tapModifiers: true,
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: POINTER_ACTION_KINDS,
    keyboard: {
      type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
      press: (key, operation) => surface.pressKey(key, operation),
    },
    validateApp: (app, info) => validateApp(app, info, resolved.executablePath),
    // No `open`: an Electron app loads its own pages, so the runner serves `app.open()` with `restart`, a fresh launch.
    session: {
      back: (operation) => surface.back(operation),
      restart: (operation) => surface.restart(operation),
      reset: (operation) => surface.reset(operation),
      switchTab: (index, operation) => surface.switchTab(index, operation),
      closeTab: (index, operation) => surface.closeTab(index, operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: () => surface.stopVideo(),
    },
    fixtures: {
      electron: (context) => createElectronFixture(surface, context),
    },
  });
}

/**
 * An Electron target names the app the Electron binary runs, `app.appPath`
 * (its directory or main script), unless `executablePath` names a packaged
 * app that knows its own. It has no URL: the app loads its own pages.
 */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo, executablePath: string | undefined): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares app.url, but an electron() target launches an app that loads its own pages; name the app with app.appPath, its directory or main script`,
    );
  }
  if (app.bundleId !== undefined) throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.bundleId, which an electron() target cannot launch; name the app with app.appPath`);
  if (app.permissions !== undefined) throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.permissions, which an electron() target cannot set`);
  const owned = app.launchArguments?.map(ownedArgument).find((reason) => reason !== undefined);
  if (owned !== undefined) throw new ConfigurationError('INVALID_CONFIG', `${where} app.launchArguments ${owned}`);
  if (app.appPath === undefined && executablePath === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs app.appPath, the Electron app's directory or main script, such as app: { appPath: '.' }; or name a packaged app with electron({ executablePath })`,
    );
  }
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
