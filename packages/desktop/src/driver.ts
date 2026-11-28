/**
 * The native driver: the engine's Rust code (`crates/e2e-desktop-napi`), loaded into this
 * process through NAPI-RS. Each call that talks to another process runs on
 * a thread of its own and resolves with an envelope, `{ ok, data }` or
 * `{ ok, error }`; `call` bounds it by the operation's budget and signal and
 * translates a failure onto the engine error contract.
 *
 * | Driver result                                                 | Code                      |
 * | ------------------------------------------------------------- | ------------------------- |
 * | `STALE_REF`, `ELEMENT_NOT_FOUND`, sent nothing                | NODE_STALE (retryable)    |
 * | `APP_UNRESPONSIVE` that `details.retryable` says is safe to retry | NODE_STALE (retryable) |
 * | `ACTION_NOT_SUPPORTED`, `POLICY_DENIED`                       | UNSUPPORTED_CAPABILITY    |
 * | `APP_NOT_FOUND`, `WINDOW_NOT_FOUND`                           | INVALID_STATE             |
 * | `ACTION_FAILED`, `TIMEOUT`, sent nothing                      | NOT_ACTIONABLE            |
 * | `TIMEOUT` of a read                                           | OPERATION_TIMEOUT         |
 * | any failure of an input that may have been delivered          | ACTION_MAY_HAVE_COMMITTED |
 * | an input still running when the operation's budget ran out    | ACTION_MAY_HAVE_COMMITTED |
 * | a read still running when the operation's budget ran out      | OPERATION_TIMEOUT         |
 * | the operation's signal aborted                                | CANCELLED                 |
 * | anything else, `PERM_DENIED` included                         | ENGINE_FAILURE            |
 *
 * The driver states delivery on every failure (`disposition.delivery`), so
 * the line between "refused" and "may have committed" is its own, never a
 * guess from the error code. Text a fill types is an argument of a function
 * call in this process, which the driver hands to the app under test through
 * the Accessibility API: no helper process sees it.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { EngineError } from '@e2e-dev/core/engine';
import type { RawSnapshot, Rect } from './nodes.ts';

/** How the driver says whether a call reached the app. */
interface Disposition {
  readonly delivery?: string;
}

/** The `error` of a failed envelope. */
export interface DriverError {
  readonly code: string;
  readonly message: string;
  readonly disposition?: Disposition;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** What a call resolves with. */
export type Envelope<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: DriverError };

/** The window a point was taken in, which must still take a click at it. */
export interface PointerTarget {
  readonly pid: number;
  readonly windowId: string;
  readonly sheet: boolean;
  readonly sheetId?: string;
  /** The point is on a node with no ref, which takes no click of its own: no control may be under it when it goes. */
  readonly content?: boolean;
}

/** One window of a process, as `listWindows` answers. */
export interface RawWindow {
  readonly id: string;
  readonly title?: string;
  /** The app's key window, or the window its focused sheet or alert is on. */
  readonly is_focused?: boolean;
  /** Focus is in a sheet or an alert on this window, not the window itself. */
  readonly sheet_focused?: boolean;
  /** A key naming that sheet: its window server id, else one for its accessibility element. */
  readonly sheet_id?: string;
  /** The app's main window, which an app in the background still names while none has focus. */
  readonly is_main?: boolean;
  /** On screen now: false for a minimized window, or one on another Space. */
  readonly visible?: boolean;
  /** False for a window accessibility cannot read. */
  readonly accessible?: boolean;
  /** True for a window in the Dock, whose controls accessibility still reads. */
  readonly minimized?: boolean;
  readonly pid?: number;
  readonly bounds?: Rect;
  /** A dialog macOS itself adds to the app's windows (Siri's, on macOS 27), which a test never means by default. */
  readonly system?: boolean;
}

/** The process a launch started. */
export interface Launched {
  readonly pid: number;
  readonly app: string;
  readonly bundle_id?: string;
  /** When the process started, in microseconds since the epoch, read as the driver claimed it. */
  readonly started?: number;
  /** The copies of the app that ran before the launch, which the launch never claims. */
  readonly running_before: readonly number[];
}

