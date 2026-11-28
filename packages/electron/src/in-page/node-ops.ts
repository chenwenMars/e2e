/**
 * The engine's page-side work on one node, run in its isolated world with
 * the node as its first argument. `devtools.ts` sends `nodeOp` as source text
 * (`toString()`), so it stays one self-contained function: no imports beyond
 * types, nothing referenced outside its body.
 */

/** A page-side check's answer: ok, or why the node cannot take the action yet. */
export type Readiness = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The option `selectOption` names: by label (the default), value, or position. */
export interface WantedOption {
  readonly label?: string;
  readonly value?: string;
  readonly index?: number;
}

/** Every operation `nodeOp` runs, by name. A text node acts through its element. */
export interface NodeOps {
  /** In the document. */
  checkConnected(): Readiness;
  /** In the document, visible, and enabled when `enabled` asks. */
  checkEnabled(enabled: boolean): Readiness;
  /** Whether a click at the viewport point lands on the element, a node inside it, or a label for it. */
  hitTest(x: number, y: number): Readiness;
  scrollIntoView(): void;
  /**
   * For a checkbox or radio with no box that a label of its own draws: the
   * viewport point at that label's centre, scrolled into view, which a click
   * reaches the control through. Null for any other node.
   */
  labelPoint(): { readonly x: number; readonly y: number } | null;
  /** Focuses the element: `held` when it holds focus after, `moved` when the app sent focus elsewhere, `none` when it cannot take focus and focus stayed where it was. */
  focus(): 'held' | 'moved' | 'none';
  blur(): void;
  /** A text field or editing host that is enabled and not read-only. */
  checkEditable(): Readiness;
  /**
   * Sets the value of an input that takes no typed text, with its input and
   * change events; null when the value is to be typed instead.
   */
  setValue(value: string): Readiness | null;
  /** Focuses the element and selects its whole content; false when the app moved focus away. */
  selectContents(): boolean;
  /** A checkbox's or radio's checked state, or `aria-checked` on a role that has one; null when it has none (a toggle button's `aria-pressed` is not a checked state, as on the web). */
  readChecked(): boolean | null;
  /** A `<select>` that is enabled and holds the option, enabled. */
  checkSelect(wanted: WantedOption): Readiness;
  selectOption(wanted: WantedOption): Readiness;
  /** An enabled file input. */
  checkFileInput(): Readiness;
  /** Whether the file input takes `count` files: more than one needs `multiple`. */
  takesFiles(count: number): Readiness;
  /** Empties a file input, with its input and change events. */
  clearFiles(): void;
  /** A native radio: one a click never clears. A custom one clears if its app says so. */
  isNativeRadio(): boolean;
  /** Whether the node is a file input, which takes files itself. */
  isFileInput(): boolean;
  /** Whether the node, the focused element, takes typed text, or typed keys as a widget's typeahead. */
  takesText(): boolean;
  /** The element's computed value of each named CSS property. */
  readStyle(names: readonly string[]): Record<string, string>;
  /** How much of the element's box is inside the window, past what its scrolling ancestors clip. */
  viewportIntersection(): { readonly intersects: boolean; readonly ratio: number };
}

