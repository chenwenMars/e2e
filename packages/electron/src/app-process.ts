/**
 * The running app: one launch of the Electron binary, the page targets it
 * opens attached and registered as windows, its main process reached over
 * the inspector when it has one, and a quit that ends it within a budget.
 * Launches and quits run one at a time.
 */

import path from 'node:path';
import type { Protocol } from 'devtools-protocol';
import { Deadline, EngineError, pollCondition, raceAbort, TestError, type EngineAppInfo, type EngineAttemptContext, type OperationContext } from '@e2e-dev/core/engine';
import { answerWithin, Budget } from './budget.ts';
import { consoleText } from './console-text.ts';
import type { DialogRouter } from './dialogs.ts';
import type { ElectronMainModule } from './fixtures.ts';
import { closedWindow, invalidState, unsupported } from './errors.ts';
import { appDirectory } from './file-bound.ts';
import { ElectronProcess, type ProcessExit } from './launcher.ts';
import { MainEvaluateError, MainProcess } from './main-process.ts';
import { REFUSED_ENV, type ResolvedElectronOptions } from './options.ts';
import { PageTarget } from './page.ts';
import type { Windows } from './windows.ts';

/** How long the app gets to close itself when its data is thrown away anyway: a `beforeunload` handler would otherwise hold every test end for the full budget. */
export const DISCARD_CLOSE_MS = 1_000;

/** How long it gets when `app.restart()` keeps its data: time to flush it. */
export const RESTART_CLOSE_MS = 5_000;

/** What a launch reads from the run and the attempt. */
export interface LaunchSetup {
  readonly executable: string;
  readonly projectRoot: string;
  readonly app: EngineAppInfo;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly userDataDir: string;
  readonly attempt: EngineAttemptContext;
}

/** How long the main process gets to answer a question whose answer is optional. */
const ANSWER_MS = 500;

/** How long a killed app gets to exit, and let go of its files, before its data is deleted. */
const EXIT_WAIT_MS = 2_000;

/** How long setting the downloads directory may take of a launch's budget. */
const DOWNLOADS_SETUP_MS = 2_000;

/** How long reading a window's OS title may take. */
const TITLE_MS = 1_000;

/** How long connecting to the main process's inspector may take. */
const INSPECTOR_CONNECT_MS = 5_000;

/**
 * How long after its first window loaded an app may still open its
 * inspector. Node prints the inspector's address before it runs the app's
 * code, so an app with a window and no address will never print one.
 */
const INSPECTOR_GRACE_MS = 500;

/** How many of the app's last stderr lines a failed launch quotes. */
const QUOTED_STDERR_LINES = 10;

/** One launched app. */
interface RunningApp {
  readonly process: ElectronProcess;
  /** The main process, or undefined for an app that opened no inspector; settles once that is known. */
  readonly main: Promise<MainProcess | undefined>;
  /** Decides `main` as undefined: the app will open no inspector. */
  readonly withoutMain: () => void;
  readonly pages: Map<string, PageTarget>;
}

/** Where one launched app's events go: the attempt that launched it, for as long as that app is the running one. */
interface AppReport {
  log(entry: Parameters<EngineAttemptContext['appLog']>[0]): void;
  navigated(url: string): void;
  /** Whether this app is still the running one: a dialog of one that was replaced is no later attempt's to answer for. */
  current(): boolean;
}

/** A download the app started: the name the server or the link gave it, where it is saved, and Electron's state for it. */
export interface AppDownload {
  readonly filename: string;
  readonly path: string;
  readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
}

