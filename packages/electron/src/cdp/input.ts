/**
 * Trusted input over `Input.*`: a keyboard and a mouse for one page, each
 * tracking what is held so modifiers apply to the keys and clicks after
 * them.
 */

import type { Session } from './connection.ts';
import { KEY_LAYOUT, MAC_EDITING_COMMANDS, type KeyDescription } from './keys.ts';

type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type MouseButton = 'left' | 'right' | 'middle';

const MODIFIERS: readonly Modifier[] = ['Alt', 'Control', 'Meta', 'Shift'];
const KEYPAD_LOCATION = 3;
const IS_MAC = process.platform === 'darwin';

/** The page input is sent to. */
export interface InputTarget {
  /** The session of the page's target. */
  readonly session: Session;
}

function isModifier(key: string): key is Modifier {
  return (MODIFIERS as readonly string[]).includes(key);
}

/** The `Input.*` modifiers bit mask. */
function modifiersMask(modifiers: ReadonlySet<Modifier>): number {
  return (modifiers.has('Alt') ? 1 : 0) | (modifiers.has('Control') ? 2 : 0) | (modifiers.has('Meta') ? 4 : 0) | (modifiers.has('Shift') ? 8 : 0);
}

/** The `Input.dispatchMouseEvent` buttons bit mask. */
function buttonsMask(buttons: ReadonlySet<MouseButton>): number {
  return (buttons.has('left') ? 1 : 0) | (buttons.has('right') ? 2 : 0) | (buttons.has('middle') ? 4 : 0);
}

/** `ControlOrMeta` is Meta on macOS and Control elsewhere. */
function platformKey(key: string): string {
  return key === 'ControlOrMeta' ? (IS_MAC ? 'Meta' : 'Control') : key;
}

/** Whether the keyboard has a key by this name: a key code (`Enter`, `Space`) or a character of the US layout. */
export function hasKey(key: string): boolean {
  return KEY_LAYOUT.has(platformKey(key));
}

export class Keyboard {
  private readonly heldModifiers = new Set<Modifier>();
  private readonly heldKeys = new Set<string>();
  constructor(private readonly target: InputTarget) {}

  /** The modifiers held now. */
  modifiers(): ReadonlySet<Modifier> {
    return this.heldModifiers;
  }

  /** Forgets what is held: the renderer that held it is gone. */
  reset(): void {
    this.heldModifiers.clear();
    this.heldKeys.clear();
  }

  /** Presses a key down and leaves it held; a held modifier applies to the keys and mouse events after it. */
  async down(key: string): Promise<void> {
    const description = this.describe(key);
    const autoRepeat = this.heldKeys.has(description.code);
    this.heldKeys.add(description.code);
    if (isModifier(description.key)) this.heldModifiers.add(description.key);
    await this.target.session.send('Input.dispatchKeyEvent', {
      type: description.text === '' ? 'rawKeyDown' : 'keyDown',
      modifiers: modifiersMask(this.heldModifiers),
      windowsVirtualKeyCode: description.keyCodeWithoutLocation,
      code: description.code,
      commands: this.editingCommands(description.code),
      key: description.key,
      text: description.text,
      unmodifiedText: description.text,
      autoRepeat,
      location: description.location,
      isKeypad: description.location === KEYPAD_LOCATION,
    });
  }

