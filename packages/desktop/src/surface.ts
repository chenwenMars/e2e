/**
 * One worker's desktop session: the macOS app the target declares, driven
 * through the engine's native driver (`driver.ts`). The app is launched in
 * the background, and every action goes through the accessibility API or
 * into the app's own event queue, so the user's pointer, focus, and typing
 * stay where they are, unless the target opts into physical input with
 * `physicalInput`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConfigurationError,
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  resolveExpression,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareResult,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type SelectOption,
  type SemanticNode,
  type ViewportPoint,
} from '@e2e-dev/core/engine';
import { call, DriverFailure, loadNativeDriver, translate, type DesktopDriver, type Envelope, type Launched, type RawWindow } from './driver.ts';
import { toCombo } from './keys.ts';
import { abandon, alive, APP_FILE, checkBundle, inheritedEnv, killed, OWNER_FILE, sleep, STATE_PREFIX, sweepStateDirectories } from './launch-ownership.ts';
import { launchArgumentList } from './launch-arguments.ts';
import { handOffClause, type WindowsRead } from './launch-report.ts';
import { LAUNCH_READY_MS, QUIT, windowReadable } from './launch-wait.ts';
import { ROOT_ID, projectSnapshot, type NodeBinding, type ProjectedScreen, type RawSnapshot, type Rect } from './nodes.ts';
import type { DesktopPlatform, ResolvedDesktopOptions } from './options.ts';
import { describeCapture, encodePng, windowImage } from './png.ts';

/** How long a quit waits for a launch whose outcome was unknown to report the process it started. */
const PENDING_SETTLE_MS = 3_000;

/** How much of a quit's budget is kept for a killed process to exit. */
const EXIT_WAIT_MS = 500;

/** How long a quit looks for an app a launch that answered without one may still have started. */
const LATE_APP_MS = 2_000;

/** How often it looks. */
const LATE_APP_POLL_MS = 100;

/** How far a swipe scrolls, in screens of the scrolled area, by its momentum: the web engine's strides, so a momentum means the same on every engine. */
const SWIPE_PAGES = { slow: 0.75, none: 0.5, fast: 1.5 } as const;

/** The cause of an input that was never sent, because the operation's budget ran out first. */
const NOT_SENT = new Error('the operation ran out of budget before anything was sent');

/** The cause of a read that found the app's windows but could read none of them. */
const UNREADABLE = new Error('no window of the app could be read');

/** The cause of a screenshot withheld because its secure fields could not be shown masked, which the harness reads as masking it could not prove. */
const UNMASKED = new Error('the secure fields of the screenshot could not be placed');

/** Launch arguments every launch gets first: no window or document the app saved at its last quit comes back. */
const FRESH_STATE_ARGUMENTS = ['-ApplePersistenceIgnoreState', 'YES'];

/** The most elements one driver snapshot reads (`MAX_NODES` in `crates/e2e-desktop-napi/src/snapshot.rs`): a larger window is read in part. */
const MAX_SNAPSHOT_NODES = '8,000';

/** How much sooner than the call's cut-off the driver stops a read, so a read cut short still answers with what it read. */
const READ_ANSWER_MARGIN_MS = 200;

/** How many node bindings stay usable; the oldest go first. */
const MAX_BINDINGS = 4096;

/** Codes a read fails with while the app has no window to read: not launched yet, still opening, or just closed. */
const NO_WINDOW_CODES = new Set(['APP_NOT_FOUND', 'WINDOW_NOT_FOUND']);

/** One open window of the app under test, as the `desktop` fixture's window handles read it. */
export interface OpenWindow {
  /** The window server's id of the window, valid while the window stays open. */
  readonly id: string;
  readonly title: string;
  /** Whether it is the active window, the one `screen` reads. */
  readonly active: boolean;
  /** Whether it is a window of the app's own that accessibility reads: not a dialog macOS put over the app, nor one only the window server lists. */
  readonly readable: boolean;
}

/** What a target launches: a `.app` bundle on disk, or an installed app by bundle id or name. */
type LaunchTarget = { readonly path: string; readonly label: string } | { readonly bundleId: string; readonly label: string };

/**
 * A launch whose outcome is unknown: its token, and the driver's answer,
 * which may still name the process it started, or say it started none
 * (`not_started`: refused before `open` ran).
 */
interface PendingLaunch {
  readonly target: string;
  readonly token: string;
  readonly settled: Promise<Launched | 'not_started' | undefined>;
}

/** What a state directory's launch record keeps: the launch's token, and once the process is known, its id and when it started. */
interface LaunchRecord {
  readonly token: string;
  readonly pid?: number;
  readonly started?: number;
}

/** One attempt's bookkeeping. */
interface Attempt {
  readonly artifactsDir: string;
  screenshots: number;
  readonly screen?: (snapshot: EngineSnapshot) => void;
}

/** A read that ran out of time, which proves nothing absent: a retryable `NODE_STALE` that says what it could not tell. */
function partialRead(what: string): EngineError {
  return new EngineError('NODE_STALE', `the window was read only in part, as the read ran out of time, so ${what} cannot be told`, { retryable: true, cause: UNREADABLE });
}

function notActionable(text: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
}

function unsupported(text: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

/**
 * The operation with one deadline: `timeoutMs` reads what is left of the
 * budget the call started with, so every call an action makes (a press
 * that focuses first, a type that clears first) shares one budget instead
 * of each getting the whole of it.
 */
function withDeadline(operation: OperationContext): OperationContext {
  const deadline = Date.now() + operation.timeoutMs;
  return {
    ...operation,
    get timeoutMs() {
      return Math.max(0, deadline - Date.now());
    },
  };
}

/** Constrains a caller-supplied artifact label to a safe filename. */
function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}

/** Every query kind an expression uses, in it and in the expressions it is built from. */
function queryKinds(expression: LocatorExpression, kinds = new Set<string>()): Set<string> {
  switch (expression.kind) {
    case 'query':
      kinds.add(expression.query.kind);
      if (expression.scope !== undefined) queryKinds(expression.scope, kinds);
      break;
    case 'filter':
      queryKinds(expression.source, kinds);
      if (expression.has !== undefined) queryKinds(expression.has, kinds);
      if (expression.hasNot !== undefined) queryKinds(expression.hasNot, kinds);
      break;
    case 'index':
    case 'frame':
      queryKinds(expression.source, kinds);
      break;
    case 'union':
      queryKinds(expression.left, kinds);
      queryKinds(expression.right, kinds);
      break;
    default:
      break;
  }
  return kinds;
}

/** The label a select names: a bare string, or `{ label }`; a `value` is a desktop option's label too, since a native list has no other value. */
function optionLabel(option: SelectOption): string {
  if (typeof option === 'string') return option;
  if (option.label !== undefined) return option.label;
  if (option.value !== undefined) return option.value;
  throw unsupported('a desktop list selects an option by its label; select by { index } is not supported');
}

export class DesktopSurface {
  private driver: DesktopDriver | undefined;
  private home: string | undefined;
  private app: EngineAppInfo = {};
  private projectRoot = process.cwd();
  /** What `app.open()` launches: the target's `appPath` bundle, resolved, else its `bundleId`. */
  private launchTarget: LaunchTarget | undefined;
  /** Whether the app is launched in the foreground: with `desktop({ physicalInput })`, or a run that asked for a visible surface (`--headed`). Physical input stays with `desktop({ physicalInput })` alone, since the engine declares it when it is created. */
  private foreground = false;
  /** The app's name, for messages and the observed location. */
  private appName: string | undefined;
  /** The process the engine launched, which it alone quits; another instance of the same app is never touched. */
  private pid: number | undefined;
  /** When that process started, which a later process given the same id does not share. */
  private started: number | undefined;
  /** The token the launch put in that process's environment. */
  private token: string | undefined;
  /**
   * A launch whose outcome is unknown (it timed out, or failed after it may
   * have started the app), so the next quit can still find and end the
   * process it started.
   */
  private pending: PendingLaunch | undefined;
  private attempt: Attempt | undefined;
  /** The launch or quit running now, which the next one waits for. */
  private lifecycle: Promise<unknown> = Promise.resolve();
  /** The window a test made active with `window.activate()`, which every read and command then uses until it closes or the app quits. */
  private chosenWindow: string | undefined;
  /**
   * The window of the newest screen handed to the harness, by observe or locate: the one a point is measured in, the
   * agent's as core hit-tests it, against the newest observation. `sheet` says whether a sheet held its focus then: one
   * that opened since was not where the point was taken.
   */
  private pointWindow: { readonly id: string; readonly sheet: string | undefined } | undefined;
  /** The newest binding of every node id an observation or a locate handed out, newest last. */
  private readonly bindings = new Map<string, NodeBinding>();
  /** The id handed out for each node identity since the app launched; see `projectSnapshot`. */
  private readonly ids = new Map<string, string>();
  private sequence = 0;
  private driverVersion = 'unknown';
  /** The run's environment cut to `INHERITED_ENV`: all the app is given of it. */
  private appEnv: Readonly<Record<string, string>> = {};

  /** `loadDriver` is how the native driver is loaded; tests pass a scripted one. */
  constructor(
    readonly options: ResolvedDesktopOptions,
    readonly platform: DesktopPlatform,
    private readonly loadDriver: () => DesktopDriver = loadNativeDriver,
  ) {}

  // --- lifecycle ---

