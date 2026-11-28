import { describe, expect, it } from 'vitest';
import { toCombo } from '../../src/keys.ts';

describe('toCombo', () => {
  it('names the contract keys the way the driver takes them', () => {
    expect(toCombo('Enter')).toBe('return');
    expect(toCombo('Escape')).toBe('escape');
    expect(toCombo('Backspace')).toBe('backspace');
    expect(toCombo('Delete')).toBe('forwarddelete');
    expect(toCombo('ArrowDown')).toBe('down');
    expect(toCombo('PageUp')).toBe('pageup');
    expect(toCombo('F5')).toBe('f5');
    expect(toCombo('Space')).toBe('space');
    expect(toCombo(' ')).toBe('space');
  });

  it('maps modifiers, ControlOrMeta to Command', () => {
    expect(toCombo('Shift+Tab')).toBe('shift+tab');
    expect(toCombo('ControlOrMeta+a')).toBe('cmd+a');
    expect(toCombo('Meta+Alt+Tab')).toBe('cmd+alt+tab');
    expect(toCombo('Control+c')).toBe('ctrl+c');
  });

  it('keeps a capital letter capital, with Shift beside other modifiers', () => {
    expect(toCombo('A')).toBe('A');
    expect(toCombo('Control+A')).toBe('ctrl+shift+A');
  });

  it('refuses what the driver cannot press', () => {
    expect(() => toCombo('Insert')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/the desktop engine cannot press "Insert"/) }));
    expect(() => toCombo('+')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    expect(() => toCombo('Hyper+a')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
    // No key of their own in the driver's macOS key map.
    for (const key of ['!', 'é', '?', 'ControlOrMeta+é']) expect(() => toCombo(key)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });

  it('refuses the shortcuts that quit, log out, force-quit, or lock, with every modifier added', () => {
    for (const key of ['Meta+q', 'ControlOrMeta+Q', 'Meta+Shift+q', 'Control+Meta+q', 'Meta+Alt+Escape', 'Meta+Shift+Backspace', 'Meta+Alt+Shift+Escape']) {
      expect(() => toCombo(key), key).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/the desktop engine refuses to press.*desktop\.closeApp\(\)/) }));
    }
    expect(toCombo('Control+q')).toBe('ctrl+q');
    expect(toCombo('Meta+Escape')).toBe('cmd+escape');
    expect(toCombo('Meta+Backspace')).toBe('cmd+backspace');
  });

  it('presses the punctuation the driver has keys for', () => {
    for (const key of [',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`']) expect(toCombo(key)).toBe(key);
    expect(toCombo('ControlOrMeta+,')).toBe('cmd+,');
    expect(toCombo('7')).toBe('7');
  });
});
