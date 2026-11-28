/**
 * The keys of a US keyboard as Chromium's `Input.dispatchKeyEvent` takes
 * them, and the editing commands macOS runs only when a key event names
 * them. Characters outside this layout have no key: they are inserted as
 * text.
 */

/** One key as a key event describes it. */
export interface KeyDescription {
  readonly key: string;
  readonly keyCode: number;
  readonly keyCodeWithoutLocation: number;
  readonly code: string;
  readonly text: string;
  readonly location: number;
  /** The same key with Shift held, when Shift changes what it types. */
  readonly shifted?: KeyDescription;
}

/** `code: [keyCode, key, shiftKey?, location?, text?, keyCodeWithoutLocation?, shiftKeyCode?]` */
type KeyRow = readonly [number, string, (string | undefined)?, (number | undefined)?, (string | undefined)?, (number | undefined)?, (number | undefined)?];

const US_LAYOUT: Readonly<Record<string, KeyRow>> = {
  Escape: [27, 'Escape'], F1: [112, 'F1'], F2: [113, 'F2'], F3: [114, 'F3'], F4: [115, 'F4'], F5: [116, 'F5'],
  F6: [117, 'F6'], F7: [118, 'F7'], F8: [119, 'F8'], F9: [120, 'F9'], F10: [121, 'F10'], F11: [122, 'F11'], F12: [123, 'F12'],
  Backquote: [192, '`', '~'], Digit1: [49, '1', '!'], Digit2: [50, '2', '@'], Digit3: [51, '3', '#'], Digit4: [52, '4', '$'],
  Digit5: [53, '5', '%'], Digit6: [54, '6', '^'], Digit7: [55, '7', '&'], Digit8: [56, '8', '*'], Digit9: [57, '9', '('],
  Digit0: [48, '0', ')'], Minus: [189, '-', '_'], Equal: [187, '=', '+'], Backslash: [220, '\\', '|'], Backspace: [8, 'Backspace'],
  Tab: [9, 'Tab'], KeyQ: [81, 'q', 'Q'], KeyW: [87, 'w', 'W'], KeyE: [69, 'e', 'E'], KeyR: [82, 'r', 'R'], KeyT: [84, 't', 'T'],
  KeyY: [89, 'y', 'Y'], KeyU: [85, 'u', 'U'], KeyI: [73, 'i', 'I'], KeyO: [79, 'o', 'O'], KeyP: [80, 'p', 'P'],
  BracketLeft: [219, '[', '{'], BracketRight: [221, ']', '}'], CapsLock: [20, 'CapsLock'],
  KeyA: [65, 'a', 'A'], KeyS: [83, 's', 'S'], KeyD: [68, 'd', 'D'], KeyF: [70, 'f', 'F'], KeyG: [71, 'g', 'G'], KeyH: [72, 'h', 'H'],
  KeyJ: [74, 'j', 'J'], KeyK: [75, 'k', 'K'], KeyL: [76, 'l', 'L'], Semicolon: [186, ';', ':'], Quote: [222, '\'', '"'],
  Enter: [13, 'Enter', undefined, undefined, '\r'],
  ShiftLeft: [160, 'Shift', undefined, 1, undefined, 16], KeyZ: [90, 'z', 'Z'], KeyX: [88, 'x', 'X'], KeyC: [67, 'c', 'C'],
  KeyV: [86, 'v', 'V'], KeyB: [66, 'b', 'B'], KeyN: [78, 'n', 'N'], KeyM: [77, 'm', 'M'], Comma: [188, ',', '<'],
  Period: [190, '.', '>'], Slash: [191, '/', '?'], ShiftRight: [161, 'Shift', undefined, 2, undefined, 16],
  ControlLeft: [162, 'Control', undefined, 1, undefined, 17], MetaLeft: [91, 'Meta', undefined, 1],
  AltLeft: [164, 'Alt', undefined, 1, undefined, 18], Space: [32, ' '], AltRight: [165, 'Alt', undefined, 2, undefined, 18],
  AltGraph: [225, 'AltGraph'], MetaRight: [92, 'Meta', undefined, 2], ContextMenu: [93, 'ContextMenu'],
  ControlRight: [163, 'Control', undefined, 2, undefined, 17],
  PrintScreen: [44, 'PrintScreen'], ScrollLock: [145, 'ScrollLock'], Pause: [19, 'Pause'], PageUp: [33, 'PageUp'],
  PageDown: [34, 'PageDown'], Insert: [45, 'Insert'], Delete: [46, 'Delete'], Home: [36, 'Home'], End: [35, 'End'],
  ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'],
  AudioVolumeMute: [173, 'AudioVolumeMute'], AudioVolumeDown: [174, 'AudioVolumeDown'], AudioVolumeUp: [175, 'AudioVolumeUp'],
  MediaTrackNext: [176, 'MediaTrackNext'], MediaTrackPrevious: [177, 'MediaTrackPrevious'], MediaPlayPause: [179, 'MediaPlayPause'],
  NumLock: [144, 'NumLock'], NumpadDivide: [111, '/', undefined, 3], NumpadMultiply: [106, '*', undefined, 3],
  NumpadSubtract: [109, '-', undefined, 3], Numpad7: [36, 'Home', '7', 3, undefined, undefined, 103],
  Numpad8: [38, 'ArrowUp', '8', 3, undefined, undefined, 104], Numpad9: [33, 'PageUp', '9', 3, undefined, undefined, 105],
  Numpad4: [37, 'ArrowLeft', '4', 3, undefined, undefined, 100], Numpad5: [12, 'Clear', '5', 3, undefined, undefined, 101],
  Numpad6: [39, 'ArrowRight', '6', 3, undefined, undefined, 102], NumpadAdd: [107, '+', undefined, 3],
  Numpad1: [35, 'End', '1', 3, undefined, undefined, 97], Numpad2: [40, 'ArrowDown', '2', 3, undefined, undefined, 98],
  Numpad3: [34, 'PageDown', '3', 3, undefined, undefined, 99], Numpad0: [45, 'Insert', '0', 3, undefined, undefined, 96],
  NumpadDecimal: [46, 'Delete', '.', 3, undefined, undefined, 110], NumpadEnter: [13, 'Enter', undefined, 3, '\r'],
};

const KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ShiftLeft: ['Shift'], ControlLeft: ['Control'], AltLeft: ['Alt'], MetaLeft: ['Meta'], Enter: ['\n', '\r'],
};

/** Editing commands macOS Chromium only runs when the key event names them; `insert*` commands are left to `text`. */
export const MAC_EDITING_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  Backspace: ['deleteBackward'], Enter: ['insertNewline'], NumpadEnter: ['insertNewline'], Escape: ['cancelOperation'],
  ArrowUp: ['moveUp'], ArrowDown: ['moveDown'], ArrowLeft: ['moveLeft'], ArrowRight: ['moveRight'], F5: ['complete'],
  Delete: ['deleteForward'], Home: ['scrollToBeginningOfDocument'], End: ['scrollToEndOfDocument'],
  PageUp: ['scrollPageUp'], PageDown: ['scrollPageDown'], 'Shift+Backspace': ['deleteBackward'],
  'Shift+Enter': ['insertNewline'], 'Shift+NumpadEnter': ['insertNewline'], 'Shift+Escape': ['cancelOperation'],
  'Shift+ArrowUp': ['moveUpAndModifySelection'], 'Shift+ArrowDown': ['moveDownAndModifySelection'],
  'Shift+ArrowLeft': ['moveLeftAndModifySelection'], 'Shift+ArrowRight': ['moveRightAndModifySelection'],
  'Shift+F5': ['complete'], 'Shift+Delete': ['deleteForward'], 'Shift+Home': ['moveToBeginningOfDocumentAndModifySelection'],
  'Shift+End': ['moveToEndOfDocumentAndModifySelection'], 'Shift+PageUp': ['pageUpAndModifySelection'],
  'Shift+PageDown': ['pageDownAndModifySelection'], 'Shift+Numpad5': ['delete'], 'Control+Tab': ['selectNextKeyView'],
  'Control+Enter': ['insertLineBreak'], 'Control+NumpadEnter': ['insertLineBreak'],
  'Control+Quote': ['insertSingleQuoteIgnoringSubstitution'], 'Control+KeyA': ['moveToBeginningOfParagraph'],
  'Control+KeyB': ['moveBackward'], 'Control+KeyD': ['deleteForward'], 'Control+KeyE': ['moveToEndOfParagraph'],
  'Control+KeyF': ['moveForward'], 'Control+KeyH': ['deleteBackward'], 'Control+KeyK': ['deleteToEndOfParagraph'],
  'Control+KeyL': ['centerSelectionInVisibleArea'], 'Control+KeyN': ['moveDown'],
  'Control+KeyO': ['insertNewlineIgnoringFieldEditor', 'moveBackward'], 'Control+KeyP': ['moveUp'],
  'Control+KeyT': ['transpose'], 'Control+KeyV': ['pageDown'], 'Control+KeyY': ['yank'],
  'Control+Backspace': ['deleteBackwardByDecomposingPreviousCharacter'], 'Control+ArrowUp': ['scrollPageUp'],
  'Control+ArrowDown': ['scrollPageDown'], 'Control+ArrowLeft': ['moveToLeftEndOfLine'],
  'Control+ArrowRight': ['moveToRightEndOfLine'], 'Shift+Control+Enter': ['insertLineBreak'],
  'Shift+Control+NumpadEnter': ['insertLineBreak'], 'Shift+Control+Tab': ['selectPreviousKeyView'],
  'Shift+Control+Quote': ['insertDoubleQuoteIgnoringSubstitution'],
  'Shift+Control+KeyA': ['moveToBeginningOfParagraphAndModifySelection'], 'Shift+Control+KeyB': ['moveBackwardAndModifySelection'],
  'Shift+Control+KeyE': ['moveToEndOfParagraphAndModifySelection'], 'Shift+Control+KeyF': ['moveForwardAndModifySelection'],
  'Shift+Control+KeyN': ['moveDownAndModifySelection'], 'Shift+Control+KeyP': ['moveUpAndModifySelection'],
  'Shift+Control+KeyV': ['pageDownAndModifySelection'],
  'Shift+Control+Backspace': ['deleteBackwardByDecomposingPreviousCharacter'], 'Shift+Control+ArrowUp': ['scrollPageUp'],
  'Shift+Control+ArrowDown': ['scrollPageDown'], 'Shift+Control+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'],
  'Shift+Control+ArrowRight': ['moveToRightEndOfLineAndModifySelection'], 'Alt+Backspace': ['deleteWordBackward'],
  'Alt+Enter': ['insertNewlineIgnoringFieldEditor'], 'Alt+NumpadEnter': ['insertNewlineIgnoringFieldEditor'],
  'Alt+Escape': ['complete'], 'Alt+ArrowUp': ['moveBackward', 'moveToBeginningOfParagraph'],
  'Alt+ArrowDown': ['moveForward', 'moveToEndOfParagraph'], 'Alt+ArrowLeft': ['moveWordLeft'],
  'Alt+ArrowRight': ['moveWordRight'], 'Alt+Delete': ['deleteWordForward'], 'Alt+PageUp': ['pageUp'],
  'Alt+PageDown': ['pageDown'], 'Shift+Alt+Backspace': ['deleteWordBackward'],
  'Shift+Alt+Enter': ['insertNewlineIgnoringFieldEditor'], 'Shift+Alt+NumpadEnter': ['insertNewlineIgnoringFieldEditor'],
  'Shift+Alt+Escape': ['complete'], 'Shift+Alt+ArrowUp': ['moveParagraphBackwardAndModifySelection'],
  'Shift+Alt+ArrowDown': ['moveParagraphForwardAndModifySelection'], 'Shift+Alt+ArrowLeft': ['moveWordLeftAndModifySelection'],
  'Shift+Alt+ArrowRight': ['moveWordRightAndModifySelection'], 'Shift+Alt+Delete': ['deleteWordForward'],
  'Shift+Alt+PageUp': ['pageUp'], 'Shift+Alt+PageDown': ['pageDown'], 'Control+Alt+KeyB': ['moveWordBackward'],
  'Control+Alt+KeyF': ['moveWordForward'], 'Control+Alt+Backspace': ['deleteWordBackward'],
  'Shift+Control+Alt+KeyB': ['moveWordBackwardAndModifySelection'], 'Shift+Control+Alt+KeyF': ['moveWordForwardAndModifySelection'],
  'Shift+Control+Alt+Backspace': ['deleteWordBackward'], 'Meta+NumpadSubtract': ['cancel'],
  'Meta+Backspace': ['deleteToBeginningOfLine'], 'Meta+ArrowUp': ['moveToBeginningOfDocument'],
  'Meta+ArrowDown': ['moveToEndOfDocument'], 'Meta+ArrowLeft': ['moveToLeftEndOfLine'], 'Meta+ArrowRight': ['moveToRightEndOfLine'],
  'Shift+Meta+NumpadSubtract': ['cancel'], 'Shift+Meta+Backspace': ['deleteToBeginningOfLine'],
  'Shift+Meta+ArrowUp': ['moveToBeginningOfDocumentAndModifySelection'], 'Shift+Meta+ArrowDown': ['moveToEndOfDocumentAndModifySelection'],
  'Shift+Meta+ArrowLeft': ['moveToLeftEndOfLineAndModifySelection'], 'Shift+Meta+ArrowRight': ['moveToRightEndOfLineAndModifySelection'],
  'Meta+KeyA': ['selectAll'], 'Meta+KeyC': ['copy'], 'Meta+KeyX': ['cut'], 'Meta+KeyV': ['paste'], 'Meta+KeyZ': ['undo'],
  'Shift+Meta+KeyZ': ['redo'],
};