  /** Loads the native driver once in the runner, so a machine without it fails before any test starts. */
  async prepare(): Promise<EnginePrepareResult> {
    this.loadDriver();
    // One worker per target: two would share one screen and one app.
    return { workers: 1 };
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.app = info.app;
    // An engine handle can serve one host after another: nothing of the last one's app carries over. A launch it could not settle stays in its launch record, which the sweep below takes.
    this.appName = undefined;
    this.pid = undefined;
    this.started = undefined;
    this.token = undefined;
    this.pending = undefined;
    this.forget();
    this.foreground = this.options.physicalInput || info.headed;
    const driver = (this.driver = this.loadDriver());
    this.appEnv = inheritedEnv(info.env);
    // A worker that was killed left its launch record behind, and maybe the app it launched.
    await sweepStateDirectories(driver);
    // A private state directory per worker, named for the process that owns it so a later sweep can tell it was left behind.
    this.home = await mkdtemp(path.join(tmpdir(), STATE_PREFIX));
    const started = driver.processStarted(process.pid);
    await writeFile(path.join(this.home, OWNER_FILE), started === null ? String(process.pid) : `${process.pid}\n${started}`);
    const status = driver.status();
    this.driverVersion = driver.version;
    if (!status.accessibility) {
      throw new EngineError(
        'ENGINE_FAILURE',
        'the desktop engine has no Accessibility permission. In System Settings > Privacy & Security > Accessibility, allow the app that starts e2e (your terminal, IDE, or CI agent), then run again',
        { retryable: false },
      );
    }
    this.launchTarget = await this.resolveLaunchTarget(info.signal);
    info.log(`desktop driver ${this.driverVersion} on macOS`);
  }

  /**
   * What `app.open()` launches. An `appPath` on macOS is an `.app` bundle,
   * which is what gets launched even when `bundleId` is set too, and its
   * `CFBundleIdentifier` must then equal `bundleId`.
   */
  private async resolveLaunchTarget(signal: AbortSignal): Promise<LaunchTarget | undefined> {
    if (this.app.appPath === undefined) return this.app.bundleId === undefined ? undefined : { bundleId: this.app.bundleId, label: this.app.bundleId };
    const bundle = path.resolve(this.projectRoot, this.app.appPath);
    const checked = await checkBundle(bundle, this.app.bundleId, signal);
    if ('problem' in checked) throw new EngineError('ENGINE_FAILURE', checked.problem, { retryable: false });
    return { path: await realpath(bundle), label: checked.bundleId };
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running on this desktop engine');
    this.attempt = { artifactsDir: context.artifactsDir, screenshots: 0, ...(context.screen === undefined ? {} : { screen: context.screen }) };
    this.forget();
    context.environment({ platform: this.platform, 'desktop-driver': this.driverVersion });
  }

  /**
   * Quits the app the attempt launched, so the next test starts from a
   * closed app as the first one did. A quit that fails is reported, and the
   * engine keeps the process as its own, so `dispose` tries again.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    this.attempt = undefined;
    this.forget();
    await this.quit(context.signal, context.timeoutMs);
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    let quit = false;
    try {
      await this.quit(context.signal, context.timeoutMs);
      quit = true;
    } finally {
      // An app that would not quit, or a launch whose process was never found, stays named in the launch record, which the next run's sweep quits.
      const leftRunning = !quit && (this.pid !== undefined || this.pending !== undefined);
      if (this.home !== undefined) await (leftRunning ? abandon(this.home) : rm(this.home, { recursive: true, force: true })).catch(() => undefined);
      this.home = undefined;
      this.driver = undefined;
      this.attempt = undefined;
      this.forget();
    }
  }

  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const checks: EngineDoctorCheck[] = [];
    let driver: DesktopDriver | undefined;
    try {
      driver = this.loadDriver();
    } catch (cause) {
      checks.push({ id: 'desktop-driver', status: 'fail', message: (cause as Error).message });
    }
    if (driver !== undefined) {
      const status = driver.status();
      checks.push(
        { id: 'desktop-driver', status: 'pass', message: `desktop driver ${driver.version}` },
        status.accessibility
          ? { id: 'accessibility', status: 'pass', message: 'Accessibility permission granted' }
          : { id: 'accessibility', status: 'fail', message: 'Allow the app that starts e2e in System Settings > Privacy & Security > Accessibility' },
        status.screenRecording
          ? { id: 'screen-recording', status: 'pass', message: 'Screen Recording permission granted' }
          : { id: 'screen-recording', status: 'warn', message: 'Screenshots need Screen Recording: allow the app that starts e2e in System Settings > Privacy & Security > Screen Recording' },
      );
    }
    if (info.app.appPath !== undefined) {
      const bundle = path.resolve(info.projectRoot, info.app.appPath);
      // What init checks of the bundle, so a bundle doctor passes is one init accepts.
      const checked = existsSync(bundle) ? await checkBundle(bundle, info.app.bundleId, info.signal) : { problem: `app.appPath ${bundle} does not exist; build the app or fix the path` };
      checks.push('problem' in checked ? { id: 'app-path', status: 'fail', message: checked.problem } : { id: 'app-path', status: 'pass', message: bundle });
    }
    return checks;
  }

  // --- the app ---

  /**
   * `app.open()`: the copy of the app the engine launched is quit, and the
   * app launched fresh, in the background unless `physicalInput` or the run's
   * `--headed`, with the target's launch arguments. A copy the engine did
   * not launch (the developer's own) is left alone, and never read or
   * driven. A launch that failed after the app started still leaves the
   * engine owning the new process, so the end of the attempt quits it.
   */
  async restart(context: OperationContext): Promise<void> {
    // The budget counts from the call, so time spent waiting for another launch or quit is part of it.
    const operation = withDeadline(context);
    await this.serially(() => this.launchFresh(operation));
  }

  /** `restart` once no other launch or quit of this surface is running. */
  private async launchFresh(operation: OperationContext): Promise<void> {
    const target = this.launchTarget;
    if (target === undefined) throw unsupported("launching the app needs the target's app.bundleId or app.appPath");
    const driver = this.requireDriver();
    // A failed launch that left no process is nothing to clean up before a new one.
    await this.quitNow(operation.signal, operation.timeoutMs, false);
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `launch ${target.label}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    // Marks the process this launch starts, so it is told apart from every other copy by evidence, never by timing.
    const token = randomUUID();
    // Written before anything is sent, so the app stays findable by its token if this worker is killed mid-launch.
    await this.writeRecord({ token });
    // The write takes time too: a launch sent with no budget left would start the app after the open gave up.
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `launch ${target.label}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    // Started by `call`, which starts nothing once the signal aborted: a cancelled open never launches the app.
    let started: Promise<Envelope<Launched>> | undefined;
    // A cut-off launch whose `open` has not run yet starts no app.
    const inputId = this.requireDriver().inputId();
    const start = (): Promise<Envelope<Launched>> =>
      (started = driver.launch({
        ...('path' in target ? { path: target.path } : { bundleId: target.bundleId }),
        arguments: [...FRESH_STATE_ARGUMENTS, ...launchArgumentList(this.app)],
        environment: this.appEnv,
        token,
        // In the background unless `physicalInput` or the run's `--headed`: otherwise the app takes the keyboard from whoever is at the Mac.
        activate: this.foreground,
        timeoutMs: operation.timeoutMs,
        claimMs: LAUNCH_READY_MS,
        inputId,
      }));
    let launched: Launched;
    try {
      launched = await call(start, { label: `launch ${target.label}`, input: true, signal: operation.signal, timeoutMs: operation.timeoutMs, onCutOff: () => driver.cancelInput(inputId) });
    } catch (cause) {
      // A launch the driver refused started nothing; any other may have started the app, which the next quit looks for.
      if (started !== undefined && !(cause instanceof DriverFailure && cause.notDelivered)) {
        this.pending = { target: target.label, token, settled: started.then((answer: Envelope<Launched>) => (answer.ok ? answer.data : answer.error.disposition?.delivery === 'not_delivered' ? 'not_started' : undefined), () => undefined) };
      }
      throw this.launchFailure(cause, target);
    }
    this.appName = launched.app === '' ? target.label : launched.app;
    this.pid = launched.pid;
    this.token = token;
    this.started = launched.started ?? driver.processStarted(launched.pid) ?? undefined;
    // The process and when it started, so a later run can quit it, and never a later process given the same id.
    await this.writeRecord({ token, pid: launched.pid, ...(this.started === undefined ? {} : { started: this.started }) });
    this.forget();
    await windowReadable(operation, {
      app: this.appName,
      foreground: this.foreground,
      // A checkout's addon built before the driver reported them answers without the list.
      runningBefore: launched.running_before ?? [],
      read: (timeoutMs) => this.readWindows(withDeadline({ ...operation, timeoutMs })),
      readable: (read) => this.readable(read),
      exited: async () => {
        if (this.pid === undefined || (await this.running(this.pid))) return false;
        this.forget();
        this.dropProcess();
        return true;
      },
      screenLocked: () => driver.screenLocked(),
    });
  }

  /** The engine error for a failed launch, naming what to fix where the driver says what went wrong. */
  private launchFailure(cause: unknown, target: LaunchTarget): Error {
    if (cause instanceof DriverFailure && cause.notDelivered) {
      if (cause.code === 'APP_NOT_FOUND') return new EngineError('ENGINE_FAILURE', `${cause.message}; check the target's app.bundleId or app.appPath`, { retryable: false, cause });
      if (cause.details.kind === 'not_started') return new EngineError('ENGINE_FAILURE', `launch ${target.label}: ${cause.message}`, { retryable: false, cause });
    }
    if (cause instanceof DriverFailure && cause.details.kind === 'unclaimed') {
      return new EngineError('ACTION_MAY_HAVE_COMMITTED', `${cause.message}, so none can be shown to be its own; the end of the attempt looks for it again${handOffClause('; ', cause.runningBefore)}`, { retryable: false, cause });
    }
    return translate(cause, `launch ${target.label}`, true);
  }

  /** Puts the launch record in the state directory, renamed into place so a worker killed mid-write never leaves half a record. */
  private async writeRecord(record: LaunchRecord): Promise<void> {
    if (this.home === undefined) return;
    const file = path.join(this.home, APP_FILE);
    await writeFile(`${file}.partial`, JSON.stringify(record));
    await rename(`${file}.partial`, file);
  }

