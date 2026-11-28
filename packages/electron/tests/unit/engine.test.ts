import { describe, expect, it } from 'vitest';
import { electron } from '../../src/engine.ts';
import { checkLaunchArguments, resolveOptions } from '../../src/options.ts';

describe('electron()', () => {
  it('declares the capabilities of a Chromium window driven over the DevTools protocol', () => {
    const engine = electron();
    expect(engine.name).toBe('electron');
    expect(engine.platform).toBe('electron');
    expect([...engine.capabilities]).toEqual(expect.arrayContaining(['observation', 'actions', 'location', 'pointer', 'keyboard', 'artifacts', 'electron']));
    expect(engine.actions).toContain('setInputFiles');
    expect(engine.actions).toContain('setInputFilePayloads');
    expect([...engine.capabilities]).toEqual(expect.arrayContaining(['computed-style', 'viewport-intersection']));
    expect(engine.artifacts?.startVideo).toBeTypeOf('function');
    expect(engine.artifacts?.stopVideo).toBeTypeOf('function');
    expect(engine.session?.back).toBeTypeOf('function');
    expect(engine.session?.restart).toBeTypeOf('function');
    expect(engine.session?.open).toBeUndefined();
  });

  it('needs app.appPath unless a packaged app names its own', () => {
    const info = { targetName: 'desktop' };
    expect(() => electron().validateApp?.({}, info)).toThrow(/needs app\.appPath/);
    expect(() => electron().validateApp?.({ appPath: '.' }, info)).not.toThrow();
    expect(() => electron({ executablePath: 'dist/My App' }).validateApp?.({}, info)).not.toThrow();
  });

  it('refuses app fields an Electron app has no use for', () => {
    const info = { targetName: 'desktop' };
    expect(() => electron().validateApp?.({ appPath: '.', url: 'http://localhost:3000' }, info)).toThrow(/loads its own pages/);
    expect(() => electron().validateApp?.({ bundleId: 'com.example.app' }, info)).toThrow(/app\.bundleId/);
    expect(() => electron().validateApp?.({ appPath: '.', permissions: { camera: 'granted' } } as never, info)).toThrow(/app\.permissions/);
    expect(() => electron().validateApp?.({ appPath: '.', launchArguments: ['--user-data-dir=/tmp/shared'] }, info)).toThrow(/--user-data-dir/);
  });
});

describe('resolveOptions', () => {
  it('applies the defaults', () => {
    expect(resolveOptions(undefined)).toEqual({ env: {}, testIdAttribute: 'data-testid', settleMs: 100 });
    expect(resolveOptions({ settle: false }).settleMs).toBe(0);
  });

  it('refuses unknown keys and values of the wrong shape at config load', () => {
    expect(() => resolveOptions({ headless: true } as never)).toThrow(/headless/);
    // Removed options: launch switches are the target's app.launchArguments, and app.open() takes the config's timeout.
    expect(() => resolveOptions({ args: ['--disable-gpu'] } as never)).toThrow(/args/);
    expect(() => resolveOptions({ launchTimeout: 1000 } as never)).toThrow(/launchTimeout/);
    expect(() => resolveOptions({ dialogs: 'accept' } as never)).toThrow(/dialogs/);
    expect(() => checkLaunchArguments(['--user-data-dir=/tmp/x'])).toThrow(/app\.launchArguments must not set --user-data-dir/);
    // The engine opens the inspector and the DevTools pipe itself; a fixed port also collides between workers.
    expect(() => checkLaunchArguments(['--inspect=9229'])).toThrow(/--inspect/);
    expect(() => checkLaunchArguments(['--remote-debugging-port=9222'])).toThrow(/--remote-debugging-port/);
    expect(() => checkLaunchArguments(['--lang=de', '--no-update-check'])).not.toThrow();
    expect(() => resolveOptions({ env: { ELECTRON_RUN_AS_NODE: '1' } })).toThrow(/ELECTRON_RUN_AS_NODE/);
    // Windows reads a variable's name in any case.
    expect(() => resolveOptions({ env: { electron_run_as_node: '1' } })).toThrow(/electron_run_as_node/);
    expect(() => resolveOptions({ env: { Node_Options: '--inspect' } })).toThrow(/Node_Options/);
    expect(() => resolveOptions({ env: { A: 1 } } as never)).toThrow(/string value/);
    expect(() => resolveOptions({ testIdAttribute: 'data test' })).toThrow(/testIdAttribute/);
    expect(() => resolveOptions(null as never)).toThrow(/must be an object/);
  });
});
