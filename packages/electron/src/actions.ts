/**
 * Actions: one function per kind, each waiting for its node as the kind
 * needs, then sending trusted input through the operation's budget. A node
 * action finds the point to act at and makes the gesture a point action
 * makes there.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Protocol } from 'devtools-protocol';
import {
  EngineError,
  parseKey,
  sleep,
  TestError,
  pollCondition,
  withTimeout,
  type LocatorAction,
  type Momentum,
  type PointerAction,
  type ScrollDirection,
  type ViewportPoint,
} from '@e2e-dev/core/engine';
import { actionablePoint, contentBox, waitReady, whole, type WaitTarget } from './actionability.ts';
import type { Budget } from './budget.ts';
import { hasKey, type MouseButton } from './cdp/input.ts';
import type { DevTools } from './devtools.ts';
import { GONE, lostFocus, notActionable, unsupported } from './errors.ts';
import { nextFrame, viewportSize } from './in-page/node-ops.ts';
import type { AppWindow, Windows } from './windows.ts';

/** How long a long press holds by default. */
const LONG_PRESS_MS = 800;

/** How long before its operation ends a held press is released: time for the release to reach the app. */
const RELEASE_MARGIN_MS = 100;

/** How long a paced drag (`swipeTo`) takes by default. */
const SWIPE_TO_MS = 300;

/** The time between two moves of a paced drag: one frame at 60 Hz. */
const FRAME_MS = 16;

/** The share of a box one wheel scroll covers, by momentum, as the web engine scrolls. */
const WHEEL_SHARE: Readonly<Record<Momentum, number>> = { none: 0.5, slow: 0.75, fast: 1.5 };

/** What every action reads beside its window. */
export interface ActionContext {
  readonly devtools: DevTools;
  readonly windows: Windows;
  readonly projectRoot: string;
  /** The attempt's directory for files the engine writes for the app to read, made on first use and removed with the attempt. */
  uploads(): string;
}

/** One action on one node: the node it waits on, and the budget its input goes through. */
interface Step extends WaitTarget {
  readonly context: ActionContext;
  readonly budget: Budget;
}

type ActionOf<K extends LocatorAction['kind']> = Extract<LocatorAction, { readonly kind: K }>;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Performs a locator action on a node of the shown window. */
export function performOnNode(context: ActionContext, window: AppWindow, backendNodeId: number, action: LocatorAction, budget: Budget): Promise<void> {
  const step: Step = { context, devtools: context.devtools, window, backendNodeId, operation: budget.operation, deadline: budget.waits, budget };
  switch (action.kind) {
    case 'tap':
    case 'doubleTap':
    case 'secondaryTap':
    case 'multiTap':
      return tap(step, action);
    case 'hover':
      return actionablePoint(step, false).then((point) => hover(budget, window, point));
    case 'longPress':
      return actionablePoint(step, true).then((point) => longPress(budget, window, point, action.durationMs));
    case 'focus':
      return focus(step);
    case 'blur':
      return waitReady(step, 'checkConnected').then(() => budget.send(() => step.devtools.callOn(window.page, backendNodeId, 'blur')));
    case 'scrollIntoView':
      return scrollIntoView(step);
    case 'fill':
    case 'clear':
      return fill(step, action.kind === 'fill' ? action.value : '');
    case 'check':
    case 'uncheck':
      return setChecked(step, action.kind === 'check');
    case 'press':
      return press(step, action);
    case 'selectOption':
      return selectOption(step, action);
    case 'setInputFiles':
      return setInputFiles(step, action);
    case 'setInputFilePayloads':
      return setInputFilePayloads(step, action);
    case 'dragTo':
      return dragTo(step, action);
    case 'swipe':
      return swipeNode(step, action);
    case 'scrollTo':
      // Not among the engine's declared actions, so the harness refuses it first.
      throw unsupported('scrollTo is not supported; swipe the container, or scroll a node into view');
  }
}

