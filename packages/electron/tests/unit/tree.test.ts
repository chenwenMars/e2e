import { readFileSync } from 'node:fs';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import type { AXNode } from '../../src/fields.ts';
import { DomSnapshot, type SnapshotDocument } from '../../src/snapshot.ts';
import { projectTree, type ProjectionMode } from '../../src/tree.ts';

/**
 * One read of the testbed's sign-in window, captured from Electron 45 with
 * the username and password filled and the page scrolled by 59.5 CSS pixels
 * on a 2x display: the accessibility tree, the DOM snapshot, and the layout
 * metrics, as the surface reads them.
 */
const captured = JSON.parse(readFileSync(new URL('../fixtures/sign-in.json', import.meta.url), 'utf8')) as {
  ax: AXNode[];
  snapshot: { documents: SnapshotDocument[]; strings: string[] };
  metrics: { layoutViewport: { clientWidth: number }; cssLayoutViewport: { clientWidth: number }; cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } };
};

function project(mode: ProjectionMode, extra: { maxNodes?: number; keep?: ReadonlySet<number> } = {}) {
  const { metrics } = captured;
  return projectTree(
    captured.ax,
    new DomSnapshot(captured.snapshot.documents[0]!, captured.snapshot.strings),
    {
      scale: metrics.layoutViewport.clientWidth / metrics.cssLayoutViewport.clientWidth,
      scrollX: metrics.cssVisualViewport.pageX,
      scrollY: metrics.cssVisualViewport.pageY,
      width: metrics.cssVisualViewport.clientWidth,
      height: metrics.cssVisualViewport.clientHeight,
    },
    { mode, testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window', title: 'Sign In', ...extra },
  );
}

function all(root: SemanticNode): SemanticNode[] {
  return [root, ...(root.children ?? []).flatMap(all)];
}

function find(root: SemanticNode, predicate: (node: SemanticNode) => boolean): SemanticNode {
  const node = all(root).find(predicate);
  if (node === undefined) throw new Error('no such node');
  return node;
}

describe('projectTree', () => {
  it('names the root after the document and sizes it to the viewport', () => {
    const { root } = project('tree');
    expect(root.ref).toEqual({ id: 'window', revision: '' });
    expect(root.role).toBe('document');
    expect(root.name).toBe('Sign In');
    expect(root.rect).toEqual({ x: 0, y: 0, width: 640, height: 688 });
  });

  it('reports a password field as secure, with no value and no text', () => {
    const { root } = project('node');
    const password = find(root, (node) => node.testId === 'password');
    expect(password.states?.secure).toBe(true);
    expect(password.value).toBeUndefined();
    expect(password.text).toBeUndefined();
    expect(password.children).toBeUndefined();
    expect(password.inputPurpose).toBe('password');
    expect(JSON.stringify(root)).not.toContain('hunter2');
    expect(JSON.stringify(root)).not.toContain('•');
  });

  it('reads a text field value from the DOM and a select from its chosen option', () => {
    const { root } = project('tree');
    const username = find(root, (node) => node.testId === 'username');
    expect(username).toMatchObject({ role: 'textbox', name: 'Username', value: 'ada', inputPurpose: 'username', attributes: { placeholder: 'ada', autocomplete: 'username' } });
    expect(find(root, (node) => node.testId === 'plan')).toMatchObject({ role: 'combobox', name: 'Plan', value: 'Pro' });
  });

  it('reports empty for a locator only: a field by its value, anything else by its text', () => {
    const node = project('node').root;
    expect(find(node, (candidate) => candidate.testId === 'username').states?.empty).toBe(false);
    expect(find(node, (candidate) => candidate.testId === 'status').states?.empty).toBe(false);
    expect(find(node, (candidate) => candidate.testId === 'password').states?.empty).toBeUndefined();
    expect(find(project('tree').root, (candidate) => candidate.testId === 'username').states?.empty).toBeUndefined();
  });

  it('reads a checkbox value for a locator only, as the value attribute or on', () => {
    expect(find(project('node').root, (node) => node.role === 'checkbox').value).toBe('on');
    expect(find(project('tree').root, (node) => node.role === 'checkbox').value).toBeUndefined();
  });

  it('maps boxes from device pixels in the document to CSS pixels in the viewport', () => {
    const { root } = project('tree');
    const add = find(root, (node) => node.role === 'button' && node.name === 'Add one');
    // Playwright measured the same button at x 24, y 339.1171875, 65.6640625 by 21.5 in this scroll position.
    expect(add.rect).toEqual({ x: 24, y: 339.1171875, width: 65.6640625, height: 21.5 });
  });

  it('folds a text run that is the only content into its node, and keeps runs beside other children as nodes', () => {
    const { root } = project('tree');
    const signIn = find(root, (node) => node.role === 'button' && node.name === 'Sign in');
    expect(signIn.text).toBe('Sign in');
    expect(signIn.children).toBeUndefined();
    const form = find(root, (node) => node.role === 'form');
    expect(form.text).toBeUndefined();
    expect(form.children?.filter((child) => child.role === undefined).map((child) => child.text)).toEqual(['Username', 'Password', 'Remember me', 'Plan']);
  });

  it('gives a locator the text of a node with its descendants', () => {
    const { root } = project('node');
    const counter = find(root, (node) => node.role === 'region' && node.name === 'Counter');
    expect(counter.text).toBe('Counter Add one 0');
  });

  it('shows a link as the web engine does: origin and path, the rest elided', () => {
    const hrefs = ['https://example.com/p?token=abc#f', 'data:text/csv;base64,U0VDUkVU', 'javascript:run("secret")', 'mailto:ada@example.com', 'settings.html?tab=2'];
    const strings = ['#document', 'BODY', 'A', 'href', ...hrefs];
    const document: SnapshotDocument = {
      nodes: { backendNodeId: [1, 2, ...hrefs.map((_, at) => 10 + at)], nodeName: [0, 1, ...hrefs.map(() => 2)], parentIndex: [-1, 0, ...hrefs.map(() => 1)], attributes: [[], [], ...hrefs.map((_, at) => [3, 4 + at])] },
      layout: { nodeIndex: hrefs.map((_, at) => 2 + at), bounds: hrefs.map(() => [0, 0, 10, 10]) },
    };
    const ax: AXNode[] = [
      { nodeId: 'root', ignored: false, role: { value: 'RootWebArea' }, childIds: hrefs.map((_, at) => String(at)), backendDOMNodeId: 1 },
      ...hrefs.map((_, at) => ({ nodeId: String(at), ignored: false, role: { value: 'link' }, name: { value: `Link ${at}` }, parentId: 'root', backendDOMNodeId: 10 + at })),
    ];
    const { root } = projectTree(ax, new DomSnapshot(document, strings), { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 }, { mode: 'tree', testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window', baseUrl: 'https://app.example/index.html' });
    expect(root.children?.map((link) => link.attributes?.['href'])).toEqual(['https://example.com/p?…#…', 'data:…', 'javascript:…', 'mailto:ada@example.com', 'https://app.example/settings.html?…']);
  });

  it('keeps attribute values whole for the harness to redact, however long', () => {
    const long = `${'x'.repeat(500)}secret-value-crossing-the-limit`;
    const strings = ['#document', 'BODY', 'INPUT', 'placeholder', long];
    const document: SnapshotDocument = {
      nodes: { backendNodeId: [1, 2, 3], nodeName: [0, 1, 2], parentIndex: [-1, 0, 1], attributes: [[], [], [3, 4]] },
      layout: { nodeIndex: [2], bounds: [[0, 0, 100, 20]] },
    };
    const ax: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['3'], backendDOMNodeId: 1 },
      { nodeId: '3', ignored: false, role: { value: 'textbox' }, name: { value: 'Field' }, parentId: '1', backendDOMNodeId: 3 },
    ];
    const { root } = projectTree(ax, new DomSnapshot(document, strings), { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 }, { mode: 'tree', testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window' });
    expect(root.children?.[0]?.attributes?.['placeholder']).toBe(long);
  });

  it('keeps every attribute for a locator and only the model-facing ones in an observation', () => {
    const tree = find(project('tree').root, (node) => node.testId === 'username');
    const node = find(project('node').root, (candidate) => candidate.testId === 'username');
    expect(Object.keys(tree.attributes ?? {}).toSorted()).toEqual(['autocomplete', 'placeholder']);
    expect(node.attributes).toMatchObject({ name: 'username', 'data-testid': 'username', placeholder: 'ada' });
  });

  it('reads headings with their level and checkbox states', () => {
    const { root } = project('tree');
    expect(find(root, (node) => node.role === 'heading' && node.name === 'Counter').level).toBe(2);
    expect(find(root, (node) => node.role === 'checkbox').states).toMatchObject({ checked: false });
  });

  it('marks nodes with no box hidden, such as the options of a closed select, which read their labels as text', () => {
    const { root } = project('node');
    const option = find(root, (node) => node.role === 'option' && node.name === 'Team');
    expect(option.states?.hidden).toBe(true);
    expect(option.text).toBe('Team');
  });

  it('answers the contract locator semantics through resolveExpression', () => {
    const { root } = project('node');
    const byRole = resolveExpression({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Sign in', exact: true } } }, [root]);
    expect(byRole.map((node) => node.testId)).toEqual(['sign-in']);
    const byText = resolveExpression({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Not signed in', exact: true } } }, [root]);
    expect(byText.map((node) => node.testId)).toEqual(['status']);
    const byPlaceholder = resolveExpression({ kind: 'query', query: { kind: 'placeholder', value: { kind: 'string', value: 'ada', exact: true } } }, [root]);
    expect(byPlaceholder.map((node) => node.testId)).toEqual(['username']);
  });

  it('keeps a container a locator selected, which the tree would leave out', () => {
    const label = captured.ax.find((node) => node.role?.value === 'LabelText')!;
    const id = `1.${label.backendDOMNodeId}`;
    expect(all(project('tree').root).some((node) => node.ref.id === id)).toBe(false);
    const kept = find(project('node', { keep: new Set([label.backendDOMNodeId!]) }).root, (node) => node.ref.id === id);
    expect(kept).toMatchObject({ role: 'generic', text: 'Username' });
    expect(kept.children?.map((child) => child.testId ?? child.text)).toEqual(['Username', 'username']);
  });

  it('keeps, for a locator, a container with text of its own beside other content: the whole sentence is found on it', () => {
    const label = captured.ax.find((node) => node.role?.value === 'LabelText')!;
    const kept = find(project('node').root, (node) => node.ref.id === `1.${label.backendDOMNodeId}`);
    expect(kept).toMatchObject({ role: 'generic', text: 'Username' });
  });

  it('reads the text of a label that names a checkbox, which Chromium leaves out of its tree', () => {
    expect(captured.ax.some((node) => node.role?.value === 'StaticText' && node.name?.value === 'Remember me')).toBe(false);
    const run = find(project('tree').root, (node) => node.text === 'Remember me');
    expect(run.states?.hidden).toBeUndefined();
    expect(run.rect?.width).toBeGreaterThan(0);
  });

  it('reads an element the tree leaves out by the rules every element reads by', () => {
    const strings = ['#document', 'BODY', 'SELECT', 'OPTION', 'INPUT', 'data-testid', 'pick', 'value', 'a', 'b', 'user', 'autocomplete', 'username'];
    const document: SnapshotDocument = {
      nodes: {
        backendNodeId: [1, 2, 3, 4, 5, 6],
        nodeName: [0, 1, 2, 3, 3, 4],
        parentIndex: [-1, 0, 1, 2, 2, 1],
        attributes: [[], [], [5, 6], [7, 8], [7, 9], [5, 10, 11, 12]],
        optionSelected: { index: [4] },
        inputValue: { index: [5], value: [8] },
      },
      layout: { nodeIndex: [], bounds: [] },
    };
    const ax: AXNode[] = [{ nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, backendDOMNodeId: 1 }];
    const { root } = projectTree(ax, new DomSnapshot(document, strings), { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 }, { mode: 'node', testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window' });
    expect(find(root, (node) => node.testId === 'pick')).toMatchObject({ role: 'generic', value: 'b', states: { hidden: true, readonly: false } });
    expect(find(root, (node) => node.testId === 'user')).toMatchObject({ value: 'a', inputPurpose: 'username', states: { hidden: true, empty: false } });
  });

  it('shows an element with no box of its own while something inside it is rendered, and hides one whose box has no size', () => {
    const strings = ['#document', 'BODY', 'UL', 'LI', 'DIV', 'P'];
    const document: SnapshotDocument = {
      nodes: { backendNodeId: [1, 2, 3, 4, 5, 6, 7], nodeName: [0, 1, 2, 3, 4, 5, 2], parentIndex: [-1, 0, 1, 2, 1, 4, 1] },
      layout: { nodeIndex: [3, 4, 5], bounds: [[0, 0, 100, 20], [0, 20, 100, 0], [0, 20, 100, 20]] },
    };
    const list = (id: number, name: string): AXNode => ({ nodeId: String(id), ignored: false, role: { value: 'list' }, name: { value: name }, parentId: '1', backendDOMNodeId: id });
    const ax: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['3', '5', '7'], backendDOMNodeId: 1 },
      list(3, 'Contents'),
      { nodeId: '5', ignored: false, role: { value: 'group' }, name: { value: 'Collapsed' }, parentId: '1', backendDOMNodeId: 5 },
      list(7, 'Empty'),
    ];
    const { root } = projectTree(ax, new DomSnapshot(document, strings), { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 }, { mode: 'tree', testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window' });
    expect(root.children?.map((node) => [node.name, node.states?.hidden === true])).toEqual([['Contents', false], ['Collapsed', true], ['Empty', true]]);
  });

  it('shows a checkbox with no box while a label of its own draws it, as the web does', () => {
    const strings = ['#document', 'BODY', 'LABEL', 'INPUT', 'BUTTON', 'type', 'checkbox', 'for', 'far', 'id'];
    // Four checkboxes: inside a shown label, inside a label that holds a button too, named by `for`, and with no label.
    const document: SnapshotDocument = {
      nodes: {
        backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        nodeName: [0, 1, 2, 3, 2, 3, 4, 2, 3, 3],
        parentIndex: [-1, 0, 1, 2, 1, 4, 4, 1, 1, 1],
        attributes: [[], [], [], [5, 6], [], [5, 6], [], [7, 8], [5, 6, 9, 8], [5, 6]],
      },
      layout: { nodeIndex: [2, 3, 4, 5, 6, 7, 8, 9], bounds: [[0, 0, 80, 20], [0, 0, 0, 0], [0, 20, 80, 20], [0, 20, 0, 0], [40, 20, 40, 20], [0, 40, 80, 20], [0, 60, 0, 0], [0, 80, 0, 0]] },
    };
    const box = (id: number, name: string): AXNode => ({ nodeId: String(id), ignored: false, role: { value: 'checkbox' }, name: { value: name }, parentId: '1', backendDOMNodeId: id });
    const ax: AXNode[] = [{ nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: ['4', '6', '9', '10'], backendDOMNodeId: 1 }, box(4, 'Wrapped'), box(6, 'Beside a button'), box(9, 'Named by for'), box(10, 'Bare')];
    const { root } = projectTree(ax, new DomSnapshot(document, strings), { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 }, { mode: 'tree', testIdAttribute: 'data-testid', idOf: (id) => `1.${id}`, rootId: 'window' });
    expect(root.children?.map((node) => [node.name, node.states?.hidden === true])).toEqual([['Wrapped', false], ['Beside a button', true], ['Named by for', false], ['Bare', true]]);
  });

  it('caps an observation and never a locator read', () => {
    const buttons = Array.from({ length: 6000 }, (_, at) => at + 2);
    const ax: AXNode[] = [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, childIds: buttons.map(String), backendDOMNodeId: 1 },
      ...buttons.map((id) => ({ nodeId: String(id), ignored: false, role: { value: 'button' }, name: { value: `Button ${id}` }, parentId: '1', backendDOMNodeId: id })),
    ];
    const empty: SnapshotDocument = { nodes: {}, layout: { nodeIndex: [], bounds: [] } };
    const geometry = { scale: 1, scrollX: 0, scrollY: 0, width: 640, height: 480 };
    const options = { testIdAttribute: 'data-testid', idOf: (id: number) => `1.${id}`, rootId: 'window' };
    const observed = projectTree(ax, new DomSnapshot(empty, []), geometry, { ...options, mode: 'tree' });
    expect(observed.truncated).toBe(true);
    expect(observed.root.children).toHaveLength(5000);
    const located = projectTree(ax, new DomSnapshot(empty, []), geometry, { ...options, mode: 'node' });
    expect(located.truncated).toBe(false);
    expect(located.root.children).toHaveLength(6000);
  });

  it('stops at the node cap and says the tree is incomplete', () => {
    const capped = project('tree', { maxNodes: 10 });
    expect(capped.truncated).toBe(true);
    expect(all(capped.root).length).toBeLessThanOrEqual(11);
    expect(project('tree').truncated).toBe(false);
  });
});

describe('unmaskableCount', () => {
  // strings: 0 '#document', 1 'BODY', 2 'DIV', 3 'INPUT', 4 'type', 5 'password', 6 'closed', 7 'open', 8 'IFRAME', 9 'text'
  const strings = ['#document', 'BODY', 'DIV', 'INPUT', 'type', 'password', 'closed', 'open', 'IFRAME', 'text'];

  /** A document of `#document > BODY > DIV(host) > child`, the child inside a shadow root of the given type, laid out or not. */
  function documentWith(child: { name: number; attributes?: number[]; shadow?: number; rendered?: boolean; nested?: number }): SnapshotDocument {
    const names = [0, 1, 2, child.name];
    const parents = [-1, 0, 1, 2];
    const shadow = { index: [] as number[], value: [] as number[] };
    if (child.nested === undefined) {
      if (child.shadow !== undefined) {
        shadow.index.push(3);
        shadow.value.push(child.shadow);
      }
    } else {
      // The child sits in a shadow root of its own (`nested`), under a host that is itself inside a `shadow` root.
      names.splice(3, 0, 2);
      parents.push(3);
      shadow.index.push(3, 4);
      shadow.value.push(child.shadow!, child.nested);
    }
    const last = names.length - 1;
    return {
      nodes: { nodeName: names, parentIndex: parents, attributes: names.map((_, at) => (at === last ? (child.attributes ?? []) : [])), shadowRootType: shadow },
      layout: { nodeIndex: child.rendered === false ? [0, 1, 2] : names.map((_, at) => at), bounds: [] },
    };
  }

  it('counts a rendered password field or nested document inside a closed shadow root', () => {
    expect(new DomSnapshot(documentWith({ name: 3, attributes: [4, 5], shadow: 6 }), strings).unmaskableCount()).toBe(1);
    expect(new DomSnapshot(documentWith({ name: 8, shadow: 6 }), strings).unmaskableCount()).toBe(1);
  });

  it('counts one inside an open shadow root that a closed one holds', () => {
    expect(new DomSnapshot(documentWith({ name: 3, attributes: [4, 5], shadow: 6, nested: 7 }), strings).unmaskableCount()).toBe(1);
  });

  it('leaves out what a selector reaches, what is not rendered, and what holds no secret', () => {
    expect(new DomSnapshot(documentWith({ name: 3, attributes: [4, 5], shadow: 7 }), strings).unmaskableCount()).toBe(0);
    expect(new DomSnapshot(documentWith({ name: 3, attributes: [4, 5] }), strings).unmaskableCount()).toBe(0);
    expect(new DomSnapshot(documentWith({ name: 3, attributes: [4, 5], shadow: 6, rendered: false }), strings).unmaskableCount()).toBe(0);
    expect(new DomSnapshot(documentWith({ name: 3, attributes: [4, 9], shadow: 6 }), strings).unmaskableCount()).toBe(0);
  });
});
