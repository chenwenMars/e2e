import { stripVTControlCharacters } from 'node:util';
import picocolors from 'picocolors';
import { afterEach, describe, expect, it } from 'vitest';
import { initStarStrip, updateStarLine, upgradeCelebration } from '../../src/cli/star.ts';

const colorSupported = picocolors.isColorSupported;
afterEach(() => {
  picocolors.isColorSupported = colorSupported;
});

const plain = (text: string): string => stripVTControlCharacters(text);

describe('star asks', () => {
  it('boxes the init strip, and drops the box on a narrow terminal', () => {
    const line = "★  You're all set!  Star e2e on GitHub → github.com/e2e-inc/e2e";
    const boxed = plain(initStarStrip(80, {})).split('\n');
    expect(boxed[1]).toBe(`  │  ${line}  │`);
    expect(boxed[0]).toBe(`  ╭${'─'.repeat(line.length + 4)}╮`);
    expect(plain(initStarStrip(40, {}))).toBe(`${line}\n\n`);
  });

  it('shows the wordmark after an upgrade only where it fits', () => {
    const wide = plain(upgradeCelebration({ isTTY: true, columns: 120, write: () => true }, '0.23.0', {}));
    expect(wide).toContain('███████████');
    expect(wide).toContain("★  You're on e2e 0.23.0. Enjoying it? Star us on GitHub → github.com/e2e-inc/e2e");
    const narrow = plain(upgradeCelebration({ isTTY: true, columns: 30, write: () => true }, '0.23.0', {}));
    expect(narrow).not.toContain('█');
    expect(narrow).toContain('Star us on GitHub');
  });

  it('paints gold and links the repository where the terminal styles text, and stays plain where it does not', () => {
    picocolors.isColorSupported = true;
    const styled = updateStarLine({ COLORTERM: 'truecolor', WT_SESSION: '1' });
    expect(styled).toContain('\u001b[38;2;255;200;0m★\u001b[39m');
    expect(styled).toContain('\u001b]8;;https://github.com/e2e-inc/e2e\u001b\\');
    expect(updateStarLine({ TERM: 'dumb' })).not.toContain('\u001b');
    picocolors.isColorSupported = false;
    expect(updateStarLine({ COLORTERM: 'truecolor' })).toBe('\n★ Enjoying e2e? Star us on GitHub → github.com/e2e-inc/e2e\n\n');
  });
});
