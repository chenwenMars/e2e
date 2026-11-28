/**
 * Which executable a launch starts: the one `electron({ executablePath })`
 * names, else the Electron binary of the `electron` package installed in the
 * project. That package downloads its binary on first use (Electron 45 and
 * later have no install script), so `prepare` fetches it once per run,
 * before the run's clock starts, and a worker only checks it is there.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ConfigurationError, InfrastructureError } from '@e2e-dev/core/engine';

/** How much of a failed download's output its error quotes, in characters. */
const INSTALL_OUTPUT_TAIL = 2000;

/** The `electron` package a project installed: its directory and the binary it runs. */
interface ElectronPackage {
  readonly directory: string;
  /** The binary's path, read from the package's `path.txt`; undefined before the binary is downloaded. */
  readonly binary: string | undefined;
  readonly version: string;
  /** Where `ELECTRON_OVERRIDE_DIST_PATH` says the binary is, when it is set: no download can fill that directory. */
  readonly override?: string;
}

/** The project's `electron` package, or undefined when the project has none. */
function electronPackage(projectRoot: string): ElectronPackage | undefined {
  let manifest: string;
  try {
    manifest = createRequire(path.join(projectRoot, 'package.json')).resolve('electron/package.json');
  } catch {
    return undefined;
  }
  const directory = path.dirname(manifest);
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string' ? parsed.version : 'unknown';
  const pathFile = path.join(directory, 'path.txt');
  const relative = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : '';
  // Electron's own index.js takes the binary from ELECTRON_OVERRIDE_DIST_PATH when it is set (a build of your own, Nix).
  const override = process.env['ELECTRON_OVERRIDE_DIST_PATH'];
  const overridden = override !== undefined && override !== '';
  const binary = overridden ? path.join(override, relative === '' ? 'electron' : relative) : relative === '' ? undefined : path.join(directory, 'dist', relative);
  return { directory, binary: binary !== undefined && existsSync(binary) ? binary : undefined, version, ...(overridden && binary !== undefined ? { override: binary } : {}) };
}

/**
 * Whether a path names a regular file this process may execute: a directory
 * passes the execute-permission check too (search permission), so it is
 * ruled out first. A packaged macOS app is the binary inside the bundle,
 * `MyApp.app/Contents/MacOS/MyApp`, not the `.app` directory.
 */
function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a launch would start, or why it has nothing to start: the one answer `prepare`, `init`, and `doctor` each act on. */
type Executable =
  /** An `executablePath` that runs. */
  | { readonly kind: 'named'; readonly file: string }
  /** The project's Electron binary, downloaded. */
  | { readonly kind: 'installed'; readonly file: string; readonly version: string }
  /** The project's `electron` package, its binary not downloaded yet. */
  | { readonly kind: 'undownloaded'; readonly package: ElectronPackage }
  | { readonly kind: 'misconfigured'; readonly problem: string };

function locateExecutable(projectRoot: string, executablePath: string | undefined): Executable {
  if (executablePath !== undefined) {
    const resolved = path.resolve(projectRoot, executablePath);
    if (isExecutableFile(resolved)) return { kind: 'named', file: resolved };
    // The fix for the common case: a macOS `.app` bundle.
    const bundle = /\.app\/?$/.test(resolved) ? `; a macOS app runs as the binary inside its bundle, ${path.join(resolved, 'Contents', 'MacOS', path.basename(resolved, '.app'))}` : '';
    return { kind: 'misconfigured', problem: `electron({ executablePath }) names ${resolved}, which is not an executable file${bundle}` };
  }
  const installed = electronPackage(projectRoot);
  if (installed === undefined) {
    return {
      kind: 'misconfigured',
      problem: `electron() starts the electron package installed in the project, and ${projectRoot} has none: install it (npm install --save-dev electron), or name an executable with electron({ executablePath })`,
    };
  }
  if (installed.binary !== undefined) return { kind: 'installed', file: installed.binary, version: installed.version };
  // The variable is wrong, and downloading would not help.
  if (installed.override !== undefined) {
    return { kind: 'misconfigured', problem: `ELECTRON_OVERRIDE_DIST_PATH names the directory of the Electron binary, and none is at ${installed.override}; fix the variable or unset it` };
  }
  return { kind: 'undownloaded', package: installed };
}