  /** The windows of the app the engine launched, for the `desktop` fixture; none while it is not running. */
  async windows(operation: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<readonly OpenWindow[]> {
    const windows = await this.ownWindows(operation);
    const active = this.activeWindow(windows)?.id;
    return windows.map((window) => ({ id: window.id, title: window.title ?? '', active: window.id === active, readable: window.system !== true && window.accessible !== false }));
  }

  /**
   * `window.activate()`: reads and acts in the window `id` names from now
   * on, rather than the focused one, until it closes or the app quits.
   */
  async activateWindow(id: string, operation: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<void> {
    const windows = await this.ownWindows(operation);
    if (!windows.some((window) => window.id === id)) throw notActionable('the window has closed; desktop.windows() lists the open ones');
    this.chosenWindow = id;
    // A point taken in the window read before is not in this one's coordinates: the next point action measures from the window now in use.
    this.pointWindow = undefined;
  }

  /**
   * `window.close()`: closes the window `id` names as its close button does.
   * One that already closed is left alone.
   */
  async closeWindow(id: string, operation: OperationContext): Promise<void> {
    const { pid } = this;
    if (pid === undefined) return;
    const inputId = this.requireDriver().inputId();
    await this.input((driver, timeoutMs) => driver.closeWindow(pid, id, inputId, timeoutMs), {
      label: 'close window',
      input: true,
      signal: operation.signal,
      timeoutMs: operation.timeoutMs,
      onCutOff: () => this.driver?.cancelInput(inputId),
    }).catch((cause: unknown) => {
      // Already closed: the driver found no such window, and pressed nothing. One accessibility cannot read is still open.
      if (cause instanceof DriverFailure && cause.notDelivered && cause.code === 'WINDOW_NOT_FOUND' && cause.details.kind === undefined) return;
      // The app is open and the window is there: it has no close button, or accessibility cannot reach it.
      if (cause instanceof DriverFailure && cause.notDelivered && (cause.code === 'WINDOW_NOT_FOUND' || cause.code === 'ACTION_NOT_SUPPORTED')) throw notActionable(`close window: ${cause.message}`);
      throw translate(cause, 'close window', true);
    });
  }

  /**
   * The window a test made active, while the app still lists it. Once it
   * closed, commands follow the focused window again, as a closed tab hands
   * the screen to another. A locked screen lists no window, which is no proof
   * that one closed: it is a retryable `NODE_STALE`.
   */
  private activeChoice(windows: readonly RawWindow[]): string | undefined {
    const chosen = this.chosenWindow;
    if (chosen === undefined || windows.some((window) => window.id === chosen)) return chosen;
    this.unlessLocked();
    this.chosenWindow = undefined;
    this.pointWindow = undefined;
    return undefined;
  }

  /** The window a command reads or acts in: the one the test made active, else the first by `byPreference`. */
  private activeWindow(windows: readonly RawWindow[]): RawWindow | undefined {
    const chosen = this.activeChoice(windows);
    return chosen === undefined ? byPreference(windows)[0] : windows.find((window) => window.id === chosen);
  }

  /** `desktop.closeApp()`: the app quit, as at the end of every test. */
  async closeApp(signal: AbortSignal, timeoutMs: number): Promise<void> {
    await this.quit(signal, timeoutMs);
  }

  /**
   * Runs launches and quits of this surface one at a time: two at once would
   * each launch a copy into the one process id and launch record the engine
   * keeps, and the end of the attempt would quit only one of them.
   */
  private serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(run, run);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  /** `quitNow` once no other launch or quit of this surface is running. */
  private quit(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return this.serially(() => this.quitNow(signal, timeoutMs));
  }

  /**
   * Quits the app the engine launched, forcefully: a test needs it gone, not
   * asked to save. It is ended by its process id, so another instance of the
   * same app (the developer's own copy) is left alone, and waited for, so the
   * next launch cannot find it still running. A process that exited on its
   * own, or whose id the OS gave to another process since, is not running
   * any more, and nothing is killed. Until the process is known to be gone,
   * the engine keeps it as its own, so a quit that failed is tried again. A
   * failed launch that turns out to have left no process is reported, so the
   * user can look for a copy by hand, unless `reportMissing` is false, as
   * before a new launch.
   */
  private async quitNow(signal: AbortSignal, timeoutMs: number, reportMissing = true): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pending = this.pending;
    if (this.pid === undefined && pending !== undefined) {
      // The driver may still report the process the launch started: wait for it, short of the quit's budget by `EXIT_WAIT_MS`, so a process found at the end can still be seen to exit.
      const wait = Math.min(Math.max(timeoutMs - EXIT_WAIT_MS, 0), PENDING_SETTLE_MS);
      const settled = await settleWithin(pending.settled, wait, signal);
      if (signal.aborted) throw new EngineError('CANCELLED', `looking for the process a launch of ${pending.target} started was cancelled`, { retryable: false });
      // The driver gave the launch up before `open` ran: it started no app, and there is nothing to look for.
      if (settled === 'not_started') {
        this.pending = undefined;
        if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
        return;
      }
      // A process carrying the launch's token is its own, whether or not the driver reported it.
      const carriers = await this.requireDriver().processesCarrying(pending.token);
      if (carriers === null) {
        throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${pending.target} started the app: looking for its token among the processes failed; quitting tries again`, { retryable: false });
      }
      const owned = new Set(carriers);
      // The process the launch answered with, while it is still that process: its id may be another's by now.
      if (settled !== 'timeout' && settled !== undefined && (carriers.includes(settled.pid) || (settled.started !== undefined && this.requireDriver().processStarted(settled.pid) === settled.started))) {
        owned.add(settled.pid);
      }
      // A launch that answered without a process may have started the app a moment later: look again, within the budget.
      if (owned.size === 0 && settled !== 'timeout') {
        const whole = Date.now() + LATE_APP_MS;
        for (const pid of await this.lateCarriers(pending.token, Math.min(deadline - EXIT_WAIT_MS, whole), whole, signal, pending.target)) owned.add(pid);
      }
      if (!(await killed([...owned], deadline, signal))) {
        throw new EngineError('ENGINE_FAILURE', `the process a launch of ${pending.target} started did not exit; quitting tries again`, { retryable: false });
      }
      // A launch still running may yet start the app: it stays pending.
      if (owned.size === 0 && settled === 'timeout') {
        throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${pending.target} started the app: it had not finished; quitting tries again`, { retryable: false });
      }
      this.pending = undefined;
      for (const pid of owned) this.requireDriver().forgetProcess(pid);
      if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
      if (owned.size > 0 || !reportMissing) return;
      throw new EngineError('ENGINE_FAILURE', `a launch of ${pending.target} failed, and no process it started was found; if the app is running, quit it by hand`, { retryable: false });
    }
    const { pid } = this;
    this.forget();
    if (pid === undefined) return;
    if ((await this.running(pid)) && !(await killed([pid], deadline, signal))) throw new EngineError('ENGINE_FAILURE', `the app (process ${pid}) did not exit`, { retryable: false });
    this.driver?.forgetProcess(pid);
    this.dropProcess();
    if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
  }

