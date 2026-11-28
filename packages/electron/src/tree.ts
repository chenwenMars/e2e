/**
 * Projects one window's Chromium accessibility tree onto the engine
 * contract's semantic tree. The roles, names, values, and states are what
 * Chromium computed (`Accessibility.getFullAXTree`); the boxes, attributes,
 * and input values come from one DOM snapshot of the same document
 * (`snapshot.ts`), joined on each node's backend DOM node id. `fields.ts`
 * reads one element; this walks the tree and folds its text.
 * Nothing runs in the page, so an app's content security policy, its frozen
 * globals, and its mutation observers never see a read.
 *
 * Pure: the surface reads the two documents, this turns them into nodes.
 */

import { OBSERVED_NAME_LIMIT, OBSERVED_TEXT_LIMIT, type SemanticNode } from '@e2e-dev/core/engine';
import { elementFields, isButtonInput, isCheckable, isFocusable, isHiddenSubtree, isSecure, isTextField, roleOf, stringOf, type AXNode, type FieldContext, type ProjectionPolicy } from './fields.ts';
import { collapse, type DomFacts, type DomSnapshot } from './snapshot.ts';

/** How the window's layout maps the snapshot's device pixels to the viewport's CSS pixels. */
export interface WindowGeometry {
  /** Device pixels per CSS pixel. */
  readonly scale: number;
  /** The visual viewport's scroll offset, in CSS pixels. */
  readonly scrollX: number;
  readonly scrollY: number;
  /** The viewport's size, in CSS pixels. */
  readonly width: number;
  readonly height: number;
}

/** `tree` is the observation for a model; `node` is what a locator reads. `POLICIES` says how they differ. */
export type ProjectionMode = 'tree' | 'node';

const POLICIES: Readonly<Record<ProjectionMode, ProjectionPolicy>> = {
  tree: {
    textLimit: OBSERVED_TEXT_LIMIT,
    nameLimit: OBSERVED_NAME_LIMIT,
    maxNodes: 5000,
    attributes: new Set(['type', 'autocomplete', 'href', 'role', 'placeholder']),
    redactHref: true,
    editingHostRole: true,
    checkableValue: false,
    emptyState: false,
    descendantText: false,
    hiddenTestIds: false,
  },
  node: {
    textLimit: Number.POSITIVE_INFINITY,
    nameLimit: Number.POSITIVE_INFINITY,
    maxNodes: Number.POSITIVE_INFINITY,
    attributes: null,
    redactHref: false,
    editingHostRole: false,
    checkableValue: true,
    emptyState: true,
    descendantText: true,
    hiddenTestIds: true,
  },
};

export interface ProjectionOptions {
  readonly mode: ProjectionMode;
  readonly testIdAttribute: string;
  /** Mints a node id from a backend DOM node id; ids carry the window, so a ref never binds in another one. */
  readonly idOf: (backendNodeId: number) => string;
  /** The root's id, stable for the surface. */
  readonly rootId: string;
  /** The document's URL, which a relative link resolves against. */
  readonly baseUrl?: string;
  /** The document's title, the root's name. */
  readonly title?: string;
  /** Backend ids of elements a locator's CSS selector matched: kept as nodes even where the tree would leave them out. */
  readonly keep?: ReadonlySet<number>;
  /** Overrides the mode's node cap; past it nodes are left out and the tree marked truncated. */
  readonly maxNodes?: number;
}

export interface Projection {
  readonly root: SemanticNode;
  /** Nodes were left out past the node cap. A nested document is never entered; its frame is a node of its own. */
  readonly truncated: boolean;
}

/** Roles whose node never reaches the tree: text runs, list bullets, line breaks. */
const DROPPED_ROLES = new Set(['InlineTextBox', 'ListMarker', 'LineBreak']);

type Rect = NonNullable<SemanticNode['rect']>;

/** A node under construction: the contract node's fields, mutable, with the text the projection folds. */
interface Draft {
  id: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  testId?: string;
  inputPurpose?: SemanticNode['inputPurpose'];
  states: Record<string, boolean>;
  level?: number;
  attributes?: Record<string, string>;
  /** The node's box, which line breaks between text runs are read from too. */
  rect?: Rect;
  children: Draft[];
  /** A text run: its text folds into the parent when it is the parent's only content. */
  isText: boolean;
  /** A run's source had white space before or after its text, which joining the runs keeps. */
  spaceBefore?: boolean;
  spaceAfter?: boolean;
  /** The node's position in the DOM snapshot, its document order. */
  order: number;
}

