/**
 * `@e2e-dev/core`'s Ctrl-C: a program that holds a host and gets SIGINT or SIGHUP
 * closes the host, and the engine with it, then ends by the signal, whatever
 * the engine listens for; a close that fails says so on stderr before the
 * process goes.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECTS = path.join(import.meta.dirname, '..', 'tmp-projects');
const FAKE_ENGINE = path.join(import.meta.dirname, '..', 'helpers', 'fake-engine.ts');

/** Runs a program that opens a host and a session, sends it `signal` once it is ready, and reports how it ended. */
async function interrupt(failClose: boolean, signal: NodeJS.Signals = 'SIGINT', listens = ''): Promise<{ signal: NodeJS.Signals | null; code: number | null; stderr: string; disposed: boolean }> {
  mkdirSync(PROJECTS, { recursive: true });
  const dir = mkdtempSync(path.join(PROJECTS, 'core-signals-'));
  const marker = path.join(dir, 'disposed');
  const program = path.join(dir, 'program.ts');
  writeFileSync(program, `
import { writeFileSync } from 'node:fs';
import { launch } from '@e2e-dev/core';
import { createFakeEngine, FAKE_APP } from ${JSON.stringify(FAKE_ENGINE)};

const fake = createFakeEngine({
  // A browser driver listens for a hangup to close its browsers, and its listener stays after they are closed.
  onInit: () => { process.on('SIGHUP', () => undefined); },
  onDispose: () => writeFileSync(${JSON.stringify(marker)}, 'disposed'),
  ${failClose ? "onEndAttempt: () => { throw new Error('the device would not let go'); }," : ''}
});
const host = await launch(fake.engine, { app: FAKE_APP, cwd: ${JSON.stringify(dir)}, env: {} });
await host.newSession();
${listens}
process.stdout.write('READY\\n');
setInterval(() => undefined, 1_000);
`);
  // Run from the package, so the program resolves @e2e-dev/core the way the tests do.
  const child = spawn(process.execPath, [program], { cwd: path.join(import.meta.dirname, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('READY')) resolve(); });
    child.once('exit', () => reject(new Error(`the program exited before it was ready:\n${stderr}`)));
  });
  child.kill(signal);
  // A program that listens for the signal itself decides when it ends: here it never does.
  const stays = listens === '' ? undefined : setTimeout(() => child.kill('SIGKILL'), 3_000);
  const [code, ended] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
  clearTimeout(stays);
  return { code, signal: ended, stderr, disposed: existsSync(marker) };
}

describe('@e2e-dev/core on a signal', { timeout: 60_000 }, () => {
  it('closes the host, disposing its engine, then ends by the signal', async () => {
    const ended = await interrupt(false);
    expect(ended, ended.stderr).toMatchObject({ signal: 'SIGINT', disposed: true });
    expect(ended.stderr).not.toContain('failed');
  });

  it('ends by SIGHUP though the engine listens for it, and leaves a program that listens itself to decide', async () => {
    expect(await interrupt(false, 'SIGHUP')).toMatchObject({ signal: 'SIGHUP', disposed: true });
    expect(await interrupt(false, 'SIGHUP', "process.on('SIGHUP', () => undefined);")).toMatchObject({ signal: 'SIGKILL', disposed: true });
  });

  it('says on stderr that a close failed, and still ends by the signal', async () => {
    const ended = await interrupt(true);
    expect(ended.signal).toBe('SIGINT');
    expect(ended.stderr).toContain('@e2e-dev/core: closing a host on SIGINT failed');
  });
});
