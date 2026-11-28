import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { appPathProblem, describeExecutable, ensureElectronBinary, resolveExecutable } from '../../src/executable.ts';

const root = mkdtempSync(path.join(tmpdir(), 'e2e-electron-executable-'));
mkdirSync(path.join(root, 'MyApp.app'));
writeFileSync(path.join(root, 'package.json'), '{}');
writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\n');
chmodSync(path.join(root, 'run.sh'), 0o755);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the project\'s electron package', () => {
  it('starts the binary ELECTRON_OVERRIDE_DIST_PATH names, as Electron\'s own index.js does', async () => {
    const project = path.join(root, 'project');
    const electron = path.join(project, 'node_modules', 'electron');
    const override = path.join(root, 'custom-dist');
    mkdirSync(electron, { recursive: true });
    mkdirSync(override, { recursive: true });
    writeFileSync(path.join(project, 'package.json'), '{}');
    writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.5.0', main: 'index.js' }));
    writeFileSync(path.join(electron, 'index.js'), '');
    writeFileSync(path.join(override, 'electron'), '');
    expect(describeExecutable(project, undefined).status).toBe('warn');
    process.env['ELECTRON_OVERRIDE_DIST_PATH'] = override;
    try {
      expect(resolveExecutable(project, undefined)).toBe(path.join(override, 'electron'));
      expect(describeExecutable(project, undefined).status).toBe('pass');
    } finally {
      delete process.env['ELECTRON_OVERRIDE_DIST_PATH'];
    }
  });

  it('names the variable, and downloads nothing, when ELECTRON_OVERRIDE_DIST_PATH points where no binary is', async () => {
    const project = path.join(root, 'project');
    process.env['ELECTRON_OVERRIDE_DIST_PATH'] = path.join(root, 'nowhere');
    try {
      expect(() => resolveExecutable(project, undefined)).toThrow(/ELECTRON_OVERRIDE_DIST_PATH/);
      await expect(ensureElectronBinary(project, undefined, () => undefined, new AbortController().signal)).rejects.toThrow(/ELECTRON_OVERRIDE_DIST_PATH/);
      expect(describeExecutable(project, undefined)).toMatchObject({ status: 'fail', message: expect.stringContaining('ELECTRON_OVERRIDE_DIST_PATH') });
    } finally {
      delete process.env['ELECTRON_OVERRIDE_DIST_PATH'];
    }
  });
});

describe('app.appPath', () => {
  it('takes a main script, or a directory whose main script exists, and says what is wrong otherwise', () => {
    const app = path.join(root, 'app');
    mkdirSync(path.join(app, 'no-main'), { recursive: true });
    writeFileSync(path.join(app, 'main.cjs'), '');
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
    writeFileSync(path.join(app, 'no-main', 'package.json'), '{}');
    expect(appPathProblem(root, 'app')).toBeUndefined();
    expect(appPathProblem(root, 'app/main.cjs')).toBeUndefined();
    expect(appPathProblem(root, 'missing')).toMatch(/does not exist/);
    expect(appPathProblem(root, 'app/no-main')).toMatch(/index\.js does not exist/);
  });
});

describe('executablePath', () => {
  it('starts a regular file it may execute', async () => {
    expect(resolveExecutable(root, 'run.sh')).toBe(path.join(root, 'run.sh'));
    expect(describeExecutable(root, 'run.sh').status).toBe('pass');
  });

  it('refuses a directory, such as an .app bundle, and a file it may not execute, in doctor as at launch', async () => {
    // Windows has no execute permission: any file it can read is one it may start.
    const refused = process.platform === 'win32' ? ['MyApp.app', 'missing'] : ['MyApp.app', 'package.json', 'missing'];
    for (const name of refused) {
      expect(() => resolveExecutable(root, name)).toThrow(/not an executable file/);
      expect(describeExecutable(root, name)).toMatchObject({ status: 'fail', message: expect.stringContaining('not an executable file') });
    }
    expect(() => resolveExecutable(root, 'MyApp.app')).toThrow(path.join(root, 'MyApp.app', 'Contents', 'MacOS', 'MyApp'));
    // Checked once in prepare, so a wrong path is one error for the run.
    await expect(ensureElectronBinary(root, 'missing', () => undefined, new AbortController().signal)).rejects.toThrow(/not an executable file/);
  });
});