/** The executable a launch starts, checked: an `executablePath` that runs, or the project's downloaded Electron binary. */
export function resolveExecutable(projectRoot: string, executablePath: string | undefined): string {
  const found = locateExecutable(projectRoot, executablePath);
  switch (found.kind) {
    case 'named':
    case 'installed':
      return found.file;
    case 'misconfigured':
      throw new ConfigurationError('INVALID_CONFIG', found.problem);
    case 'undownloaded':
      throw new InfrastructureError(
        'ELECTRON_INSTALL_FAILED',
        `electron ${found.package.version} is installed at ${found.package.directory} without its binary; the engine's prepare step downloads it before the first test`,
      );
  }
}

/**
 * Downloads the project's Electron binary when it is missing. Nothing to do
 * with `executablePath`, or with the binary in place; a wrong path fails
 * here, once for the run rather than once per test.
 */
export async function ensureElectronBinary(projectRoot: string, executablePath: string | undefined, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const found = locateExecutable(projectRoot, executablePath);
  if (found.kind === 'misconfigured') throw new ConfigurationError('INVALID_CONFIG', found.problem);
  if (found.kind !== 'undownloaded') return;
  await download(found.package, log, signal);
  if (electronPackage(projectRoot)?.binary === undefined) {
    throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `electron ${found.package.version}'s install.js finished, but its binary is still missing at ${found.package.directory}`);
  }
}

/** Runs the package's own `install.js` (what its first `require` would run), its output sent to `log`. */
async function download(installed: ElectronPackage, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const script = path.join(installed.directory, 'install.js');
  if (!existsSync(script)) {
    throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `electron ${installed.version} at ${installed.directory} has no binary and no install.js to download it with; reinstall the electron package`);
  }
  log(`downloading the Electron ${installed.version} binary`);
  const failure = await new Promise<string | undefined>((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: installed.directory, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let tail = '';
    const read = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-INSTALL_OUTPUT_TAIL);
      for (const line of text.split(/\r?\n/)) if (line.trim() !== '') log(line.trim());
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (cause) => resolve(cause.message));
    child.on('close', (code) => resolve(code === 0 ? undefined : `install.js exited with ${code}: ${tail.trim()}`));
  });
  if (failure !== undefined) throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `downloading the Electron ${installed.version} binary failed: ${failure}`);
}

/** For `e2e doctor`: what a run would start, without downloading anything. */
export function describeExecutable(projectRoot: string, executablePath: string | undefined): { readonly status: 'pass' | 'warn' | 'fail'; readonly message: string } {
  const found = locateExecutable(projectRoot, executablePath);
  switch (found.kind) {
    case 'named':
      return { status: 'pass', message: `starts ${found.file}` };
    case 'installed':
      return { status: 'pass', message: `electron ${found.version} at ${found.file}` };
    case 'undownloaded':
      return { status: 'warn', message: `electron ${found.package.version} is installed without its binary; the first run downloads it` };
    case 'misconfigured':
      return { status: 'fail', message: found.problem };
  }
}

/**
 * Why `app.appPath` names no app Electron can start, or undefined when it
 * does: a main script, or a directory whose `package.json` names an existing
 * `main` (else Electron runs its `index.js`).
 */
export function appPathProblem(projectRoot: string, appPath: string): string | undefined {
  const resolved = path.resolve(projectRoot, appPath);
  if (!existsSync(resolved)) return `app.appPath names ${resolved}, which does not exist`;
  if (statSync(resolved).isFile()) return undefined;
  const manifest = path.join(resolved, 'package.json');
  let main = 'index.js';
  if (existsSync(manifest)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'main' in parsed && typeof parsed.main === 'string' && parsed.main !== '') main = parsed.main;
    } catch {
      return `app.appPath names ${resolved}, whose package.json is not valid JSON`;
    }
  }
  const script = path.resolve(resolved, main);
  if (!existsSync(script) && !existsSync(`${script}.js`)) return `app.appPath names ${resolved}, and its main script ${script} does not exist; set "main" in its package.json`;
  return undefined;
}
