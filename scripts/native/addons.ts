/**
 * The NAPI addons the Cargo workspace (`crates/`) builds, and where each one
 * goes: the crate that builds it, the npm package whose loader takes a
 * checkout build, and the platform packages a release ships it in. The
 * scripts beside this file take an addon's name as their first argument.
 */

import { copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/** The repository root, which is also the Cargo workspace root. */
export const ROOT = path.join(import.meta.dirname, '..', '..');

interface AddonSpec {
  /** The crate under `crates/` that builds the addon, a `cdylib`. */
  readonly crate: string;
  /** The npm package that loads the addon, a directory under `packages/`. */
  readonly package: string;
  /** The addon's file name before the platform: `<file>.<platform>.node`. */
  readonly file: string;
  /**
   * The target triples the addon ships for, each to its NAPI-RS platform
   * name. Each platform is one npm package, `@e2e-dev/<package>-<platform>`,
   * in `packages/<package>/npm/<platform>`.
   */
  readonly targets: Readonly<Record<string, string>>;
}

const ADDONS: Readonly<Record<string, AddonSpec>> = {
  desktop: {
    crate: 'e2e-desktop-napi',
    package: 'desktop',
    file: 'desktop',
    targets: { 'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64' },
  },
};

/** An addon with its paths resolved against the repository root. */
export interface Addon extends AddonSpec {
  readonly name: string;
  /** The crate's directory. */
  readonly crateDir: string;
  /** The npm package's directory, where a checkout build goes. */
  readonly packageDir: string;
}

/** The addon a script was asked for, or an error naming the ones there are. */
export function findAddon(name: string | undefined): Addon {
  // Own keys only: `constructor` and the like are not addons.
  const spec = name !== undefined && Object.hasOwn(ADDONS, name) ? ADDONS[name] : undefined;
  if (name === undefined || spec === undefined) throw new Error(`name an addon first: one of ${Object.keys(ADDONS).join(', ')}`);
  return {
    ...spec,
    name,
    crateDir: path.join(ROOT, 'crates', spec.crate),
    packageDir: path.join(ROOT, 'packages', spec.package),
  };
}

/** The addon's file name for one platform: `desktop.darwin-arm64.node`. */
export function addonFile(addon: Addon, platform: string): string {
  return `${addon.file}.${platform}.node`;
}

/** The directory of the platform package that ships the addon for one platform. */
export function platformPackageDir(addon: Addon, platform: string): string {
  return path.join(ROOT, 'packages', addon.package, 'npm', platform);
}

/**
 * The script's own arguments. pnpm passes a `--` before them through, which
 * separates nothing here.
 */
export function scriptArgs(): string[] {
  return process.argv.slice(2).filter((arg) => arg !== '--');
}

/**
 * Copies an addon over an older one as a new file. macOS keeps the code
 * signature it checked for a file, so an addon overwritten in place gets the
 * next process that loads it killed (exit 137).
 */
export function replaceAddon(from: string, to: string): void {
  rmSync(to, { force: true });
  copyFileSync(from, to);
}
