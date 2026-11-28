/**
 * The test line a session action answers with: built from the target as the
 * newest observation listed it, tried against the live screen (here a table
 * of what each locator matches), printed only when it reaches the target
 * alone, narrowed when it reaches twins too, and collected by `test_lines`.
 */

import type { ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import type { ExecutorActions, ExecutorNode, ExecutorObservation, ExecutorObserveOptions, ExecutorVerb, StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import { GRAMMAR_TOOL_NAMES } from '@e2e-dev/core/lib/agent/action-names';
import { imagePointToViewport } from '@e2e-dev/core/lib/agent/point-tap';
import { createGrammarTools, grammarTools } from '@e2e-dev/core/lib/agent/primitives';
import { ScreenPresenter } from '@e2e-dev/core/lib/agent/screen-update';
import type { LocatorExpression, NodeRef, SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import { TestError } from '@e2e-dev/core/lib/internal/errors';
import { describeExpression } from '@e2e-dev/core/lib/locator/expression';
import { locateQuery } from '../../src/session-tools/catalog.ts';
import { navigationLine, nodeQueries, SessionTestLines } from '../../src/session-tools/test-lines.ts';
import { invokeTool } from '../../src/session-tools/tools.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';

const extra = { signal: new AbortController().signal };

/** One node on the fake screen: what observe lists, and what the locator engine reads. */
interface Fake {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string;
  readonly testId?: string;
  readonly placeholder?: string;
  /** Top edge; every node is 100 by 20 at x 0, so no two boxes overlap. */
  readonly y: number;
  readonly children?: readonly Fake[];
}

const listed = (node: Fake): ExecutorNode => ({
  id: node.id,
  ...(node.role === undefined ? {} : { role: node.role }),
  ...(node.name === undefined ? {} : { name: node.name }),
  ...(node.text === undefined ? {} : { text: node.text }),
  ...(node.placeholder === undefined ? {} : { attributes: { placeholder: node.placeholder } }),
  ...(node.testId === undefined ? {} : { testId: node.testId }),
  rect: { x: 0, y: node.y, width: 100, height: 20 },
  ...(node.children === undefined ? {} : { children: node.children.map(listed) }),
});

const read = (node: Fake): SemanticNode => ({
  ref: { id: `located-${node.id}`, revision: 'l1' },
  ...(node.role === undefined ? {} : { role: node.role }),
  ...(node.name === undefined ? {} : { name: node.name }),
  ...(node.text === undefined ? {} : { text: node.text }),
  ...(node.placeholder === undefined ? {} : { attributes: { placeholder: node.placeholder } }),
  ...(node.testId === undefined ? {} : { testId: node.testId }),
  rect: { x: 0, y: node.y, width: 100, height: 20 },
});

interface Harness {
  readonly tools: ToolSet;
  /** How many locators the session tried on the live screen. */
  readonly resolves: () => number;
  readonly lines: SessionTestLines;
  readonly context: StepExecutorContext;
  /** Runs one tool through the session's `call` path and returns its text. */
  run(tool: string, args: Record<string, unknown>): Promise<string>;
  /** Replaces what observe lists from the next observation on, as an engine that numbers every screen afresh does. */
  show(screen: readonly Fake[]): void;
}

/**
 * A session over one screen: `screen` is what observe lists, `matches` what
 * each locator (by its rendered expression) finds on the live screen.
 */
async function harness(options: {
  readonly screen: readonly Fake[];
  readonly matches: Readonly<Record<string, readonly Fake[]>>;
  readonly actions?: Partial<ExecutorActions>;
  readonly tree?: boolean;
  readonly testRan?: string;
  readonly attached?: boolean;
  readonly hasAgent?: boolean;
  /** The verbs the target declares; the whole grammar by default. */
  readonly verbs?: readonly ExecutorVerb[];
}): Promise<Harness> {
  let root: Fake = { id: 'root', role: 'document', name: 'Page', y: 0, children: options.screen };
  const base = fakeExecutorContext({
    secrets: [{ name: 'admin.password', purpose: 'password' }, { name: 'apiKey', purpose: 'generic-secret' }],
    ...(options.verbs === undefined ? {} : { verbs: options.verbs }),
  }).context;
  const ok = async (): Promise<void> => undefined;
  const actions: ExecutorActions = {
    ...base.actions,
    tap: ok, doubleTap: ok, longPress: ok, secondaryTap: ok, hover: ok, type: ok, typeSecret: ok, press: ok, select: ok,
    check: ok, drag: ok, scrollTo: ok, scrollUntil: ok, upload: ok, scroll: ok, navigate: ok, back: ok, typeText: ok, pressKey: ok,
    dismissKeyboard: ok, resize: ok,
    ...options.actions,
  };
  const observe = async (asked: ExecutorObserveOptions = {}): Promise<ExecutorObservation> => ({
    revision: 'r1',
    text: '#root document "Page"',
    truncated: false,
    viewport: { width: 800, height: 600 },
    ...(asked.tree === true && options.tree !== false ? { tree: listed(root) } : {}),
    // A screenshot at twice the CSS pixels, as on a high-density display.
    ...(asked.pixels === true ? { pixels: { data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' as const, width: 1600, height: 1200, scale: 2, maskedRegionCount: 0 } } : {}),
  });
  const context: StepExecutorContext = { ...base, actions, observe };
  const nodes = new Map<string, Fake>();
  const index = (node: Fake): void => {
    nodes.set(`located-${node.id}`, node);
    for (const child of node.children ?? []) index(child);
  };
  index(root);
  // A match may be a node observe never listed: one the live screen has since grown.
  for (const node of Object.values(options.matches).flat()) index(node);
  let resolves = 0;
  const presenter = new ScreenPresenter();
  const lines = new SessionTestLines({
    query: locateQuery,
    resolve: async (expression: LocatorExpression): Promise<readonly NodeRef[]> => {
      resolves += 1;
      return (options.matches[describeExpression(expression)] ?? []).map((node) => ({ id: `located-${node.id}`, revision: 'l1' }));
    },
    read: async (ref) => read(nodes.get(ref.id)!),
    redact: (text) => text.replaceAll('sk-live-0000', '<secret:apiKey>'),
    pointOf: (x, y) => {
      const shot = presenter.latestScreenshot;
      return shot === undefined ? undefined : imagePointToViewport({ x, y }, shot.pixels, shot.viewport);
    },
    appBase: { href: 'http://127.0.0.1:4100/', origin: 'http://127.0.0.1:4100' },
    fills: { credentials: [{ name: 'admin', username: 'ada@example.test', password: 'admin.password' }], secrets: ['apiKey'] },
    testRan: options.testRan,
    attached: options.attached,
    hasAgent: options.hasAgent,
  });
  const watched = lines.watch(context);
  const tools: ToolSet = { ...lines.wrap(grammarTools(watched, { screen: presenter })), test_lines: lines.tool() };
  await watched.observe();
  return {
    tools,
    resolves: () => resolves,
    lines,
    context: watched,
    run: async (tool, args) => {
      const result = await invokeTool(tool, tools[tool]!, args, extra);
      return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    },
    show: (screen) => {
      root = { ...root, children: screen };
      for (const node of screen) index(node);
    },
  };
}

/** The line a result carries after its lead, or why it has none. */
const noteOf = (text: string): string => text.split('\n')[1] ?? '';

describe('nodeQueries', () => {
  it('orders role and name, label, placeholder, then text, and skips a role getByRole does not take', () => {
    expect(nodeQueries(listed({ id: 'n1', role: 'textbox', name: 'Email', placeholder: 'you@example.test', y: 0 }))).toEqual([
      { role: 'textbox', name: 'Email' },
      { label: 'Email' },
      { placeholder: 'you@example.test' },
      { text: 'Email' },
    ]);
    expect(nodeQueries(listed({ id: 'n2', role: 'generic', name: 'Card', text: 'Card  body ', y: 0 }))).toEqual([
      { label: 'Card' },
      { text: 'Card body' },
      { text: 'Card' },
    ]);
    expect(nodeQueries(listed({ id: 'n3', role: 'button', y: 0 }))).toEqual([]);
  });
});

describe('navigationLine', () => {
  const base = { href: 'http://127.0.0.1:4100/', origin: 'http://127.0.0.1:4100' };

  it("writes a URL on the app's origin as its path, so the line holds on the next run's port", () => {
    expect(navigationLine('/forms', base)).toBe('await app.open("/forms");');
    expect(navigationLine('http://127.0.0.1:4100/forms?tab=2#top', base)).toBe('await app.open("/forms?tab=2#top");');
    expect(navigationLine('http://127.0.0.1:4100/', base)).toBe('await app.open();');
    expect(navigationLine('https://example.com/login', base)).toBe('await app.open("https://example.com/login");');
    expect(navigationLine('/forms', undefined)).toBe('await app.open("/forms");');
  });
});

describe('SessionTestLines', () => {
  it('answers every grammar action that acts, the point tools among them, so a new verb needs a line or a reason', async () => {
    const context = { ...fakeExecutorContext().context, observe: async () => ({ revision: 'r', text: '', truncated: false, viewport: { width: 1, height: 1 } }) };
    const tools = createGrammarTools(context);
    expect(new Set(Object.keys(tools))).toEqual(GRAMMAR_TOOL_NAMES);
    const wrapped = new SessionTestLines({ query: locateQuery, resolve: async () => [], read: async () => ({ ref: { id: 'x', revision: 'x' } }), redact: (text) => text }).wrap(tools);
    expect(Object.keys(tools).filter((name) => wrapped[name] === tools[name]).toSorted()).toEqual(['observe', 'screenshot']);
  });

  const save: Fake = { id: 'n2', role: 'button', name: 'Save', y: 40 };

  it('answers an action with its line after the lead, and test_lines collects it', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] } });
    const text = await session.run('tap', { target: 'n2' });
    expect(text).toMatch(/^Tapped #n2\.\nTest line: await screen\.getByRole\("button", "Save"\)\.tap\(\);\n\n/);
    const draft = await session.run('test_lines', {});
    expect(draft).toContain('\nawait screen.getByRole("button", "Save").tap();\n');
    expect(draft).toContain('(1 lines)');
  });

  it('falls back to the label, the placeholder, and the text in that order', async () => {
    const email: Fake = { id: 'n3', role: 'textbox', name: 'Email', placeholder: 'you@example.test', y: 40 };
    const labelled = await harness({ screen: [email], matches: { 'getByLabel("Email")': [email] } });
    expect(noteOf(await labelled.run('type', { target: 'n3', value: 'Grace' }))).toBe('Test line: await screen.getByLabel("Email").fill("Grace");');
    const placeheld = await harness({ screen: [email], matches: { 'getByPlaceholder("you@example.test")': [email] } });
    expect(noteOf(await placeheld.run('type', { target: 'n3', value: 'Grace' }))).toBe('Test line: await screen.getByPlaceholder("you@example.test").fill("Grace");');
  });

  it('reads the test id off the live node for a control with nothing else to name it', async () => {
    const star: Fake = { id: 'n4', role: 'button', testId: 'star', y: 80 };
    const session = await harness({ screen: [save, star], matches: { 'getByRole("button")': [save, star], 'getByTestId("star")': [star] } });
    expect(noteOf(await session.run('tap', { target: 'n4' }))).toBe('Test line: await screen.getByTestId("star").tap();');
  });

  it('finds a control nothing names by its role: alone, under its row, or by position', async () => {
    const quantity: Fake = { id: 'n40', role: 'spinbutton', y: 80 };
    const only = await harness({ screen: [quantity, save], matches: { 'getByRole("spinbutton")': [quantity] } });
    expect(noteOf(await only.run('type', { target: 'n40', value: '10' }))).toBe(
      'Test line: await screen.getByRole("spinbutton").fill("10"); // the only spinbutton on the screen, found by its role alone; a name or test id holds up better',
    );

    const other: Fake = { id: 'n41', role: 'spinbutton', y: 120 };
    const rows: Fake[] = [
      { id: 'n42', role: 'row', y: 80, children: [{ id: 'n43', text: 'Boxes', y: 80 }, quantity] },
      { id: 'n44', role: 'row', y: 120, children: [{ id: 'n45', text: 'Crates', y: 120 }, other] },
    ];
    const scoped = await harness({
      screen: rows,
      matches: { 'getByRole("spinbutton")': [quantity, other], 'getByRole("row").filter({ hasText: "Crates" }) >> getByRole("spinbutton")': [other] },
    });
    expect(noteOf(await scoped.run('type', { target: 'n41', value: '3' }))).toBe(
      'Test line: await screen.getByRole("row").filter({ hasText: "Crates" }).getByRole("spinbutton").fill("3");',
    );

    const placed = await harness({ screen: [quantity, other], matches: { 'getByRole("spinbutton")': [quantity, other] } });
    expect(noteOf(await placed.run('type', { target: 'n41', value: '3' }))).toBe(
      'Test line: await screen.getByRole("spinbutton").nth(1).fill("3"); // 2 of 2 matches, by position; a unique name or test id holds up better',
    );
    // A node with no role getByRole takes still has nothing to find it by.
    const bare = await harness({ screen: [{ id: 'n46', y: 200 }], matches: {} });
    expect(noteOf(await bare.run('tap', { target: 'n46' }))).toBe('No test line: the node has no name, text, placeholder, or test id to find it by.');
  });

  it('never prints a locator whose one match is another node', async () => {
    const caption: Fake = { id: 'n9', text: 'Save', y: 300 };
    const session = await harness({ screen: [save, caption], matches: { 'getByText("Save")': [caption] } });
    const text = await session.run('tap', { target: 'n2' });
    expect(noteOf(text)).toBe('No test line: no locator from its role and name, label, placeholder, text, or test id finds it on the live screen; try locate.');
    expect(await session.run('test_lines', {})).toContain('// tap: no test line: no locator from its role and name');
  });

  it('keeps the line of a control that moved since the observation, by what it reads', async () => {
    const moved: Fake = { ...save, y: 400 };
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [moved] } });
    expect(noteOf(await session.run('tap', { target: 'n2' }))).toBe('Test line: await screen.getByRole("button", "Save").tap();');
  });

  it('narrows twins to the nodes that render before anything else', async () => {
    const hidden: Fake = { id: 'n5', text: 'Sale', y: 500 };
    const sale: Fake = { id: 'n6', text: 'Sale', y: 120 };
    const session = await harness({
      screen: [hidden, sale],
      matches: { 'getByText("Sale")': [hidden, sale], 'getByText("Sale", visible: true)': [sale] },
    });
    expect(noteOf(await session.run('tap', { target: 'n6' }))).toBe('Test line: await screen.getByText("Sale", { visible: true }).tap();');
  });

  it('scopes a control repeated per row under the row it sits in', async () => {
    const reserveA: Fake = { id: 'n12', role: 'button', name: 'Reserve', y: 160 };
    const reserveB: Fake = { id: 'n22', role: 'button', name: 'Reserve', y: 200 };
    const rows: Fake[] = [
      { id: 'n10', role: 'listitem', name: 'Offer A Reserve', y: 150, children: [{ id: 'n11', text: 'Offer A', y: 150 }, reserveA] },
      { id: 'n20', role: 'listitem', name: 'Offer B Reserve', y: 190, children: [{ id: 'n21', text: 'Offer B', y: 190 }, reserveB] },
    ];
    const session = await harness({
      screen: [{ id: 'n9', role: 'list', y: 140, children: rows }],
      matches: {
        'getByRole("button", name: "Reserve")': [reserveA, reserveB],
        'getByText("Reserve")': [reserveA, reserveB],
        'getByRole("button", name: "Reserve", visible: true)': [reserveA, reserveB],
        'getByRole("listitem").filter({ hasText: "Offer B" }) >> getByRole("button", name: "Reserve")': [reserveB],
      },
    });
    expect(noteOf(await session.run('tap', { target: 'n22' }))).toBe(
      'Test line: await screen.getByRole("listitem").filter({ hasText: "Offer B" }).getByRole("button", "Reserve").tap();',
    );
  });

  it('pins twins nothing else tells apart by position, and says so in a comment', async () => {
    const first: Fake = { id: 'n30', role: 'button', name: 'Add', y: 100 };
    const second: Fake = { id: 'n31', role: 'button', name: 'Add', y: 140 };
    const session = await harness({ screen: [first, second], matches: { 'getByRole("button", name: "Add")': [first, second] } });
    expect(noteOf(await session.run('tap', { target: 'n31' }))).toBe(
      'Test line: await screen.getByRole("button", "Add").nth(1).tap(); // 2 of 2 matches, by position; a unique name or test id holds up better',
    );
    expect(noteOf(await session.run('tap', { target: 'n30' }))).toContain('getByRole("button", "Add").first().tap();');
  });

  it('pins a twin by its turn, not its old box, after the page shifted', async () => {
    // A banner pushed every row down 40px: the second row's button now sits where the first one was.
    const observed = [100, 140, 180].map((y, index): Fake => ({ id: `n4${String(index)}`, role: 'button', name: 'Add', y }));
    const live = observed.map((node) => ({ ...node, y: node.y + 40 }));
    const session = await harness({ screen: observed, matches: { 'getByRole("button", name: "Add")': live } });
    expect(noteOf(await session.run('tap', { target: 'n41' }))).toMatch(/^Test line: await screen\.getByRole\("button", "Add"\)\.nth\(1\)\.tap\(\);/);
  });

  it('pins a twin the engine lists out of the observation order by the box it never left', async () => {
    // A shadow root's button is listed in place by observe, after the light DOM by the locator engine.
    const shadow: Fake = { id: 'n45', role: 'button', name: 'Keep', y: 100 };
    const light: Fake = { id: 'n46', role: 'button', name: 'Keep', y: 140 };
    const session = await harness({ screen: [shadow, light], matches: { 'getByRole("button", name: "Keep")': [light, shadow] } });
    expect(noteOf(await session.run('tap', { target: 'n45' }))).toMatch(/^Test line: await screen\.getByRole\("button", "Keep"\)\.nth\(1\)\.tap\(\);/);
  });

  it('pins no twin that both moved and changed places, nor reads a test id off one', async () => {
    const first: Fake = { id: 'n47', role: 'button', name: 'Keep', y: 100 };
    const second: Fake = { id: 'n48', role: 'button', name: 'Keep', testId: 'second', y: 140 };
    const session = await harness({
      screen: [first, second],
      matches: { 'getByRole("button", name: "Keep")': [{ ...second, y: 100 }, { ...first, y: 300 }], 'getByTestId("second")': [{ ...second, y: 100 }] },
    });
    expect(noteOf(await session.run('tap', { target: 'n47' }))).toBe(
      'No test line: it shares screen.getByRole("button", "Keep") with 1 other nodes, and nothing on the screen tells it apart for certain.',
    );
  });

  it('pins no twin when the live screen holds another number of them than the observation did', async () => {
    const observed = [100, 140].map((y, index): Fake => ({ id: `n5${String(index)}`, role: 'button', name: 'Add', y }));
    const appeared: Fake = { id: 'n59', role: 'button', name: 'Add', y: 60 };
    const session = await harness({ screen: observed, matches: { 'getByRole("button", name: "Add")': [appeared, ...observed] } });
    expect(noteOf(await session.run('tap', { target: 'n51' }))).toBe(
      'No test line: it shares screen.getByRole("button", "Add") with 2 other nodes, and nothing on the screen tells it apart for certain.',
    );
  });

  it('tries a bounded number of locators, each a snapshot on a device, then falls back to the position', async () => {
    const cards = [100, 140, 180].map((y, index): Fake => ({ id: `n7${String(index)}`, role: 'button', name: 'Open', text: 'Open card', placeholder: 'Card', y }));
    const article: Fake = { id: 'n82', role: 'article', name: 'Board', y: 90, children: cards };
    const group: Fake = { id: 'n81', role: 'group', name: 'Lane', y: 90, children: [article] };
    const region: Fake = { id: 'n80', role: 'region', name: 'Work', y: 90, children: [group] };
    const session = await harness({ screen: [region], matches: { 'getByRole("button", name: "Open")': cards } });
    expect(noteOf(await session.run('tap', { target: 'n71' }))).toMatch(/^Test line: await screen\.getByRole\("button", "Open"\)\.nth\(1\)\.tap\(\); \/\/ 2 of 3 matches/);
    expect(session.resolves()).toBe(10);
  });

  it('writes credentials and secrets by name, never by value', async () => {
    const user: Fake = { id: 'n40', role: 'textbox', name: 'Username', y: 40 };
    const password: Fake = { id: 'n41', role: 'textbox', name: 'Password', y: 80 };
    const key: Fake = { id: 'n42', role: 'textbox', name: 'API key', y: 120 };
    const session = await harness({
      screen: [user, password, key],
      matches: {
        'getByRole("textbox", name: "Username")': [user],
        'getByRole("textbox", name: "Password")': [password],
        'getByRole("textbox", name: "API key")': [key],
      },
    });
    expect(noteOf(await session.run('type', { target: 'n40', value: 'ada@example.test' }))).toBe(
      'Test line: await screen.getByRole("textbox", "Username").fill(credentials.user("admin").username);',
    );
    expect(noteOf(await session.run('type_secret', { target: 'n41', name: 'admin.password' }))).toBe(
      'Test line: await screen.getByRole("textbox", "Password").fill(credentials.user("admin").password);',
    );
    expect(noteOf(await session.run('type_secret', { target: 'n42', name: 'apiKey' }))).toBe(
      'Test line: await screen.getByRole("textbox", "API key").fill(secrets.get("apiKey"));',
    );
    expect(await session.run('test_lines', {})).toContain("Import credentials and secrets from 'e2e'.");
  });

  it('maps every verb onto the locator method that repeats it', async () => {
    const field: Fake = { id: 'n50', role: 'textbox', name: 'Notes', y: 40 };
    const plan: Fake = { id: 'n51', role: 'combobox', name: 'Plan', y: 80 };
    const terms: Fake = { id: 'n52', role: 'checkbox', name: 'Terms', y: 120 };
    const card: Fake = { id: 'n53', role: 'listitem', name: 'Card', text: 'Card', y: 160 };
    const done: Fake = { id: 'n54', role: 'region', name: 'Done', y: 200 };
    const file: Fake = { id: 'n55', role: 'button', name: 'Attach', y: 240 };
    const session = await harness({
      screen: [field, plan, terms, card, done, file, save],
      matches: {
        'getByRole("textbox", name: "Notes")': [field],
        'getByRole("combobox", name: "Plan")': [plan],
        'getByRole("checkbox", name: "Terms")': [terms],
        'getByText("Card")': [card],
        'getByRole("region", name: "Done")': [done],
        'getByRole("button", name: "Attach")': [file],
        'getByRole("button", name: "Save")': [save],
      },
    });
    const lines: Record<string, [string, Record<string, unknown>]> = {
      'await screen.getByRole("button", "Save").doubleTap();': ['double_tap', { target: 'n2' }],
      'await screen.getByRole("button", "Save").longPress();': ['long_press', { target: 'n2' }],
      'await screen.getByRole("button", "Save").secondaryTap();': ['right_click', { target: 'n2' }],
      'await screen.getByRole("button", "Save").hover();': ['hover', { target: 'n2' }],
      'await screen.getByRole("textbox", "Notes").press("Enter");': ['press', { target: 'n50', key: 'Enter' }],
      'await screen.getByRole("combobox", "Plan").selectOption("Pro");': ['select', { target: 'n51', value: 'Pro' }],
      'await screen.getByRole("checkbox", "Terms").check();': ['check', { target: 'n52' }],
      'await screen.getByRole("checkbox", "Terms").uncheck();': ['check', { target: 'n52', checked: false }],
      'await screen.getByText("Card").dragTo(screen.getByRole("region", "Done"));': ['drag', { target: 'n53', to: 'n54' }],
      'await screen.getByRole("button", "Attach").setInputFiles("fixtures/a.png");': ['upload', { target: 'n55', files: ['fixtures/a.png'] }],
      'await screen.getByRole("button", "Attach").setInputFiles(["a.png","b.png"]);': ['upload', { target: 'n55', files: ['a.png', 'b.png'] }],
      'await screen.getByRole("button", "Save").scrollIntoView();': ['scroll_to', { target: 'n2' }],
      'await app.open("/settings");': ['navigate', { url: 'http://127.0.0.1:4100/settings' }],
      'await app.back();': ['back', {}],
    };
    for (const [line, [tool, args]] of Object.entries(lines)) {
      expect(noteOf(await session.run(tool, args)), tool).toBe(`Test line: ${line}`);
    }
  });

  it('says why an action has no line: no node, a repeated key, a scroll, a keyboard fallback, a sample file', async () => {
    const field: Fake = { id: 'n60', role: 'textbox', name: 'Notes', y: 40 };
    const canvas: Fake = { id: 'n61', role: 'image', name: 'Pad', y: 80 };
    const file: Fake = { id: 'n62', role: 'button', name: 'Attach', y: 120 };
    const session = await harness({
      screen: [field, canvas, file],
      matches: { 'getByRole("textbox", name: "Notes")': [field], 'getByRole("image", name: "Pad")': [canvas], 'getByRole("button", name: "Attach")': [file] },
      actions: {
        type: async (target) => {
          if (target.id === 'n61') throw new TestError('ACTION_FAILED', 'fill failed', { cause: Object.assign(new Error('the node is not an input'), { code: 'NOT_ACTIONABLE' }) });
        },
      },
    });
    expect(noteOf(await session.run('type', { value: 'x' }))).toBe('No test line: the value went to the focused field; type into a listed node by id for a line.');
    expect(noteOf(await session.run('press', { target: 'n60', key: 'ArrowDown', times: 3 }))).toMatch(/^No test line: a key pressed several times/);
    expect(noteOf(await session.run('press', { key: 'Enter' }))).toMatch(/^No test line: the key went to whatever had focus/);
    expect(noteOf(await session.run('scroll', { direction: 'down' }))).toMatch(/^No test line: a test action brings its node into view itself/);
    expect(noteOf(await session.run('scroll_to', { text: 'Row 40' }))).toMatch(/^No test line: scrolling to a text has none/);
    expect(noteOf(await session.run('type_secret', { target: 'n60', name: 'unknown' }))).toMatch(/^No test line: the secret is neither/);
    expect(noteOf(await session.run('upload', { target: 'n62', files: ['sample:photo.png'] }))).toBe(
      'No test line: a sample file exists only for the agent; save a file in the project and upload its path for a line.',
    );
    const fallback = await session.run('type', { target: 'n61', value: 'x' });
    expect(fallback.split('\n')[0]).toMatch(/is not an input; tapped it to focus it and typed through the keyboard/);
    expect(noteOf(fallback)).toMatch(/^No test line: the node is not an input and took the value through the keyboard/);
    expect(noteOf(await session.run('tap', { target: 'n404' }))).toBe('No test line: #n404 is not on the newest screen.');
  });

  it('prints and records nothing for an action that failed', async () => {
    const session = await harness({
      screen: [save],
      matches: { 'getByRole("button", name: "Save")': [save] },
      actions: { tap: () => Promise.reject(new TestError('ACTION_FAILED', 'covered by an overlay')) },
    });
    const text = await session.run('tap', { target: 'n2' });
    expect(text).toMatch(/^tap #n2 failed: ACTION_FAILED: covered by an overlay/);
    expect(text).not.toContain('Test line');
    expect(await session.run('test_lines', {})).toMatch(/^No test lines yet\./);
  });

  it('forgets every id after a screen read without a tree, as the step does', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] }, tree: false });
    expect(noteOf(await session.run('tap', { target: 'n2' }))).toBe('No test line: #n2 is not on the newest screen.');
  });

  it('finds an id an earlier screen listed on the newest one, as the step does for the action', async () => {
    const renumbered: Fake = { id: 'n9', role: 'button', name: 'Save', y: 40 };
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [renumbered] } });
    session.show([renumbered]);
    await session.context.observe();
    expect(noteOf(await session.run('tap', { target: 'n2' }))).toBe('Test line: await screen.getByRole("button", "Save").tap();');
    // Two nodes that read like it: the step finds neither, and neither does the line.
    session.show([renumbered, { id: 'n10', role: 'button', name: 'Save', y: 80 }]);
    await session.context.observe();
    expect(noteOf(await session.run('tap', { target: 'n2' }))).toBe('No test line: #n2 is not on the newest screen.');
  });

  it('re-finds an earlier id by the test id the action goes by, so the line names the node the action touched', async () => {
    // Two Delete buttons told apart by test id, renumbered and swapped on the next screen.
    const first: Fake = { id: 'n3', role: 'button', name: 'Delete', testId: 'delete-1', y: 40 };
    const second: Fake = { id: 'n4', role: 'button', name: 'Delete', testId: 'delete-2', y: 80 };
    const moved1: Fake = { id: 'n14', role: 'button', name: 'Delete', testId: 'delete-1', y: 80 };
    const moved2: Fake = { id: 'n13', role: 'button', name: 'Delete', testId: 'delete-2', y: 40 };
    const session = await harness({ screen: [first, second], matches: { 'getByRole("button", name: "Delete")': [moved2, moved1], 'getByTestId("delete-1")': [moved1] } });
    session.show([moved2, moved1]);
    await session.context.observe();
    expect(noteOf(await session.run('tap', { target: 'n3' }))).toBe('Test line: await screen.getByTestId("delete-1").tap();');

    // Two nameless rows told apart by test id, whose text swapped: the text does not decide.
    const rowA: Fake = { id: 'n5', role: 'row', text: 'Paid', testId: 'row-a', y: 120 };
    const rowB: Fake = { id: 'n6', role: 'row', text: 'Due', testId: 'row-b', y: 160 };
    const nowA: Fake = { ...rowA, id: 'n15', text: 'Due' };
    const nowB: Fake = { ...rowB, id: 'n16', text: 'Paid' };
    const rows = await harness({ screen: [rowA, rowB], matches: { 'getByRole("row")': [nowA, nowB], 'getByText("Due")': [nowA], 'getByTestId("row-a")': [nowA] } });
    rows.show([nowA, nowB]);
    await rows.context.observe();
    // The row the action touched shows "Due" now; the one showing "Paid" is the other row.
    expect(noteOf(await rows.run('tap', { target: 'n5' }))).toBe('Test line: await screen.getByText("Due").tap();');
  });

  describe('point tools', () => {
    const notes: Fake = { id: 'n20', role: 'textbox', name: 'Notes', y: 100 };
    const plan: Fake = { id: 'n21', role: 'combobox', name: 'Plan', y: 140 };
    /** What the step's hit test finds at each CSS point: Save over y 40 to 60, Notes over 100 to 120, Plan over 140 to 160. */
    const hitTest: ExecutorActions['hitTest'] = async (point) => {
      const control = [save, notes, plan].find((node) => point.y >= node.y && point.y <= node.y + 20);
      return { point, ...(control === undefined ? {} : { control: { id: control.id } }), summary: control === undefined ? 'nothing the screen lists is there' : `#${control.id}` };
    };
    const tapAt: ExecutorActions['tapAt'] = async (point) => ({ point, summary: `Tapped the point (${String(point.x)}, ${String(point.y)}).` });
    const hoverAt: ExecutorActions['hoverAt'] = async (point) => ({ point, summary: `Hovered over the point (${String(point.x)}, ${String(point.y)}).` });
    const dragAt: ExecutorActions['dragAt'] = async (from, to) => ({ from, to, summary: 'Dragged.' });
    const pointActions = { hitTest, tapAt, hoverAt, dragAt };
    const matches = { 'getByRole("button", name: "Save")': [save], 'getByRole("textbox", name: "Notes")': [notes], 'getByRole("combobox", name: "Plan")': [plan] };
    // Every verb but the bare-point ones: the point tools act on the listed control under the point by id.
    const byId = (Object.keys(fakeExecutorContext().context.actions) as ExecutorVerb[]).filter((verb) => verb !== 'tapAt' && verb !== 'hoverAt' && verb !== 'dragAt');

    it('prints nothing for a point tool before the first screenshot, which does not act', async () => {
      const session = await harness({ screen: [save], matches, actions: pointActions });
      expect(await session.run('tap_at', { x: 20, y: 100 })).toMatch(/^No screenshot has been taken/);
      expect(await session.run('test_lines', {})).toMatch(/^No test lines yet\./);
    });

    it('writes a bare tap as screen.tapAt in CSS pixels, where the engine takes the bare point', async () => {
      const session = await harness({ screen: [save], matches, actions: pointActions });
      await session.run('screenshot', {});
      expect(noteOf(await session.run('tap_at', { x: 20, y: 102 }))).toBe(
        'Test line: await screen.tapAt({ x: 10, y: 51 }); // a bare point holds only while the layout does; tap a listed node by id for a locator line',
      );
      expect(noteOf(await session.run('hover_at', { x: 20, y: 101 }))).toMatch(/^No test line: a hover at a bare point has no screen call/);
      expect(noteOf(await session.run('drag_at', { x: 20, y: 101, to_x: 20, to_y: 220 }))).toMatch(/^No test line: a drag between bare points has no screen call/);
    });

    it("writes the listed control's locator where the step acts on it by id", async () => {
      const session = await harness({ screen: [save, notes, plan], matches, actions: pointActions, verbs: byId });
      await session.run('screenshot', {});
      expect(noteOf(await session.run('tap_at', { x: 20, y: 100 }))).toBe('Test line: await screen.getByRole("button", "Save").tap();');
      expect(noteOf(await session.run('hover_at', { x: 20, y: 100 }))).toBe('Test line: await screen.getByRole("button", "Save").hover();');
      expect(noteOf(await session.run('type_at', { x: 20, y: 220, value: 'ada@example.test' }))).toBe(
        'Test line: await screen.getByRole("textbox", "Notes").fill(credentials.user("admin").username);',
      );
      expect(noteOf(await session.run('press_at', { x: 20, y: 220, key: 'Enter' }))).toBe('Test line: await screen.getByRole("textbox", "Notes").press("Enter");');
      expect(noteOf(await session.run('select_at', { x: 20, y: 300, value: 'Pro' }))).toBe('Test line: await screen.getByRole("combobox", "Plan").selectOption("Pro");');
      expect(noteOf(await session.run('drag_at', { x: 20, y: 100, to_x: 20, to_y: 300 }))).toBe(
        'Test line: await screen.getByRole("button", "Save").dragTo(screen.getByRole("combobox", "Plan"));',
      );
    });

    it('says why a point on nothing listed has no line, and the draft keeps the step as a comment', async () => {
      const session = await harness({ screen: [save], matches, actions: pointActions, verbs: byId });
      await session.run('screenshot', {});
      expect(noteOf(await session.run('press_at', { x: 20, y: 500, key: 'Enter' }))).toBe(
        'No test line: no listed control is at the point: it was tapped to focus what is there and the keys went through the keyboard, which no locator line repeats.',
      );
      const draft = await session.run('test_lines', {});
      expect(draft).toContain('\n// press_at: no test line: no listed control is at the point: it was tapped');
    });
  });

  it('records the opening of the app as app.open() and drafts the lines in order', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] }, hasAgent: true });
    session.lines.opened();
    await session.run('tap', { target: 'n2' });
    await session.run('scroll', { direction: 'down' });
    expect(session.lines.draft()).toBe(
      [
        "Draft test body from this session's actions, in order (2 lines):",
        '',
        'await app.open();',
        'await screen.getByRole("button", "Save").tap();',
        '// scroll: no test line: a test action brings its node into view itself, and a row deep in a windowed list takes screen.scrollUntilVisible(locator)',
        '',
        'Split these lines into tests, one behavior each: its arrange lines, the act under test, then its checks together at the end. Each test body is async ({ app, screen }) => { ... }. Every test needs a check of its outcome; add one where none is here. A check of a screen the flow later leaves belongs to its own test. Name a locator a test uses twice. Prefer agent.act for user flows, with agent among the test fixtures (keep screen lines for low-level mechanics under test or a sign-in setup). Give the agent the steps for one test goal, and split into calls when a later step needs a known screen state, risks maxSteps or maxModelCalls budgets, or needs a middle step boundary. Wait for the intermediate screen state before continuing. See topic writing-tests, Structure.',
      ].join('\n'),
    );
    expect(session.tools.test_lines?.description).toContain('Split the draft into tests, one behavior each');
    expect(session.tools.test_lines?.description).not.toContain('continue the existing test');
    expect(session.tools.test_lines?.description).not.toContain('pause point');
  });

  it('drafts the lines while attached to a held test for its pause point', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] }, attached: true });
    await session.run('tap', { target: 'n2' });
    expect(session.lines.draft()).toBe(
      [
        "Test lines from this session's actions while the test was held, in order (1 lines):",
        '',
        'await screen.getByRole("button", "Save").tap();',
        '',
        "Put them in the held test at the pause point. Keep the test's checks together at its end, with one that checks its outcome. See topic writing-tests, Structure.",
      ].join('\n'),
    );
    expect(session.tools.test_lines?.description).toContain('Use these lines at the pause point of the held test');
    expect(session.tools.test_lines?.description).not.toMatch(/split the draft into tests/i);
    expect(session.tools.test_lines?.description).not.toContain('continue the existing test');
  });

  it('omits agent.act advice from the draft when no model or executor is configured', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] }, hasAgent: false });
    session.lines.opened();
    await session.run('tap', { target: 'n2' });
    const draft = session.lines.draft();
    expect(draft).toContain('Split these lines into tests, one behavior each');
    expect(draft).not.toContain('agent.act');
  });

  it('prints no line for a resize, naming the size to set with the engine fixture', async () => {
    const session = await harness({ screen: [save], matches: {} });
    await session.run('resize_viewport', { width: 390, height: 844 });
    expect(session.lines.draft()).toContain("// resize_viewport: no test line: set 390x844 with the engine fixture's viewport call");
  });

  it('drafts the lines after a test the session ran as the ones that continue it', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] }, testRan: 'tests/profile.e2e.ts:4' });
    await session.run('tap', { target: 'n2' });
    expect(session.lines.draft()).toBe(
      [
        "Test lines from this session's actions after test tests/profile.e2e.ts:4 stopped, in order (1 lines):",
        '',
        'await screen.getByRole("button", "Save").tap();',
        '',
        "Put them in that test where it stopped, in place of the line that failed or after its last step. Keep the test's checks together at its end, with one that checks its outcome. See topic writing-tests, Structure.",
      ].join('\n'),
    );
    expect(session.tools.test_lines?.description).toContain('Use these lines to continue the existing test');
    expect(session.tools.test_lines?.description).not.toMatch(/split the draft into tests/i);
  });

  it('drafts the lines run_code passed among the action lines', async () => {
    const session = await harness({ screen: [save], matches: { 'getByRole("button", name: "Save")': [save] } });
    session.lines.opened();
    session.lines.ran(["await screen.getByLabel('Email').fill(credentials.user('admin').password);", "await expect(screen.getByRole('status')).toHaveText('Saved');"]);
    await session.run('tap', { target: 'n2' });
    const draft = session.lines.draft();
    expect(draft.split('\n').slice(0, 6)).toEqual([
      "Draft test body from this session's actions, in order (4 lines):",
      '',
      'await app.open();',
      "await screen.getByLabel('Email').fill(credentials.user('admin').password);",
      "await expect(screen.getByRole('status')).toHaveText('Saved');",
      'await screen.getByRole("button", "Save").tap();',
    ]);
    expect(draft).toContain("Import credentials from 'e2e'.");
  });

  it("asks the draft's test body for an engine fixture a line only passes along", () => {
    const drafted = (line: string): string => {
      const lines = new SessionTestLines({ query: locateQuery, resolve: async () => [], read: async () => ({ ref: { id: 'x', revision: 'x' } }), redact: (text) => text, engineFixtures: ['browser'] });
      lines.ran([line]);
      return /async \(\{ ([^}]*) \}\)/.exec(lines.draft())?.[1] ?? '';
    };
    expect(drafted('await expect(browser).toHaveURL(/done/);')).toBe('app, screen, browser');
    expect(drafted('await screen.getByRole("row").dragTo(browser.locator("#bin"));')).toBe('app, screen, browser');
    // The word in a string, or as another object's member, is not the fixture.
    expect(drafted("await screen.getByText('browser, then').tap();")).toBe('app, screen');
    expect(drafted('await app.browser.open();')).toBe('app, screen');
  });

  it("asks the draft's test body for services, whether a line starts from them or only passes them along", () => {
    const drafted = (line: string): string => {
      const lines = new SessionTestLines({ query: locateQuery, resolve: async () => [], read: async () => ({ ref: { id: 'x', revision: 'x' } }), redact: (text) => text, engineFixtures: ['browser'] });
      lines.ran([line]);
      return /async \(\{ ([^}]*) \}\)/.exec(lines.draft())?.[1] ?? '';
    };
    expect(drafted('await services["my-mail"].createInbox();')).toBe('app, screen, services');
    expect(drafted('await browser.setViewport(services.layout.size);')).toBe('app, screen, browser, services');
  });

  it('hands the caller the observation it asked for, tree or not, and keeps the context live', async () => {
    let resolutions = 0;
    const base = fakeExecutorContext().context;
    const context = Object.defineProperty(
      { ...base, observe: async (asked?: ExecutorObserveOptions) => ({ revision: 'r', text: '', truncated: false, viewport: { width: 1, height: 1 }, ...(asked?.tree === true ? { tree: { id: 'root' } } : {}) }) },
      'model',
      { get: () => { resolutions += 1; return undefined; } },
    ) as StepExecutorContext;
    const watched = new SessionTestLines({ query: locateQuery, resolve: async () => [], read: async () => ({ ref: { id: 'x', revision: 'x' } }), redact: (text) => text }).watch(context);
    expect(await watched.observe()).not.toHaveProperty('tree');
    expect(await watched.observe({ tree: true })).toHaveProperty('tree', { id: 'root' });
    expect(resolutions).toBe(0);
    void watched.model;
    expect(resolutions).toBe(1);
  });
});
