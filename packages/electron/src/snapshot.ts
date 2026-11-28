/**
 * One `DOMSnapshot.captureSnapshot` document, indexed once: each element's
 * facts by backend DOM node id, and the questions the projection asks of the
 * document's order (source text, white space between runs, table cells,
 * subtrees). Pure: the surface reads the snapshot, this answers from it.
 */

/** A `DOMSnapshot` rare-string table: `value[i]` is the string index for node `index[i]`. */
interface RareStrings {
  readonly index: readonly number[];
  readonly value: readonly number[];
}

/** The fields of one `DOMSnapshot.captureSnapshot` document the engine reads. */
export interface SnapshotDocument {
  readonly nodes: {
    readonly backendNodeId?: readonly number[];
    readonly nodeName?: readonly number[];
    readonly attributes?: readonly (readonly number[])[];
    readonly inputValue?: RareStrings;
    /** A textarea's current text. */
    readonly textValue?: RareStrings;
    readonly nodeType?: readonly number[];
    readonly nodeValue?: readonly number[];
    /** The option elements that are selected. */
    readonly optionSelected?: { readonly index: readonly number[] };
    /** The checkboxes and radios that are checked. */
    readonly inputChecked?: { readonly index: readonly number[] };
    readonly parentIndex?: readonly number[];
    /** For every node inside a shadow root, that root's type: `open`, `closed`, or `user-agent`. */
    readonly shadowRootType?: RareStrings;
  };
  readonly layout: {
    readonly nodeIndex: readonly number[];
    readonly bounds: readonly (readonly number[])[];
    /** Per layout node, the computed styles the read asked for, as string indexes: `visibility` alone. */
    readonly styles?: readonly (readonly number[])[];
  };
}

/** The computed styles a snapshot is captured with, in the order `layout.styles` lists them. */
export const SNAPSHOT_STYLES: readonly string[] = ['visibility'];

/** Elements a screenshot paints over besides a secure field's value: the nested documents the engine does not read. */
export const MASKED_TAGS: readonly string[] = ['IFRAME', 'FRAME', 'WEBVIEW', 'EMBED', 'OBJECT'];

/** Elements a click on a label would press instead of the label's own control. */
const CONTROL_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

/** `Node.TEXT_NODE`. */
const TEXT_NODE = 3;

/** One element's facts from the snapshot. */
export interface DomFacts {
  /** The node's position in the snapshot, its document order. */
  readonly index: number;
  readonly nodeName: string;
  /** Attribute names in lower case. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly inputValue?: string;
  /** A textarea's current text. */
  readonly textValue?: string;
  /** Whether the node's text content holds anything but white space, as `textContent` reads it. */
  readonly hasText: boolean;
  /** A select's value: what its first selected option submits. */
  readonly selectValue?: string;
  /** A checkbox or radio that is checked now, whatever its `checked` attribute says. */
  readonly checked: boolean;
  /** Device-pixel document bounds; none for a node with no layout box. */
  readonly bounds?: readonly number[];
  /** Its computed `visibility` is `hidden` or `collapse`. */
  readonly invisible: boolean;
}

/** A password input: it reports no value and no text, and a screenshot paints it over. */
export function isSecureField(nodeName: string, attributes: Readonly<Record<string, string>>): boolean {
  return nodeName === 'INPUT' && attributes['type']?.toLowerCase() === 'password';
}

