import { execFileSync } from 'node:child_process';

/** The testbed app's bundle id. */
export const TESTBED_APP = 'dev.e2e.desktop-testbed.sign-in';

/** The bundle id of the app in front, from `lsappinfo`, which needs no Automation permission; undefined when none is. */
export function frontmost(): string | undefined {
  const front = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
  const info = execFileSync('lsappinfo', ['info', '-only', 'bundleid', front], { encoding: 'utf8' });
  return /bundleID="([^"]+)"/.exec(info)?.[1];
}