/** A pointer action at a viewport point of the shown window. */
export async function performAtPoint(context: ActionContext, window: AppWindow, point: ViewportPoint, action: PointerAction, budget: Budget): Promise<void> {
  const at = whole(point);
  switch (action.kind) {
    case 'tap':
      return click(budget, window, at, {});
    case 'doubleTap':
      return click(budget, window, at, { clickCount: 2 });
    case 'secondaryTap':
      return click(budget, window, at, { button: 'right' });
    case 'hover':
      return hover(budget, window, at);
    case 'longPress':
      return longPress(budget, window, at, action.durationMs);
    case 'dragTo':
      return drag(budget, window, at, () => Promise.resolve(whole(action.target)));
    case 'swipeTo':
      return drag(budget, window, at, () => Promise.resolve(whole(action.target)), action.durationMs ?? SWIPE_TO_MS);
    case 'swipe':
      return swipe(budget, window, at, await window.page.evaluate(viewportSize), action);
  }
}

/** A swipe on the window itself, from its centre. */
export async function swipeWindow(context: ActionContext, window: AppWindow, action: ActionOf<'swipe'>, budget: Budget): Promise<void> {
  const size = await window.page.evaluate(viewportSize);
  await swipe(budget, window, whole({ x: size.width / 2, y: size.height / 2 }), size, action);
}

/** Types into the focused element of the shown window, one character at a time: no key goes out once the caller stopped waiting. */
export async function typeText(context: ActionContext, window: AppWindow, text: string, replace: boolean, budget: Budget): Promise<void> {
  const { keyboard } = window.page;
  if (!(await context.devtools.focusedTakesText(window.page))) throw notActionable('nothing that takes text has keyboard focus; tap the field first');
  if (replace) {
    await withModifiers(budget, window, ['ControlOrMeta'], () => keyboard.press('A'));
    await budget.send(() => keyboard.press('Delete'));
  }
  for (const character of text) await budget.send(() => keyboard.type(character));
}

/** Presses a key in the shown window, wherever focus is. */
export async function pressKey(window: AppWindow, key: string, budget: Budget): Promise<void> {
  const chord = keyChord(key);
  await withModifiers(budget, window, chord.modifiers, () => window.page.keyboard.press(chord.key));
}

// --- node actions ---

async function tap(step: Step, action: ActionOf<'tap' | 'doubleTap' | 'secondaryTap' | 'multiTap'>): Promise<void> {
  const point = await actionablePoint(step, true);
  await click(step.budget, step.window, point, {
    clickCount: action.kind === 'doubleTap' ? 2 : action.kind === 'multiTap' ? action.count : 1,
    button: action.kind === 'secondaryTap' ? 'right' : 'left',
    modifiers: action.modifiers ?? [],
  });
}

async function focus(step: Step): Promise<void> {
  // A node that is gone fails as stale before anything is sent, so the harness locates it again.
  await waitReady(step, 'checkConnected');
  // pressSequentially focuses, then types into whatever holds focus: the node must be the one that does. An element that
  // cannot take focus leaves it where it was, as on the web; the typing that follows says nothing takes text.
  if ((await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'focus'))) === 'moved') throw lostFocus();
}

/** Scrolls the element into view, waiting until it has a box to scroll to: an element that is not rendered cannot be. */
async function scrollIntoView(step: Step): Promise<void> {
  const { session } = step.window.page;
  await pollCondition({
    deadline: step.deadline,
    signal: step.operation.signal,
    negated: false,
    evaluate: async () => {
      await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: step.backendNodeId }).catch(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'scrollIntoView'));
      return (await contentBox(step)) !== undefined;
    },
    onTimeout: () => notActionable('the element cannot be scrolled into view: it has no box on screen (hidden, or empty)'),
  });
}

async function fill(step: Step, value: string): Promise<void> {
  const { devtools, window, backendNodeId, budget } = step;
  await waitReady(step, 'checkEditable');
  // A date, time, color, or range input takes no typed text: its value is set, as a browser's own picker does.
  const set = await budget.send(() => devtools.callOn(window.page, backendNodeId, 'setValue', value));
  if (set !== null) {
    if (!set.ok) throw notActionable(set.reason);
    return;
  }
  // The app's focus handler can hand focus on; text goes only to the node that still holds it.
  if (!(await budget.send(() => devtools.callOn(window.page, backendNodeId, 'selectContents')))) throw lostFocus();
  // Text replaces the selection as typing would, with input events and no key events, as fill promises; an empty value
  // is a Delete key, so an editor that keeps its own model sees beforeinput.
  if (value === '') await budget.send(() => window.page.keyboard.press('Delete'));
  else await budget.send(() => window.page.keyboard.insertText(value));
}