export class AppProcess {
  private app: RunningApp | undefined;
  private exit: string | undefined;
  private directory: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: ResolvedElectronOptions,
    private readonly windows: Windows,
    private readonly dialogs: DialogRouter,
  ) {}

  /** Whether an app is running. */
  get running(): boolean {
    return this.app !== undefined;
  }

  /** The directory the running app's own pages are in, once it launched; see `appDirectory`. */
  get appDirectory(): string | undefined {
    return this.directory;
  }

  /** Why nothing can be read or run: the app quit on its own during the test, or was never opened. */
  notRunning(): Error {
    const { exit } = this;
    return invalidState(exit === undefined ? 'the app is not running: open it with app.open()' : `the app quit on its own${exit === '' ? '' : ` ${exit}`}: open it again with app.open() or app.restart()`);
  }

  /**
   * Runs a launch or a quit after the ones before it: `app.open()` and
   * `app.restart()` that overlap would each start a main process, and only
   * one is tracked.
   */
  serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Quits the running app, if any: a graceful quit within `graceMs` and the budget, then its process tree killed. */
  async quit(budget: { readonly timeoutMs: number }, graceMs: number): Promise<void> {
    const app = this.app;
    this.app = undefined;
    this.exit = undefined;
    this.directory = undefined;
    this.windows.clear();
    if (app === undefined) return;
    await stop(app, Math.min(budget.timeoutMs, graceMs));
  }

  /** Launches the app on the attempt's user-data directory and waits for its first window to load, all within one budget. */
  async launch(setup: LaunchSetup, operation: OperationContext): Promise<void> {
    // One budget for the whole launch, ending a little before the operation does so the launch reports why it failed
    // rather than the operation timing out; each phase gets what the ones before it left.
    const timeout = Math.max(1, new Budget(operation, 'app.open').waits.remaining());
    const deadline = new Deadline(timeout);
    const left = (): number => Math.max(1, deadline.remaining());
    let app: RunningApp;
    let opened = false;
    try {
      app = this.start(setup);
    } catch (cause) {
      // The operating system refused the binary outright, before any process existed.
      throw new EngineError('ENGINE_FAILURE', `could not launch ${setup.executable}: ${cause instanceof Error ? cause.message : String(cause)}`, { retryable: false, cause });
    }
    this.app = app;
    this.watch(app, setup.attempt);
    const quitEarly = app.process.exited.then(() => {
      throw new Error('the app quit');
    });
    quitEarly.catch(() => undefined);
    try {
      // Any window counts, not the first one opened: a splash screen may close, or never finish loading, before the app's real window is there.
      const open = (): PageTarget[] => this.windows.open().map((window) => window.page);
      const window = (): Promise<PageTarget> => raceAbort(() => Promise.race([loaded(open, deadline, operation.signal), quitEarly]), operation.signal, 'waiting for the first window to load');
      let first = await window();
      opened = true;
      // Still inside the launch: an app that quits here, or a caller that stopped waiting, fails it.
      await raceAbort(() => Promise.race([this.setUp(app, setup, left), quitEarly]), operation.signal, 'setting up the app');
      // A splash screen can close while the app is set up: the launch ends on a window that is there.
      while (first.isClosed()) first = await window();
      // The window that loaded is the one read, not one still on its way.
      this.windows.show(open().indexOf(first));
    } catch (cause) {
      // Read before the engine's own quit, which ends the process too.
      const exited = app.process.ended;
      const main = exited === undefined ? await answerWithin(app.main, ANSWER_MS) : undefined;
      // Electron can stall before its ready event on a loaded machine; say so rather than blame the app's window.
      const ready = main === undefined ? undefined : await answerWithin(main.evaluate(({ app: electronApp }) => electronApp.isReady(), undefined), ANSWER_MS);
      const stuck = [...app.pages.values()].filter((page) => !this.windows.has(page)).length;
      await this.quit({ timeoutMs: DISCARD_CLOSE_MS }, DISCARD_CLOSE_MS);
      if (cause instanceof EngineError) throw cause;
      throw launchError(setup, app.process, { exited, ready, stuck, timeout, opened }, cause);
    }
  }

  /** What a launch does once the app has a window: its main process connected, its downloads placed, its versions reported. */
  private async setUp(app: RunningApp, setup: LaunchSetup, left: () => number): Promise<void> {
    // Only now is an app with no inspector known to have none: the address is printed before the app's own code runs.
    // One that printed it is being connected to, and that has a bound of its own.
    setTimeout(() => {
      if (!app.process.inspectorSeen) app.withoutMain();
    }, INSPECTOR_GRACE_MS).unref();
    const main = await answerWithin(app.main, Math.min(left(), INSPECTOR_GRACE_MS + INSPECTOR_CONNECT_MS));
    const downloads = path.join(setup.userDataDir, 'Downloads');
    if (main === undefined) {
      if (app.process.ended === undefined) setup.attempt.appLog({ source: 'console', level: 'warning', text: `[engine] ${NO_INSPECTOR}` });
      // The browser's own setting, for an app whose main process cannot be asked: it places what the default session downloads.
      await answerWithin(app.process.browser.root.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }), Math.min(left(), DOWNLOADS_SETUP_MS));
    } else {
      await placeDownloads(main, downloads, Math.min(left(), DOWNLOADS_SETUP_MS));
    }
    const versions = await answerWithin(readVersions(app, main), left());
    if (versions !== undefined) setup.attempt.environment(versions);
    const reported = main === undefined ? undefined : await answerWithin(main.evaluate(({ app: electronApp }) => electronApp.getAppPath(), undefined), Math.min(left(), ANSWER_MS));
    const { appPath } = setup.app;
    const firstDocument = this.windows.current()?.page.url() ?? '';
    this.directory = appDirectory({ reported, declared: appPath === undefined ? undefined : path.resolve(setup.projectRoot, appPath), firstDocument });
  }

  /** Starts the binary. Nothing is awaited: a binary that cannot start shows as a process that ended. */
  private start(setup: LaunchSetup): RunningApp {
    const { appPath, launchArguments } = setup.app;
    const args = [`--user-data-dir=${setup.userDataDir}`, ...(appPath === undefined ? [] : [path.resolve(setup.projectRoot, appPath)]), ...(launchArguments ?? [])];
    const process = new ElectronProcess({ executable: setup.executable, args, cwd: setup.projectRoot, env: launchEnv(setup.env, this.options.env) });
    let withoutMain: () => void = () => undefined;
    const none = new Promise<undefined>((resolve) => {
      withoutMain = () => resolve(undefined);
    });
    void process.exited.then(withoutMain);
    const log = (type: string, text: string): void => {
      if (this.app === undefined || this.app.process === process) setup.attempt.appLog({ source: 'console', level: levelOf(type), text: `[main] ${text}` });
    };
    const connected = process.inspector.then((address) => MainProcess.connect(address, INSPECTOR_CONNECT_MS, log)).catch(() => undefined);
    const main = Promise.race([connected, none]);
    // Node keeps a finished process alive for its inspector's client: let go, or the app never exits.
    process.onWaitingForInspector(() => void connected.then((client) => client?.close()));
    void process.exited.then(() => connected.then((client) => client?.close()));
    return { process, main, withoutMain, pages: new Map() };
  }

  /**
   * Follows one launched app: its page targets attached and registered as
   * windows once they answer, its logs sent to the attempt that launched it,
   * and its own quit noticed. Its logs stop once another launch replaced it,
   * so an app slow to die never writes into a later attempt; what it logs
   * while it quits still arrives.
   */
  private watch(app: RunningApp, attempt: EngineAttemptContext): void {
    const { root } = app.process.browser;
    const current = (): boolean => this.app === app;
    const replaced = (): boolean => this.app !== undefined && this.app !== app;
    const report: AppReport = {
      log: (entry) => {
        if (!replaced()) attempt.appLog(entry);
      },
      navigated: (url) => {
        if (current()) attempt.navigation(url);
      },
      current,
    };
    /** The targets being attached right now; one that is destroyed meanwhile is taken out. */
    const attaching = new Set<string>();
    const attach = async (info: Protocol.Target.TargetInfo): Promise<void> => {
      // A window or a view is a page target; workers, and the browser itself, are not windows.
      if (info.type !== 'page' || app.pages.has(info.targetId) || attaching.has(info.targetId)) return;
      attaching.add(info.targetId);
      let sessionId: string;
      try {
        ({ sessionId } = await root.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }));
      } catch (cause) {
        attaching.delete(info.targetId);
        throw cause;
      }
      // A target that went away while it was being attached was never a window.
      if (!attaching.delete(info.targetId)) return;
      const page = new PageTarget(info.targetId, app.process.browser.session(sessionId), info.url, info.openerId === undefined ? undefined : app.pages.get(info.openerId));
      app.pages.set(info.targetId, page);
      // A window that has loaded nothing has no renderer and never answers: it becomes a window once it does.
      await this.follow(page, report);
      if (current() && !page.isClosed()) this.windows.add(page);
    };
    root.on('Target.targetCreated', ({ targetInfo }) => void attach(targetInfo).catch(() => undefined));
    root.on('Target.targetInfoChanged', ({ targetInfo }) => app.pages.get(targetInfo.targetId)?.navigated(targetInfo.url));
    root.on('Target.targetDestroyed', ({ targetId }) => {
      attaching.delete(targetId);
      app.pages.get(targetId)?.emit('close');
      app.pages.delete(targetId);
    });
    void root.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
    void app.process.exited.then((exit) => {
      for (const page of app.pages.values()) page.emit('close');
      app.pages.clear();
      // The app quit on its own (its last window closed, or it called app.quit()): there is nothing left to close.
      if (!current()) return;
      this.app = undefined;
      this.windows.clear();
      this.exit = describeExit(exit);
    });
  }

  /**
   * Starts one page's protocol domains and sends its log to the attempt,
   * answers its dialogs, and keeps its crashed and navigated states.
   * Resolves once the page answers, which a page with a renderer does.
   */
  private async follow(page: PageTarget, report: AppReport): Promise<void> {
    const { session } = page;
    const { log } = report;
    let mainFrame: string | undefined;
    const navigatedTo = (url: string): void => {
      page.navigated(url);
      if (this.windows.isShownPage(page)) report.navigated(url);
    };
    session.on('Runtime.consoleAPICalled', (event) => log({ source: 'console', level: levelOf(event.type), text: consoleText(event.args) }));
    session.on('Log.entryAdded', ({ entry }) => log({ source: 'console', level: levelOf(entry.level), text: entry.text }));
    session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      log({ source: 'error', level: 'error', text: exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text });
    });
    // A beforeunload guard is accepted: dismissing it would keep the window open through the engine's own quit. Any
    // other dialog goes to the handler `electron.onDialog` registered.
    session.on('Page.javascriptDialogOpening', ({ type, message }) => {
      const answer = async (accept: boolean): Promise<void> => {
        await session.send('Page.handleJavaScriptDialog', { accept });
      };
      if ((type !== 'alert' && type !== 'confirm') || !report.current()) {
        void answer(type === 'beforeunload').catch(() => undefined);
        return;
      }
      log({ source: 'console', level: 'info', text: `${type} dialog opened: ${message}` });
      this.dialogs.dispatch({ type, message, answer });
    });
    // A crashed renderer answers nothing, and reads say so until it reloads. The session lives on: the renderer the
    // reload starts answers on it, in a new document.
    session.on('Inspector.targetCrashed', () => {
      this.windows.markCrashed(page);
      page.crashed();
      log({ source: 'error', level: 'error', text: 'a window\'s renderer crashed' });
      page.emit('crash');
    });
    session.on('Page.loadEventFired', () => {
      this.windows.markLoaded(page);
      page.emit('load');
    });
    session.on('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId !== undefined) return;
      mainFrame = frame.id;
      page.documentChanged();
      navigatedTo(frame.url + (frame.urlFragment ?? ''));
    });
    session.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
      if (frameId === mainFrame) navigatedTo(url);
    });
    const enabled = session.send('Page.enable');
    for (const start of [
      session.send('Page.getFrameTree').then(({ frameTree }) => {
        mainFrame ??= frameTree.frame.id;
      }),
      session.send('Runtime.enable'),
      session.send('Log.enable'),
      // A hidden or background window still takes focus, as the window a user works in does.
      session.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
    ]) {
      start.catch(() => undefined);
    }
    await enabled;
  }

  /** The running app's main process, or why a function cannot run there. */
  private async main(app: RunningApp): Promise<MainProcess> {
    const main = await app.main;
    if (main === undefined) throw unsupported(NO_INSPECTOR);
    return main;
  }

  /** Runs a function in the app's main process; a failure is the function's own unless the app quit under it. */
  async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg: A): Promise<R> {
    const app = this.app;
    if (app === undefined) throw this.notRunning();
    const main = await this.main(app);
    try {
      return await main.evaluate(fn, arg);
    } catch (cause) {
      // An app that exits under the function fails it before its exit is seen: wait for that a moment. Only then:
      // the function's own error is reported at once.
      const exiting = this.app === app && (closedWindow(cause) || /Execution context was destroyed/.test(String(cause)));
      if (exiting) await answerWithin(app.process.exited, ANSWER_MS);
      if (this.app !== app) throw new EngineError('INVALID_STATE', 'the app quit while electron.evaluate ran', { retryable: false, cause });
      if (!(cause instanceof MainEvaluateError)) throw cause;
      // Its message is the test's, never read for a pattern.
      throw new TestError('EVALUATE_FAILED', `electron.evaluate: ${cause.message}`, { cause });
    }
  }

  /** Every download the app started since it launched, in order, each as it stands now. */
  async downloads(): Promise<readonly AppDownload[]> {
    const app = this.app;
    if (app === undefined) throw this.notRunning();
    return await (await this.main(app)).evaluate(() => (globalThis as { e2eDownloads?: AppDownload[] }).e2eDownloads ?? [], undefined);
  }

  /** The OS window title of a page's `BrowserWindow`, read in the main process; undefined for a view, or when the app does not answer. */
  async windowTitle(page: PageTarget): Promise<string | undefined> {
    const main = this.app === undefined ? undefined : await answerWithin(this.app.main, TITLE_MS);
    if (main === undefined) return undefined;
    const title = await answerWithin(
      main.evaluate(({ BrowserWindow, webContents }, targetId) => {
        const contents = webContents.fromDevToolsTargetId(targetId);
        return contents === undefined ? undefined : BrowserWindow.fromWebContents(contents)?.getTitle();
      }, page.targetId),
      TITLE_MS,
    );
    return title ?? undefined;
  }

  /** Closes one window, past any `beforeunload` guard, and resolves once it is gone. */
  async closeWindow(page: PageTarget): Promise<void> {
    const app = this.app;
    if (app === undefined) throw this.notRunning();
    const gone = page.isClosed() ? Promise.resolve() : page.next('close');
    const main = await answerWithin(app.main, ANSWER_MS);
    // The main process closes a view as well as a window; the protocol's own close is for an app with no inspector.
    const closed = await main
      ?.evaluate(({ webContents }, targetId) => {
        const contents = webContents.fromDevToolsTargetId(targetId);
        if (contents === undefined || contents.isDestroyed()) return false;
        contents.close({ waitForBeforeUnload: false });
        return true;
      }, page.targetId)
      .catch(() => false);
    if (closed !== true) await app.process.browser.root.send('Target.closeTarget', { targetId: page.targetId });
    await gone;
  }
}