/** What the driver can do: one function per native call. */
export interface DesktopDriver {
  /** The version of the package the driver came from, or `checkout build` for one built into this package's directory. */
  readonly version: string;
  status(): { readonly accessibility: boolean; readonly screenRecording: boolean };
  /** Whether the screen is locked; null when that cannot be told. */
  screenLocked(): boolean | null;
  /** When a process started, in microseconds since the epoch; null when it is not running. */
  processStarted(pid: number): number | null;
  /** Every process that carries the launch `token`, in its environment or its arguments; null when the processes cannot be listed. */
  processesCarrying(token: string): Promise<readonly number[] | null>;
  /** Drops the refs of a process that quit. */
  forgetProcess(pid: number): void;
  launch(options: {
    path?: string;
    bundleId?: string;
    arguments: readonly string[];
    environment: Readonly<Record<string, string>>;
    token: string;
    activate: boolean;
    /** The whole launch's budget: `open`, then the search for the process it started. */
    timeoutMs: number;
    /** How long that search may take once `open` has exited. */
    claimMs: number;
    /** Names the launch, so `cancelInput` can stop it before it starts the app. */
    inputId?: number;
  }): Promise<Envelope<Launched>>;
  listWindows(pid: number): Promise<Envelope<readonly RawWindow[]>>;
  snapshot(options: { pid: number; windowId: string; maxDepth: number; interactive: boolean; timeoutMs: number }): Promise<Envelope<RawSnapshot>>;
  /** `inputId` names the action, so `cancelInput` can stop it before it sends input. */
  act(options: { ref: string; action: string; value?: string; direction?: string; pages?: number; physical?: boolean; inputId?: number; timeoutMs: number }): Promise<Envelope<unknown>>;
  /** A fresh id for one call's input, unique across every worker thread of the process, which share the driver's cancel marks. */
  inputId(): number;
  /** Stops the action given `inputId`: it sends no input from then on. */
  cancelInput(inputId: number): void;
  /** `inputId` names the press, so `cancelInput` can stop it before it sends the key. */
  press(options: { pid: number; windowId: string; combo: string; physical: boolean; inputId?: number; timeoutMs: number; focusedRef?: string }): Promise<Envelope<unknown>>;
  /** Fails as `press` would for a combo this Mac's keyboard layout cannot type, and sends nothing. */
  checkCombo(combo: string): Promise<Envelope<unknown>>;
  /** `inputId` names the call, so `cancelInput` stops it before it changes the focus. */
  focusWindow(pid: number, windowId: string, inputId?: number, timeoutMs?: number): Promise<Envelope<unknown>>;
  /** Closes a window as its close button does, and answers once it left the app's windows. `inputId` names the call, so `cancelInput` stops it before the button is pressed. */
  closeWindow(pid: number, windowId: string, inputId?: number, timeoutMs?: number): Promise<Envelope<unknown>>;
  /**
   * `inputId` names the pointer input, so `cancelInput` stops what it has yet to send. With `target`, the window the
   * point was taken in, no click goes once another window or app took the focus from it, or its sheet changed: `sheet`
   * says whether one held the window's focus, and `sheetId` which.
   */
  pointer(x: number, y: number, kind: string, inputId?: number, timeoutMs?: number, target?: PointerTarget): Promise<Envelope<unknown>>;
  screenshot(options: { windowId: string; path: string; timeoutMs: number }): Promise<Envelope<{ readonly scale_factor?: number }>>;
}

/** The npm package that ships the driver built for each platform. */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'darwin-arm64': '@e2e-dev/desktop-darwin-arm64',
  'darwin-x64': '@e2e-dev/desktop-darwin-x64',
};

const ownRequire = createRequire(import.meta.url);

/**
 * Loads the driver built for this machine: a build in this package's
 * directory (`pnpm build:native` in a checkout), else the
 * platform package npm installed beside this one. Throws
 * `UNSUPPORTED_CAPABILITY` on a platform no driver is built for, and
 * `ENGINE_FAILURE` naming what is missing on one that has a driver.
 */
export function loadNativeDriver(): DesktopDriver {
  const platform = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[platform];
  if (packageName === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `@e2e-dev/desktop has no native driver for ${process.platform} on ${process.arch}: it drives macOS apps only`, { retryable: false });
  }
  const failures: string[] = [];
  // A build in the package directory exists only in a checkout (the package ships `dist` alone), and is the one just built there:
  // a platform package placed by a canary build stays in the checkout, and must not hide it.
  const builds: readonly [string, () => string][] = [
    [path.join(import.meta.dirname, '..', `desktop.${platform}.node`), () => 'checkout build'],
    [packageName, () => (ownRequire(`${packageName}/package.json`) as { version: string }).version],
  ];
  for (const [specifier, version] of builds) {
    try {
      return { ...(ownRequire(specifier) as Omit<DesktopDriver, 'version'>), version: version() };
    } catch (cause) {
      failures.push(`${specifier}: ${(cause as Error).message.split('\n')[0] ?? ''}`);
    }
  }
  throw new EngineError('ENGINE_FAILURE', `the desktop engine's native driver could not be loaded; install ${packageName}, which npm installs with @e2e-dev/desktop on this platform (${failures.join('; ')})`, { retryable: false });
}

/** A failure the driver reported, before translation, for a caller that tries another way when nothing was sent. */
export class DriverFailure extends Error {
  readonly code: string;
  /** Whether the driver says nothing reached the app, so another way may be tried. */
  readonly notDelivered: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(failure: DriverError) {
    super(failure.message);
    this.name = 'DriverFailure';
    this.code = failure.code;
    this.notDelivered = failure.disposition?.delivery === 'not_delivered';
    this.details = failure.details ?? {};
  }

  /** The copies of the app a failed launch says ran before it; none when it names none. */
  get runningBefore(): readonly number[] {
    const before = this.details.running_before;
    return Array.isArray(before) ? before.filter((pid): pid is number => typeof pid === 'number') : [];
  }
}

