/**
 * Starts the Electron binary and holds its process: the DevTools pipe to its
 * windows, the address of its main process's inspector once it prints one,
 * what it wrote to stderr, and the kill that takes its whole process tree.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { Connection, pipeTransport } from './cdp/connection.ts';

/** How many of the app's last stderr lines a failed launch can quote. */
const STDERR_LINES = 50;

/** How long Windows' taskkill gets to end the process tree before the process alone is killed. */
const TASKKILL_MS = 5_000;

/** How long a process that exited gets to hand over the rest of its stderr. */
const STDERR_DRAIN_MS = 500;

const INSPECTOR_LISTENING = /^Debugger listening on (ws:\/\/\S+)/;
/** What the Node inspector prints about itself, which is not the app's output. */
const INSPECTOR_NOISE = /^(Debugger listening on |For help, see: https:\/\/nodejs\.org\/|Debugger attached\.|Waiting for the debugger to disconnect)/;
/** Printed when the process is done and only the inspector's client keeps it alive. */
const INSPECTOR_WAITING = /Waiting for the debugger to disconnect/;

export interface LaunchCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** How the app's process ended. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The switches the engine starts every app with, before the caller's own. */
export function engineArguments(args: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return [
    // The main process's inspector, on a port of its own choosing, for electron.evaluate.
    '--inspect=0',
    // The windows' DevTools protocol on a pipe: no port, so no other process can connect.
    '--remote-debugging-pipe',
    // Captures in sRGB whatever the display: a wide-gamut screen would otherwise give other pixels for the same page.
    ...(args.some((argument) => argument.startsWith('--force-color-profile')) ? [] : ['--force-color-profile=srgb']),
    // A window another one covers, or the app keeps hidden, still draws and runs its timers: Chromium would
    // otherwise stop both, and a capture of such a window never returns. Parallel workers cover each other's windows.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    ...(args.some((argument) => argument.startsWith('--disable-features')) ? [] : ['--disable-features=CalculateNativeWinOcclusion']),
    // Chromium's sandbox needs a setuid helper or user namespaces, which a CI container rarely has.
    ...(platform === 'linux' && !args.includes('--no-sandbox') ? ['--no-sandbox'] : []),
  ];
}

const running = new Set<ElectronProcess>();
let exitHookInstalled = false;

/** An app the runner leaves behind when it exits would keep its windows open: every one still running is killed. */
function killAtExit(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const launched of running) launched.killNow();
  });
}

export class ElectronProcess {
  /** The DevTools protocol of the app's browser process, over the pipe. */
  readonly browser: Connection;
  /** Resolves when the process ends, however it does; a binary that cannot be started ends at once. */
  readonly exited: Promise<ProcessExit>;
  /** The address of the main process's inspector, once it printed one; never settles for an app that opens none. */
  readonly inspector: Promise<string>;
  /** Why the binary could not be started at all. */
  spawnError: Error | undefined;
  /** Whether the main process printed its inspector's address. */
  inspectorSeen = false;
  private exit: ProcessExit | undefined;
  private readonly stderr: string[] = [];
  private readonly child: ChildProcess;
  private readonly waitingHandlers: (() => void)[] = [];

  constructor(command: LaunchCommand) {
    killAtExit();
    this.child = spawn(command.executable, [...engineArguments(command.args), ...command.args], {
      cwd: command.cwd,
      env: command.env,
      // fd 3 carries the engine's commands and fd 4 the browser's answers. stdout is not read: an unread pipe would stall the app.
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      // A process group of its own, so the kill reaches every helper process Chromium starts.
      detached: process.platform !== 'win32',
    });
    running.add(this);
    this.browser = new Connection(pipeTransport(this.child.stdio[3] as Writable, this.child.stdio[4] as Readable));
    this.exited = new Promise((resolve) => {
      const done = (exit: ProcessExit): void => {
        if (this.exit !== undefined) return;
        // A helper the app started can outlive it, holding the pipes open: the whole group goes, and the pipes with it.
        this.killGroup();
        this.exit = exit;
        running.delete(this);
        this.browser.close();
        // What the app wrote last is still on its way: its stderr is read to the end, which the killed group cannot hold off.
        const { stderr } = this.child;
        const finish = (): void => {
          stderr?.destroy();
          resolve(exit);
        };
        if (stderr === null || stderr.readableEnded || stderr.destroyed) return finish();
        stderr.once('close', finish);
        setTimeout(finish, STDERR_DRAIN_MS).unref();
      };
      this.child.once('exit', (code, signal) => done({ code, signal }));
      this.child.once('error', (error) => {
        this.spawnError = error;
        done({ code: null, signal: null });
      });
    });
    this.inspector = new Promise((resolve) => {
      let partial = '';
      this.child.stderr?.setEncoding('utf8');
      const read = (chunk: string, last: boolean): void => {
        const lines = (partial + chunk).split('\n');
        partial = last ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          const address = INSPECTOR_LISTENING.exec(line)?.[1];
          if (address !== undefined) {
            this.inspectorSeen = true;
            resolve(address);
          }
          if (INSPECTOR_WAITING.test(line)) for (const handler of this.waitingHandlers) handler();
          if (line.trim() === '' || INSPECTOR_NOISE.test(line)) continue;
          this.stderr.push(line.trim());
          if (this.stderr.length > STDERR_LINES) this.stderr.shift();
        }
      };
      this.child.stderr?.on('data', (chunk: string) => read(chunk, false));
      // A last line with no newline after it is a line all the same.
      this.child.stderr?.once('end', () => read('', true));
    });
  }

  /** How the process ended, or undefined while it runs. */
  get ended(): ProcessExit | undefined {
    return this.exit;
  }

  /** The last lines the app wrote to stderr, each once, in order. */
  stderrTail(count: number): string[] {
    return [...new Set(this.stderr)].slice(-count);
  }

  /** Runs `handler` when the process is done and waits only for the inspector's client to let go. */
  onWaitingForInspector(handler: () => void): void {
    this.waitingHandlers.push(handler);
  }

  /** Kills the process and every process it started, without waiting for them. */
  killNow(): void {
    if (this.exit === undefined) this.killGroup();
  }

  private killGroup(): void {
    const { pid } = this.child;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') {
        const { status, error } = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: TASKKILL_MS });
        if (error !== undefined || status !== 0) throw error ?? new Error(`taskkill exited with ${status}`);
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      // The group is gone already, or was never the process's own: the process itself is still killed.
      if (this.exit === undefined) this.child.kill('SIGKILL');
    }
  }
}