const NO_INSPECTOR =
  'the app\'s main process opened no inspector, so electron.evaluate cannot run in it and windows are known by their document titles only: a packaged app built with the EnableNodeCliInspectArguments fuse off ignores --inspect';

/** Ends an app: a graceful quit within `graceMs`, then its process tree killed and waited for. */
async function stop(app: RunningApp, graceMs: number): Promise<void> {
  const { process } = app;
  if (process.ended !== undefined) return;
  const main = await answerWithin(app.main, ANSWER_MS);
  if (main === undefined) {
    void process.browser.root.send('Browser.close').catch(() => undefined);
  } else {
    // A beforeunload guard would keep its window open, and the app's quit handlers from running: Electron ignores one
    // whose will-prevent-unload event is prevented.
    await answerWithin(
      main.evaluate(({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) contents.on('will-prevent-unload', (event) => event.preventDefault());
      }, undefined),
      Math.min(graceMs, ANSWER_MS),
    );
    void main.evaluate(({ app: electronApp }) => electronApp.quit(), undefined).catch(() => undefined);
  }
  if ((await answerWithin(process.exited, graceMs)) !== undefined) return;
  process.killNow();
  // Its files in the user-data directory are deleted next: wait, briefly, until it has let go of them.
  await answerWithin(process.exited, EXIT_WAIT_MS);
}