  /** Releases a key `down` pressed. */
  async up(key: string): Promise<void> {
    const description = this.describe(key);
    if (isModifier(description.key)) this.heldModifiers.delete(description.key);
    this.heldKeys.delete(description.code);
    await this.target.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiersMask(this.heldModifiers),
      key: description.key,
      windowsVirtualKeyCode: description.keyCodeWithoutLocation,
      code: description.code,
      location: description.location,
      isKeypad: description.location === KEYPAD_LOCATION,
    });
  }

  /** Presses a key down and releases it, under whatever modifiers are held. */
  async press(key: string): Promise<void> {
    await this.down(key);
    await this.up(key);
  }

  /** Types one character: its key when the layout has one, else the character inserted as text. */
  async type(character: string): Promise<void> {
    if (KEY_LAYOUT.has(character)) await this.press(character);
    else await this.insertText(character);
  }

  /** Inserts text as an input method's commit would: input events and no key events. */
  async insertText(text: string): Promise<void> {
    await this.target.session.send('Input.insertText', { text });
  }

  private describe(name: string): KeyDescription {
    const key = platformKey(name);
    let description = KEY_LAYOUT.get(key);
    if (description === undefined) throw new Error(`the keyboard has no key ${JSON.stringify(key)}`);
    if (this.heldModifiers.has('Shift') && description.shifted !== undefined) description = description.shifted;
    // A key pressed with Control, Alt, or Meta held types nothing.
    const onlyShift = this.heldModifiers.size === 1 && this.heldModifiers.has('Shift');
    return this.heldModifiers.size > 0 && !onlyShift ? { ...description, text: '' } : description;
  }

  /** The editing commands macOS runs for this key with the held modifiers; text insertion is left to the event's `text`. */
  private editingCommands(code: string): string[] {
    if (!IS_MAC) return [];
    const chord = [...(['Shift', 'Control', 'Alt', 'Meta'] as const).filter((modifier) => this.heldModifiers.has(modifier)), code].join('+');
    return (MAC_EDITING_COMMANDS[chord] ?? []).filter((command) => !command.startsWith('insert'));
  }
}

/**
 * The page's mouse, in viewport CSS pixels. A press that moves over a
 * draggable element starts an HTML drag, which Chromium carries through from
 * these events alone: the moves after it are its `dragover`, and the release
 * its `drop`.
 */
export class Mouse {
  private x = 0;
  private y = 0;
  private lastButton: MouseButton | 'none' = 'none';
  private readonly buttons = new Set<MouseButton>();

  constructor(
    private readonly target: InputTarget,
    private readonly keyboard: Keyboard,
  ) {}

  /** Forgets the buttons held: the renderer that held them is gone. */
  reset(): void {
    this.buttons.clear();
    this.lastButton = 'none';
  }

  async move(x: number, y: number): Promise<void> {
    this.x = x;
    this.y = y;
    await this.target.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      button: this.lastButton,
      buttons: buttonsMask(this.buttons),
      x,
      y,
      modifiers: modifiersMask(this.keyboard.modifiers()),
    });
  }

  /** Presses a button where the pointer is. */
  async down(button: MouseButton = 'left', clickCount = 1): Promise<void> {
    this.lastButton = button;
    this.buttons.add(button);
    await this.target.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button,
      buttons: buttonsMask(this.buttons),
      x: this.x,
      y: this.y,
      modifiers: modifiersMask(this.keyboard.modifiers()),
      clickCount,
    });
  }

  /** Releases a button where the pointer is. */
  async up(button: MouseButton = 'left', clickCount = 1): Promise<void> {
    this.lastButton = 'none';
    this.buttons.delete(button);
    await this.target.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button,
      buttons: buttonsMask(this.buttons),
      x: this.x,
      y: this.y,
      modifiers: modifiersMask(this.keyboard.modifiers()),
      clickCount,
    });
  }

  /** Moves to a point and clicks `clickCount` times, the events sent back to back as one gesture. */
  async click(x: number, y: number, button: MouseButton = 'left', clickCount = 1): Promise<void> {
    const events: Promise<void>[] = [this.move(x, y)];
    for (let count = 1; count <= clickCount; count += 1) events.push(this.down(button, count), this.up(button, count));
    await Promise.all(events);
  }

  /** A wheel event where the pointer is. */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    await this.target.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.x, y: this.y, modifiers: modifiersMask(this.keyboard.modifiers()), deltaX, deltaY });
  }
}
