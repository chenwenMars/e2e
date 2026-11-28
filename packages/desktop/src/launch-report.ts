import type { DriverFailure, RawWindow } from './driver.ts';
import { alive } from './launch-ownership.ts';
import type { ProjectedScreen } from './nodes.ts';

/** What one read of the app's windows came to: the windows it listed, and what reading them gave. */
export interface WindowsRead {
  readonly windows: readonly RawWindow[];
  /** How many of the listed windows the read was asked for. */
  readonly candidates: number;
  /** The failure of each window accessibility had no element for. */
  readonly failures: readonly DriverFailure[];
  /** The first window that could be read; undefined when none could, or none was asked for. */
  readonly screen?: ProjectedScreen;
}

/**
 * One clause, for the error of an app whose window never became readable,
 * on the newest read of the launch wait that finished: what it listed and
 * could not read, or the failure of a read that listed nothing. `cutOff`
 * says a later read ran out of time, so the one described is not the last
 * one made. Undefined is a wait none of whose reads finished.
 */
export function describeLastRead(read: WindowsRead | DriverFailure | undefined, cutOff = false): string {
  if (read === undefined) return 'no read of its windows finished';
  const subject = cutOff ? 'the last read that finished' : 'the last read';
  const failed = (failure: DriverFailure, by = 'the last read'): string => `${by} failed with ${failure.code} (${failure.message.replace(/\.$/, '')})`;
  if (read instanceof Error) return failed(read, subject);
  const listed = read.windows.length;
  const unreadable = read.windows.filter((window) => window.accessible === false).length + read.failures.length;
  const rootless = read.screen?.rootUnread === true ? ', 1 whose root element did not answer' : '';
  const dialogs = read.windows.filter((window) => window.system === true).length;
  const system = dialogs === 0 ? '' : `, ${dialogs === 1 ? '1 a system dialog' : `${dialogs} system dialogs`}`;
  const failure = read.failures.at(-1);
  return `${subject} listed ${listed} ${listed === 1 ? 'window' : 'windows'}, ${unreadable} unreadable${rootless}${system}${failure === undefined ? '' : `; ${failed(failure)}`}`;
}

/**
 * What a copy that ran before the launch may explain, and what to do about
 * it, after `lead`; empty when none of `before` still runs. Only the app
 * knows whether it runs one copy at a time, so that stays a condition: the
 * copy may be one another run launched.
 */
export function handOffClause(lead: string, before: readonly number[]): string {
  const copies = before.filter(alive);
  if (copies.length === 0) return '';
  const one = copies.length === 1;
  const running = one ? `a copy of it was already running (process ${copies[0]})` : `copies of it were already running (processes ${copies.join(', ')})`;
  return `${lead}${running}, and an app that runs one copy at a time hands the launch to ${one ? 'that copy' : 'a running copy'} and exits. If this app does, quit the running ${one ? 'copy' : 'copies'} first: the engine drives only a copy it launched`;
}
