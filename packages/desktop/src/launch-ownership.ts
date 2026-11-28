/**
 * What a desktop worker owns outside its process, and how a later run takes it
 * back: the state directory each worker keeps (its owner file and the record
 * of the app it launched), the sweep that quits an app a killed worker left
 * running and removes its directory, the kill that waits for an app to exit,
 * and the cut of the run's environment the app is given.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EngineError } from '@e2e-dev/core/engine';
import type { DesktopDriver } from './driver.ts';

const execFileAsync = promisify(execFile);

/** How often a launch checks whether the app's window can be read yet. */
export const LAUNCH_POLL_MS = 100;

/** The prefix of every worker's private state directory, which a later run sweeps once its worker is gone. */
export const STATE_PREFIX = 'e2e-desktop-worker-';

/** The prefixes a sweep takes: this engine's, and the agent-desktop engine's before it, whose directories hold the text of fields. */
const SWEPT_PREFIXES = [STATE_PREFIX, 'e2e-agent-desktop-'];

/** The file in a state directory that names the process that owns it: its id, and on the next line when it started, which tells it from a later process the OS gives the same id. */
export const OWNER_FILE = 'owner';

/** What the owner file holds once its worker gave the directory up: a later sweep takes it, though the process that wrote it may still run another worker. */
const ABANDONED = 'abandoned';

/** The file in a state directory that names the app the worker launched and its launch token, so a sweep can quit an app a killed worker left running. */
export const APP_FILE = 'app.json';

/** How old a state directory with no owner file must be before a sweep removes it. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The variables of the run's environment the app under test gets, and
 * nothing else: the run's secrets, model keys, and CI tokens never reach a
 * process the runner does not control. `LC_*` passes too.
 */
const INHERITED_ENV = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING']);

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * What `init` needs of an `appPath` bundle: an Info.plist naming the
 * bundle id, which is the target's `bundleId` when that is set too.
 */
export async function checkBundle(bundle: string, bundleId: string | undefined, signal: AbortSignal): Promise<{ bundleId: string } | { problem: string }> {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return { problem: `app.appPath ${bundle} is not an app bundle: it has no Contents/Info.plist. Build the app first` };
  // plutil exits with an error when the key is missing or the file is no plist.
  const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { signal }).catch(() => ({ stdout: '' }));
  const declared = stdout.trim();
  if (declared === '') return { problem: `${plist} declares no CFBundleIdentifier` };
  if (bundleId !== undefined && bundleId !== declared) {
    return { problem: `app.bundleId "${bundleId}" is not the CFBundleIdentifier "${declared}" of app.appPath ${bundle}; the build at appPath is what app.open() launches` };
  }
  return { bundleId: declared };
}

/** The run's environment cut to the variables the app may see (`INHERITED_ENV`, and `LC_*`). */
export function inheritedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (INHERITED_ENV.has(name) || name.startsWith('LC_'))) kept[name] = value;
  }
  return kept;
}

/**
 * Removes the state directories workers left behind, and quits the app such
 * a worker launched and left running: every process whose environment
 * carries the token its launch record names, and the process the record
 * names when it is still the one that started then. A directory goes once
 * the process its owner file names is gone, or, with no owner file, once it
 * is a day old. One still in use is never touched. A process shown to be
 * the launch's by neither is left alone. When the processes cannot be
 * looked up, or one does not exit, the record stays for the next run to try
 * again. The agent-desktop engine's directories, which hold the text of
 * fields, are swept the same way.
 */