async function setChecked(step: Step, want: boolean): Promise<void> {
  const { devtools, window, backendNodeId } = step;
  const kind = want ? 'check' : 'uncheck';
  const now = await devtools.callOn(window.page, backendNodeId, 'readChecked');
  if (now === null) throw notActionable(`the element has no checked state to ${kind}: it is no checkbox, radio, or switch`);
  if (now === want) return;
  // A click on a checked native radio leaves it checked: only another radio of its group clears it. A custom radio
  // clears if its app says so, which the read after the click finds out.
  if (!want && (await devtools.callOn(window.page, backendNodeId, 'isNativeRadio'))) throw notActionable('uncheck cannot clear a radio button; select another radio in its group');
  await click(step.budget, window, await actionablePoint(step, true), {});
  // A custom widget can set its state in a later task: the state is polled until the deadline, as the checks before the click are.
  let read = false;
  await pollCondition({
    deadline: step.deadline,
    signal: step.operation.signal,
    negated: false,
    evaluate: async () => {
      let state: boolean | null;
      try {
        state = await devtools.callOn(window.page, backendNodeId, 'readChecked');
      } catch (cause) {
        // The app answered the click by replacing the control (a "Saved" in its place): the click did its work. One
        // that goes away after it was read unchanged did not take it.
        if (!read && isGone(cause)) return true;
        throw cause;
      }
      read = true;
      return state === want;
    },
    onTimeout: () => notActionable(`clicking the element did not ${kind} it`),
  });
}

async function press(step: Step, action: ActionOf<'press'>): Promise<void> {
  // A key the keyboard cannot send is refused before focus moves.
  const chord = keyChord(action.key);
  await waitReady(step, 'checkConnected');
  // The key goes to what holds focus after the node is focused, as on the web: a node that cannot take focus (a plain div) leaves it where it was.
  await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'focus'));
  await withModifiers(step.budget, step.window, chord.modifiers, () => step.window.page.keyboard.press(chord.key));
}

async function selectOption(step: Step, action: ActionOf<'selectOption'>): Promise<void> {
  const option = typeof action.value === 'string' ? { label: action.value } : action.value;
  // An app can fill its options in after a request: the wait lasts until the option is there and enabled.
  await waitReady(step, 'checkSelect', option);
  const outcome = await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'selectOption', option));
  if (!outcome.ok) throw notActionable(outcome.reason);
}

async function setInputFiles(step: Step, action: ActionOf<'setInputFiles'>): Promise<void> {
  const files = action.paths.map((file) => path.resolve(step.context.projectRoot, file));
  // The DevTools call takes a path that names nothing and attaches nothing, reporting success.
  const missing = files.find((file) => !existsSync(file));
  if (missing !== undefined) throw new TestError('INVALID_ARGUMENT', `setInputFiles: no file at ${missing}`);
  if (!(await step.devtools.callOn(step.window.page, step.backendNodeId, 'isFileInput'))) return await chooseFiles(step, files);
  await waitReady(step, 'checkFileInput');
  const takes = await step.devtools.callOn(step.window.page, step.backendNodeId, 'takesFiles', files.length);
  if (!takes.ok) throw new TestError('INVALID_ARGUMENT', `setInputFiles: ${takes.reason}`);
  // The DevTools call leaves the input as it was for an empty list; `[]` clears it.
  if (files.length === 0) {
    await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'clearFiles'));
    return;
  }
  await step.budget.send(() => step.window.page.session.send('DOM.setFileInputFiles', { files, backendNodeId: step.backendNodeId }));
}

/**
 * In-memory files. The DevTools protocol sets a file input from paths only,
 * so each file is written to the attempt's upload directory, which lasts as
 * long as the app may read it: a page reads a chosen file when it sends it,
 * not when it is chosen.
 */