/** Runs one of `NodeOps` on `node`. */
export function nodeOp<K extends keyof NodeOps>(node: Node, name: K, args: Parameters<NodeOps[K]>): ReturnType<NodeOps[K]> {
  const owner = node instanceof Element ? node : node.parentElement;
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'password', 'email', 'search', 'tel', 'url', 'number']);
  /** Input types whose value is set rather than typed. */
  const SET_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
  /** Roles whose `aria-checked` is a checked state, as the web reads them. */
  const CHECKED_ROLES = new Set(['checkbox', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'switch', 'treeitem']);
  /** Widgets that take typed keys as typeahead: a key moves to the item it starts. */
  const TYPEAHEAD_ROLES = new Set(['listbox', 'option', 'tree', 'treeitem', 'menu', 'menubar', 'menuitem', 'combobox', 'grid', 'gridcell', 'radiogroup', 'tablist', 'tab']);
  /** Of those, the ones that also take typed text: digits a key at a time. */
  const TYPED_PICKER_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);
  /** What a click inside a label presses instead of the label's own control. */
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[contenteditable],[role="button"],[role="link"]';
  /** The node's element. A node the document dropped fails as one: the harness locates it again, where a reason would only wait out the deadline. */
  const live = (): Element => {
    if (owner?.isConnected !== true) throw new Error('Node is detached: it is no longer in the document');
    return owner;
  };
  /** An input's type as the browser reads it (an unknown type is `text`); another element's type attribute. */
  const typeOf = (target: Element): string => (target instanceof HTMLInputElement ? target.type : (target.getAttribute('type') ?? '').toLowerCase());
  /** The nearest element matching `selector`, from `target` up through the hosts of the shadow roots it sits in: `closest` stops at a root. */
  const above = (target: Element, selector: string): Element | null => {
    for (let at: Element | null = target; at !== null; ) {
      const found = at.closest(selector);
      if (found !== null) return found;
      const root = at.getRootNode();
      at = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  };
  /**
   * Whether the element is disabled, as Chromium's tree and Playwright read
   * it: its nearest form control's :disabled (a disabled fieldset disables its
   * controls, not a link in it), or the nearest aria-disabled attribute above
   * it saying true (a nearer aria-disabled="false" enables it again).
   */
  const isDisabled = (target: Element): boolean => {
    const control = target.closest('button, input, select, textarea, option, optgroup');
    if (control?.matches(':disabled') === true) return true;
    return above(target, '[aria-disabled]')?.getAttribute('aria-disabled')?.toLowerCase() === 'true';
  };
  /** Whether the element, or anything above it, is inert. */
  const isInert = (target: Element): boolean => above(target, '[inert]') !== null;
  /** Whether the element holds focus within its own document or shadow root. */
  const holdsFocus = (target: Element): boolean => {
    const root = target.getRootNode();
    return (root instanceof Document || root instanceof ShadowRoot) && root.activeElement === target;
  };
  /**
   * The index of the option `wanted` names, or a reason it cannot be chosen. A
   * label matches an option's label, which is its text unless it has a label
   * attribute: then its text never matches, as on the web.
   */
  const findOption = (select: HTMLSelectElement, wanted: WantedOption): { readonly index: number } | Readiness => {
    const options = [...select.options];
    const byLabel = options.findIndex((option) => option.label === wanted.label);
    let index: number;
    if (wanted.index !== undefined) index = wanted.index >= 0 && wanted.index < options.length ? wanted.index : -1;
    else if (wanted.value !== undefined) index = options.findIndex((option) => option.value === wanted.value);
    else index = byLabel >= 0 ? byLabel : options.findIndex((option) => !option.hasAttribute('label') && option.text.trim() === wanted.label);
    const option = options[index];
    if (option === undefined) {
      const byValue = wanted.label !== undefined && options.some((each) => each.value === wanted.label) ? `; an option has the value ${JSON.stringify(wanted.label)}: pass { value: ${JSON.stringify(wanted.label)} }` : '';
      return { ok: false, reason: `no option matches ${JSON.stringify(wanted)}; the options are ${options.map((each) => JSON.stringify(each.label)).join(', ')}${byValue}` };
    }
    // :disabled covers an option a disabled group holds.
    if (option.matches(':disabled')) return { ok: false, reason: `option ${JSON.stringify(option.label)} is disabled` };
    return { index };
  };
  const fire = (target: Element): void => {
    target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const ops: NodeOps = {
    checkConnected() {
      live();
      return { ok: true };
    },
    checkEnabled(enabled) {
      const element = live();
      if (enabled && isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      if (isInert(element)) return { ok: false, reason: 'it is inert (a modal or the app blocks it)' };
      if (getComputedStyle(element).visibility !== 'visible') return { ok: false, reason: 'it is not visible' };
      return { ok: true };
    },
    hitTest(x, y) {
      const element = live();
      const root = element.getRootNode();
      const hit = (root instanceof ShadowRoot ? root : document).elementFromPoint(x, y);
      if (hit === null) return { ok: false, reason: 'its centre is outside the window' };
      // Walk up from the hit through slots, parents, and shadow hosts: Node.contains stops at a slot and a shadow root.
      for (let at: Node | null = hit; at !== null; at = at instanceof Element && at.assignedSlot !== null ? at.assignedSlot : (at.parentNode ?? (at instanceof ShadowRoot ? at.host : null))) {
        if (at === element) return { ok: true };
      }
      // A click inside the label of the element reaches it, unless it presses another control the label holds. Only
      // the control the label activates: a link in the same label, covered, is not what the click would press.
      const label = hit.closest('label');
      if (label !== null && label.control === element && !label.contains(hit.closest(INTERACTIVE))) return { ok: true };
      return { ok: false, reason: `another element (${hit.tagName.toLowerCase()}${hit.id === '' ? '' : `#${hit.id}`}) would receive the click` };
    },
    labelPoint() {
      const element = live();
      if (!(element instanceof HTMLInputElement) || (element.type !== 'checkbox' && element.type !== 'radio')) return null;
      const own = element.getBoundingClientRect();
      if (own.width > 0 && own.height > 0) return null;
      for (const label of element.labels ?? []) {
        if (!label.checkVisibility({ visibilityProperty: true })) continue;
        label.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const box = label.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      }
      return null;
    },
    scrollIntoView() {
      live().scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    },
    focus() {
      const target = live();
      // Whether the element took focus at all, even for a moment: an app's focus handler can send it on at once.
      let took = false;
      const onFocus = (): void => {
        took = true;
      };
      target.addEventListener('focus', onFocus, { once: true });
      if (target instanceof HTMLElement || target instanceof SVGElement) target.focus();
      target.removeEventListener('focus', onFocus);
      if (holdsFocus(target)) return 'held';
      return took ? 'moved' : 'none';
    },
    blur() {
      const target = live();
      if (target instanceof HTMLElement || target instanceof SVGElement) target.blur();
    },
    checkEditable() {
      const element = live();
      const type = typeOf(element);
      const field = element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && (TEXT_INPUT_TYPES.has(type) || SET_VALUE_TYPES.has(type))) ? element : undefined;
      if (field === undefined && !(element instanceof HTMLElement && element.isContentEditable)) return { ok: false, reason: 'it is not a text field' };
      if (isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      if (isInert(element)) return { ok: false, reason: 'it is inert (a modal or the app blocks it)' };
      // An editing host says so itself: it has no readOnly of its own.
      if (field?.readOnly === true || (field === undefined && element.getAttribute('aria-readonly')?.toLowerCase() === 'true')) return { ok: false, reason: 'it is read-only' };
      // A value can be set on a field no user reaches; typing into one would fail on its own.
      if (!element.checkVisibility({ visibilityProperty: true })) return { ok: false, reason: 'it is not visible' };
      return { ok: true };
    },
    setValue(value) {
      const element = live();
      if (!(element instanceof HTMLInputElement)) return null;
      const type = typeOf(element);
      const refused: Readiness = { ok: false, reason: `the ${type} input does not take ${JSON.stringify(value)}` };
      if (type === 'number' && value.trim() !== '' && Number.isNaN(Number(value))) return refused;
      if (!SET_VALUE_TYPES.has(type)) return null;
      // As Playwright's fill: the value trimmed, a color in the lower case the input keeps, a range clamped by the input.
      const set = type === 'color' ? value.trim().toLowerCase() : value.trim();
      if (type !== 'range') {
        // Tried on a detached input of the same type first: the field would sanitize a malformed value to "" and lose what it held.
        const probe = element.ownerDocument.createElement('input');
        probe.type = type;
        probe.value = set;
        if (probe.value !== set) return refused;
      }
      element.focus();
      element.value = set;
      fire(element);
      return { ok: true };
    },
    selectContents() {
      const target = live();
      if (target instanceof HTMLElement) target.focus();
      if (!holdsFocus(target)) return false;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        target.select();
        return true;
      }
      const range = target.ownerDocument.createRange();
      range.selectNodeContents(target);
      const selection = target.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    },
    readChecked() {
      const target = live();
      if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) return target.checked;
      if (!CHECKED_ROLES.has(target.getAttribute('role') ?? '')) return null;
      const aria = target.getAttribute('aria-checked');
      // A mixed checkbox is not checked: check() clicks it.
      return aria === 'true' ? true : aria === 'false' || aria === 'mixed' ? false : null;
    },
    checkSelect(wanted) {
      const element = live();
      if (!(element instanceof HTMLSelectElement)) return { ok: false, reason: 'it is not a <select>' };
      if (isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      if (isInert(element)) return { ok: false, reason: 'it is inert (a modal or the app blocks it)' };
      if (!element.checkVisibility({ visibilityProperty: true })) return { ok: false, reason: 'it is not visible' };
      const found = findOption(element, wanted);
      return 'index' in found ? { ok: true } : found;
    },
    selectOption(wanted) {
      const element = live();
      if (!(element instanceof HTMLSelectElement)) return { ok: false, reason: 'it is not a <select>' };
      const found = findOption(element, wanted);
      if (!('index' in found)) return found;
      element.focus();
      element.selectedIndex = found.index;
      fire(element);
      return { ok: true };
    },
    checkFileInput() {
      const element = live();
      if (!(element instanceof HTMLInputElement) || element.type !== 'file') return { ok: false, reason: 'it is not a file input' };
      if (isDisabled(element)) return { ok: false, reason: 'it is disabled' };
      return { ok: true };
    },
    takesFiles(count) {
      const input = live();
      if (count > 1 && input instanceof HTMLInputElement && !input.multiple) return { ok: false, reason: `the file input takes one file, not ${count}: it has no multiple attribute` };
      return { ok: true };
    },
    clearFiles() {
      const input = live();
      if (!(input instanceof HTMLInputElement) || input.files === null || input.files.length === 0) return;
      input.value = '';
      fire(input);
    },
    isNativeRadio() {
      const target = live();
      return target instanceof HTMLInputElement && target.type === 'radio';
    },
    isFileInput() {
      const target = live();
      return target instanceof HTMLInputElement && target.type === 'file';
    },
    readStyle(names) {
      const computed = getComputedStyle(live());
      return Object.fromEntries(names.map((property) => [property, computed.getPropertyValue(property)]));
    },
    // Measured from the boxes rather than with an IntersectionObserver, which answers at the page's next frame: a
    // window the app keeps hidden draws none.
    viewportIntersection() {
      const target = live();
      const box = target.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return { intersects: false, ratio: 0 };
      let { left, top, right, bottom } = box;
      const clip = (by: { left: number; top: number; right: number; bottom: number }, x: boolean, y: boolean): void => {
        if (x) [left, right] = [Math.max(left, by.left), Math.min(right, by.right)];
        if (y) [top, bottom] = [Math.max(top, by.top), Math.min(bottom, by.bottom)];
      };
      // A fixed box is clipped by the window alone; an absolute one by the scrollers that position it.
      let position = getComputedStyle(target).position;
      for (let parent = target.parentElement ?? (target.getRootNode() as ShadowRoot).host ?? null; parent !== null && position !== 'fixed'; parent = parent.parentElement ?? (parent.getRootNode() as ShadowRoot).host ?? null) {
        const style = getComputedStyle(parent);
        if (position !== 'absolute' || style.position !== 'static') {
          const inner = parent.getBoundingClientRect();
          const edge = { left: inner.left + parent.clientLeft, top: inner.top + parent.clientTop, right: inner.left + parent.clientLeft + parent.clientWidth, bottom: inner.top + parent.clientTop + parent.clientHeight };
          if (parent !== document.documentElement && parent !== document.body) clip(edge, style.overflowX !== 'visible', style.overflowY !== 'visible');
          position = style.position;
        }
      }
      clip({ left: 0, top: 0, right: innerWidth, bottom: innerHeight }, true, true);
      const inside = Math.max(0, right - left) * Math.max(0, bottom - top);
      const ratio = Math.min(1, inside / (box.width * box.height));
      return { intersects: inside > 0, ratio };
    },
    takesText() {
      const active = live();
      if (active.tagName === 'IFRAME' || active.tagName === 'WEBVIEW') return true;
      if (active instanceof HTMLElement && active.isContentEditable) return true;
      if (active instanceof HTMLTextAreaElement) return !active.readOnly && !active.disabled;
      if (TYPEAHEAD_ROLES.has(active.getAttribute('role') ?? '')) return true;
      // A date or time input takes typed digits; a range or color picker takes none.
      if (active instanceof HTMLInputElement) return (TEXT_INPUT_TYPES.has(typeOf(active)) || TYPED_PICKER_TYPES.has(typeOf(active))) && !active.readOnly && !active.disabled;
      return false;
    },
  };
  // TypeScript cannot tie `args` to the method `name` picks; `NodeOps` holds the two together for callers.
  const run = ops[name] as (...values: Parameters<NodeOps[K]>) => ReturnType<NodeOps[K]>;
  return run.apply(ops, args);
}

/**
 * The focused element under a document or shadow root, through every open
 * shadow root; it stops at a closed root's host. Its answer is a handle, which
 * only the protocol can hold, so it is no `NodeOps` entry: those answer in
 * JSON. Sent as source text: self-contained.
 */
export function activeUnder(root: Node): Element | null {
  let active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * The backend-resolvable elements a CSS selector matches in the document and
 * in each open shadow root, one root at a time as `querySelectorAll` does. It
 * never enters a frame. Sent as source text: self-contained.
 */
export function queryAll(selector: string): Element[] {
  const found: Element[] = [];
  const visit = (root: Document | ShadowRoot): void => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) visit(element.shadowRoot);
  };
  visit(document);
  return found;
}

/** Resolves after the next frame renders, or at once in a hidden window, which renders none. Sent as source text: self-contained. */
export function nextFrame(): Promise<void> {
  if (document.visibilityState === 'hidden') return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** The window's inner size in CSS pixels. Sent as source text: self-contained. */
export function viewportSize(): { readonly width: number; readonly height: number } {
  return { width: innerWidth, height: innerHeight };
}
