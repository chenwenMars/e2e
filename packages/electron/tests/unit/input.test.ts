import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/cdp/connection.ts';
import { hasKey, Keyboard, Mouse, type InputTarget } from '../../src/cdp/input.ts';

const IS_MAC = process.platform === 'darwin';

/** A page that records the input events sent to it. */
function recorder(): { readonly target: InputTarget; readonly events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  const session = {
    send: (method: string, params: Record<string, unknown> = {}) => {
      events.push({ method, ...params });
      return Promise.resolve({});
    },
  } as unknown as Session;
  return { target: { session }, events };
}

describe('hasKey', () => {
  it('knows the named keys and the characters of a US layout, and no others', () => {
    for (const key of ['Enter', 'Space', 'F12', 'ArrowUp', 'a', 'A', '$', ' ', 'ControlOrMeta']) expect(hasKey(key), key).toBe(true);
    for (const key of ['é', 'ß', '€', 'Nope']) expect(hasKey(key), key).toBe(false);
  });
});

describe('Keyboard', () => {
  it('presses a character as a key down that types it and a key up', async () => {
    const { target, events } = recorder();
    await new Keyboard(target).press('a');
    expect(events).toMatchObject([
      { method: 'Input.dispatchKeyEvent', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, modifiers: 0 },
      { method: 'Input.dispatchKeyEvent', type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 },
    ]);
  });

  it('holds the modifiers around the key, and types nothing with Control held', async () => {
    const { target, events } = recorder();
    const keyboard = new Keyboard(target);
    await keyboard.down('Shift');
    await keyboard.press('Tab');
    await keyboard.up('Shift');
    await keyboard.down('Control');
    await keyboard.press('A');
    await keyboard.up('Control');
    const downs = events.filter((event) => event['type'] !== 'keyUp');
    expect(downs).toMatchObject([
      { key: 'Shift', code: 'ShiftLeft', modifiers: 8, type: 'rawKeyDown' },
      { key: 'Tab', code: 'Tab', modifiers: 8, type: 'rawKeyDown' },
      { key: 'Control', code: 'ControlLeft', modifiers: 2 },
      { key: 'A', code: 'KeyA', text: '', modifiers: 2, type: 'rawKeyDown' },
    ]);
    expect(keyboard.modifiers().size).toBe(0);
  });

  it('presses ControlOrMeta as the platform\'s own modifier, with the editing command macOS needs named', async () => {
    const { target, events } = recorder();
    const keyboard = new Keyboard(target);
    await keyboard.down('ControlOrMeta');
    await keyboard.press('A');
    expect(events[0]).toMatchObject({ key: IS_MAC ? 'Meta' : 'Control' });
    expect(events[1]).toMatchObject({ code: 'KeyA', modifiers: IS_MAC ? 4 : 2, commands: IS_MAC ? ['selectAll'] : [] });
  });

  it('refuses a key the layout does not have', async () => {
    const { target, events } = recorder();
    await expect(new Keyboard(target).press('é')).rejects.toThrow(/no key "é"/);
    expect(events).toEqual([]);
  });

  it('types a character the layout has no key for as inserted text', async () => {
    const { target, events } = recorder();
    const keyboard = new Keyboard(target);
    await keyboard.type('é');
    await keyboard.type('x');
    expect(events.map((event) => event['method'])).toEqual(['Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    expect(events[0]).toMatchObject({ text: 'é' });
  });
});

describe('Mouse', () => {
  it('clicks as a move, a press, and a release at the point, once per click, with the held modifiers', async () => {
    const { target, events } = recorder();
    const keyboard = new Keyboard(target);
    const mouse = new Mouse(target, keyboard);
    await keyboard.down('Shift');
    await mouse.click(10, 20, 'left', 2);
    expect(events.slice(1)).toMatchObject([
      { type: 'mouseMoved', x: 10, y: 20, modifiers: 8, buttons: 0 },
      { type: 'mousePressed', button: 'left', clickCount: 1, buttons: 1, x: 10, y: 20, modifiers: 8 },
      { type: 'mouseReleased', button: 'left', clickCount: 1, buttons: 0 },
      { type: 'mousePressed', clickCount: 2 },
      { type: 'mouseReleased', clickCount: 2 },
    ]);
  });

  it('moves with the button held, and releases where the pointer went', async () => {
    const { target, events } = recorder();
    const mouse = new Mouse(target, new Keyboard(target));
    await mouse.move(1, 1);
    await mouse.down();
    await mouse.move(50, 60);
    await mouse.up();
    expect(events.map((event) => event['type'])).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseReleased']);
    expect(events[2]).toMatchObject({ x: 50, y: 60, button: 'left', buttons: 1 });
    expect(events[3]).toMatchObject({ x: 50, y: 60, buttons: 0 });
  });
});