/** The least time an input gets once started, however little budget was left: a click that lands is then not reported as cut off. A read gets exactly its budget. */
const MIN_INPUT_MS = 500;

/** One driver call to bound and translate. */
export interface DriverCall {
  /** Whether the call sends input to an app; decides how a cut-off or failed call is reported. */
  readonly input: boolean;
  readonly signal: AbortSignal;
  /** The call is given up once this budget is spent. */
  readonly timeoutMs: number;
  /** Names the call in an error message. */
  readonly label: string;
  /** Runs when the budget or the signal cuts the call off, to stop work the driver would otherwise go on with. */
  readonly onCutOff?: () => void;
}

/**
 * Runs one driver call and returns its `data`. A failure the envelope
 * reports is thrown as `DriverFailure`, untranslated, so a caller can try
 * another way when nothing was sent; `translate` turns it into the engine
 * contract. A call cut off by the budget or the signal keeps running on its
 * thread, and its answer is dropped: an input may still land, which is why
 * it is reported as one that may have committed. `onCutOff` then stops what
 * the driver can stop, such as any input an action had yet to send.
 */
export async function call<T>(start: () => Promise<Envelope<T>>, options: DriverCall): Promise<T> {
  if (options.signal.aborted) throw new EngineError('CANCELLED', `${options.label} was cancelled`, { retryable: false });
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const cutOff = new Promise<'timeout' | 'aborted'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.input ? Math.max(options.timeoutMs, MIN_INPUT_MS) : options.timeoutMs);
    onAbort = () => resolve('aborted');
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
  let outcome: Envelope<T> | 'timeout' | 'aborted';
  try {
    outcome = await Promise.race([start(), cutOff]);
  } catch (cause) {
    throw new EngineError('ENGINE_FAILURE', `${options.label}: the native driver failed: ${(cause as Error).message}`, { retryable: false, cause });
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal.removeEventListener('abort', onAbort);
  }
  if (outcome === 'aborted' || outcome === 'timeout') options.onCutOff?.();
  if (outcome === 'aborted') throw new EngineError('CANCELLED', `${options.label} was cancelled`, { retryable: false });
  if (outcome === 'timeout') {
    throw options.input
      ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${options.label} timed out before the driver answered; its input may have reached the app`, { retryable: false })
      : new EngineError('OPERATION_TIMEOUT', `${options.label} timed out`, { retryable: false });
  }
  if (!outcome.ok) throw new DriverFailure(outcome.error);
  return outcome.data;
}

const STALE_CODES = new Set(['STALE_REF', 'ELEMENT_NOT_FOUND']);
const UNSUPPORTED_CODES = new Set(['ACTION_NOT_SUPPORTED', 'POLICY_DENIED']);
const GONE_CODES = new Set(['APP_NOT_FOUND', 'WINDOW_NOT_FOUND']);
const REFUSED_CODES = new Set(['ACTION_FAILED', 'TIMEOUT']);

/**
 * The engine error for a failure of `label`. An `EngineError` passes through.
 * `input` says whether the call sent input to the app: its failure is
 * `ACTION_MAY_HAVE_COMMITTED` unless the driver says nothing was sent.
 */
export function translate(cause: unknown, label: string, input: boolean): Error {
  if (!(cause instanceof DriverFailure)) return cause instanceof Error ? cause : new EngineError('ENGINE_FAILURE', `${label}: ${String(cause)}`, { retryable: false });
  const text = `${label}: ${cause.message}`;
  if (input && !cause.notDelivered) return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${text} (the input may have reached the app)`, { retryable: false, cause });
  if (STALE_CODES.has(cause.code)) return new EngineError('NODE_STALE', text, { retryable: true, cause });
  // A read the driver says is safe to try again (the app was busy): read again, as a stale one.
  if (cause.code === 'APP_UNRESPONSIVE' && cause.details.retryable === true) return new EngineError('NODE_STALE', text, { retryable: true, cause });
  if (UNSUPPORTED_CODES.has(cause.code)) return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false, cause });
  if (GONE_CODES.has(cause.code)) return new EngineError('INVALID_STATE', `${text}; open the app with app.open()`, { retryable: false, cause });
  // A read that ran out of time is a timeout; only an input that could not be delivered in time is not actionable.
  if (cause.code === 'TIMEOUT' && !input) return new EngineError('OPERATION_TIMEOUT', text, { retryable: false, cause });
  if (REFUSED_CODES.has(cause.code)) return new EngineError('NOT_ACTIONABLE', text, { retryable: false, cause });
  if (cause.code === 'PERM_DENIED') {
    return new EngineError('ENGINE_FAILURE', `${text}. Grant Accessibility (and Screen Recording, for screenshots) to the app that starts e2e, such as your terminal, then run again`, { retryable: false, cause });
  }
  return new EngineError('ENGINE_FAILURE', text, { retryable: false, cause });
}