async function setInputFilePayloads(step: Step, action: ActionOf<'setInputFilePayloads'>): Promise<void> {
  const directory = mkdtempSync(path.join(step.context.uploads(), 'files-'));
  const paths = action.files.map((file, index) => {
    // A directory per file: two files may share a name, and a name is the page's to read, never a path to follow.
    const own = path.join(directory, String(index));
    mkdirSync(own);
    const written = path.join(own, path.basename(file.name) || 'file');
    writeFileSync(written, file.buffer);
    return written;
  });
  await setInputFiles(step, { kind: 'setInputFiles', paths });
}

/**
 * Files for a control that is no file input itself: a button whose click
 * opens a file chooser. The chooser is held back from the screen, the control
 * clicked, and the files given to the input the chooser belongs to.
 */
async function chooseFiles(step: Step, files: readonly string[]): Promise<void> {
  const { session } = step.window.page;
  let opened: (event: Protocol.Page.FileChooserOpenedEvent) => void = () => undefined;
  const chooser = new Promise<Protocol.Page.FileChooserOpenedEvent>((resolve) => {
    opened = resolve;
  });
  const stopListening = session.on('Page.fileChooserOpened', (event) => opened(event));
  await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    await click(step.budget, step.window, await actionablePoint(step, true), {});
    const { backendNodeId, mode } = await withTimeout(chooser, Math.max(1, step.deadline.remaining()), () => notActionable('the element is not a file input, and clicking it opened no file chooser'));
    if (backendNodeId === undefined) throw notActionable('the file chooser the element opened belongs to no input in the window');
    if (files.length > 1 && mode !== 'selectMultiple') throw new TestError('INVALID_ARGUMENT', `setInputFiles: the file chooser takes one file, not ${files.length}`);
    // The DevTools call leaves the input as it was for an empty list, as on the input itself.
    if (files.length === 0) await step.budget.send(() => step.devtools.callOn(step.window.page, backendNodeId, 'clearFiles'));
    else await step.budget.send(() => session.send('DOM.setFileInputFiles', { files: [...files], backendNodeId }));
  } finally {
    stopListening();
    await session.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
  }
}

/** Whether a failure says the node is no longer in the document. */
function isGone(cause: unknown): boolean {
  return (cause instanceof EngineError && cause.code === 'NODE_STALE') || GONE.test(cause instanceof Error ? cause.message : String(cause));
}

async function dragTo(step: Step, action: ActionOf<'dragTo'>): Promise<void> {
  const target = step.context.windows.bind(action.target);
  // The source is pressed where it is now; only then does the target scroll into view, under the held pointer. It is
  // waited for as the source was: in view, and the topmost element at the point the drop lands on.
  await drag(step.budget, step.window, await actionablePoint(step, true), () =>
    actionablePoint({ ...step, backendNodeId: target.backendNodeId }, false).catch((cause: unknown) => {
      if (cause instanceof EngineError && cause.code === 'NOT_ACTIONABLE') {
        throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `the drop target ${cause.message.replace(/^the element /, '')}, and the source was already pressed`, { retryable: false, cause });
      }
      throw cause;
    }),
  );
}

async function swipeNode(step: Step, action: ActionOf<'swipe'>): Promise<void> {
  const point = await actionablePoint(step, false);
  // The layout can change after the wait for actionability read the box.
  const box = await contentBox(step);
  if (box === undefined) throw notActionable('the element has no box on screen to swipe');
  await swipe(step.budget, step.window, point, box, action);
}

// --- pointer gestures at a point, which node and point actions share ---

async function click(budget: Budget, window: AppWindow, at: ViewportPoint, options: { readonly clickCount?: number; readonly button?: MouseButton; readonly modifiers?: readonly string[] }): Promise<void> {
  const { clickCount = 1, button = 'left', modifiers = [] } = options;
  await withModifiers(budget, window, modifiers, () => window.page.mouse.click(at.x, at.y, button, clickCount));
}

async function hover(budget: Budget, window: AppWindow, at: ViewportPoint): Promise<void> {
  await budget.send(() => window.page.mouse.move(at.x, at.y));
}

/**
 * Presses at a point and holds for `durationMs`, never past the operation's
 * end, and releases whatever happens: a release that waited for a press
 * longer than its operation would land on whatever control the next action
 * leaves the pointer over.
 */