  /**
   * The processes carrying a launch's token, looked for until one appears or `until` passes; none when none did through
   * the whole wait, which ends at `whole`. A cancel throws `CANCELLED`, and a scan that failed or a wait cut short of
   * `whole` `ENGINE_FAILURE`, so the launch stays pending.
   */
  private async lateCarriers(token: string, until: number, whole: number, signal: AbortSignal, target: string): Promise<readonly number[]> {
    // None found is a finding only after a whole wait of scans that answered: a cancel, a scan that failed, or a wait
    // the budget cut short proves nothing, and the launch's record must stay for the next quit or sweep.
    let failed = false;
    while (Date.now() < until && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, LATE_APP_POLL_MS));
      const carriers = await this.requireDriver().processesCarrying(token);
      if (carriers === null) failed = true;
      else if (carriers.length > 0) return carriers;
    }
    if (signal.aborted) throw new EngineError('CANCELLED', `looking for the process a launch of ${target} started was cancelled`, { retryable: false });
    if (failed) throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${target} started the app: looking for its token among the processes failed; quitting tries again`, { retryable: false });
    if (until < whole) throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${target} started the app: the quit ran out of time to look for it; quitting tries again`, { retryable: false });
    return [];
  }

  /**
   * Whether the process the engine launched still runs: the id alone does
   * not show that, since another process can take it over once the app
   * quits, so it must have started when the launch's did, or else carry the
   * launch's token. A process that cannot be told either way throws, and
   * stays the engine's, so a quit tries again and the launch record stays.
   */
  private async running(pid: number): Promise<boolean> {
    if (!alive(pid)) return false;
    const driver = this.requireDriver();
    if (this.started !== undefined) {
      const now = driver.processStarted(pid);
      if (now !== null) return now === this.started;
      // Gone between the two looks; still there, its start unreadable, it is the app only if it carries the token.
      if (!alive(pid)) return false;
    }
    const carriers = this.token === undefined ? null : await driver.processesCarrying(this.token);
    if (carriers === null) throw new EngineError('ENGINE_FAILURE', `could not tell whether process ${pid} is still the app the engine launched; quitting tries again`, { retryable: false });
    return carriers.includes(pid);
  }

  /** Forgets the launched process, once it is gone. */
  private dropProcess(): void {
    this.pid = undefined;
    this.started = undefined;
    this.token = undefined;
  }

  /** Every binding of the screen before: after a launch or a quit, none names a control that still exists. */
  private forget(): void {
    this.pointWindow = undefined;
    this.chosenWindow = undefined;
    this.bindings.clear();
    this.ids.clear();
  }

  /** The node id for an identity: the one it had before, else a new one, never handed out before since the app launched. */
  private idFor(identity: string | undefined): string {
    let id = identity === undefined ? undefined : this.ids.get(identity);
    if (id === undefined) {
      id = `n${(this.sequence += 1)}`;
      if (identity !== undefined) this.ids.set(identity, id);
    }
    return id;
  }

  /**
   * Projects a snapshot of one window, its node identities scoped to that
   * window. An identity of that window a complete snapshot no longer has is
   * retired: a control that went, or now has a look-alike sibling, never
   * passes its id on to another. A snapshot cut short retires only the
   * identities it saw a look-alike take. Another window's identities stay, so
   * its controls keep their ids when it is read again.
   */
  private projectWindow(raw: RawSnapshot, minimized: boolean, interactive: boolean): ProjectedScreen {
    // An interactive read prunes the tree, a whole one does not: each keeps its own identities, so one never retires the other's ids.
    const scope = `${raw.window?.id ?? ''}|${interactive ? 'i' : 'w'}|`;
    const used = new Set<string>();
    const shared = new Set<string>();
    const screen = projectSnapshot(
      raw,
      (identity) => {
        if (identity === undefined) return this.idFor(undefined);
        const scoped = `${scope}${identity}`;
        used.add(scoped);
        return this.idFor(scoped);
      },
      { minimized, interactive, onLookAlike: (identity) => shared.add(`${scope}${identity}`), priorIdOf: (identity) => this.ids.get(`${scope}${identity}`) },
    );
    // A read that ran out of time saw only part of the window: what it did not reach may still be there, so only an identity it saw a twin take retires.
    const partial = raw.complete === false || raw.truncated === true;
    for (const identity of this.ids.keys()) if (identity.startsWith(scope) && !used.has(identity) && (!partial || shared.has(identity))) this.ids.delete(identity);
    return screen;
  }

  // --- reading the screen ---

  /**
   * One snapshot of a window of the app the engine launched, projected: the
   * window `windowId` names, else the one the test made active (and no other
   * while it is open), else the focused one, the visible ones, and the rest, in
   * that order, the first one accessibility can read. `forMask` is a
   * read that only places secure fields: it reads every node even with
   * `snapshot: 'interactive'`, which leaves out a secure node with no action
   * of its own, and hands out no ids, so the ids of the screen the harness
   * holds stay as they are. `whole` reads every node too, with ids, for a
   * locator: a label left out of an interactive read would match nothing,
   * and a negative assertion on it pass. Undefined, an empty screen, before
   * `app.open()` and while the running app has no window; a copy of the app
   * the engine did not launch is never read. A read that fails is no empty
   * screen, which would let a negative assertion pass: an app that quit is
   * `INVALID_STATE`, and windows none of
   * which could be read, or none listed while the screen is locked, are a
   * retryable `NODE_STALE`, so a locator reads again until its deadline.
   */
  private async capture(operation: OperationContext, windowId?: string, forMask = false, whole = false): Promise<ProjectedScreen | undefined> {
    return this.readable(await this.readWindows(operation, windowId, forMask, whole));
  }

  /** The screen of a read, as `capture` answers; throws the retryable `NODE_STALE` of a read that found windows and could read none. */
  private readable({ windows, candidates, screen }: WindowsRead): ProjectedScreen | undefined {
    if (screen !== undefined) return screen;
    // Only a dialog macOS put over the app is open: no screen of the app's own, and no empty one either.
    if (candidates === 0 && windows.some((window) => window.system === true)) {
      throw new EngineError('NODE_STALE', `only a system dialog is over ${this.appName ?? 'the app'}; reading again (activate() on its window from desktop.windows() reads the dialog itself)`, { retryable: true, cause: UNREADABLE });
    }
    if (candidates === 0) return undefined;
    // A locked screen still lists the app's windows, none of them readable: say so rather than that each closed.
    this.unlessLocked();
    throw new EngineError('NODE_STALE', `no window of ${this.appName ?? 'the app'} could be read through accessibility, or each closed while it was read`, { retryable: true, cause: UNREADABLE });
  }

  /** One read for `capture`: the app's windows, and the first of those asked for that accessibility can read. */
  private async readWindows(operation: OperationContext, windowId?: string, forMask = false, whole = false): Promise<WindowsRead> {
    const windows = await this.ownWindows(operation, true);
    const target = windowId ?? this.activeChoice(windows);
    if (windows.length === 0 && this.pid !== undefined) this.unlessLocked();
    // A window the list no longer has is closed: its identities go, so windows opened and closed one after another do not pile them up.
    const open = new Set(windows.map((window) => window.id));
    for (const identity of this.ids.keys()) if (!open.has(identity.slice(0, identity.indexOf('|')))) this.ids.delete(identity);
    const candidates = target === undefined ? byPreference(windows) : windows.filter((window) => window.id === target);
    const read = { windows, candidates: candidates.length };
    const failures: DriverFailure[] = [];
    const { pid } = this;
    for (const window of candidates) {
      if (pid === undefined || window.accessible === false) continue;
      const interactive = this.options.interactiveOnly && !forMask && !whole;
      try {
        const raw = await this.read(
          (driver, timeoutMs) => driver.snapshot({ pid, windowId: window.id, maxDepth: this.options.maxDepth, interactive, timeoutMs }),
          { label: 'snapshot', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs },
        );
        if (!forMask) {
          const projected = this.projectWindow(raw, window.minimized === true, interactive);
          const sheet = sheetKey(window);
          return { ...read, failures, screen: sheet === undefined ? projected : { ...projected, sheet } };
        }
        let scratch = 0;
        return { ...read, failures, screen: projectSnapshot(raw, () => `mask${(scratch += 1)}`) };
      } catch (cause) {
        // A panel accessibility cannot read, or a window that just closed: try the next one.
        if (cause instanceof DriverFailure && NO_WINDOW_CODES.has(cause.code)) {
          failures.push(cause);
          continue;
        }
        throw translate(cause, 'snapshot', false);
      }
    }
    return { ...read, failures };
  }

  /**
   * Throws a retryable `NODE_STALE` while the Mac's screen is locked: macOS
   * then lists the app's windows as unreadable, or none of them, which must
   * not read as a window that closed or an app with none open.
   */
  private unlessLocked(): void {
    if (this.requireDriver().screenLocked() !== true) return;
    throw new EngineError('NODE_STALE', `the Mac's screen is locked, so no window of ${this.appName ?? 'the app'} can be read through accessibility; reading again`, { retryable: true, cause: UNREADABLE });
  }

  /** Throws `INVALID_STATE` unless the process the engine launched still runs. */
  private async requireRunning(): Promise<void> {
    const { pid } = this;
    if (pid === undefined || (await this.running(pid))) return;
    throw new EngineError('INVALID_STATE', `${this.appName ?? 'the app'} quit (process ${pid}); open it again with app.open()`, { retryable: false, cause: QUIT });
  }

  /**
   * The windows of the process the engine launched; none before
   * `app.open()` or after the app quit. `strict` is for a read of the
   * screen, where an app that quit must not pass for an empty screen: it is
   * `INVALID_STATE`.
   */
  private async ownWindows(operation: Pick<OperationContext, 'signal' | 'timeoutMs'>, strict = false): Promise<readonly RawWindow[]> {
    const { pid } = this;
    if (pid === undefined) return [];
    // An id another process took over since the app quit names none of its windows.
    if (!(await this.running(pid))) {
      if (strict) await this.requireRunning();
      return [];
    }
    try {
      const windows = await this.read((driver) => driver.listWindows(pid), { label: 'list windows', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs });
      return windows.filter((window) => window.pid === undefined || window.pid === pid);
    } catch (cause) {
      if (cause instanceof DriverFailure && NO_WINDOW_CODES.has(cause.code)) {
        if (strict) {
          await this.requireRunning();
          // The process still runs, so the list failed, not the app: no empty screen, which would let a negative assertion pass.
          throw new EngineError('NODE_STALE', `the windows of ${this.appName ?? 'the app'} could not be listed while it runs; reading again`, { retryable: true, cause });
        }
        return [];
      }
      throw translate(cause, 'list windows', false);
    }
  }

  /** The window of the launched process a command reads or acts in. */
  private async ownWindow(operation: OperationContext): Promise<RawWindow | undefined> {
    return this.activeWindow(await this.ownWindows(operation));
  }

  async observe(context: OperationContext, options: EngineObserveOptions | undefined): Promise<EngineSnapshot> {
    const operation = withDeadline(context);
    const screen = await this.capture(operation);
    if (screen === undefined) {
      return { root: { ref: { id: ROOT_ID, revision: '' }, role: 'window' }, viewport: { width: 0, height: 0 } };
    }
    this.remember(screen.bindings.values());
    let withheld = false;
    const pixels = options?.pixels === true ? await this.pixelsFor(screen, operation).catch((cause: unknown) => {
      // Out of time or cancelled is no screenshot at all, and the observation with it.
      if (cause instanceof EngineError && (cause.code === 'OPERATION_TIMEOUT' || cause.code === 'CANCELLED')) throw cause;
      // A capture that failed (no Screen Recording permission) is no screenshot, as on the mobile engine, not masking that could not be proven.
      withheld = cause instanceof Error && cause.cause === UNMASKED;
      return undefined;
    }) : undefined;
    this.pointWindow = pointIn(screen);
    // Pixels withheld for their secure fields still report the regions masked, none, so the harness reads masking it could not prove (MASKING_UNPROVEN), not a missing screenshot.
    return {
      ...this.snapshotOf(screen),
      ...(pixels === undefined ? (withheld ? { maskedRegionCount: 0 } : {}) : { pixels: pixels.pixels, maskedRegionCount: pixels.masked }),
    };
  }

  private snapshotOf(screen: ProjectedScreen): EngineSnapshot {
    const app = this.appName;
    const location = app === undefined ? screen.title : screen.title === undefined ? app : `${app} › ${screen.title}`;
    return {
      root: bounded(screen.root),
      viewport: screen.viewport,
      ...(screen.truncated ? { truncated: true } : {}),
      ...(location === undefined ? {} : { location }),
    };
  }

  async locate(expression: LocatorExpression, context: OperationContext): Promise<readonly SemanticNode[]> {
    // A field's placeholder names it when it has no label, so a placeholder query would read the same text twice; it is refused, as before.
    if (queryKinds(expression).has('placeholder')) {
      throw unsupported("macOS names a field with no label by its placeholder, so find it with getByRole('textbox', name) or getByLabel(name)");
    }
    const operation = withDeadline(context);
    // A locator reads the whole window whatever `snapshot` says, as on the mobile engine: the interactive read leaves out static text.
    const screen = await this.capture(operation, undefined, false, true);
    if (screen === undefined) return [];
    const sink = this.attempt?.screen;
    if (sink !== undefined) {
      try {
        sink(this.snapshotOf(screen));
      } catch {
        // The trace is evidence; a sink that throws never fails the step.
      }
    }
    // A read the deadline stopped is the locator's time running out: it answers as the timeout it is, so the wait ends on what its last whole read found (core never takes a cut read for an answer).
    if (screen.timedOut) throw new EngineError('OPERATION_TIMEOUT', 'the window could not be read whole before the deadline', { retryable: false });
    // A read cut short (by a stall, or at the depth limit) can leave out a match: no match would not prove a control absent, and one would not prove it the only one. The locator reads again until its deadline.
    if (screen.truncated) {
      throw new EngineError(
        'NODE_STALE',
        `the window was read only in part (the app did not answer for part of it, it is deeper than the ${this.options.maxDepth} levels a snapshot reads, which desktop({ maxDepth }) raises, or it holds more than the ${MAX_SNAPSHOT_NODES} elements it reads), so the matches cannot be counted`,
        { retryable: true },
      );
    }
    const matches = resolveExpression(expression, [screen.root]);
    this.pointWindow = pointIn(screen);
    this.remember(matches.flatMap((match) => screen.bindings.get(match.ref.id) ?? []));
    return matches;
  }

  // --- acting ---

  private binding(ref: NodeRef): NodeBinding {
    const binding = this.bindings.get(ref.id);
    if (binding === undefined) throw new EngineError('NODE_STALE', `node ${ref.id} is not on the screen`, { retryable: true });
    // A node read before a test made another window active is not on the screen in use: the harness locates it again there.
    if (this.chosenWindow !== undefined && binding.windowId !== this.chosenWindow) {
      throw new EngineError('NODE_STALE', `node ${ref.id} is in another window than the active one`, { retryable: true });
    }
    return binding;
  }

  /**
   * Keeps the newest binding of each node: an id names the same control in
   * every snapshot, and the newest snapshot's ref is the one to act on. A
   * control that has since gone keeps its last ref, which the driver
   * refuses as stale.
   */
  private remember(bindings: Iterable<NodeBinding>): void {
    const fresh = new Set<string>();
    for (const binding of bindings) {
      this.bindings.delete(binding.id);
      this.bindings.set(binding.id, binding);
      fresh.add(binding.id);
    }
    // The oldest go first, but never one just read: a screen larger than the cap keeps every node.
    for (const oldest of this.bindings.keys()) {
      if (this.bindings.size <= MAX_BINDINGS) break;
      if (!fresh.has(oldest)) this.bindings.delete(oldest);
    }
  }

  private refOf(binding: NodeBinding, action: string): string {
    if (binding.ref === undefined) throw notActionable(`node ${binding.id} (${binding.role ?? 'unknown'}) is not a control the engine can ${action}`);
    return binding.ref;
  }

  async perform(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void> {
    const operation = withDeadline(context);
    if (ref.id === ROOT_ID) {
      // The window is in view unless it is minimized: toHaveScreenshot on a window locator scrolls it into view first.
      if (action.kind === 'scrollIntoView') {
        const shown = await this.capture(operation);
        if (shown === undefined || shown.root.states?.hidden === true) throw notActionable('the window is not on screen (minimized, or closed), so it cannot be brought into view');
        return;
      }
      if (action.kind !== 'swipe') throw notActionable(`the window takes swipe and scrollIntoView only, not ${action.kind}; act on a node`);
      // The root is the window as it is now: read it again, since a locate or a restart may have moved on from the last observation.
      const screen = await this.capture(operation);
      if (screen !== undefined) this.remember(screen.bindings.values());
      const axis = action.direction === 'left' || action.direction === 'right' ? 'horizontal' : 'vertical';
      const target = screen?.scrollTargets?.[axis];
      if (target === undefined && screen?.cutShort === true) throw partialRead(`what in it scrolls ${axis === 'vertical' ? 'up and down' : 'sideways'}`);
      if (target === undefined) throw notActionable(`the window has nothing that scrolls ${axis === 'vertical' ? 'up and down' : 'sideways'}`);
      await this.scroll(this.binding({ id: target, revision: '' }), action.direction, action.momentum, operation);
      return this.settle(operation);
    }
    const binding = this.binding(ref);
    switch (action.kind) {
      case 'tap': {
        const scrolled = await this.shown(binding, 'tap', operation);
        const click = (): Promise<void> => this.refCommand('click', binding, operation);
        if (scrolled) await afterChange('click', click);
        else await click();
        break;
      }
      case 'secondaryTap':
        // The driver checks the control offers a context menu, live, before it scrolls one out of view into view (or
        // refuses one it cannot reach), and counts a failure after that scroll as delivered: the observed actions may be
        // from a read that stalled, which proves no menu absent.
        await this.refCommand('rightClick', binding, operation);
        break;
      case 'doubleTap':
        // A double click needs the real pointer; declared with `physicalInput` alone. A node with no ref (a plain view, text) takes it at its center.
        if (binding.ref === undefined) return await this.pointAtNode(binding, 'doubleTap', operation);
        await this.refCommand('doubleClick', binding, operation);
        break;
      case 'focus':
        await this.refCommand('focus', binding, operation);
        break;
      case 'clear':
        await this.refCommand('clear', binding, operation);
        break;
      case 'check':
      case 'uncheck':
        // The driver reads the live state, so a box already right gets nothing; the observed state may be stale. A box it
        // must press while a scroll area holds it out of view is scrolled into view first, or refused, as a tap is.
        await this.refCommand(action.kind, binding, operation);
        break;
      case 'scrollIntoView':
        // A node outside the window is read offscreen, as hidden, so one not hidden is in view already. It is scrolled only when it
        // can be (a ref and the driver's ScrollTo): most static text has no ref, and a button need not take the scroll action, which an
        // element screenshot asks for before it captures.
        if (binding.states?.hidden !== true && (binding.ref === undefined || !binding.actions.includes('ScrollTo'))) break;
        await this.refCommand('scrollTo', binding, operation);
        break;
      case 'hover':
        if (binding.ref === undefined) return await this.pointAtNode(binding, 'hover', operation);
        await this.refCommand('hover', binding, operation);
        break;
      case 'fill':
        await this.refCommand('setValue', binding, operation, { value: action.value });
        break;
      case 'press': {
        // A key the engine cannot press is refused before focus moves, and so is one this Mac's keyboard layout cannot type (a digit shortcut on AZERTY).
        const combo = toCombo(action.key);
        const window = binding.windowId;
        if (window === undefined) throw notActionable(`node ${binding.id} was read in no window to press a key into`);
        await this.read((driver) => driver.checkCombo(combo), { label: 'press', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs }).catch((cause: unknown) => Promise.reject(translate(cause, 'press', false)));
        // With `physicalInput` the key goes through the real keyboard to the window in front: the control's window comes forward
        // first, so a control in a window a test made active while another held the keyboard can take focus. The checks
        // below still run before the key.
        if (this.options.physicalInput && this.pid !== undefined) {
          const pid = this.pid;
          const focusId = this.requireDriver().inputId();
          await this.input((driver, timeoutMs) => driver.focusWindow(pid, window, focusId, timeoutMs), {
            label: 'focus window',
            input: true,
            signal: operation.signal,
            timeoutMs: operation.timeoutMs,
            onCutOff: () => this.driver?.cancelInput(focusId),
          }).catch((cause: unknown) => Promise.reject(translate(cause, 'focus window', true)));
        }
        await this.refCommand('focus', binding, operation);
        try {
          // The key goes to the process, which hands it to its key window: with another window that could be it, the control's must be the one shown focused.
          // A window on another Space, which the window list shows as not visible, is still the control's: with `physicalInput` the press brings it forward.
          const windows = await this.ownWindows(operation);
          const home = windows.find((candidate) => candidate.id === window);
          if (home === undefined) throw notActionable(`the window node ${binding.id} was read in is gone`);
          if (home.minimized === true) throw notActionable(`the window node ${binding.id} was read in is minimized, so no key reaches it`);
          const rivals = windows.filter((candidate) => candidate.id !== window && candidate.visible !== false && candidate.minimized !== true);
          if (rivals.length > 0 && home.is_focused !== true) {
            throw notActionable(`node ${binding.id} is in a window that cannot be shown to be the app's key window, so the key could land in another window`);
          }
          // Focusing can hand focus on (a dialog it opens): the driver sends the key only while the control's own element still holds it.
          await this.sendKey(combo, window, `press ${action.key}`, operation, binding.ref);
        } catch (cause) {
          // The focus already moved: a retry of the whole press would focus the control a second time, which an app's focus handler sees.
          if (cause instanceof EngineError && cause.retryable) {
            throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `press ${action.key}: ${cause.message} (the control was already focused)`, { retryable: false, cause });
          }
          throw cause;
        }
        break;
      }
      case 'selectOption':
        await this.select(binding, optionLabel(action.value), operation);
        break;
      case 'swipe':
        await this.scroll(binding, action.direction, action.momentum, operation);
        break;
      case 'longPress':
      case 'setInputFiles':
      case 'setInputFilePayloads':
      case 'dragTo':
        // Not declared in `actions` (engine.ts), so the harness never sends them; kept exhaustive.
        throw unsupported(`the desktop engine cannot perform ${action.kind}`);
    }
    await this.settle(operation);
  }

  /** The agent reads the screen right after acting, so its actions let the UI settle first; a test's own steps verify with `expect`. */
  private async settle(operation: OperationContext): Promise<void> {
    if (operation.origin === 'agent') await sleep(Math.min(this.options.settleMs, operation.timeoutMs), operation.signal);
  }

  /**
   * Refuses a tap on a node the read found off screen, which accessibility would press all the same: one a scroll area
   * holds out of view. When the driver can scroll it into view, it does, and answers only once the element shows: a
   * fresh read could not tell a look-alike node that moved from its siblings.
   */
  private async shown(binding: NodeBinding, what: string, operation: OperationContext): Promise<boolean> {
    if (binding.states?.hidden !== true) return false;
    // Only a node a scroll area holds out of view is scrolled: the driver checks it shows by its frame and the scroll
    // areas around it, which a minimized window or a collapsed control would pass unchanged.
    if (binding.scrolledOut === true && binding.ref !== undefined && binding.actions.includes('ScrollTo')) {
      await this.refCommand('scrollTo', binding, operation);
      return true;
    }
    throw notActionable(`node ${binding.id} is not on screen, so a ${what} would reach a control the user cannot; scroll it into view first`);
  }

  /** One action on a node's ref, failures translated. */
  private async refCommand(action: string, binding: NodeBinding, operation: OperationContext, extra: { value?: string; direction?: string; pages?: number; physical?: boolean } = {}): Promise<void> {
    try {
      await this.tryRef(action, binding, operation, extra);
    } catch (cause) {
      throw translate(cause, action, true);
    }
  }

  /** One action on a node's ref, a failure left as the driver reported it so a caller can tell what was sent. */
  private async tryRef(action: string, binding: NodeBinding, operation: OperationContext, extra: { value?: string; direction?: string; pages?: number; physical?: boolean } = {}): Promise<unknown> {
    const ref = this.refOf(binding, action);
    // Input still to send once the call is given up is never sent: the app may be another's by then, or the step over.
    const inputId = this.requireDriver().inputId();
    return await this.input((driver, timeoutMs) => driver.act({ ref, action, inputId, timeoutMs, ...extra }), {
      label: action,
      input: true,
      signal: operation.signal,
      timeoutMs: operation.timeoutMs,
      onCutOff: () => this.driver?.cancelInput(inputId),
    });
  }

  /**
   * Chooses an option of a list or dropdown, never by setting the value,
   * which would put a missing option in an editable combo box as free text:
   * one is refused. For a pop-up button the driver opens its menu, chooses
   * the item, checks the button shows it, and closes the menu again when the
   * option is missing. A stale ref is `NODE_STALE`, so the harness locates
   * the list again. A failure after the menu opened stays one that may have
   * chosen something; a menu the driver could not close is named, since it
   * covers the window for the steps after.
   */
  private async select(binding: NodeBinding, label: string, operation: OperationContext): Promise<void> {
    // An editable combo box takes any text: a missing option would land in it as free text.
    if (binding.role === 'combobox' && binding.actions.includes('SetValue')) {
      throw unsupported(`this combo box is editable and takes any text, so a select of "${label}" could not tell a missing option from a chosen one; fill() it and check its value`);
    }
    try {
      await this.tryRef('select', binding, operation, { value: label });
    } catch (cause) {
      if (cause instanceof DriverFailure && cause.notDelivered && cause.code === 'ELEMENT_NOT_FOUND') throw notActionable(`the list has no option "${label}"`);
      if (cause instanceof DriverFailure && !cause.notDelivered && cause.details.menu === 'open') {
        throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `select "${label}": ${cause.message}. The list's menu is still open`, { retryable: false, cause });
      }
      throw translate(cause, `select "${label}"`, true);
    }
  }

  private async scroll(binding: NodeBinding, direction: string, momentum: string | undefined, operation: OperationContext): Promise<void> {
    const pages = momentum === 'fast' ? SWIPE_PAGES.fast : momentum === 'slow' ? SWIPE_PAGES.slow : SWIPE_PAGES.none;
    await this.refCommand('scroll', binding, operation, { direction, pages });
  }

  /** A pointer action at the center of a node the driver gave no ref, through the checks a point action makes: the node's window forward, the point inside it. */
  private async pointAtNode(binding: NodeBinding, kind: 'hover' | 'doubleTap', operation: OperationContext): Promise<void> {
    const what = kind === 'hover' ? 'hover' : 'double-click';
    if (binding.windowId === undefined) throw notActionable(`node ${binding.id} (${binding.role ?? 'unknown'}) has no box on screen to ${what}`);
    if (binding.states?.hidden === true) throw notActionable(`node ${binding.id} is not on screen; scroll it into view first`);
    // With no ref, the driver cannot check the node is still there: the pointer goes where a fresh read of its window finds it now, or nowhere.
    // The box it was read with could hold what replaced it, and a node with a stable id may have moved.
    const now = await this.capture(operation, binding.windowId, false, !binding.interactive);
    if (now?.cutShort === true) throw partialRead(`whether node ${binding.id} is still on screen`);
    // A read stopped at the depth limit left out what is below some nodes: a control at the center may be one of them.
    if (kind === 'doubleTap' && now?.truncated === true) {
      throw new EngineError('NODE_STALE', `the window was read only in part (it is deeper than the ${this.options.maxDepth} levels a snapshot reads, which desktop({ maxDepth }) raises, or holds more than the ${MAX_SNAPSHOT_NODES} elements it reads), so what is at the center of node ${binding.id} cannot be told`, { retryable: true });
    }
    const fresh = [...(now?.bindings.values() ?? [])].find((candidate) => sameNode(candidate, binding));
    if (fresh === undefined) throw new EngineError('NODE_STALE', `node ${binding.id} (${binding.role ?? 'unknown'}) is no longer on screen; observe again`, { retryable: true });
    if (fresh.states?.hidden === true) throw notActionable(`node ${binding.id} is not on screen; scroll it into view first`);
    const rect = fresh.rect;
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) throw notActionable(`node ${binding.id} (${binding.role ?? 'unknown'}) has no box on screen to ${what}`);
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    // A point names no element: the driver's check takes any control of the window there. Any other control at this node's center (a button inside it, even one reaching past its box, or one laid over it) would take the double-click, so it is refused here, from the same read. The node's ancestors hold the point by being around it, and only one that takes a press of its own (a button the text is in) takes the click, as the driver judges it. A hover presses nothing.
    if (kind === 'doubleTap') {
      const around = new Set(now === undefined ? [] : ancestors(now.root, fresh.id));
      const other = [...(now?.bindings.values() ?? [])].find(
        (candidate) =>
          candidate.id !== fresh.id &&
          (!around.has(candidate.id) || pressable(candidate)) &&
          candidate.ref !== undefined &&
          candidate.states?.hidden !== true &&
          candidate.rect !== undefined &&
          holds(candidate.rect, center),
      );
      if (other !== undefined) throw notActionable(`a ${other.role ?? 'control'} is at the center of node ${binding.id}, so a double-click there would press it; act on that control instead`);
    }
    this.pointWindow = binding.windowId === undefined ? undefined : { id: binding.windowId, sheet: now?.sheet };
    // Coming forward can reveal a control over the node: the driver checks after the move that none is under a double-click.
    await this.pointerAt(center, { kind }, operation, kind === 'doubleTap');
  }

  /** Physical pointer input at a point in the window: only with `physicalInput`, and only then declared. */
  async performAt(point: ViewportPoint, action: PointerAction, context: OperationContext): Promise<void> {
    await this.pointerAt(point, action, context, false);
  }

  /**
   * `performAt`, and `content` when the point is on a node with no ref, which takes no click of its own: the driver
   * then refuses a control under the pointer after the move, not only another window.
   */
  private async pointerAt(point: ViewportPoint, action: PointerAction, context: OperationContext, content: boolean): Promise<void> {
    const operation = withDeadline(context);
    if (action.kind !== 'hover' && action.kind !== 'tap' && action.kind !== 'doubleTap' && action.kind !== 'secondaryTap') {
      throw unsupported(`the desktop engine cannot perform ${action.kind} at a point`);
    }
    // The point is in the observed window's coordinates: find that window where it is now (it may have moved), or the app's own window before any observation.
    const observed = this.pointWindow;
    const target = observed === undefined ? await this.ownWindow(operation) : (await this.ownWindows(operation)).find((candidate) => candidate.id === observed.id);
    const window = target?.bounds;
    if (target === undefined || window === undefined) throw notActionable('the window the point was taken from is no longer on screen; observe again');
    if (point.x < 0 || point.y < 0 || point.x >= window.width || point.y >= window.height) {
      throw notActionable(`(${point.x}, ${point.y}) is outside the ${window.width}x${window.height} window; a click there would land on another app`);
    }
    const pid = this.pid;
    if (pid === undefined) throw invalidState('the app is not running; open it with app.open()');
    // Physical input lands on whatever is frontmost at the point: bring the window forward first.
    // Finding the window can wait on the app: a call given up on must not bring it forward later, over what the user or the next step is doing.
    const focusId = this.requireDriver().inputId();
    await this.input((driver, timeoutMs) => driver.focusWindow(pid, target.id, focusId, timeoutMs), {
      label: 'focus window',
      input: true,
      signal: operation.signal,
      timeoutMs: operation.timeoutMs,
      onCutOff: () => this.driver?.cancelInput(focusId),
    }).catch((cause: unknown) => Promise.reject(translate(cause, 'focus window', true)));
    // Coming forward can move the window (onto another space, out from under the menu bar): the click is measured from where it is now.
    const forward = (await this.ownWindows(operation)).find((candidate) => candidate.id === target.id);
    const focused = forward?.bounds;
    if (forward === undefined || focused === undefined) throw notActionable('the window the point was taken from closed as it was brought forward; observe again');
    // A click carries no window, only screen coordinates: if another window (a sheet, a panel the app raised) took focus as this one came forward, it could be the one under the point.
    if (forward.is_focused !== true) throw notActionable('another window took focus as the window the point was taken from was brought forward, and could be under the point; observe again');
    // A sheet counts as its window's focus, for keys. The point was taken on the sheet there then (in the observation, or as this action began when none came first): one that opened since could cover it, one that closed uncovered what was under it, and one in its place is another.
    const sheetThen = observed === undefined ? sheetKey(target) : observed.sheet;
    const sheetNow = sheetKey(forward);
    if (!sameSheet(sheetNow, sheetThen)) {
      const what = sheetThen === undefined ? 'a sheet opened over the window' : sheetNow === undefined ? 'the sheet the point was taken on closed' : 'another sheet took the place of the one the point was taken on';
      throw notActionable(`${what} since the point was taken, and the click could land on something else; observe again`);
    }
    if (point.x >= focused.width || point.y >= focused.height) {
      throw notActionable(`(${point.x}, ${point.y}) is outside the ${focused.width}x${focused.height} window; a click there would land on another app`);
    }
    // Unrounded: the driver takes fractional points, and rounding could carry a point past the window's edge.
    const kind = action.kind;
    // As for `tryRef`: pointer input still unsent once the call is given up is never sent.
    const inputId = this.requireDriver().inputId();
    // The driver checks the window again after the move, before the click: a sheet or window that opens meanwhile would take it.
    const takes = { pid, windowId: target.id, sheet: sheetNow !== undefined, ...(sheetNow === undefined || sheetNow === UNKNOWN_SHEET ? {} : { sheetId: sheetNow }), ...(content ? { content } : {}) };
    await this.input((driver, timeoutMs) => driver.pointer(focused.x + point.x, focused.y + point.y, kind, inputId, timeoutMs, takes), {
      label: kind,
      input: true,
      signal: operation.signal,
      timeoutMs: operation.timeoutMs,
      onCutOff: () => this.driver?.cancelInput(inputId),
    }).catch((cause: unknown) => Promise.reject(translate(cause, kind, true)));
    await this.settle(operation);
  }

  /** The keyboard capability's `type`: keystrokes into the focused field, which a fresh snapshot names. */
  async typeText(text: string, options: { readonly replace: boolean }, context: OperationContext): Promise<void> {
    // Refused before anything is sent: with replace, the select-all and delete would already have emptied the field.
    if (text.includes('\0')) throw notActionable('a NUL character cannot be typed');
    const operation = withDeadline(context);
    const screen = await this.capture(operation);
    const focused = screen === undefined ? undefined : [...screen.bindings.values()].find((binding) => binding.ref !== undefined && binding.states?.focused === true);
    // A read that ran out of time may stop short of the focused field: no proof that none has focus.
    if (focused === undefined && screen?.cutShort === true) throw partialRead('which field has keyboard focus');
    if (focused === undefined) throw notActionable('no field has keyboard focus; tap or focus the field first');
    // Text goes only into a control that takes it; a list or button with focus would take the select-all and delete as commands.
    if (!focused.actions.includes('TypeText')) {
      throw notActionable(`the ${focused.role ?? 'control'}${focused.name === undefined ? '' : ` "${focused.name}"`} that has keyboard focus takes no text; tap or focus a text field first`);
    }
    // Keystrokes, so the app's key handlers run; with `physicalInput` they go through the real keyboard.
    const type = (): Promise<unknown> => this.tryRef('type', focused, operation, { value: text, physical: this.options.physicalInput });
    if (options.replace) {
      // Cleared as on a keyboard, select all and then delete: the app's key handlers see the delete, and a field that takes keys but refuses an accessibility write is cleared too.
      const window = focused.windowId ?? (await this.ownWindow(operation))?.id;
      if (window === undefined) throw invalidState('the app is not running; open it with app.open()');
      await this.selectAll(focused, window, operation);
      // The app may move focus on select all, and the delete's handler on from an emptied field: the driver sends the
      // delete, and then types, only while the field's own element still holds the app's focus, and never focuses it back.
      await afterChange('delete the selection', () => this.sendKey('backspace', window, 'delete the selection', operation, focused.ref));
      await afterChange('type', type);
    } else await type().catch((cause: unknown) => Promise.reject(translate(cause, 'type', true)));
    await this.settle(operation);
  }

  /**
   * Selects all the text of the focused field. Through accessibility first:
   * Cmd+A sent to an app in the background goes to its menu bar, not the
   * field, and selects nothing, so the delete after it would remove one
   * character. A field whose selection cannot be set gets the key only with
   * `physicalInput`, through the real keyboard; without it, nothing is sent.
   */
  private async selectAll(focused: NodeBinding, window: string, operation: OperationContext): Promise<void> {
    try {
      await this.tryRef('selectAll', focused, operation);
    } catch (cause) {
      if (!(cause instanceof DriverFailure && cause.notDelivered && cause.code === 'ACTION_NOT_SUPPORTED')) throw translate(cause, 'select all', true);
      if (!this.options.physicalInput) {
        throw notActionable("the focused field's text cannot be selected through accessibility, and Cmd+A sent to an app in the background selects nothing; use fill(), or set desktop({ physicalInput: true })");
      }
      await this.sendKey('cmd+a', window, 'select all', operation, focused.ref);
    }
  }

  /** One key to whatever holds focus in the app's window. */
  async pressKey(key: string, context: OperationContext): Promise<void> {
    const operation = withDeadline(context);
    const combo = toCombo(key);
    const window = await this.ownWindow(operation);
    if (window === undefined) throw invalidState('the app is not running; open it with app.open()');
    await this.sendKey(combo, window.id, `press ${key}`, operation);
    // As after every other agent action: the app reacts to the key before the agent reads the screen again.
    await this.settle(operation);
  }

  /**
   * Sends one key combo to the launched process's window; with `focusedRef`, only while that control still holds the
   * app's focus, checked by the driver right before the key goes. Without `physicalInput`
   * the key goes into the process's event queue, which hands it to its key
   * window, so the driver sends it only while the window named is that one.
   * With `physicalInput`, the driver brings the window forward and presses the key
   * on the real keyboard.
   */
  private async sendKey(combo: string, window: string, label: string, operation: OperationContext, focusedRef?: string): Promise<void> {
    const pid = this.pid;
    if (pid === undefined) throw invalidState('the app is not running; open it with app.open()');
    const physical = this.options.physicalInput;
    // As for `tryRef`: a key still unsent once the call is given up is never sent.
    const inputId = this.requireDriver().inputId();
    try {
      await this.input((driver, timeoutMs) => driver.press({ pid, windowId: window, combo, physical, inputId, timeoutMs, ...(focusedRef === undefined ? {} : { focusedRef }) }), {
        label,
        input: true,
        signal: operation.signal,
        timeoutMs: operation.timeoutMs,
        onCutOff: () => this.driver?.cancelInput(inputId),
      });
    } catch (cause) {
      if (cause instanceof DriverFailure && cause.notDelivered && cause.details.cause === 'exact_window_focus_unconfirmed') {
        throw notActionable(`${label}: the window is not the app's key window, so a key sent to the app would land in another; nothing was sent`);
      }
      throw translate(cause, label, true);
    }
  }

  // --- pixels ---

  async screenshot(label: string | undefined, context: OperationContext): Promise<string> {
    const operation = withDeadline(context);
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('screenshot outside an attempt');
    const screen = await this.capture(operation);
    if (screen === undefined) throw invalidState('the app has no window to capture; open it with app.open()');
    const { pixels } = await this.pixelsFor(screen, operation);
    attempt.screenshots += 1;
    const relative = path.join('screenshots', `${String(attempt.screenshots).padStart(3, '0')}-${sanitizeFilename(label ?? 'screenshot')}.png`);
    await mkdir(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    await writeFile(path.join(attempt.artifactsDir, relative), pixels.data);
    return relative;
  }

  /**
   * The window's pixels with every secure field painted over. The fields
   * come from the snapshot taken just before, and the window is read again
   * after the capture: a secure field without bounds, a partial snapshot, or
   * a field that moved in between withholds the image rather than ship it
   * unproven. That is a refusal of policy, `POLICY_DENIED`, as on the mobile
   * engine: the image could hold a credential. A window with no secure field
   * that closed, changed size, or was read in part because the read ran out
   * of time is a capture that failed, and the next one may work.
   */
  private async pixelsFor(observed: ProjectedScreen, operation: OperationContext): Promise<{ pixels: ObservationPixels; masked: number }> {
    if (observed.windowId === undefined) throw notActionable('the observed surface has no window to capture');
    const unmasked = (reason: string): ConfigurationError => new ConfigurationError('POLICY_DENIED', `${reason}, so the screenshot is withheld`, { cause: UNMASKED });
    // The secure fields come from a whole read of the window, never an interactive one, which can leave a secure node out.
    const screen = this.options.interactiveOnly ? await this.capture(operation, observed.windowId, true) : observed;
    if (screen?.windowId === undefined) throw new EngineError('ENGINE_FAILURE', 'the window closed before it could be captured', { retryable: false });
    const windowId = screen.windowId;
    // The image goes out beside the observed tree: a window that changed size since that read would pair it with the wrong viewport and boxes.
    if (screen.viewport.width !== observed.viewport.width || screen.viewport.height !== observed.viewport.height) {
      throw new EngineError('ENGINE_FAILURE', 'the window changed size between the read and the capture', { retryable: false });
    }
    const secure = screen.secureRects;
    if (secure === undefined) throw unmasked('a secure field on screen has no bounds to mask');
    // A snapshot cut short can leave out a secure field, which would then go unmasked.
    if (screen.truncated) {
      // One that ran out of time and saw no secure field may read whole next time: a capture that failed, not a refusal.
      if (screen.cutShort && secure.length === 0) throw new EngineError('ENGINE_FAILURE', 'the window was read only in part, as the read ran out of time, so it cannot be shown to hold no secure field', { retryable: false });
      throw unmasked(
        screen.cutShort
          ? 'the snapshot did not read the whole window, so a secure field may be missing from it'
          : `the window is deeper than desktop({ maxDepth }) reads (${this.options.maxDepth} levels), or holds more than the ${MAX_SNAPSHOT_NODES} elements a snapshot reads, so a secure field may be missing from the read`,
      );
    }
    // The capture lands unmasked on disk first: in the worker's private directory, removed below.
    const directory = await mkdtemp(path.join(this.home ?? tmpdir(), 'shot-'));
    try {
      const file = path.join(directory, 'window.png');
      const shot = await this.read((driver, timeoutMs) => driver.screenshot({ windowId, path: file, timeoutMs }), { label: 'screenshot', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs }).catch((cause: unknown) =>
        Promise.reject(translate(cause, 'screenshot', false)),
      );
      // The snapshot and the capture are two calls: read the window again, and withhold the image if a secure field moved, came, or went between them.
      const after = await this.capture(operation, windowId, true).catch((cause: unknown) => {
        if (cause instanceof EngineError && (cause.code === 'OPERATION_TIMEOUT' || cause.code === 'CANCELLED')) throw cause;
        // The image holds a secure field the read after it could not place: that is masking not proven, not a capture that failed.
        if (secure.length > 0) throw unmasked('the window could not be read again after the capture, so its secure fields cannot be placed');
        throw cause;
      });
      if (after === undefined || after.windowId !== windowId || after.truncated || !sameRects(after.secureRects, secure) || after.viewport.width !== screen.viewport.width || after.viewport.height !== screen.viewport.height) {
        // Only a secure field, seen in either read or possibly below the depth a read stops at, makes this a matter of masking; a read that ran out of time is tried again.
        if (secure.length > 0 || (after !== undefined && ((after.truncated && !after.cutShort) || after.secureRects?.length !== 0))) throw unmasked('the window changed while it was captured, so its secure fields cannot be placed');
        throw new EngineError('ENGINE_FAILURE', 'the window closed or changed size while it was captured', { retryable: false });
      }
      const scale = typeof shot.scale_factor === 'number' && shot.scale_factor > 0 ? shot.scale_factor : 1;
      const raw = new Uint8Array(await readFile(file));
      const expected = { width: Math.round(screen.viewport.width * scale), height: Math.round(screen.viewport.height * scale) };
      const rects: Rect[] = secure.map((rect) => ({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale }));
      const image = windowImage(raw, expected, rects);
      if (image === undefined) {
        const mismatch = `the window capture (${describeCapture(raw)}) does not match the window's ${expected.width}x${expected.height} pixels`;
        if (rects.length > 0) throw unmasked(`${mismatch}, so its secure fields cannot be placed`);
        throw new EngineError('ENGINE_FAILURE', mismatch, { retryable: false });
      }
      return { pixels: { data: encodePng(image), mediaType: 'image/png', width: image.width, height: image.height, scale }, masked: rects.length };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // --- plumbing ---

  private requireDriver(): DesktopDriver {
    if (this.driver === undefined) throw invalidState('the desktop engine is not initialized');
    return this.driver;
  }

  /** A driver call that reads: refused once the budget is spent, its failure left untranslated for the caller. */
  private read<T>(start: (driver: DesktopDriver, timeoutMs: number) => Promise<Envelope<T>>, options: { label: string; input: false; signal: AbortSignal; timeoutMs: number }): Promise<T> {
    return this.driverCall(start, options);
  }

  /** A driver call that sends input: refused once the budget is spent, its failure left untranslated for the caller. */
  private input<T>(start: (driver: DesktopDriver, timeoutMs: number) => Promise<Envelope<T>>, options: { label: string; input: true; signal: AbortSignal; timeoutMs: number; onCutOff?: () => void }): Promise<T> {
    return this.driverCall(start, options);
  }

  private async driverCall<T>(start: (driver: DesktopDriver, timeoutMs: number) => Promise<Envelope<T>>, options: { label: string; input: boolean; signal: AbortSignal; timeoutMs: number; onCutOff?: () => void }): Promise<T> {
    const driver = this.requireDriver();
    // Nothing is sent once the operation's budget is spent: a later step of an action never starts past the deadline.
    if (options.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `${options.label}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    // A read the driver stops at its deadline answers with what it read, marked incomplete: it must answer before the call is cut off.
    const driverMs = options.input ? options.timeoutMs : Math.max(options.timeoutMs - READ_ANSWER_MARGIN_MS, options.timeoutMs / 2);
    return await call(() => start(driver, driverMs), options);
  }
}

/**
 * Whether a node of a fresh read is the one a binding names: by its id when
 * that comes from its identity, else by its role, name, developer id, place,
 * and as many twins around it as before.
 */
function sameNode(candidate: NodeBinding, binding: NodeBinding): boolean {
  return binding.stable
    ? candidate.id === binding.id
    : candidate.role === binding.role && candidate.name === binding.name && candidate.testId === binding.testId && sameRect(candidate.rect, binding.rect) && candidate.likeness === binding.likeness;
}

/**
 * The app's windows in the order a command reads them when the test chose
 * none: the focused one, the main one (an app in the background may have no
 * focused window), the visible ones, the rest. A dialog macOS adds (Siri's,
 * which macOS 27 shows over an app after a press in a SwiftUI sheet, and
 * lists first) is left out, though it may take focus: read in place of an
 * unreadable window of the app, it would let a negative assertion pass.
 * `activate()` on its window still picks it.
 */
function byPreference(windows: readonly RawWindow[]): RawWindow[] {
  const rank = (window: RawWindow): number => (window.is_focused === true ? 0 : window.is_main === true ? 1 : window.visible !== false ? 2 : 3);
  return windows.filter((window) => window.system !== true).toSorted((a, b) => rank(a) - rank(b));
}

/** The driver's answer within `ms`, or `timeout`; a cancelled wait answers at once. */
async function settleWithin<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const limit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(ms, 0));
    onAbort = () => resolve('timeout');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** Roles whose `Click` may be a selection (`AXSelected`), not a press of their own. */
const SELECTED_BY_CLICK = new Set(['row', 'cell', 'treeitem', 'option', 'tab']);

/** Whether a node takes a press of its own, as the driver's hit test judges an element under the pointer. */
function pressable(binding: NodeBinding): boolean {
  return binding.actions.includes('Click') && !SELECTED_BY_CLICK.has(binding.role ?? '');
}

/** The ids of the nodes above the node `id` in a tree, from the root down; none when the tree does not hold it. */
function ancestors(root: SemanticNode, id: string): string[] {
  const above = (node: SemanticNode): string[] | undefined => {
    if (node.ref.id === id) return [];
    for (const child of node.children ?? []) {
      const below = above(child);
      if (below !== undefined) return [node.ref.id, ...below];
    }
    return undefined;
  };
  return above(root) ?? [];
}

/** Whether a rect holds a point. */
function holds(rect: Rect, point: { readonly x: number; readonly y: number }): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

/** The window a screen was read from, and the sheet that held its focus then: where a point taken in it was taken. */
function pointIn(screen: ProjectedScreen): { readonly id: string; readonly sheet: string | undefined } | undefined {
  return screen.windowId === undefined ? undefined : { id: screen.windowId, sheet: screen.sheet };
}

/** Stands for a sheet the driver gave no key: it is never known to be the same sheet as any. */
const UNKNOWN_SHEET = '?';

/** The sheet that holds a window's focus: its key, `UNKNOWN_SHEET` when the driver gave none, undefined for no sheet. */
function sheetKey(window: RawWindow): string | undefined {
  if (window.sheet_focused !== true) return undefined;
  return window.sheet_id ?? UNKNOWN_SHEET;
}

/** Whether two sheet keys name the same sheet: both none, or both sheets with the same key. A sheet with no key matches none. */
function sameSheet(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a !== UNKNOWN_SHEET && a === b;
}

/**
 * Runs the input that follows one that already changed the app (a clear
 * before a type): its failure, whatever the driver says it sent, is
 * `ACTION_MAY_HAVE_COMMITTED`, so the step is never repeated as if nothing
 * happened.
 */
async function afterChange(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    // Only the driver's own failure is unnamed: an engine error already says which command it is.
    const message = cause instanceof DriverFailure ? `${label}: ${cause.message}` : (cause as Error).message;
    throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `${message} (an earlier command of this step changed the app)`, { retryable: false, cause });
  }
}

/**
 * An observation tree with each field cut at the contract's limit, the end
 * dropped: a name at `OBSERVED_NAME_LIMIT`, text, a value, and a selection at
 * `OBSERVED_TEXT_LIMIT`. The harness reads a field exactly at its limit as
 * one that may have been cut (and redacts a secret it may end with), and one
 * long label can no longer crowd the controls after it out of what the agent
 * reads. `locate` matches on the whole tree, and single-node reads carry the
 * whole value.
 */
function bounded(node: SemanticNode): SemanticNode {
  const cut = (text: string | undefined, limit: number): { readonly text?: string } => (text === undefined ? {} : { text: text.length > limit ? text.slice(0, limit) : text });
  const name = cut(node.name, OBSERVED_NAME_LIMIT).text;
  const text = cut(node.text, OBSERVED_TEXT_LIMIT).text;
  const value = cut(node.value, OBSERVED_TEXT_LIMIT).text;
  const selection = cut(node.selection, OBSERVED_TEXT_LIMIT).text;
  return {
    ...node,
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
    ...(value === undefined ? {} : { value }),
    ...(selection === undefined ? {} : { selection }),
    ...(node.children === undefined ? {} : { children: node.children.map(bounded) }),
  };
}

/** Whether two rects are the same; two missing rects are not. */
function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether two lists of secure-field rects are the same, in order. */
function sameRects(a: readonly Rect[] | undefined, b: readonly Rect[]): boolean {
  return a !== undefined && a.length === b.length && a.every((rect, index) => {
    const other = b[index]!;
    return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
  });
}
