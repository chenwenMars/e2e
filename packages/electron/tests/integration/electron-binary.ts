/**
 * The Electron binary the integration tests start: the one this package's
 * `electron` dev dependency installs. Electron downloads it on first use, so
 * the suite's global setup fetches it once, before test files that run side
 * by side would each start a download of their own.
 */

import path from 'node:path';
import { ensureElectronBinary, resolveExecutable } from '../../src/executable.ts';

const packageRoot = path.resolve(import.meta.dirname, '../..');

export function electronBinary(): string {
  return resolveExecutable(packageRoot, undefined);
}

/** The process's environment as a launch takes it, without what would start Electron as plain Node.js. */
export function launchEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_OPTIONS') env[key] = value;
  return env;
}

export default async function setup(): Promise<void> {
  await ensureElectronBinary(packageRoot, undefined, (line) => console.log(line), new AbortController().signal);
}