async function longPress(budget: Budget, window: AppWindow, at: ViewportPoint, durationMs = LONG_PRESS_MS): Promise<void> {
  const { mouse } = window.page;
  await budget.send(() => mouse.move(at.x, at.y));
  await budget.send(() => mouse.down());
  // The release lands before the operation's bound fires, so a press its budget cuts short is up when the step fails.
  const held = Math.min(durationMs, Math.max(0, budget.deadline.remaining() - RELEASE_MARGIN_MS));
  try {
    await sleep(held, budget.operation.signal);
  } finally {
    await mouse.up();
  }
  budget.check();
  if (held < durationMs) throw new EngineError('OPERATION_TIMEOUT', `the press was released after ${Math.round(held)}ms of ${durationMs}ms: the step's timeout ran out`, { retryable: false });
}

/**
 * Presses at `from` and drags to the point `target` answers once the pointer
 * is down, through a move in between so drag handlers see motion before the
 * drop; paced over `durationMs` when given.
 */
async function drag(budget: Budget, window: AppWindow, from: ViewportPoint, target: () => Promise<ViewportPoint>, durationMs?: number): Promise<void> {
  const { mouse } = window.page;
  await budget.send(() => mouse.move(from.x, from.y));
  await budget.send(() => mouse.down());
  try {
    const to = await target();
    const steps = durationMs === undefined ? 2 : Math.max(2, Math.round(durationMs / FRAME_MS));
    for (let step = 1; step <= steps; step += 1) {
      await budget.send(() => mouse.move(Math.round(from.x + ((to.x - from.x) * step) / steps), Math.round(from.y + ((to.y - from.y) * step) / steps)));
      if (durationMs !== undefined) await sleep(durationMs / steps, budget.operation.signal);
    }
  } finally {
    await mouse.up();
  }
}

/** A wheel scroll with the pointer at a point, its distance a share of `box` by momentum, then a frame for the app to render it. */
async function swipe(budget: Budget, window: AppWindow, at: ViewportPoint, box: Size, action: { readonly direction: ScrollDirection; readonly momentum?: Momentum }): Promise<void> {
  const { direction } = action;
  const extent = direction === 'up' || direction === 'down' ? box.height : box.width;
  const distance = Math.max(1, Math.round(extent * WHEEL_SHARE[action.momentum ?? 'none']));
  const [deltaX, deltaY] = direction === 'down' ? [0, distance] : direction === 'up' ? [0, -distance] : direction === 'right' ? [distance, 0] : [-distance, 0];
  await budget.send(() => window.page.mouse.move(at.x, at.y));
  await budget.send(() => window.page.mouse.wheel(deltaX, deltaY));
  await window.page.evaluate(nextFrame);
}

/**
 * Sends `input` with `modifiers` held. Each press passes the budget's check
 * on its own: a modifier the app was slow to take is not followed by the key
 * once the caller stopped waiting. Every modifier that went down comes up,
 * whatever happens.
 */
export async function withModifiers(budget: Budget, window: AppWindow, modifiers: readonly string[], input: () => Promise<void>): Promise<void> {
  const { keyboard } = window.page;
  const held: string[] = [];
  try {
    for (const modifier of modifiers) {
      await budget.send(() => {
        held.push(modifier);
        return keyboard.down(modifier);
      });
    }
    await budget.send(input);
  } finally {
    for (const modifier of held.toReversed()) await keyboard.up(modifier);
  }
}

/**
 * A key of the contract grammar as the keyboard presses it: the key and the
 * modifiers held with it. The keyboard has the named keys and the characters
 * of a US layout; any other character (`é`, `ß`) is
 * `UNSUPPORTED_CAPABILITY`, as the contract asks of a key a surface cannot
 * deliver.
 */
export function keyChord(key: string): { readonly key: string; readonly modifiers: readonly string[] } {
  const parsed = parseKey(key);
  if (parsed === undefined) throw unsupported(`${JSON.stringify(key)} is not a key of the contract grammar`);
  const name = parsed.key.kind === 'char' ? parsed.key.char : parsed.key.name;
  if (!hasKey(name)) {
    throw unsupported(`the keyboard cannot press ${JSON.stringify(name)}: only named keys and the characters of a US keyboard have a key; type other text with fill or pressSequentially`);
  }
  return { key: name, modifiers: parsed.modifiers };
}