function cut(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/** Whether `next` starts below `previous`, which with no white space between them means a block boundary, not inline markup. */
function startsNewLine(previous: Draft, next: Draft): boolean {
  const { rect: above } = previous;
  const { rect: below } = next;
  return above !== undefined && below !== undefined && below.y >= above.y + above.height - 0.5;
}

/**
 * The text a node reads as: its text runs, and with `deep` its descendants'
 * too. Runs join as the source has them: with white space where the source had
 * some or where a block boundary falls, and with none between inline markup
 * (`<span>$</span><span>10</span>` reads `$10`). Two table cells side by side
 * read with a space between them.
 */
function textOf(draft: Draft, deep: boolean, snapshot: DomSnapshot): string {
  const parts: Draft[] = [];
  const walk = (node: Draft): void => {
    for (const child of node.children) {
      if (child.isText) parts.push(child);
      else if (deep) {
        if (child.children.length === 0 && child.text !== undefined) parts.push(child);
        else walk(child);
      }
    }
  };
  walk(draft);
  let joined = '';
  parts.forEach((part, at) => {
    const previous = parts[at - 1];
    if (previous !== undefined && separated(previous, part, snapshot)) joined += ' ';
    joined += part.text ?? '';
  });
  return collapse(joined);
}

function separated(previous: Draft, part: Draft, snapshot: DomSnapshot): boolean {
  if (previous.spaceAfter === true || part.spaceBefore === true) return true;
  if (snapshot.cellOf(previous.order) !== snapshot.cellOf(part.order)) return true;
  return snapshot.gap(previous.order, part.order) || startsNewLine(previous, part);
}

/** One projection: the walk over the accessibility tree, and the state it keeps (the node count, the drafts by backend id). */
class TreeProjector {
  truncated = false;
  private kept = 0;
  private readonly drafted = new Map<number, Draft>();
  private readonly nodes: ReadonlyMap<string, AXNode>;
  private readonly snapshot: DomSnapshot;
  private readonly geometry: WindowGeometry;
  private readonly options: ProjectionOptions;
  private readonly policy: ProjectionPolicy;
  private readonly context: FieldContext;
  private readonly testIdAttribute: string;

  constructor(axNodes: readonly AXNode[], snapshot: DomSnapshot, geometry: WindowGeometry, options: ProjectionOptions) {
    this.nodes = new Map(axNodes.map((node) => [node.nodeId, node]));
    this.snapshot = snapshot;
    this.geometry = geometry;
    this.options = options;
    this.policy = options.maxNodes === undefined ? POLICIES[options.mode] : { ...POLICIES[options.mode], maxNodes: options.maxNodes };
    this.context = { policy: this.policy, testIdAttribute: options.testIdAttribute, baseUrl: options.baseUrl };
    this.testIdAttribute = options.testIdAttribute.toLowerCase();
  }

  children(node: AXNode): Draft[] {
    return (node.childIds ?? []).flatMap((id) => {
      const child = this.nodes.get(id);
      return child === undefined ? [] : this.build(child);
    });
  }

  /**
   * An element a locator asks for that the tree leaves out (`hidden`,
   * `display: none`) is still there to count, as on the web: one a CSS
   * selector matched, and on a locator's read one with a test id. It joins
   * the tree at its place in the document, under its nearest ancestor that is
   * in the tree, read by the same field rules as any other element.
   */
  placeAbsent(roots: Draft[]): void {
    const wanted = new Set(this.options.keep ?? []);
    if (this.policy.hiddenTestIds) {
      for (const [backend, facts] of this.snapshot.elements()) {
        // Content under aria-hidden is out of the accessibility tree and on screen all the same: a text query finds
        // it, as on the web, on the element that hides it. It has no role, so a role query still does not.
        const offTree = facts.attributes['aria-hidden']?.toLowerCase() === 'true' && facts.bounds !== undefined;
        if (facts.attributes[this.testIdAttribute] !== undefined || offTree) wanted.add(backend);
      }
    }
    const absent = [...wanted].flatMap((backend) => {
      const facts = this.drafted.has(backend) ? undefined : this.snapshot.element(backend);
      return facts === undefined ? [] : [{ backend, facts }];
    });
    for (const { backend, facts } of absent.toSorted((a, b) => a.facts.index - b.facts.index)) {
      const draft = this.element(backend, undefined, facts, 'generic');
      const siblings = this.parentOf(facts.index)?.children ?? roots;
      if (!isSecure(facts) && !isTextField(facts)) this.adoptText(draft, siblings);
      const at = siblings.findIndex((sibling) => sibling.order > draft.order);
      siblings.splice(at < 0 ? siblings.length : at, 0, draft);
    }
  }

  private build(node: AXNode): Draft[] {
    const chromium = stringOf(node.role) ?? '';
    if (isHiddenSubtree(node) || DROPPED_ROLES.has(chromium)) return [];
    const backend = node.backendDOMNodeId;
    const facts = backend === undefined ? undefined : this.snapshot.element(backend);
    // The text as rendered, `text-transform` applied, as the web's innerText reads it.
    if (chromium === 'StaticText') return backend === undefined ? [] : this.textRun(backend, facts, stringOf(node.name) ?? '');
    // Chromium leaves the text of a label out once the label names a checkbox or radio, though it is on screen: such
    // a text node reads from the DOM, so the label has text to find and to tap.
    const unnamed = node.ignored && facts?.bounds !== undefined ? this.snapshot.sourceText(facts.index) : undefined;
    if (backend !== undefined && unnamed !== undefined) return this.textRun(backend, facts, unnamed);
    const { role, silent } = roleOf(node, facts, this.policy);
    const name = collapse(stringOf(node.name) ?? '');
    // A container Chromium leaves out, or one that says nothing, gives its place to its children: unless a test id,
    // a name, a locator's selector, or taking focus makes it addressable, so an action reaches it rather than the
    // container its text would fold into.
    const addressable =
      facts?.attributes[this.testIdAttribute] !== undefined ||
      (backend !== undefined && this.options.keep?.has(backend) === true) ||
      isFocusable(node) ||
      (!node.ignored && name !== '');
    if (backend === undefined) return this.children(node);
    let children: Draft[] | undefined;
    if (silent && !addressable) {
      children = this.children(node);
      // Inline markup splits a sentence into parts (`Order <strong>ABC123</strong>`). A locator finds the sentence
      // on the container that holds all of it, as on the web: a container with text of its own beside other
      // content stays, with its parts under it.
      const sentence = this.policy.descendantText && children.length > 1 && children.some((child) => child.isText);
      if (!sentence) return children;
    }
    if (!this.take()) return children ?? [];
    const draft = this.element(backend, node, facts, silent ? 'generic' : role);
    if (name !== '') draft.name = cut(name, this.policy.nameLimit);
    if (isSecure(facts)) return [draft];
    // A native field's inner editor repeats its value as text, which says nothing new. An editing host
    // (contenteditable) keeps its content, which is its text.
    if (!isTextField(facts)) draft.children = children ?? this.children(node);
    this.foldText(draft);
    // A closed select's option has no text run: its text is its label, which Chromium names it by.
    if (draft.text === undefined && facts?.nodeName === 'OPTION' && name !== '') draft.text = cut(name, this.policy.textLimit);
    return [draft];
  }

  /** Counts one more node against the cap; false once the cap is reached. */
  private take(): boolean {
    if (this.kept >= this.policy.maxNodes) {
      this.truncated = true;
      return false;
    }
    this.kept += 1;
    return true;
  }

  private textRun(backend: number, facts: DomFacts | undefined, rendered: string): Draft[] {
    const text = collapse(rendered);
    if (text === '' || !this.take()) return [];
    const rect = this.rectOf(facts);
    // The white space comes from the text node's own source: Chromium's name for a run trims what the next element's run follows.
    const source = (facts === undefined ? undefined : this.snapshot.sourceText(facts.index)) ?? rendered;
    const run: Draft = {
      id: this.options.idOf(backend),
      text: cut(text, this.policy.textLimit),
      states: this.isHidden(facts, rect) ? { hidden: true } : {},
      ...(rect === undefined ? {} : { rect }),
      children: [],
      isText: true,
      spaceBefore: /^\s/.test(source),
      spaceAfter: /\s$/.test(source),
      order: facts?.index ?? -1,
    };
    this.drafted.set(backend, run);
    return [run];
  }

  /** An element's node, without its name, children, or text. `node` is undefined for one the accessibility tree leaves out. */
  private element(backend: number, node: AXNode | undefined, facts: DomFacts | undefined, role: string): Draft {
    const { value, ...fields } = elementFields(node, facts, role, this.context);
    const rect = this.rectOf(facts);
    const draft: Draft = {
      id: this.options.idOf(backend),
      role,
      ...fields,
      ...(value === undefined ? {} : { value: cut(value, this.policy.textLimit) }),
      ...(rect === undefined ? {} : { rect }),
      children: [],
      isText: false,
      order: facts?.index ?? -1,
    };
    if (this.isHidden(facts, rect)) draft.states['hidden'] = true;
    if (isButtonInput(facts) && draft.value !== undefined && draft.value !== '') draft.text = draft.value;
    // What toBeEmpty reads, never on a secure field: a field by its value, anything else by its text content, as the
    // web engine reads it (a select's option text counts, and so does hidden text).
    if (this.policy.emptyState && !isSecure(facts)) draft.states['empty'] = isTextField(facts) ? (value ?? '') === '' : facts?.hasText !== true;
    this.drafted.set(backend, draft);
    return draft;
  }

  /**
   * Text runs that are the node's only content are the node's text, not nodes
   * of their own. Beside other children they stay nodes, and an observation
   * does not repeat them on the node; a locator reads all of it, and keeps
   * several runs as nodes so an exact text query finds each one
   * (`<span>Price</span> <span>$10</span>`).
   */
  private foldText(draft: Draft): void {
    const onlyText = draft.children.length > 0 && draft.children.every((child) => child.isText);
    if (this.policy.descendantText || onlyText) {
      const text = textOf(draft, this.policy.descendantText, this.snapshot);
      if (text !== '') draft.text = cut(text, this.policy.textLimit);
    }
    if (onlyText && (!this.policy.descendantText || draft.children.length === 1)) draft.children = [];
  }

  /**
   * The text of an element the tree left out. The text runs the tree already
   * holds for it move under it, so its text is not read twice; with none
   * (nothing rendered), the text comes from the DOM.
   */
  private adoptText(draft: Draft, siblings: Draft[]): void {
    const inside = this.snapshot.subtree(draft.order);
    const runs = siblings.filter((sibling) => sibling.isText && inside.has(sibling.order));
    if (runs.length === 0) {
      const text = this.snapshot.textContent(draft.order);
      if (text !== '') draft.text = cut(text, this.policy.textLimit);
      return;
    }
    for (const run of runs) siblings.splice(siblings.indexOf(run), 1);
    draft.children = runs;
    this.foldText(draft);
  }

  /** The nearest DOM ancestor of the node at `index` that is an element in the tree; undefined when it sits under the root. */
  private parentOf(index: number): Draft | undefined {
    for (const backend of this.snapshot.ancestors(index)) {
      const draft = this.drafted.get(backend);
      if (draft !== undefined && !draft.isText) return draft;
    }
    return undefined;
  }

  private rectOf(facts: DomFacts | undefined): Rect | undefined {
    const box = facts?.bounds;
    if (box === undefined || box.length < 4) return undefined;
    const [x = 0, y = 0, width = 0, height = 0] = box;
    const { scale, scrollX, scrollY } = this.geometry;
    return { x: x / scale - scrollX, y: y / scale - scrollY, width: width / scale, height: height / scale };
  }

  /**
   * Hidden as the web reads it: by its `visibility`, else by its box. An
   * element with no box of its own (`display: contents`) is shown while
   * something inside it is rendered, and a checkbox or radio with none
   * while its label draws it.
   */
  private isHidden(facts: DomFacts | undefined, rect: Rect | undefined): boolean {
    if (facts === undefined || facts.invisible) return true;
    const sized = rect !== undefined && rect.width > 0 && rect.height > 0;
    if (sized || (rect === undefined && this.snapshot.rendersContent(facts.index))) return false;
    return !(isCheckable(facts) && this.snapshot.drawnByLabel(facts.index));
  }
}

/** Projects the window's accessibility tree onto the contract's semantic tree. */
export function projectTree(axNodes: readonly AXNode[], snapshot: DomSnapshot, geometry: WindowGeometry, options: ProjectionOptions): Projection {
  const projector = new TreeProjector(axNodes, snapshot, geometry, options);
  const rootNode = axNodes.find((node) => node.parentId === undefined) ?? axNodes[0];
  const children = rootNode === undefined ? [] : projector.children(rootNode);
  projector.placeAbsent(children);
  const rootName = options.title ?? stringOf(rootNode?.name);
  const root: SemanticNode = {
    ref: { id: options.rootId, revision: '' },
    role: 'document',
    ...(rootName === undefined || rootName === '' ? {} : { name: cut(rootName, POLICIES[options.mode].nameLimit) }),
    rect: { x: 0, y: 0, width: geometry.width, height: geometry.height },
    ...(children.length === 0 ? {} : { children: children.map(finish) }),
  };
  return { root, truncated: projector.truncated };
}

/** A draft as a contract node, empty fields left out. */
function finish(draft: Draft): SemanticNode {
  return {
    ref: { id: draft.id, revision: '' },
    ...(draft.role === undefined ? {} : { role: draft.role }),
    ...(draft.name === undefined ? {} : { name: draft.name }),
    ...(draft.text === undefined ? {} : { text: draft.text }),
    ...(draft.value === undefined ? {} : { value: draft.value }),
    ...(draft.testId === undefined ? {} : { testId: draft.testId }),
    ...(draft.inputPurpose === undefined ? {} : { inputPurpose: draft.inputPurpose }),
    ...(Object.keys(draft.states).length === 0 ? {} : { states: draft.states }),
    ...(draft.level === undefined ? {} : { level: draft.level }),
    ...(draft.attributes === undefined ? {} : { attributes: draft.attributes }),
    ...(draft.rect === undefined ? {} : { rect: draft.rect }),
    ...(draft.children.length === 0 ? {} : { children: draft.children.map(finish) }),
  };
}
