/** Exercises process ownership and CDP discovery through a fake Moli executable. */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserLease, BrowserProvider, BrowserReleaseContext, BrowserRequest } from '@e2e-dev/web';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { moli } from '../../src/index.ts';

const FAKE_SERVER = `
const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
if (args[0] !== 'serve') { process.stderr.write('usage: moli serve'); process.exit(2); }
if (args.includes('--crash')) { process.stderr.write('moli could not initialize'); process.exit(1); }
if (args.includes('--ignore-term')) process.on('SIGTERM', () => {});
else process.on('SIGTERM', () => process.exit(0));
setTimeout(() => {
  require('node:http').createServer((request, response) => {
    if (request.url !== '/json/version') { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(flag('--version-body') ?? JSON.stringify({
      'Moli-Version': '1.1.25-test',
      webSocketDebuggerUrl: 'ws://127.0.0.1:' + flag('--port') + '/devtools/browser/fake',
      args,
      marker: process.env.MOLI_TEST_MARKER,
    }));
  }).listen(Number(flag('--port')), flag('--host'));
}, Number(flag('--delay') ?? 0));
`;

let directory: string;
let script: string;
let binary: string;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'e2e-moli-'));
  script = path.join(directory, 'fake-moli.cjs');
  binary = path.join(directory, 'moli');
  writeFileSync(script, FAKE_SERVER);
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(binary, 0o755);
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A worker request with its logs available to the test. */
function browserRequest(overrides: Partial<BrowserRequest> = {}): BrowserRequest & { lines: string[] } {
  const lines: string[] = [];
  return {
    runId: 'moli-test', targetName: 'web', slot: 0, slots: 1,
    env: {}, signal: new AbortController().signal,
    log: (line) => lines.push(line), lines,
    ...overrides,
  };
}

const releaseContext: BrowserReleaseContext = {
  runId: 'moli-test', targetName: 'web', env: {},
  signal: new AbortController().signal, log: () => undefined,
};

/** Registers successful acquisitions for cleanup even when a later assertion fails. */
async function acquire(provider: BrowserProvider, request = browserRequest()): Promise<BrowserLease> {
  const lease = await provider.acquire(request);
  cleanup.push(() => provider.release(lease, releaseContext));
  return lease;
}

/** Reads the discovery response, or returns undefined after the process exits. */
async function discovery(lease: BrowserLease): Promise<{ args: string[]; marker?: string } | undefined> {
  try {
    const response = await fetch(`${lease.cdpEndpoint}/json/version`);
    return await response.json() as { args: string[]; marker?: string };
  } catch {
    return undefined;
  }
}

/** Counts only this test file's uniquely named fake process. */
function runningServers(pattern = script): number {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').length;
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 1) return 0;
    throw cause;
  }
}

