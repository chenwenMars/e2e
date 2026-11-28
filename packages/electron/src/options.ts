/**
 * What the Electron engine is given: its options. The app under test is the
 * target's `app` (`appPath`, `launchArguments`); these options only say how
 * the engine starts Electron and reads its windows.
 */

import { ConfigurationError, rejectUnknownKeys } from '@e2e-dev/core/engine';

/** Variables no app is started with, whoever sets them, by their upper-case names. */
export const REFUSED_ENV: ReadonlySet<string> = new Set(['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']);

/**
 * Options of the Electron engine. Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface ElectronOptions {
  /**
   * The executable to start: a packaged app's binary, or an Electron binary
   * of your own; relative to the project root. Default: the `electron`
   * package installed in the project, which runs the target's `app.appPath`.
   */
  readonly executablePath?: string | undefined;
  /** Variables added to the app's environment, over the run's own. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** The attribute `getByTestId` reads. Default `data-testid`. */
  readonly testIdAttribute?: string | undefined;
  /**
   * How long the engine waits after an action the agent took before the
   * agent observes again, in milliseconds; `false` skips the wait. A test's
   * own steps never wait: `expect` polls their outcome. Default 100.
   */
  readonly settle?: number | false | undefined;
}

const OPTION_KEYS = Object.keys({
  executablePath: true,
  env: true,
  testIdAttribute: true,
  settle: true,
} satisfies Record<keyof ElectronOptions, true>);

/** The options with defaults applied, checked once at config load. */
export interface ResolvedElectronOptions {
  readonly executablePath?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly testIdAttribute: string;
  readonly settleMs: number;
}

/**
 * Why the engine refuses a launch argument it owns, or undefined: Chromium's
 * profile directory (every attempt gets an empty one), and the inspector and
 * the DevTools transport the engine drives the app through (a fixed port
 * would also collide between workers).
 */
export function ownedArgument(argument: string): string | undefined {
  if (/^--user-data-dir(=|$)/.test(argument)) return 'must not set --user-data-dir: the engine gives every attempt an empty one of its own';
  const port = /^(--inspect(-brk)?|--remote-debugging-port|--remote-debugging-pipe)(=|$)/.exec(argument);
  if (port !== null) return `must not set ${port[1]}: the engine opens the inspector and the DevTools pipe it drives the app through itself`;
  return undefined;
}

/** Checks the target's `app.launchArguments`: the app's own switches and Chromium's, none of the engine's. */
export function checkLaunchArguments(launchArguments: readonly string[] | undefined): void {
  const owned = launchArguments?.map(ownedArgument).find((reason) => reason !== undefined);
  if (owned !== undefined) throw new ConfigurationError('INVALID_CONFIG', `app.launchArguments ${owned}`);
}

const DEFAULT_SETTLE_MS = 100;

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match
 * nothing and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** Checks the option bag the way every config option is checked: unknown keys and wrong types fail the config load. */
export function resolveOptions(options: ElectronOptions | undefined): ResolvedElectronOptions {
  // Only a missing bag defaults: a null one (from JSON an agent wrote for e2e mcp) is a config error, not the defaults.
  const bag: ElectronOptions = options === undefined ? {} : options;
  if (typeof bag !== 'object' || bag === null || Array.isArray(bag)) throw new ConfigurationError('INVALID_CONFIG', 'electron() options must be an object');
  rejectUnknownKeys('electron() options', bag, OPTION_KEYS);
  const { executablePath, env, testIdAttribute, settle } = bag;
  if (executablePath !== undefined && (typeof executablePath !== 'string' || executablePath === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ executablePath }) must be a path to an executable');
  }
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string'))) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ env }) must be an object of variable name to string value');
  }
  // Windows reads a variable's name in any case.
  const refused = env === undefined ? undefined : Object.keys(env).find((name) => REFUSED_ENV.has(name.toUpperCase()));
  if (refused !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `electron({ env }) must not set ${refused}: ${refused.toUpperCase() === 'NODE_OPTIONS' ? 'the engine starts the app with its own Node.js switches' : 'it starts the binary as plain Node.js, which opens no window'}`,
    );
  }
  if (testIdAttribute !== undefined && (typeof testIdAttribute !== 'string' || !ATTRIBUTE_NAME.test(testIdAttribute))) {
    throw new ConfigurationError('INVALID_CONFIG', `electron({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(testIdAttribute)}`);
  }
  if (settle !== undefined && settle !== false && (!Number.isInteger(settle) || settle < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'electron({ settle }) must be a whole number of milliseconds, or false');
  }
  return {
    ...(executablePath === undefined ? {} : { executablePath }),
    env: env ?? {},
    testIdAttribute: testIdAttribute ?? 'data-testid',
    settleMs: settle === false ? 0 : (settle ?? DEFAULT_SETTLE_MS),
  };
}
