/**
 * What the desktop engine is given: its options, and the platform it runs on.
 * The app under test is the target's `app` (`bundleId`, `appPath`,
 * `launchArguments`); these options only say how the engine drives it.
 */

import { ConfigurationError, rejectUnknownKeys } from '@e2e-dev/core/engine';

/** The desktop operating system the engine drives, as its platform label: macOS only for now. */
export type DesktopPlatform = 'macos';

/**
 * Options of the desktop engine. Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface DesktopOptions {
  /**
   * What an observation captures. `full` (default) includes static text, so
   * judgments can read labels; `interactive` keeps only the controls and
   * the nodes that hold them. Locators read the whole window either way.
   */
  readonly snapshot?: 'full' | 'interactive' | undefined;
  /**
   * Allows physical input: the real pointer and keyboard, which take focus
   * and move the cursor. Off by default: every action goes through the
   * accessibility API or into the app's own event queue, which leaves the
   * user's pointer and focus alone, and the app stays in the background. On,
   * `app.open()` brings the app forward, which some apps need before they
   * show a window, keys and typing go through the real keyboard, and the
   * engine also offers `doubleTap`, `hover`, and point-addressed taps.
   */
  readonly physicalInput?: boolean | undefined;
  /**
   * How long the engine waits after an action the agent took before the agent
   * observes again, in milliseconds; `false` skips the wait. A test's own
   * steps never wait: `expect` polls their outcome. Default 150.
   */
  readonly settle?: number | false | undefined;
  /**
   * How many levels of a window's accessibility tree a read goes down, from
   * 1 to 50. A read cut short at this depth cannot prove a control absent or
   * the only one, so a locator on such a window reads again until its
   * timeout: raise it for an app nested deeper. Default 24.
   */
  readonly maxDepth?: number | undefined;
}

const OPTION_KEYS = Object.keys({ snapshot: true, physicalInput: true, settle: true, maxDepth: true } satisfies Record<keyof DesktopOptions, true>);

/** The options with defaults applied, checked once at config load. */
export interface ResolvedDesktopOptions {
  readonly interactiveOnly: boolean;
  readonly physicalInput: boolean;
  readonly settleMs: number;
  readonly maxDepth: number;
}

const DEFAULT_SETTLE_MS = 150;

/** How deep a read goes by default: deeper than the controls of the apps tried, and quick to read. */
const DEFAULT_MAX_DEPTH = 24;

/** The deepest read the engine takes. */
const MAX_DEPTH_LIMIT = 50;

/** Checks the option bag the way every config option is checked: unknown keys and wrong types fail the config load. */
export function resolveOptions(options: DesktopOptions | undefined): ResolvedDesktopOptions {
  // Only a missing bag defaults: a null one (from JSON an agent wrote for e2e mcp) is a config error, not the defaults.
  const bag: DesktopOptions = options === undefined ? {} : options;
  if (typeof bag !== 'object' || bag === null) throw new ConfigurationError('INVALID_CONFIG', 'desktop() options must be an object');
  rejectUnknownKeys('desktop() options', bag, OPTION_KEYS);
  const { snapshot, physicalInput, settle, maxDepth } = bag;
  if (snapshot !== undefined && snapshot !== 'full' && snapshot !== 'interactive') {
    throw new ConfigurationError('INVALID_CONFIG', `desktop({ snapshot }) must be 'full' or 'interactive', got ${JSON.stringify(snapshot)}`);
  }
  if (physicalInput !== undefined && typeof physicalInput !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ physicalInput }) must be a boolean');
  }
  if (settle !== undefined && settle !== false && (!Number.isInteger(settle) || settle < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ settle }) must be a whole number of milliseconds, or false');
  }
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPTH_LIMIT)) {
    throw new ConfigurationError('INVALID_CONFIG', `desktop({ maxDepth }) must be a whole number from 1 to ${MAX_DEPTH_LIMIT}`);
  }
  return {
    interactiveOnly: snapshot === 'interactive',
    physicalInput: physicalInput === true,
    settleMs: settle === false ? 0 : (settle ?? DEFAULT_SETTLE_MS),
    maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH,
  };
}

/** Why the engine refuses this machine: it drives macOS only, and the native driver is built for nothing else. */
export function unsupportedPlatform(): string {
  return `desktop() is not supported on ${process.platform}: it drives macOS apps only`;
}

/** Fails with `UNSUPPORTED_CAPABILITY` on any OS but macOS, the only one the native driver is built for. */
export function requireMacOS(): void {
  if (process.platform !== 'darwin') throw new ConfigurationError('UNSUPPORTED_CAPABILITY', unsupportedPlatform());
}
