import { afterEach, describe, expect, it } from 'vitest';
import { DriverFailure, type RawWindow } from '../../src/driver.ts';
import { describeLastRead, handOffClause } from '../../src/launch-report.ts';
import { killSpawned, standIn } from '../helpers/fake-driver.ts';

afterEach(killSpawned);

const failure = (code: string, message: string, details?: Record<string, unknown>): DriverFailure =>
  new DriverFailure({ code, message, ...(details === undefined ? {} : { details }) });

const window = (id: string, extra: Partial<RawWindow> = {}): RawWindow => ({ id, pid: 1, ...extra }) as RawWindow;

describe('describeLastRead', () => {
  it('says no read finished when the wait has none to describe', () => {
    expect(describeLastRead(undefined)).toBe('no read of its windows finished');
    expect(describeLastRead(undefined, true)).toBe('no read of its windows finished');
  });

  it('names the read as the last one that finished when a later read was cut off', () => {
    const read = { windows: [window('w-1', { accessible: false })], candidates: 0, failures: [] };
    expect(describeLastRead(read)).toBe('the last read listed 1 window, 1 unreadable');
    expect(describeLastRead(read, true)).toBe('the last read that finished listed 1 window, 1 unreadable');
    const failed = failure('APP_NOT_FOUND', 'no app has that process id.');
    expect(describeLastRead(failed)).toBe('the last read failed with APP_NOT_FOUND (no app has that process id)');
    expect(describeLastRead(failed, true)).toBe('the last read that finished failed with APP_NOT_FOUND (no app has that process id)');
  });

  it('counts each unreadable window once and reports the failure of the last one', () => {
    const read = {
      windows: [window('w-1'), window('w-2'), window('w-3', { accessible: false })],
      candidates: 2,
      failures: [failure('WINDOW_NOT_FOUND', 'window w-1 has no accessibility element.'), failure('APP_UNRESPONSIVE', 'window w-2 did not answer.')],
    };
    expect(describeLastRead(read)).toBe('the last read listed 3 windows, 3 unreadable; the last read failed with APP_UNRESPONSIVE (window w-2 did not answer)');
  });

  it('counts the system dialogs among the windows', () => {
    const one = { windows: [window('w-1', { accessible: false }), window('w-siri', { system: true })], candidates: 0, failures: [] };
    expect(describeLastRead(one)).toBe('the last read listed 2 windows, 1 unreadable, 1 a system dialog');
    const two = { ...one, windows: [...one.windows, window('w-orb', { system: true })] };
    expect(describeLastRead(two)).toBe('the last read listed 3 windows, 1 unreadable, 2 system dialogs');
  });
});

describe('handOffClause', () => {
  it('names one running copy, and several as several', () => {
    const [first, second] = [standIn(), standIn()];
    expect(handOffClause(': ', [first])).toBe(
      `: a copy of it was already running (process ${first}), and an app that runs one copy at a time hands the launch to that copy and exits. If this app does, quit the running copy first: the engine drives only a copy it launched`,
    );
    expect(handOffClause('; ', [first, second])).toBe(
      `; copies of it were already running (processes ${first}, ${second}), and an app that runs one copy at a time hands the launch to a running copy and exits. If this app does, quit the running copies first: the engine drives only a copy it launched`,
    );
    expect(handOffClause(': ', [])).toBe('');
  });
});

describe('DriverFailure.runningBefore', () => {
  it('keeps the process ids of a failure and drops anything else', () => {
    expect(failure('TIMEOUT', 'unclaimed', { running_before: [3, '4', null, 5] }).runningBefore).toEqual([3, 5]);
    expect(failure('TIMEOUT', 'unclaimed', { running_before: 'none' }).runningBefore).toEqual([]);
    expect(failure('TIMEOUT', 'unclaimed').runningBefore).toEqual([]);
  });
});
