/**
 * A scripted native driver: each async method answers with the next answer
 * its scenario lists (the last one repeats), every call is recorded with
 * its arguments, and a launch can start a real process standing in for the
 * app, so the engine's quit and sweep paths kill something real. Nothing
 * here loads the native addon, so the tests run on any OS.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import type { DesktopDriver, DriverError, Envelope, Launched, PointerTarget, RawWindow } from '../../src/driver.ts';
import type { RawSnapshot } from '../../src/nodes.ts';

/** One scripted answer: an envelope, with what the fake does before it answers. */
export interface Answer {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: DriverError;
  /** How long the call takes before it answers. */
  readonly sleepMs?: number;
  /** For `snapshot`: the answer to the same call made with `interactive: true`. */
  readonly interactive?: Answer;
  /** For `screenshot`: writes an opaque black PNG of this size to the call's `path`. */
  readonly writePng?: { readonly width: number; readonly height: number };
}

/** An answer, or one computed when the call is made from the fake and the call's arguments. */
export type Scripted = Answer | ((fake: FakeDriver, args: readonly unknown[]) => Answer);

/** The async methods a scenario scripts. */
type AsyncMethod = 'launch' | 'listWindows' | 'snapshot' | 'act' | 'press' | 'focusWindow' | 'closeWindow' | 'pointer' | 'screenshot';

export type Scenario = Partial<Record<AsyncMethod, readonly Scripted[]>>;

/** One call the fake received. */
export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** The processes every fake started, killed by `killSpawned`. */
const children: ChildProcess[] = [];

/** Kills every process a fake started; call it after each test. */
export function killSpawned(): void {
  for (const child of children.splice(0)) child.kill('SIGKILL');
}