export async function sweepStateDirectories(driver: DesktopDriver): Promise<void> {
  const root = tmpdir();
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!SWEPT_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    const directory = path.join(root, entry);
    // A shared temporary directory (`/tmp` when TMPDIR is unset) holds other users' entries too: a record this user did not write names no launch of its own, and its process id must not be killed with this user's rights.
    if (!(await ownDirectory(directory))) continue;
    const ownerText = (await readFile(path.join(directory, OWNER_FILE), 'utf8').catch(() => '')).trim();
    const [ownerId = '', ownerStarted] = ownerText.split('\n');
    const owner = Number(ownerId);
    const stale =
      ownerText === ABANDONED ||
      (Number.isInteger(owner) && owner > 0 ? !ownerRuns(driver, owner, ownerStarted) : await stat(directory).then((info) => Date.now() - info.mtimeMs > ORPHAN_AGE_MS, () => false));
    if (!stale) continue;
    // A record cut short by the kill that left it names no process: the directory still goes.
    const parsed: unknown = await readFile(path.join(directory, APP_FILE), 'utf8').then((text): unknown => JSON.parse(text)).catch(() => undefined);
    const launched = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const owned: number[] = [];
    let known = true;
    if (typeof launched.token === 'string' && launched.token !== '') {
      const carriers = await driver.processesCarrying(launched.token);
      if (carriers === null) known = false;
      else owned.push(...carriers);
    }
    const { pid, started } = launched;
    if (typeof pid === 'number' && (typeof started === 'number' || typeof started === 'string') && alive(pid)) {
      const now = driver.processStarted(pid);
      const same = now === null ? undefined : sameStart(started, now);
      // Running, but when it started cannot be read or matched: whether it is the launch's process is unknown.
      if (same === undefined) known = false;
      else if (same && !owned.includes(pid)) owned.push(pid);
    }
    const settled = known && (await killed(owned, Date.now() + 2_000, AbortSignal.timeout(5_000)));
    await (settled ? rm(directory, { recursive: true, force: true }) : keepOnlyRecord(directory)).catch(() => undefined);
  }
}

/**
 * Whether the worker process an owner file names still runs: one with its id
 * that started when the file says, in this engine's form or the
 * agent-desktop engine's (`sameStart`). A start time that cannot be read or
 * compared counts as the same process, so a directory in use is never taken.
 */
function ownerRuns(driver: DesktopDriver, pid: number, started: string | undefined): boolean {
  if (!alive(pid)) return false;
  if (started === undefined) return true;
  const now = driver.processStarted(pid);
  if (now === null) return true;
  return sameStart(/^\d+$/.test(started) ? Number(started) : started, now) ?? true;
}

/**
 * Whether a recorded start time names the process that started at `now`
 * (microseconds since the epoch). This engine records the microseconds; the
 * agent-desktop engine before it recorded `ps -o lstart=` printed in UTC, to
 * the second. Undefined for a record in neither form.
 */
function sameStart(recorded: number | string, now: number): boolean | undefined {
  if (typeof recorded === 'number') return recorded === now;
  const at = Date.parse(`${recorded} UTC`);
  return Number.isNaN(at) ? undefined : Math.floor(now / 1_000_000) === at / 1_000;
}

/** Whether `directory` is a real directory (not a symlink) that belongs to the user this process runs as. */
async function ownDirectory(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return false;
  return process.getuid === undefined || info.uid === process.getuid();
}

/**
 * Gives up a state directory whose launch record still names an app: only
 * the record stays, and the owner file says the directory has no worker any
 * more, so the next sweep takes it even while this process runs on, as a
 * program that opens one host after another does.
 */
export async function abandon(directory: string): Promise<void> {
  await keepOnlyRecord(directory);
  await writeFile(path.join(directory, OWNER_FILE), ABANDONED);
}

/** Removes everything in a state directory but its owner file and launch record. */
async function keepOnlyRecord(directory: string): Promise<void> {
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    if (entry !== OWNER_FILE && entry !== APP_FILE) await rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

/**
 * Kills each process and waits until all of them exited; false when one still runs at `until`. A quit cancelled, or out
 * of time, before the kill sends none: the caller gave the app up as running, and keeps it to quit again.
 */
export async function killed(pids: readonly number[], until: number, signal: AbortSignal): Promise<boolean> {
  if (pids.length > 0 && signal.aborted) throw new EngineError('CANCELLED', 'quitting the app was cancelled before it was killed', { retryable: false });
  if (pids.length > 0 && Date.now() >= until) throw new EngineError('OPERATION_TIMEOUT', 'quitting the app ran out of time before it was killed', { retryable: false });
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  while (pids.some((pid) => alive(pid))) {
    if (signal.aborted || Date.now() >= until) return false;
    await sleep(LAUNCH_POLL_MS, signal);
  }
  return true;
}

/** Whether a process still runs: it answers signal 0, or exists but belongs to another user. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}