// The fake executable uses a POSIX shell wrapper.
describe.skipIf(process.platform === 'win32')('moli()', () => {
  it('starts a local browser with layout and resources, then stops it on release', async () => {
    const provider = moli({ binary });
    const request = browserRequest({ env: { MOLI_TEST_MARKER: 'worker-environment' } });
    const lease = await acquire(provider, request);
    expect(provider.name).toBe('moli');
    expect(provider.scope).toBeUndefined();
    expect(lease.cdpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(lease.id).toBe(lease.cdpEndpoint);
    expect(request.lines).toEqual([`moli 1.1.25-test at ${lease.cdpEndpoint}`]);
    expect(await discovery(lease)).toMatchObject({ args: ['serve', '--host', '127.0.0.1', '--port', new URL(lease.cdpEndpoint).port, '--layout', '--resource'], marker: 'worker-environment' });
    await provider.release(lease, releaseContext);
    expect(await discovery(lease)).toBeUndefined();
  });

  it('opts out of layout and resources and forwards additional serve flags', async () => {
    const lease = await acquire(moli({ binary, layout: false, loadResources: false, args: ['--log-level', 'warn'] }));
    expect((await discovery(lease))?.args.slice(5)).toEqual(['--log-level', 'warn']);
  });

  it('starts a separate server for each worker slot', async () => {
    const provider = moli({ binary });
    const [first, second] = await Promise.all([
      acquire(provider, browserRequest({ slot: 0, slots: 2 })),
      acquire(provider, browserRequest({ slot: 1, slots: 2 })),
    ]);
    expect(first.cdpEndpoint).not.toBe(second.cdpEndpoint);
    await provider.release(first, releaseContext);
    expect(await discovery(first)).toBeUndefined();
    expect(await discovery(second)).toBeDefined();
  });

  it('uses MOLI_PATH from the run environment and lets binary override it', async () => {
    const request = browserRequest({ env: { MOLI_PATH: ` ${binary} ` } });
    expect(await discovery(await acquire(moli(), request))).toBeDefined();
    const explicit = await acquire(moli({ binary }), browserRequest({ env: { MOLI_PATH: path.join(directory, 'missing') } }));
    expect(await discovery(explicit)).toBeDefined();
  });

  it('finds an executable on PATH, skipping a directory and a non-executable file', async () => {
    const shadow = path.join(directory, 'shadow');
    const locked = path.join(directory, 'locked');
    mkdirSync(path.join(shadow, 'moli'), { recursive: true });
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'moli'), 'not executable');
    const lease = await acquire(moli(), browserRequest({ env: { PATH: [shadow, locked, directory].join(path.delimiter), MOLI_PATH: ' ' } }));
    expect(await discovery(lease)).toBeDefined();
  });

  it('falls back to ~/.local/bin and names the install guide when no binary exists', async () => {
    const home = path.join(directory, 'home');
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    copyFileSync(binary, path.join(home, '.local', 'bin', 'moli'));
    expect(await discovery(await acquire(moli(), browserRequest({ env: { HOME: home } })))).toBeDefined();
    await expect(acquire(moli(), browserRequest({ env: { HOME: path.join(directory, 'missing-home') } }))).rejects.toThrow(/install it \(https:\/\/github.com\/lexmount\/moli#direct-installation\) or set MOLI_PATH/);
  });

  it('accepts CDP discovery without a Moli version', async () => {
    const request = browserRequest();
    const lease = await acquire(moli({ binary, args: ['--version-body', JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fake' })] }), request);
    expect(request.lines).toEqual([`moli unknown at ${lease.cdpEndpoint}`]);
  });

  it('requires a WebSocket endpoint in CDP discovery', async () => {
    const provider = moli({ binary, args: ['--version-body', '{}'] });
    await expect(acquire(provider, browserRequest({ signal: AbortSignal.timeout(300) }))).rejects.toThrow(/cancelled before the Moli CDP server answered/);
    expect(runningServers()).toBe(0);
  });

  it('reports the stderr of a process that exits before discovery is ready', async () => {
    await expect(acquire(moli({ binary, args: ['--crash'] }))).rejects.toThrow(/exited with code 1 before its CDP server answered:\nmoli could not initialize/);
    expect(runningServers()).toBe(0);
  });

  it('reports a missing executable without leaking the startup poll', async () => {
    await expect(acquire(moli({ binary: path.join(directory, 'missing') }))).rejects.toThrow(/could not start .*missing/);
  });

  it('starts no process for an already cancelled acquisition', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquire(moli({ binary }), browserRequest({ signal: controller.signal }))).rejects.toThrow(/cancelled/);
    expect(runningServers()).toBe(0);
  });

  it('stops a process when cancellation arrives during startup', async () => {
    const provider = moli({ binary, args: ['--delay', '60000'] });
    await expect(acquire(provider, browserRequest({ signal: AbortSignal.timeout(100) }))).rejects.toThrow(/cancelled before the Moli CDP server answered/);
    expect(runningServers()).toBe(0);
  });

  it('ends a server that never answers within the startup timeout', async () => {
    await expect(acquire(moli({ binary, args: ['--delay', '60000'] }))).rejects.toThrow(/within 10000ms/);
    expect(runningServers()).toBe(0);
  }, 20_000);

  it.each(['on SIGTERM', 'before release'])('stops descendants when the wrapper exits %s', async (when) => {
    const wrapper = path.join(directory, `wrapper-${when.replaceAll(' ', '-')}.cjs`);
    const wrapperBinary = `${wrapper}.sh`;
    const pidFile = `${wrapper}.pid`;
    writeFileSync(wrapper, `
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require('node:child_process').spawn(process.execPath, [${JSON.stringify(script)}, ...process.argv.slice(2), '--ignore-term'], { stdio: 'ignore' });
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
    writeFileSync(wrapperBinary, `#!/bin/sh\nexec "${process.execPath}" "${wrapper}" "$@"\n`, { mode: 0o755 });
    cleanup.push(async () => {
      if (!existsSync(pidFile)) return;
      try {
        process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch (cause) {
        if (!(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH')) throw cause;
      }
      await expect.poll(() => runningServers()).toBe(0);
    });
    const provider = moli({ binary: wrapperBinary });
    const lease = await acquire(provider);
    if (when === 'before release') {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM');
      await expect.poll(() => runningServers(wrapper)).toBe(0);
    }
    expect(await discovery(lease)).toBeDefined();
    await provider.release(lease, releaseContext);
    await expect.poll(() => discovery(lease)).toBeUndefined();
    expect(runningServers()).toBe(0);
  });

  it('kills a server that ignores SIGTERM', async () => {
    const provider = moli({ binary, args: ['--ignore-term'] });
    const lease = await acquire(provider);
    await provider.release(lease, releaseContext);
    expect(await discovery(lease)).toBeUndefined();
    expect(runningServers()).toBe(0);
  });
});