/** Whether a process still runs. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A long-lived stand-in process, killed after the test; `exits` makes one that quits at once. */
export function standIn({ exits = false }: { exits?: boolean } = {}): number {
  const child = spawn(process.execPath, ['-e', exits ? '' : 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid!;
}

const ok = (data: unknown): Answer => ({ ok: true, data });

export class FakeDriver implements DesktopDriver {
  readonly version = '0.0.0-test';
  readonly calls: FakeCall[] = [];
  /** What `screenLocked` answers. */
  locked: boolean | null = false;
  /** Whether `processesCarrying` cannot list the processes. */
  lookupFails = false;
  /** Whether `processStarted` cannot tell when any process started. */
  startsUnreadable = false;
  /** When each process started, by id; a running process not listed here started at a time its id fixes. */
  readonly startTimes = new Map<number, number>();
  /** The launch token each process carries in its environment, by id. */
  readonly carriers = new Map<number, string>();
  /** The processes `spawnApp` started, oldest first. */
  readonly spawned: number[] = [];
  accessibility = true;
  screenRecording = true;

  constructor(private scenario: Scenario) {}

  /** Replaces the scenario, as the next host on the same engine handle sees it. */
  rescript(scenario: Scenario): void {
    this.scenario = scenario;
  }

  /** The newest process a launch started. */
  get pid(): number {
    const pid = this.spawned.at(-1);
    if (pid === undefined) throw new Error('nothing was launched');
    return pid;
  }

  /** Starts a process standing in for the app, carrying `token` unless it is undefined. */
  spawn({ token, exits = false }: { token?: string | undefined; exits?: boolean } = {}): number {
    const pid = standIn({ exits });
    this.spawned.push(pid);
    if (token !== undefined) this.carriers.set(pid, token);
    return pid;
  }

  /** The calls of one method. */
  of(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** The actions `act` was asked for, in order. */
  acted(): string[] {
    return this.of('act').map((call) => (call.args[0] as { action: string }).action);
  }

  status() {
    this.calls.push({ method: 'status', args: [] });
    return { accessibility: this.accessibility, screenRecording: this.screenRecording };
  }

  screenLocked(): boolean | null {
    this.calls.push({ method: 'screenLocked', args: [] });
    return this.locked;
  }


  processStarted(pid: number): number | null {
    if (this.startsUnreadable || !alive(pid)) return null;
    return this.startTimes.get(pid) ?? 1_000_000 + pid;
  }

  processesCarrying(token: string): Promise<readonly number[] | null> {
    this.calls.push({ method: 'processesCarrying', args: [token] });
    if (this.lookupFails) return Promise.resolve(null);
    return Promise.resolve([...this.carriers].filter(([pid, carried]) => carried === token && alive(pid)).map(([pid]) => pid));
  }

  forgetProcess(pid: number): void {
    this.calls.push({ method: 'forgetProcess', args: [pid] });
  }

  launch(options: Parameters<DesktopDriver['launch']>[0]): Promise<Envelope<Launched>> {
    return this.answer('launch', [options], spawnApp());
  }

  listWindows(pid: number): Promise<Envelope<readonly RawWindow[]>> {
    return this.answer('listWindows', [pid], (fake) => ok([{ id: 'w-mine', title: 'Spike Form', pid: fake.pid, is_focused: true }]));
  }

  snapshot(options: Parameters<DesktopDriver['snapshot']>[0]): Promise<Envelope<RawSnapshot>> {
    return this.answer('snapshot', [options], snapshotAnswer('macos/appkit-form'));
  }

  act(options: Parameters<DesktopDriver['act']>[0]): Promise<Envelope<unknown>> {
    return this.answer('act', [options], ok({}));
  }

  private lastInputId = 0;

  inputId(): number {
    return (this.lastInputId += 1);
  }

  cancelInput(inputId: number): void {
    this.calls.push({ method: 'cancelInput', args: [inputId] });
  }

  /** Answers like the driver's layout check: a combo this fake's keyboard cannot type is listed in `untypable`. */
  readonly untypable = new Set<string>();

  checkCombo(combo: string): Promise<Envelope<unknown>> {
    if (this.untypable.has(combo)) return Promise.resolve({ ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: `${combo}: no key on this layout types it`, disposition: { delivery: 'not_delivered' }, details: {} } } as Envelope<unknown>);
    return Promise.resolve({ ok: true, data: {} });
  }

  press(options: Parameters<DesktopDriver['press']>[0]): Promise<Envelope<unknown>> {
    return this.answer('press', [options], ok({}));
  }

  /** The input id and budget of each `focusWindow` call, in order. */
  readonly focusOptions: { readonly inputId: number | undefined; readonly timeoutMs: number | undefined }[] = [];

  focusWindow(pid: number, windowId: string, inputId?: number, timeoutMs?: number): Promise<Envelope<unknown>> {
    this.focusOptions.push({ inputId, timeoutMs });
    return this.answer('focusWindow', [pid, windowId], ok({}));
  }

  closeWindow(pid: number, windowId: string, _inputId?: number, _timeoutMs?: number): Promise<Envelope<unknown>> {
    return this.answer('closeWindow', [pid, windowId], ok({}));
  }

  /** The input id and budget of each `pointer` call, in order; its `args` keep the point and kind. */
  readonly pointerOptions: { readonly inputId: number | undefined; readonly timeoutMs: number | undefined; readonly target: PointerTarget | undefined }[] = [];

  pointer(x: number, y: number, kind: string, inputId?: number, timeoutMs?: number, target?: PointerTarget): Promise<Envelope<unknown>> {
    this.pointerOptions.push({ inputId, timeoutMs, target });
    return this.answer('pointer', [x, y, kind], ok({}));
  }

  screenshot(options: Parameters<DesktopDriver['screenshot']>[0]): Promise<Envelope<{ readonly scale_factor?: number }>> {
    return this.answer('screenshot', [options], ok({ scale_factor: 1 }));
  }

  private async answer<T>(method: AsyncMethod, args: readonly unknown[], fallback: Scripted): Promise<Envelope<T>> {
    const index = this.of(method).length;
    this.calls.push({ method, args });
    const list = this.scenario[method] ?? [fallback];
    const scripted = list[Math.min(index, list.length - 1)]!;
    let answer = typeof scripted === 'function' ? scripted(this, args) : scripted;
    if (method === 'snapshot' && (args[0] as { interactive: boolean }).interactive && answer.interactive !== undefined) answer = answer.interactive;
    if (answer.writePng !== undefined) writeFileSync((args[0] as { path: string }).path, blackPng(answer.writePng.width, answer.writePng.height));
    if (answer.sleepMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.sleepMs));
    return (answer.ok ? { ok: true, data: answer.data } : { ok: false, error: answer.error ?? { code: 'INTERNAL', message: 'failed' } }) as Envelope<T>;
  }
}

/** A fake driver on a scenario. */
export function fakeDriver(scenario: Scenario = {}): FakeDriver {
  return new FakeDriver(scenario);
}

/**
 * A launch that starts a real process standing in for the app, carrying the
 * launch's token unless `token` is false, and reports it as the driver does.
 * `runningBefore` are the copies the driver says ran before the launch.
 * `answer` replaces the success envelope: a failure the driver reports after
 * the process started.
 */
export function spawnApp({ token = true, exits = false, sleepMs, answer, runningBefore = [] }: { token?: boolean; exits?: boolean; sleepMs?: number; answer?: Answer; runningBefore?: readonly number[] } = {}): Scripted {
  return (fake, args) => {
    const pid = fake.spawn({ token: token ? (args[0] as { token: string }).token : undefined, exits });
    const reported = answer ?? { ok: true, data: { app: 'SpikeForm', pid, bundle_id: 'dev.e2e.spike.form', started: fake.processStarted(pid) ?? undefined, running_before: runningBefore } };
    return sleepMs === undefined ? reported : { ...reported, sleepMs };
  };
}

/** A snapshot fixture's `data`, as an answer. */
export function snapshotAnswer(name: string): Answer {
  return { ok: true, data: JSON.parse(readFileSync(new URL(`../fixtures/snapshots/${name}.json`, import.meta.url), 'utf8')) as unknown };
}

/** A failed envelope. */
export function failure(code: string, delivery: 'not_delivered' | 'delivered_unverified', message = `${code} from the fake`, details?: Record<string, unknown>): Answer {
  return { ok: false, error: { code, message, disposition: { delivery }, ...(details === undefined ? {} : { details }) } };
}

/** An opaque black 8-bit RGBA PNG. */
function blackPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) row[1 + x * 4 + 3] = 255;
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
