import { EngineError } from '@e2e-dev/core/engine';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { call, DriverFailure, loadNativeDriver, translate, type DesktopDriver, type Envelope } from '../../src/driver.ts';

const signal = new AbortController().signal;
const later = <T>(answer: Envelope<T>, ms: number): Promise<Envelope<T>> => new Promise((resolve) => setTimeout(() => resolve(answer), ms));
const failed = (code: string, delivery: string, details?: Record<string, unknown>) => new DriverFailure({ code, message: `${code} from the driver`, disposition: { delivery }, ...(details === undefined ? {} : { details }) });

describe('call', () => {
  it("returns the envelope's data, and throws the failure the driver reported, untranslated", async () => {
    await expect(call(() => Promise.resolve({ ok: true, data: 7 }), { label: 'read', input: false, signal, timeoutMs: 1_000 })).resolves.toBe(7);
    const thrown = await call(() => Promise.resolve({ ok: false, error: { code: 'STALE_REF', message: 'gone', disposition: { delivery: 'not_delivered' } } }), { label: 'click', input: true, signal, timeoutMs: 1_000 }).catch((cause: unknown) => cause);
    expect(thrown).toBeInstanceOf(DriverFailure);
    expect(thrown).toMatchObject({ code: 'STALE_REF', notDelivered: true });
  });

  it('reports an input cut off by the budget as possibly committed, and a read as timed out', async () => {
    await expect(call(() => later({ ok: true, data: {} }, 2_000), { label: 'click', input: true, signal, timeoutMs: 100 })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(call(() => later({ ok: true, data: {} }, 2_000), { label: 'read', input: false, signal, timeoutMs: 100 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('gives an input at least half a second once started, so one that lands is not reported cut off, and a read exactly its budget', async () => {
    await expect(call(() => later({ ok: true, data: 'landed' }, 300), { label: 'click', input: true, signal, timeoutMs: 50 })).resolves.toBe('landed');
    await expect(call(() => later({ ok: true, data: 'late' }, 300), { label: 'read', input: false, signal, timeoutMs: 50 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('cancels with the signal, and starts nothing once it aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(call(() => later({ ok: true, data: {} }, 2_000), { label: 'read', input: false, signal: controller.signal, timeoutMs: 5_000 })).rejects.toMatchObject({ code: 'CANCELLED' });
    let started = false;
    await expect(
      call(
        () => {
          started = true;
          return later({ ok: true, data: {} }, 10);
        },
        { label: 'read', input: false, signal: controller.signal, timeoutMs: 5_000 },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(started).toBe(false);
  });

  it('reports a native call that threw as an engine failure', async () => {
    await expect(call(() => Promise.reject(new Error('addon crashed')), { label: 'read', input: false, signal, timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/addon crashed/) });
  });
});

describe('translate', () => {
  it('keeps only a refusal that sent nothing retryable or refusable', () => {
    expect(translate(failed('STALE_REF', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translate(failed('ELEMENT_NOT_FOUND', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translate(failed('APP_UNRESPONSIVE', 'not_delivered', { retryable: true }), 'snapshot', false)).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(translate(failed('APP_UNRESPONSIVE', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(translate(failed('ACTION_NOT_SUPPORTED', 'not_delivered'), 'click', true)).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(translate(failed('POLICY_DENIED', 'not_delivered'), 'press', true)).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(translate(failed('WINDOW_NOT_FOUND', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/app\.open\(\)/) });
    expect(translate(failed('ACTION_FAILED', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(translate(failed('TIMEOUT', 'not_delivered'), 'click', true)).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(translate(failed('TIMEOUT', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(translate(failed('INTERNAL', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('never lets an input that may have landed look retryable', () => {
    for (const code of ['STALE_REF', 'ACTION_FAILED', 'TIMEOUT', 'ELEMENT_NOT_FOUND']) {
      expect(translate(failed(code, 'delivered_unverified'), 'click', true)).toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    }
  });

  it('names the permission to grant, and passes an engine error through', () => {
    expect(translate(failed('PERM_DENIED', 'not_delivered'), 'snapshot', false)).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/Grant Accessibility/) });
    const engineError = new EngineError('CANCELLED', 'cancelled', { retryable: false });
    expect(translate(engineError, 'click', true)).toBe(engineError);
    expect(translate('odd', 'click', true)).toMatchObject({ code: 'ENGINE_FAILURE' });
  });
});

describe('call: onCutOff', () => {
  it('runs when the budget or the signal cuts the call off, and not when the driver answers', async () => {
    let cutOff = 0;
    const onCutOff = () => {
      cutOff += 1;
    };
    await expect(call(() => later({ ok: true, data: {} }, 2_000), { label: 'type', input: true, signal, timeoutMs: 100, onCutOff })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(call(() => later({ ok: true, data: {} }, 2_000), { label: 'type', input: true, signal: controller.signal, timeoutMs: 5_000, onCutOff })).rejects.toMatchObject({ code: 'CANCELLED' });
    await call(() => Promise.resolve({ ok: true, data: {} }), { label: 'type', input: true, signal, timeoutMs: 1_000, onCutOff });
    expect(cutOff).toBe(2);
  });
});

/** Every function of `DesktopDriver`; `satisfies` fails the typecheck when the interface gains or loses one. */
const NATIVE_FUNCTIONS = [
  'status',
  'screenLocked',
  'processStarted',
  'processesCarrying',
  'forgetProcess',
  'launch',
  'listWindows',
  'snapshot',
  'act',
  'inputId',
  'cancelInput',
  'press',
  'checkCombo',
  'focusWindow',
  'closeWindow',
  'pointer',
  'screenshot',
] as const satisfies readonly Exclude<keyof DesktopDriver, 'version'>[];
type Missing = Exclude<Exclude<keyof DesktopDriver, 'version'>, (typeof NATIVE_FUNCTIONS)[number]>;
const everyFunction: [Missing] extends [never] ? true : Missing = true;

describe('loadNativeDriver', () => {
  it('lists every function of the driver interface', () => expect(everyFunction).toBe(true));

  // Skipped wherever no addon was built, but never in CI's `native` job, which sets REQUIRE_DESKTOP_NATIVE once it built one.
  // It runs only on a checkout build, which the loader must take before a platform package a canary left behind.
  it.skipIf(process.env.REQUIRE_DESKTOP_NATIVE !== '1' && (process.platform !== 'darwin' || !existsSync(new URL(`../../desktop.darwin-${process.arch}.node`, import.meta.url))))(
    'names the build it loaded and keeps every native function callable',
    () => {
      const driver = loadNativeDriver();
      expect(driver.version).toBe('checkout build');
      expect(typeof driver.status().accessibility).toBe('boolean');
      // The loader casts the addon to the interface unchecked: a renamed export would fail only on a real app.
      for (const name of NATIVE_FUNCTIONS) expect(typeof driver[name], name).toBe('function');
      // Input ids come from the addon, which every worker thread of the process shares with its cancel marks.
      const first = driver.inputId();
      expect(driver.inputId()).toBeGreaterThan(first);
    },
  );

  it.each(['linux', 'win32'] as const)('reports %s as unsupported: no driver is built for it', (platform) => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      expect(() => loadNativeDriver()).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining(`no native driver for ${platform}`) }));
    } finally {
      if (real !== undefined) Object.defineProperty(process, 'platform', real);
    }
  });
});
