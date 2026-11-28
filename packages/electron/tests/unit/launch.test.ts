import { describe, expect, it } from 'vitest';
import { keyChord } from '../../src/actions.ts';
import { launchEnv } from '../../src/app-process.ts';
import { engineArguments } from '../../src/launcher.ts';

describe('launchEnv', () => {
  it('gives the app what a process needs to start and draw, never the rest of the run\'s environment', () => {
    const run = { PATH: '/bin', HOME: '/home/ada', DISPLAY: ':99', LC_ALL: 'C', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-secret', AI_GATEWAY_API_KEY: 'secret', GITHUB_TOKEN: 'ghs', MODE: 'run', UNSET: undefined };
    expect(launchEnv(run, {})).toEqual({ PATH: '/bin', HOME: '/home/ada', DISPLAY: ':99', LC_ALL: 'C', SystemRoot: 'C:\\Windows' });
  });

  it('adds the engine\'s env option over it, and never ELECTRON_RUN_AS_NODE or NODE_OPTIONS in any case', () => {
    expect(launchEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' }, { PATH: '/app/bin', API_URL: 'http://localhost', electron_run_as_node: '1', Node_Options: '--x' })).toEqual({ PATH: '/app/bin', API_URL: 'http://localhost' });
  });
});

describe('engineArguments', () => {
  it('opens the main process\'s inspector and the DevTools pipe, and no port', () => {
    const drawing = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
    expect(engineArguments([], 'darwin')).toEqual(['--inspect=0', '--remote-debugging-pipe', '--force-color-profile=srgb', ...drawing, '--disable-features=CalculateNativeWinOcclusion']);
    expect(engineArguments(['--force-color-profile=display-p3-d65', '--disable-features=Other'], 'darwin')).toEqual(['--inspect=0', '--remote-debugging-pipe', ...drawing]);
  });

  it('turns Chromium\'s sandbox off on Linux, once', () => {
    expect(engineArguments([], 'linux')).toContain('--no-sandbox');
    expect(engineArguments(['--no-sandbox'], 'linux')).not.toContain('--no-sandbox');
    expect(engineArguments([], 'win32')).not.toContain('--no-sandbox');
  });
});

describe('keyChord', () => {
  it('splits a key of the contract grammar into the key and the modifiers held with it', () => {
    expect(keyChord('Enter')).toEqual({ key: 'Enter', modifiers: [] });
    expect(keyChord('Space')).toEqual({ key: 'Space', modifiers: [] });
    expect(keyChord('Shift+Space')).toEqual({ key: 'Space', modifiers: ['Shift'] });
    expect(keyChord('ControlOrMeta+A')).toEqual({ key: 'A', modifiers: ['ControlOrMeta'] });
    expect(keyChord('Shift++')).toEqual({ key: '+', modifiers: ['Shift'] });
  });

  it('refuses a key the keyboard has none for', () => {
    expect(() => keyChord('é')).toThrow(/cannot press/);
    expect(() => keyChord('Not+A+Key+At+All')).toThrow(/not a key of the contract grammar/);
  });
});