/** The first of the app's open windows, in the order they opened, to have a parsed document: a window is read from then on. */
async function loaded(pages: () => PageTarget[], deadline: Deadline, signal: AbortSignal): Promise<PageTarget> {
  let first: PageTarget | undefined;
  await pollCondition({
    deadline,
    signal,
    negated: false,
    evaluate: async () => {
      const open = pages();
      const ready = await Promise.all(open.map((page) => parsed(page, Math.min(ANSWER_MS, deadline.remaining()))));
      first = open.find((page, index) => ready[index] === true && !page.isClosed());
      return first !== undefined;
    },
    onTimeout: () => new Error('no window loaded'),
  });
  if (first === undefined) throw new Error('no window loaded');
  return first;
}

/**
 * Whether the page's document has been parsed. A window starts on an empty
 * document while its first page is on the way, and that document is done at
 * once: the target's own address, which names the page being loaded, says the
 * window is not there yet.
 */
async function parsed(page: PageTarget, withinMs: number): Promise<boolean> {
  // A renderer that crashed or is busy never answers, and a window that closed fails the read: neither is loaded.
  const read = await answerWithin(page.session.send('Runtime.evaluate', { expression: '[document.readyState, location.href]', returnByValue: true }), withinMs);
  if (read === undefined) return false;
  const [state, address] = read.result.value as [string, string];
  if (address === 'about:blank' && page.url() !== address && page.url() !== '') return false;
  return state === 'interactive' || state === 'complete';
}

