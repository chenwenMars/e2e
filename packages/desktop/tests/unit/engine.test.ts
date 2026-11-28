import { describeEngine } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { desktop } from '../../src/engine.ts';
import { resolveOptions } from '../../src/options.ts';

describe('desktop()', () => {
  it('offers keys without physicalInput, and the pointer-only actions with physicalInput alone', () => {
    const plain = desktop();
    const physical = desktop({ physicalInput: true });
    expect(plain.actions).not.toContain('doubleTap');
    expect(plain.actions).not.toContain('hover');
    // A key goes into the app's own event queue, which reaches its key window while it stays in the background.
    expect(plain.actions).toContain('press');
    expect(plain.keyboard).toBeDefined();
    expect(plain.pointerActions).toBeUndefined();
    expect(physical.actions).toEqual(expect.arrayContaining(['doubleTap', 'hover', 'press']));
    expect(physical.pointerActions).toEqual(expect.arrayContaining(['tap', 'doubleTap', 'secondaryTap', 'hover']));
    expect(physical.keyboard).toBeDefined();
    expect(plain.workers).toBe(1);
    expect(describeEngine(plain).launchArgumentValues).toBe(true);
  });

  it('refuses options it does not take', () => {
    expect(() => resolveOptions({ settle: 1.5 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    // The agent-desktop executable is gone: a config that still names one fails to load, rather than run on something else.
    expect(() => resolveOptions({ binary: '/usr/local/bin/agent-desktop' } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ snapshot: 'all' as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions({ bogus: 1 } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(resolveOptions({ settle: false })).toMatchObject({ settleMs: 0, physicalInput: false, interactiveOnly: false });
    expect(resolveOptions({})).toMatchObject({ maxDepth: 24 });
    expect(resolveOptions({ maxDepth: 50 })).toMatchObject({ maxDepth: 50 });
    for (const maxDepth of [0, 51, 2.5]) expect(() => resolveOptions({ maxDepth })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => resolveOptions(null as unknown as undefined)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses an app it cannot launch', () => {
    const engine = desktop();
    const check = (app: Record<string, unknown>) => () => engine.validateApp?.(app, { targetName: 'mac' });
    expect(check({ url: 'http://localhost:3000' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({})).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ bundleId: 'com.example.app', permissions: { camera: 'grant' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ bundleId: 'com.example.app' })).not.toThrow();
    expect(check({ appPath: 'build/App.zip' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(check({ appPath: 'build/App.app' })).not.toThrow();
  });

  it.each(['linux', 'win32'] as const)('loads on %s, and reports a target there as unsupported before it starts', async (platform) => {
    const engine = desktop();
    expect(engine.platform).toBe('macos');
    await onPlatform(platform, async () => {
      const unsupported = { code: 'UNSUPPORTED_CAPABILITY', message: `desktop() is not supported on ${platform}: it drives macOS apps only` };
      await expect(Promise.resolve().then(() => engine.prepare?.({} as never))).rejects.toMatchObject(unsupported);
      await expect(Promise.resolve().then(() => engine.init?.({} as never))).rejects.toMatchObject(unsupported);
      await expect(engine.doctor?.({} as never)).resolves.toEqual([{ id: 'platform', status: 'fail', message: unsupported.message }]);
    });
  });
});

/** Runs `body` while `process.platform` reads `platform`. */
async function onPlatform(platform: NodeJS.Platform, body: () => Promise<void>): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    await body();
  } finally {
    if (real !== undefined) Object.defineProperty(process, 'platform', real);
  }
}
