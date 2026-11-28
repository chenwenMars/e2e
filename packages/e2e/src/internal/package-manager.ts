/** Which package manager a project uses, for install hints that name a runnable command. */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { compileGlob, matchesGlob } from '@e2e-dev/core/lib/internal/globs';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** A project's manager with what its commands depend on. */
export interface ProjectManager {
  readonly manager: PackageManager;
  /** Where the install keeps its lockfile. */
  readonly root: string;
  /** True for Yarn 2 or later, whose commands differ from Yarn 1's. False for every other manager. */
  readonly yarnBerry: boolean;
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set<PackageManager>(['npm', 'pnpm', 'yarn', 'bun']);
const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

function isPackageManager(value: string | undefined): value is PackageManager {
  return value !== undefined && PACKAGE_MANAGERS.has(value);
}

/** The manager a `packageManager` field such as `pnpm@10.0.0` names, or undefined for another value. */
function fieldManager(packageManagerField: string | undefined): PackageManager | undefined {
  const configured = packageManagerField?.split('@')[0];
  return isPackageManager(configured) ? configured : undefined;
}

/** The manager whose lockfile sits in `dir`, or undefined when none does. */
function lockfileManager(dir: string): PackageManager | undefined {
  return LOCKFILES.find(([lock]) => {
    try {
      return statSync(path.join(dir, lock)).isFile();
    } catch {
      return false;
    }
  })?.[1];
}

/**
 * The `packageManager` field wins, then a lockfile in `dir`, then the manager
 * `devEngines` pins in the package.json there, then the manager that invoked
 * the current process, then npm.
 */
export function detectPackageManager(
  dir: string,
  packageManagerField?: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  return fieldManager(packageManagerField) ?? lockfileManager(dir) ?? pinnedManager(dir)?.name ?? invokingManager(env);
}

/**
 * The manager of the package in `dir`, which may be a member of a workspace
 * whose lockfile and `packageManager` field are at the workspace root: the
 * package's own field or lockfile (or pnpm, for a pnpm workspace root that
 * has neither yet), else those of the nearest workspace root
 * above whose package globs include it, else the manager `devEngines` pins,
 * else the manager that invoked the current process, else npm. A lockfile
 * above that belongs to no workspace holding the package is another
 * project's, and does not count. `root` is where the install keeps its
 * lockfile: the workspace root for a member, the package's own directory
 * otherwise. A `devEngines` pin names a manager and never an install root: a
 * member may repeat its workspace's pin.
 */
export function detectWorkspacePackageManager(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectManager {
  const project = path.resolve(dir);
  const own = managerAt(project) ?? workspaceGlobs(project)?.manager;
  if (own !== undefined) return projectManager(own, project, env);
  for (let current = path.dirname(project); ; current = path.dirname(current)) {
    const workspace = workspaceGlobs(current);
    if (workspace !== undefined) {
      const member = includesPackage(workspace.globs, path.relative(current, project).split(path.sep).join('/'));
      if (member) {
        return projectManager(managerAt(current) ?? workspace.manager ?? pinnedManager(current)?.name ?? pinnedManager(project)?.name ?? invokingManager(env), current, env);
      }
      break;
    }
    if (path.dirname(current) === current) break;
  }
  return projectManager(pinnedManager(project)?.name ?? invokingManager(env), project, env);
}

/** `manager` as the manager of the install rooted at `root`. */
export function projectManager(manager: PackageManager, root: string, env: NodeJS.ProcessEnv = process.env): ProjectManager {
  return { manager, root, yarnBerry: manager === 'yarn' && usesYarnBerry(root, env) };
}

/** The lockfile names every manager writes, for a caller that must put one back. */
export const LOCKFILE_NAMES: readonly string[] = [...new Set(LOCKFILES.map(([lock]) => lock))];

function invokingManager(env: NodeJS.ProcessEnv): PackageManager {
  const invoking = env['npm_config_user_agent']?.split('/')[0];
  return isPackageManager(invoking) ? invoking : 'npm';
}

/** The manager `dir` names itself as the root of an install: its `packageManager` field, else its lockfile. */
function managerAt(dir: string): PackageManager | undefined {
  const field = readPackageManifest(dir)?.['packageManager'];
  return fieldManager(typeof field === 'string' ? field : undefined) ?? lockfileManager(dir);
}

/**
 * The one manager `devEngines.packageManager` pins in the package.json in
 * `dir`, with the version range it gives, or undefined when it pins none or
 * allows several.
 */
function pinnedManager(dir: string): { readonly name: PackageManager; readonly version: string | undefined } | undefined {
  const devEngines = readPackageManifest(dir)?.['devEngines'];
  const declared: unknown = isPlainObject(devEngines) ? devEngines['packageManager'] : undefined;
  const pin: unknown = Array.isArray(declared) && declared.length === 1 ? declared[0] : declared;
  if (!isPlainObject(pin)) return undefined;
  const { name, version } = pin;
  if (typeof name !== 'string' || !isPackageManager(name)) return undefined;
  return { name, version: typeof version === 'string' ? version : undefined };
}

/**
 * Whether the Yarn project rooted at `root` is on Yarn 2 or later: it has a
 * `.yarnrc.yml`, else its `packageManager` field names the version, else its
 * lockfile is in one format or the other, else its `devEngines` pin starts
 * with a major, else, for a project that says nothing, the Yarn that invoked
 * the current process is.
 */
function usesYarnBerry(root: string, env: NodeJS.ProcessEnv): boolean {
  if (existsSync(path.join(root, '.yarnrc.yml'))) return true;
  const field = readPackageManifest(root)?.['packageManager'];
  const major =
    (typeof field === 'string' ? /^yarn@(\d+)/u.exec(field)?.[1] : undefined) ??
    lockfileYarnMajor(root) ??
    pinnedYarnMajor(root) ??
    /^yarn\/(\d+)/u.exec(env['npm_config_user_agent'] ?? '')?.[1];
  return major !== undefined && Number(major) >= 2;
}

/** `'1'` or `'2'` for the format of the `yarn.lock` in `root`; undefined for none, or one in neither format, such as an empty file. */
function lockfileYarnMajor(root: string): string | undefined {
  let lock: string;
  try {
    lock = readFileSync(path.join(root, 'yarn.lock'), 'utf8');
  } catch {
    return undefined;
  }
  if (/^__metadata:/mu.test(lock)) return '2';
  return /^# yarn lockfile v1$/mu.test(lock) ? '1' : undefined;
}

/** The major a `devEngines` pin on Yarn in `root` starts with, as `4.19.0`, `^4.0.0`, and `~4.1` do; undefined for a range that leaves the major open. */
function pinnedYarnMajor(root: string): string | undefined {
  const pin = pinnedManager(root);
  return pin?.name === 'yarn' ? /^[\^~=v]?(\d+)(?:\.[\dx*]+)*$/u.exec(pin.version?.trim() ?? '')?.[1] : undefined;
}

/** The package.json in `dir` as an object, or undefined when it is missing or not one. */
export function readPackageManifest(dir: string): Record<string, unknown> | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return isPlainObject(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package globs of a workspace root at `dir`: `pnpm-workspace.yaml`'s
 * `packages` list (a pnpm workspace), else the `workspaces` field of its
 * package.json, an array or `{ packages }` (npm, Yarn, Bun). Undefined when
 * `dir` is no workspace root.
 */
function workspaceGlobs(dir: string): { globs: string[]; manager: PackageManager | undefined } | undefined {
  try {
    return { globs: pnpmWorkspacePackages(readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8')), manager: 'pnpm' };
  } catch {
    // No pnpm workspace here; the manifest may declare one.
  }
  const field = readPackageManifest(dir)?.['workspaces'];
  const list = Array.isArray(field) ? field : typeof field === 'object' && field !== null && 'packages' in field ? field.packages : undefined;
  if (!Array.isArray(list)) return undefined;
  return { globs: list.filter((glob): glob is string => typeof glob === 'string'), manager: undefined };
}

/**
 * The entries of the top-level `packages:` list in a pnpm-workspace.yaml,
 * without reading the rest of the YAML: a block list, indented or not, or a
 * flow list on one line or several (`packages: ['apps/*']`).
 */
function pnpmWorkspacePackages(text: string): string[] {
  const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/u, '$2');
  const flow = /^packages:[ \t]*\[([^\]]*)\]/mu.exec(text.replace(/[ \t]+#.*$/gmu, ''));
  if (flow !== null) return flow[1]!.split(',').map(unquote).filter((glob) => glob !== '');
  const globs: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^packages:\s*(?:#.*)?$/u.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || /^\s*(?:#.*)?$/u.test(line)) continue;
    const item = /^\s*-\s+(.+?)\s*(?:#.*)?$/u.exec(line);
    if (item === null) break;
    globs.push(unquote(item[1]!));
  }
  return globs;
}

/** Whether `relative`, a `/`-separated path from the workspace root, matches an including glob and no `!` one. */
function includesPackage(globs: readonly string[], relative: string): boolean {
  if (relative === '' || relative.startsWith('..')) return false;
  const matches = (pattern: string): boolean => {
    const normalized = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (normalized === relative) return true;
    try {
      return matchesGlob(compileGlob(normalized), relative);
    } catch {
      return false;
    }
  };
  return (
    globs.some((glob) => !glob.startsWith('!') && matches(glob)) &&
    !globs.some((glob) => glob.startsWith('!') && matches(glob.slice(1)))
  );
}

/**
 * The install that resolves an edited package.json: its arguments, and the
 * variables to add to its environment. The lockfile changes with the new
 * specs, which pnpm and Yarn refuse in CI unless told otherwise.
 */
export function installCommand(manager: PackageManager): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: manager === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'],
    env: { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
  };
}

/** The command that runs the package.json script `name` with the given manager. */
export function runScriptCommand(manager: PackageManager, name: string): string {
  switch (manager) {
    case 'npm':
      return `npm run ${name}`;
    case 'pnpm':
      return `pnpm ${name}`;
    case 'yarn':
      return `yarn ${name}`;
    case 'bun':
      return `bun run ${name}`;
  }
}

/**
 * The command a person types to run an installed binary, never a registry
 * download, with the given manager. Yarn takes `exec --` in every version:
 * `yarn e2e` runs a package.json script named e2e before the binary, and
 * Yarn 1 takes the binary's flags as its own without the separator.
 */
export function execCommand(manager: PackageManager, command: string): string {
  switch (manager) {
    case 'npm':
      return `npm exec -- ${command}`;
    case 'pnpm':
      return `pnpm exec ${command}`;
    case 'yarn':
      return `yarn exec -- ${command}`;
    case 'bun':
      return `bun run ${command}`;
  }
}

/**
 * The program and leading arguments that run an installed binary when
 * another program starts it and reads its stdout; the binary's name and
 * arguments follow. It differs from `execCommand` on purpose: `npx` and
 * `bunx` are the forms MCP clients document, and Yarn 1 prints a banner to
 * stdout unless silenced, with a flag Yarn 2 and later refuse.
 */
export function execArgv({ manager, yarnBerry }: Pick<ProjectManager, 'manager' | 'yarnBerry'>): { readonly command: string; readonly args: readonly string[] } {
  switch (manager) {
    case 'npm':
      return { command: 'npx', args: [] };
    case 'pnpm':
      return { command: 'pnpm', args: ['exec'] };
    case 'yarn':
      return { command: 'yarn', args: yarnBerry ? ['exec'] : ['--silent', 'exec', '--'] };
    case 'bun':
      return { command: 'bunx', args: [] };
  }
}

/** The command that adds `name` as a dev dependency with the given manager. */
export function addDevDependencyCommand(manager: PackageManager, name: string): string {
  switch (manager) {
    case 'npm':
      return `npm install --save-dev ${name}`;
    case 'pnpm':
      return `pnpm add -D ${name}`;
    case 'yarn':
      return `yarn add -D ${name}`;
    case 'bun':
      return `bun add -d ${name}`;
  }
}