/** Why a launch failed, from what the app did: not `OPERATION_TIMEOUT`, whose message the harness replaces. */
function launchError(
  setup: LaunchSetup,
  process: ElectronProcess,
  seen: { readonly exited: ProcessExit | undefined; readonly ready: boolean | undefined; readonly stuck: number; readonly timeout: number; readonly opened: boolean },
  cause: unknown,
): EngineError {
  const { appPath } = setup.app;
  const output = stderrQuote(process);
  if (process.spawnError !== undefined) {
    return new EngineError('ENGINE_FAILURE', `could not launch ${setup.executable}${appPath === undefined ? '' : ` with ${appPath}`}: ${process.spawnError.message}`, { retryable: false, cause: process.spawnError });
  }
  if (seen.exited !== undefined) {
    const how = describeExit(seen.exited);
    return new EngineError('INVALID_STATE', `the app quit ${seen.opened ? 'right after it opened its first window' : 'before it opened a window'}${how === '' ? '' : ` (${how})`}${noDisplayHint(output)}${output}`, { retryable: false, cause });
  }
  const message =
    seen.ready === false
      ? `Electron did not become ready within ${seen.timeout}ms (its ready event never fired), so the app opened no window`
      : seen.stuck > 0
        ? `the app opened no window that loaded a page within ${seen.timeout}ms: ${seen.stuck} window${seen.stuck === 1 ? ' has' : 's have'} loaded nothing yet`
        : `the app opened no window within ${seen.timeout}ms`;
  return new EngineError('INVALID_STATE', `${message}${keychainHint()}${output}`, { retryable: false, cause });
}