/** Expands the layout into every name a key is pressed by: its code, its key, and its shifted key. */
function buildLayout(): ReadonlyMap<string, KeyDescription> {
  const layout = new Map<string, KeyDescription>();
  for (const [code, [keyCode, key, shiftKey, location = 0, text, withoutLocation, shiftKeyCode]] of Object.entries(US_LAYOUT)) {
    const plain = { key, keyCode, keyCodeWithoutLocation: withoutLocation ?? keyCode, code, text: key.length === 1 ? key : (text ?? ''), location };
    const shifted: KeyDescription | undefined =
      shiftKey === undefined ? undefined : { ...plain, key: shiftKey, text: shiftKey, ...(shiftKeyCode === undefined ? {} : { keyCode: shiftKeyCode, keyCodeWithoutLocation: shiftKeyCode }) };
    layout.set(code, { ...plain, ...(shifted === undefined ? {} : { shifted }) });
    for (const alias of KEY_ALIASES[code] ?? []) layout.set(alias, plain);
    if (location !== 0) continue;
    if (key.length === 1) layout.set(key, plain);
    if (shifted !== undefined) layout.set(shifted.key, shifted);
  }
  return layout;
}

/** Every key the keyboard has, by each name it is pressed by. */
export const KEY_LAYOUT = buildLayout();