/** Collapses runs of white space the way rendered text reads. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export class DomSnapshot {
  private readonly strings: readonly string[];
  private readonly names: readonly number[];
  private readonly parents: readonly number[];
  private readonly types: readonly number[];
  private readonly values: readonly number[];
  private readonly backendIds: readonly number[];
  private readonly attributePairs: readonly (readonly number[])[];
  private readonly closedShadow: ReadonlySet<number>;
  private readonly rendered: ReadonlySet<number>;
  private readonly facts = new Map<number, DomFacts>();
  /** Per node with a layout box, its device-pixel bounds. */
  private readonly boxes = new Map<number, readonly number[]>();
  /** The label elements that name an id with `for`, by that id. */
  private readonly labelsFor = new Map<string, number[]>();
  /** Per node, how many white-space-only text nodes precede or are it. */
  private readonly blanks: number[] = [];
  /** Per node, its nearest table cell, or -1. */
  private readonly cells: number[] = [];

  constructor(document: SnapshotDocument, strings: readonly string[]) {
    const { nodes, layout } = document;
    this.strings = strings;
    this.names = nodes.nodeName ?? [];
    this.parents = nodes.parentIndex ?? [];
    this.types = nodes.nodeType ?? [];
    this.values = nodes.nodeValue ?? [];
    this.backendIds = nodes.backendNodeId ?? [];
    this.attributePairs = nodes.attributes ?? [];
    this.rendered = new Set(layout.nodeIndex);
    this.closedShadow = new Set([...this.rare(nodes.shadowRootType)].filter(([, type]) => type === 'closed').map(([node]) => node));
    this.types.forEach((_, index) => this.blanks.push((this.blanks[index - 1] ?? 0) + (/^\s+$/.test(this.sourceText(index) ?? '') ? 1 : 0)));
    // A parent precedes its children, so its cell is known first.
    this.names.forEach((_, index) => {
      const name = this.nameAt(index);
      this.cells.push(name === 'TD' || name === 'TH' ? index : (this.cells[this.parents[index] ?? -1] ?? -1));
    });
    this.indexFacts(nodes, layout);
  }

  /** The element with this backend DOM node id, if the snapshot holds it. */
  element(backendNodeId: number): DomFacts | undefined {
    return this.facts.get(backendNodeId);
  }

  /** Every node of the document, text nodes included, by backend DOM node id. */
  elements(): IterableIterator<[number, DomFacts]> {
    return this.facts.entries();
  }

  /** A text node's text as the source has it, white space included; undefined for any other node. */
  sourceText(index: number): string | undefined {
    return this.types[index] === TEXT_NODE ? (this.strings[this.values[index]!] ?? '') : undefined;
  }

  /** Whether the source has white space (a text node of nothing else) between two nodes, which reads as a space, as it renders. */
  gap(from: number, to: number): boolean {
    return from >= 0 && to > from && (this.blanks[to - 1] ?? 0) - (this.blanks[from] ?? 0) > 0;
  }

  /** The node's nearest table cell, from the DOM: Chromium gives a layout table's cells no cell role. */
  cellOf(index: number): number {
    return this.cells[index] ?? -1;
  }

  /** The snapshot indices inside the node at `index`, itself included: its descendants follow it in document order. */
  subtree(index: number): Set<number> {
    const inside = new Set([index]);
    for (let at = index + 1; at < this.parents.length && inside.has(this.parents[at] ?? -1); at += 1) inside.add(at);
    return inside;
  }

  /** The text content of the node at `index`, white space collapsed. */
  textContent(index: number): string {
    return collapse([...this.subtree(index)].map((at) => this.sourceText(at) ?? '').join(''));
  }

  /** The backend ids of the node's ancestors, nearest first. */
  *ancestors(index: number): IterableIterator<number> {
    for (let at = this.parents[index] ?? -1; at >= 0; at = this.parents[at] ?? -1) yield this.backendIds[at]!;
  }

  /** Whether anything inside the node, itself aside, has a layout box: what a `display: contents` wrapper holds. */
  rendersContent(index: number): boolean {
    for (const at of this.subtree(index)) if (at !== index && this.rendered.has(at)) return true;
    return false;
  }

  /**
   * Whether a shown label of the element's own draws it: a label around it or
   * one whose `for` names it, with a box, that is no control itself and holds
   * no other one. A checkbox or radio with no box under such a label is on
   * screen as the label, as the web reads it.
   */
  drawnByLabel(index: number): boolean {
    const id = this.attributesAt(index)['id'];
    const labels = [...this.labelsFor.get(id ?? '') ?? []];
    for (let at = this.parents[index] ?? -1; at >= 0; at = this.parents[at] ?? -1) if (this.nameAt(at) === 'LABEL') labels.push(at);
    return labels.some((label) => {
      const box = this.boxes.get(label);
      if (box === undefined || (box[2] ?? 0) === 0 || (box[3] ?? 0) === 0) return false;
      for (const at of this.subtree(label)) if (at !== index && at !== label && this.isControl(at)) return false;
      return true;
    });
  }

  /**
   * How many rendered elements a screenshot must paint over and a selector
   * cannot reach: password inputs and nested documents inside a closed shadow
   * root, at any depth. The snapshot enters every shadow root, so it holds
   * whatever the accessibility tree leaves out (`aria-hidden`, the node cap).
   * Every other such element in the document, open shadow roots included, a
   * selector mask covers.
   */
  unmaskableCount(): number {
    if (this.closedShadow.size === 0) return 0;
    let count = 0;
    this.names.forEach((_, index) => {
      if (!this.rendered.has(index)) return;
      const name = this.nameAt(index);
      if (!isSecureField(name, this.attributesAt(index)) && !MASKED_TAGS.includes(name)) return;
      for (let at = index; at >= 0; at = this.parents[at] ?? -1) {
        if (this.closedShadow.has(at)) {
          count += 1;
          return;
        }
      }
    });
    return count;
  }

  private isControl(index: number): boolean {
    if (CONTROL_TAGS.has(this.nameAt(index))) return true;
    const attributes = this.attributesAt(index);
    return 'contenteditable' in attributes || attributes['role'] === 'button' || attributes['role'] === 'link';
  }

  private nameAt(index: number): string {
    return this.strings[this.names[index]!] ?? '';
  }

  private attributesAt(index: number): Record<string, string> {
    const pairs = this.attributePairs[index] ?? [];
    const record: Record<string, string> = {};
    for (let at = 0; at + 1 < pairs.length; at += 2) record[(this.strings[pairs[at]!] ?? '').toLowerCase()] = this.strings[pairs[at + 1]!] ?? '';
    return record;
  }

  private rare(table: RareStrings | undefined): Map<number, string> {
    const values = new Map<number, string>();
    table?.index.forEach((node, at) => values.set(node, this.strings[table.value[at]!] ?? ''));
    return values;
  }

  private indexFacts(nodes: SnapshotDocument['nodes'], layout: SnapshotDocument['layout']): void {
    const inputValues = this.rare(nodes.inputValue);
    const textValues = this.rare(nodes.textValue);
    const selectValues = this.selectValues(nodes.optionSelected?.index ?? []);
    const checked = new Set(nodes.inputChecked?.index ?? []);
    const withText = this.nodesWithText();
    const bounds = this.boxes;
    const invisible = new Set<number>();
    layout.nodeIndex.forEach((node, at) => {
      if (!bounds.has(node)) bounds.set(node, layout.bounds[at]!);
      const visibility = this.strings[layout.styles?.[at]?.[0] ?? -1];
      if (visibility === 'hidden' || visibility === 'collapse') invisible.add(node);
    });
    this.backendIds.forEach((backendNodeId, index) => {
      const named = this.nameAt(index) === 'LABEL' ? this.attributesAt(index)['for'] : undefined;
      if (named !== undefined) this.labelsFor.set(named, [...(this.labelsFor.get(named) ?? []), index]);
      const input = inputValues.get(index);
      const text = textValues.get(index);
      const selected = selectValues.get(index);
      const box = bounds.get(index);
      this.facts.set(backendNodeId, {
        index,
        nodeName: this.nameAt(index),
        attributes: this.attributesAt(index),
        hasText: withText.has(index),
        invisible: invisible.has(index),
        checked: checked.has(index),
        ...(input === undefined ? {} : { inputValue: input }),
        ...(text === undefined ? {} : { textValue: text }),
        ...(selected === undefined ? {} : { selectValue: selected }),
        ...(box === undefined ? {} : { bounds: box }),
      });
    });
  }

  /** The node indices whose text content holds anything but white space: every ancestor of such a text node. */
  private nodesWithText(): Set<number> {
    const marked = new Set<number>();
    this.types.forEach((_, index) => {
      if ((this.sourceText(index) ?? '').trim() === '') return;
      for (let at = this.parents[index] ?? -1; at >= 0 && !marked.has(at); at = this.parents[at] ?? -1) marked.add(at);
    });
    return marked;
  }

  /**
   * Each select's value, by node index: what its first selected option
   * submits, the option's `value` attribute or else its text, as
   * `HTMLSelectElement.value` reads it. An option's text is all the text
   * under it, with ASCII white space collapsed and no other: a no-break
   * space stays one.
   */
  private selectValues(selected: readonly number[]): Map<number, string> {
    const values = new Map<number, string>();
    if (selected.length === 0) return values;
    const texts = new Map<number, string>();
    this.types.forEach((_, index) => {
      const text = this.sourceText(index);
      if (text === undefined) return;
      let option = this.parents[index] ?? -1;
      while (option >= 0 && this.nameAt(option) !== 'OPTION') option = this.parents[option] ?? -1;
      if (option >= 0) texts.set(option, (texts.get(option) ?? '') + text);
    });
    for (const option of selected.toSorted((a, b) => a - b)) {
      let select = this.parents[option] ?? -1;
      while (select >= 0 && this.nameAt(select) !== 'SELECT') select = this.parents[select] ?? -1;
      if (select < 0 || values.has(select)) continue;
      values.set(select, this.attributesAt(option)['value'] ?? (texts.get(option) ?? '').replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, ''));
    }
    return values;
  }
}
