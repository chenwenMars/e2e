/**
 * Finds cargo for the native addon scripts: a Homebrew rustup puts no
 * `cargo` on `PATH` of its own, and the toolchain the workspace's
 * `rust-toolchain.toml` pins may not be installed yet.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './addons.ts';

/** How to run cargo for a crate: the program, the arguments before cargo's own, and the environment. */
export interface Cargo {
  readonly file: string;
  readonly prefix: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The toolchain `rust-toolchain.toml` pins, when rustup runs cargo; with none, the `cargo` on `PATH`. */
  readonly toolchain?: string;
}

/**
 * Cargo through `rustup run <pinned toolchain>`, so a standalone cargo earlier
 * on `PATH` (one without both macOS targets) is not the one that builds, and
 * the toolchain's own tools find their libraries: `rust-objcopy`, which strips
 * the release build, aborts on a missing `libLLVM.dylib` when the toolchain's
 * `bin` is merely put on `PATH`. With no rustup, the `cargo` on `PATH`. The
 * toolchain `rust-toolchain.toml` pins may not be installed yet: rustup
 * installs it first.
 */
export function cargo(directory: string): Cargo {
  if (spawnSync('rustup', ['--version'], { stdio: 'ignore' }).error !== undefined) {
    if (spawnSync('cargo', ['--version'], { cwd: directory, stdio: 'ignore' }).error === undefined) return { file: 'cargo', prefix: [], env: process.env };
    throw new Error('a native addon needs Rust to build: install rustup (https://rustup.rs), which installs the toolchain rust-toolchain.toml pins');
  }
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(ROOT, 'rust-toolchain.toml'), 'utf8'))?.[1];
  if (channel === undefined) throw new Error('rust-toolchain.toml names no channel');
  if (spawnSync('rustup', ['which', '--toolchain', channel, 'cargo'], { cwd: directory, stdio: 'ignore' }).status !== 0) {
    // With no toolchain named, rustup installs the one the workspace's `rust-toolchain.toml` pins, with its targets and
    // components. A `RUSTUP_TOOLCHAIN` override would name another, so it is left out.
    const { RUSTUP_TOOLCHAIN: _override, ...env } = process.env;
    spawnSync('rustup', ['toolchain', 'install'], { cwd: directory, stdio: 'inherit', env });
  }
  const pinned = spawnSync('rustup', ['which', '--toolchain', channel, 'cargo'], { cwd: directory, encoding: 'utf8' });
  if (pinned.status !== 0) throw new Error('rustup could not install the toolchain rust-toolchain.toml pins');
  // `rustup run` alone leaves the toolchain off PATH where rustup is the only tool there (Homebrew's), and cargo then
  // finds no rustc: its bin goes first too.
  const bin = path.dirname(pinned.stdout.trim());
  return { file: 'rustup', prefix: ['run', channel, 'cargo'], env: { ...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter) }, toolchain: channel };
}