/** What the app wrote to stderr, for a failure's message; empty when it wrote nothing. */
function stderrQuote(process: ElectronProcess): string {
  const lines = process.stderrTail(QUOTED_STDERR_LINES);
  return lines.length === 0 ? '' : `. The app wrote to stderr:\n${lines.join('\n')}`;
}

/** Electron has no headless mode: on a machine with no display it exits at once, and its own message is easy to miss. */
function noDisplayHint(output: string): string {
  return /Missing X server|Unable to open X display|cannot open display/i.test(output) ? ': there is no display, and Electron has no headless mode; run under a virtual display such as xvfb-run' : '';
}

/** An unsigned macOS build that reads the keychain waits on a prompt no test can answer. */
function keychainHint(): string {
  return process.platform === 'darwin' ? ' (an app that waits on a keychain prompt opens none: add \'--use-mock-keychain\' to app.launchArguments)' : '';
}

function describeExit({ code, signal }: ProcessExit): string {
  return signal !== null ? `on ${signal}` : code !== null ? `with exit code ${code}` : '';
}

/** The Electron and Chromium versions of the running app, for the report's environment. */
async function readVersions(app: RunningApp, main: MainProcess | undefined): Promise<{ electron: string; chromium: string }> {
  if (main !== undefined) return await main.evaluate(() => ({ electron: process.versions.electron ?? '', chromium: process.versions.chrome ?? '' }), undefined);
  // Without the main process, the browser's own answer: the app can change its user agent, so this is the fallback.
  const { product, userAgent } = await app.process.browser.root.send('Browser.getVersion');
  return { electron: /Electron\/(\S+)/.exec(userAgent)?.[1] ?? '', chromium: product.replace(/^[^/]*\//, '') };
}

/**
 * Sends downloads to the attempt's own directory, never the user's: Electron
 * saves one without asking in a hidden window. A download the app placed
 * itself, in its own `will-download` handler, stays where the app put it.
 */
async function placeDownloads(main: MainProcess, directory: string, withinMs: number): Promise<void> {
  await answerWithin(
    main.evaluate(({ app: electronApp, session, webContents }, downloads) => {
      electronApp.setPath('downloads', downloads);
      // A session's path is read when it starts, which may be before this runs: each download is placed explicitly, in
      // the sessions there are (a partition the app's ready handler made, too) and in every one made later.
      const placed = new Set<Electron.Session>();
      const place = (target: Electron.Session): void => {
        if (placed.has(target)) return;
        placed.add(target);
        target.on('will-download', (_event, item) => {
          if (item.getSavePath() === '') item.setSavePath(`${downloads}/${item.getFilename()}`);
          // What `electron.waitForDownload` reads: each download the app started, and how it ended.
          const entry = { filename: item.getFilename(), path: item.getSavePath(), state: 'progressing' };
          const log = ((globalThis as { e2eDownloads?: (typeof entry)[] }).e2eDownloads ??= []);
          log.push(entry);
          item.once('done', (_done, state) => {
            entry.path = item.getSavePath();
            entry.state = state;
          });
        });
      };
      place(session.defaultSession);
      for (const contents of webContents.getAllWebContents()) place(contents.session);
      electronApp.on('session-created', place);
    }, directory),
    withinMs,
  );
}

/**
 * The app's environment: the few variables of the run's that a process needs
 * to start and draw (`INHERITED_ENV`, and the locale's `LC_*`), with the
 * engine's `env` option over them. The rest of the run's environment stays
 * with the runner: it holds provider keys and tokens, and an app can log or
 * upload what it is given. Never `ELECTRON_RUN_AS_NODE`, which would start
 * the binary as plain Node.js, nor `NODE_OPTIONS`.
 */
export function launchEnv(runEnv: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  // Windows reads a variable's name in any case.
  for (const [key, value] of Object.entries(runEnv)) {
    const name = key.toUpperCase();
    if (value !== undefined && (INHERITED_ENV.has(name) || name.startsWith('LC_'))) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) if (!REFUSED_ENV.has(key.toUpperCase())) env[key] = value;
  return env;
}

/** The variables of the run's environment an app is started with, by their upper-case names. */
const INHERITED_ENV: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', '__CF_USER_TEXT_ENCODING',
  // A display to draw on, and the session it belongs to.
  'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS',
  // What Windows processes read to find the system and the user's profile.
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
]);


function levelOf(type: string): 'error' | 'warning' | 'info' {
  return type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
}
