/**
 * What one element reads as: its role, states, level, value, and attributes,
 * each a pure function of the element's accessibility node (when Chromium
 * gave it one) and its DOM facts. An element the accessibility tree leaves
 * out reads by the same rules with no accessibility node.
 */

import type { SemanticNode } from '@e2e-dev/core/engine';
import { isSecureField, type DomFacts } from './snapshot.ts';

/** The fields of a Chromium `AXValue` the projection reads. */
interface AXValue {
  readonly value?: unknown;
}

/** One node of `Accessibility.getFullAXTree`, the fields the projection reads. */
export interface AXNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly ignoredReasons?: readonly { readonly name: string }[];
  readonly role?: AXValue;
  readonly name?: AXValue;
  readonly value?: AXValue;
  readonly properties?: readonly { readonly name: string; readonly value: AXValue }[];
  readonly parentId?: string;
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
}

/**
 * Where a model's observation and a locator's read differ, as data: an
 * observation is bounded and shows what a model reads a control by; a locator
 * reads every attribute, whole fields, and each element's text with its
 * descendants'.
 */
export interface ProjectionPolicy {
  readonly textLimit: number;
  readonly nameLimit: number;
  /** The most nodes one projection keeps: a locator reads every node, or it would miss a match past the cap. */
  readonly maxNodes: number;
  /** The attributes kept beside every `aria-*` one; null keeps all of them. */
  readonly attributes: ReadonlySet<string> | null;
  /** A link shows as origin and path, its query and fragment elided. */
  readonly redactHref: boolean;
  /** An editing host with no role reads as a text field. A role query does not find it as one, as the web's does not. */
  readonly editingHostRole: boolean;
  /** A checkbox or radio reports the token it submits. */
  readonly checkableValue: boolean;
  /** Reports `empty`, which only `toBeEmpty` reads. */
  readonly emptyState: boolean;
  /** An element's text includes its descendants', and several runs under one element stay nodes an exact text query finds. */
  readonly descendantText: boolean;
  /** An element with a test id that the accessibility tree leaves out still joins the tree. */
  readonly hiddenTestIds: boolean;
}

/**
 * Chromium's own role names mapped to the roles of the engine contract's
 * vocabulary, where an image is `image` (`getByRole('img')` is that role's
 * alias, resolved before it reaches the tree). A role missing here and spelled
 * with a capital is Chromium-internal and reads as a generic container.
 */
const CHROMIUM_ROLES: Readonly<Record<string, string>> = {
  image: 'image',
  MenuListPopup: 'listbox',
  MenuListOption: 'option',
  Iframe: 'iframe',
  IframePresentational: 'iframe',
  DisclosureTriangle: 'button',
  // Date, time, and color inputs, which the web reads as text fields.
  Date: 'textbox',
  DateTime: 'textbox',
  InputTime: 'textbox',
  ColorWell: 'textbox',
  Canvas: 'image',
  Video: 'generic',
  Audio: 'generic',
};

/** Containers that say nothing on their own: kept only with a name, a test id, or for a locator's `selector`. */
const GENERIC_ROLES = new Set(['generic', 'none', 'presentation', 'LabelText', 'Section', 'Pre', 'Ruby', 'Abbr', 'Mark', 'Legend', 'Unknown']);

/** Reasons Chromium leaves a node out that also hide it from a person: its subtree never reaches the tree. */
const HIDING_REASONS = new Set(['ariaHiddenElement', 'ariaHiddenSubtree', 'notRendered', 'inertElement', 'inertSubtree', 'notVisible']);

/** Roles whose value is what a person typed or picked. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

/** ARIA range roles: an element's value is its `aria-valuetext`, else its `aria-valuenow`, as written, as the web reads it. */
const RANGE_ROLES = new Set(['slider', 'spinbutton', 'progressbar', 'meter', 'scrollbar']);

/** Roles whose read-only state is their `aria-readonly`, as the web reads it. */
const ARIA_READONLY_ROLES = new Set([
  'checkbox', 'combobox', 'grid', 'gridcell', 'listbox', 'radiogroup', 'slider', 'spinbutton', 'textbox',
  'searchbox', 'columnheader', 'rowheader', 'switch', 'treegrid',
]);

/** Roles whose level is their `aria-level`, as the web reads it; a heading element's comes from its tag. */
const LEVEL_ROLES = new Set(['heading', 'listitem', 'row', 'treeitem']);

/** The states read straight from Chromium's properties. */
const AX_STATES = new Set(['checked', 'pressed', 'disabled', 'expanded', 'selected', 'focused']);

export function stringOf(value: AXValue | undefined): string | undefined {
  const raw = value?.value;
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === 'string' ? raw : String(raw);
}

function property(node: AXNode | undefined, name: string): unknown {
  return node?.properties?.find((entry) => entry.name === name)?.value.value;
}

/** Whether Chromium hides the node from a person, and its subtree with it. */
export function isHiddenSubtree(node: AXNode): boolean {
  return node.ignored && node.ignoredReasons?.some((reason) => HIDING_REASONS.has(reason.name)) === true;
}

/** A focusable element with no role (a span with a tabindex) is a control of the app's own. */
export function isFocusable(node: AXNode): boolean {
  return !node.ignored && property(node, 'focusable') === true;
}

function isEditingHost(facts: DomFacts | undefined): boolean {
  const editable = facts?.attributes['contenteditable'];
  return editable !== undefined && editable.toLowerCase() !== 'false';
}

/** An input or textarea: its value is the element's own, and its inner editor is not read as text. */
export function isTextField(facts: DomFacts | undefined): boolean {
  return facts?.nodeName === 'INPUT' || facts?.nodeName === 'TEXTAREA';
}

/** An input drawn as a button: the value it shows is its text, as the web reads it. */
export function isButtonInput(facts: DomFacts | undefined): boolean {
  return facts?.nodeName === 'INPUT' && ['submit', 'button'].includes(facts.attributes['type']?.toLowerCase() ?? '');
}

export function isSecure(facts: DomFacts | undefined): boolean {
  return facts !== undefined && isSecureField(facts.nodeName, facts.attributes);
}

export function isCheckable(facts: DomFacts | undefined): boolean {
  return facts?.nodeName === 'INPUT' && ['checkbox', 'radio'].includes(facts.attributes['type']?.toLowerCase() ?? '');
}

interface Role {
  /** The contract role the element reads as. */
  readonly role: string;
  /** A container that says nothing on its own: it gives its place to its children unless something makes it addressable. */
  readonly silent: boolean;
}

export function roleOf(node: AXNode, facts: DomFacts | undefined, policy: ProjectionPolicy): Role {
  const chromium = stringOf(node.role) ?? '';
  const mapped = CHROMIUM_ROLES[chromium] ?? (/^[A-Z]/.test(chromium) ? 'generic' : chromium);
  const generic = mapped === 'generic' || GENERIC_ROLES.has(chromium);
  const role = policy.editingHostRole && generic && isEditingHost(facts) ? 'textbox' : mapped;
  return { role, silent: node.ignored || (role !== 'textbox' && generic) };
}

function inputPurposeOf(facts: DomFacts): SemanticNode['inputPurpose'] {
  const autocomplete = facts.attributes['autocomplete']?.toLowerCase();
  if (isSecure(facts) || autocomplete === 'current-password' || autocomplete === 'new-password') return 'password';
  return autocomplete === 'username' || autocomplete === 'one-time-code' ? autocomplete : undefined;
}

/**
 * A heading element's level is its tag's, whatever its aria-level; an ARIA
 * role's is its aria-level, as the web reads them (Chromium computes one for
 * every treeitem, and a default for a role="heading" with none).
 */
function levelOf(role: string, facts: DomFacts | undefined): number | undefined {
  const tagLevel = /^H([1-6])$/.exec(facts?.nodeName ?? '')?.[1];
  if (role === 'heading' && tagLevel !== undefined) return Number(tagLevel);
  const ariaLevel = Number.parseInt(facts?.attributes['aria-level'] ?? '', 10);
  return LEVEL_ROLES.has(role) && ariaLevel >= 1 ? ariaLevel : undefined;
}

/**
 * Whether the element is read-only, as the web reads it: a native field by
 * its `readonly` attribute, whatever Chromium reports for it (nothing for a
 * select); then what Chromium reports; then a role that takes `aria-readonly`
 * by that attribute. An editing host, and an element inside one, takes text:
 * Chromium marks it `editable` and gives no read-only state. Undefined for
 * anything else, which has no read-only state.
 */
function readOnlyOf(node: AXNode | undefined, facts: DomFacts | undefined, role: string): boolean | undefined {
  if (isTextField(facts) || facts?.nodeName === 'SELECT') return 'readonly' in facts!.attributes;
  // What the element says of itself comes first: Chromium reports an editing host as not read-only whatever it says.
  const said = ARIA_READONLY_ROLES.has(role) ? facts?.attributes['aria-readonly']?.toLowerCase() : undefined;
  if (said !== undefined) return said === 'true';
  const reported = property(node, 'readonly');
  if (reported !== undefined) return reported === true || reported === 'true';
  if (ARIA_READONLY_ROLES.has(role)) return false;
  return node?.properties?.some((entry) => entry.name === 'editable') === true ? false : undefined;
}

/** As written, as the web reads it: Chromium clamps aria-valuenow, drops aria-valuetext, and makes up a midpoint. */
function rangeValueOf(facts: DomFacts | undefined): string {
  const filled = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value);
  const attributes = facts?.attributes ?? {};
  // A native progress or meter element's value is its value attribute; an empty attribute counts as none.
  const native = facts?.nodeName === 'PROGRESS' || facts?.nodeName === 'METER' ? filled(attributes['value']) : undefined;
  return filled(attributes['aria-valuetext']) ?? filled(attributes['aria-valuenow']) ?? native ?? '';
}

function valueOf(node: AXNode | undefined, facts: DomFacts | undefined, role: string, policy: ProjectionPolicy): string | undefined {
  // A select's value is what its chosen option submits, as `select.value` reads it; its options name the labels.
  if (facts?.nodeName === 'SELECT') return facts.selectValue ?? '';
  // A checkbox or radio submits its value attribute, `on` without one, whatever its state.
  if (isCheckable(facts)) return policy.checkableValue ? (facts!.attributes['value'] ?? 'on') : undefined;
  if (isSecure(facts)) return undefined;
  // A field's value is the element's own, whatever role Chromium gives it (a date input is no textbox).
  if (isTextField(facts)) return (facts!.nodeName === 'INPUT' ? facts!.inputValue : facts!.textValue) ?? '';
  if (RANGE_ROLES.has(role)) return rangeValueOf(facts);
  // An editing host or an ARIA widget has no DOM value: its value is the one Chromium computes. A combobox that only
  // shows its choice (a div) has none, as on the web; Chromium would echo its text.
  if (VALUE_ROLES.has(role) && (role !== 'combobox' || isEditingHost(facts))) return stringOf(node?.value) ?? '';
  return undefined;
}

/**
 * A link as an observation shows it, as the web engine reduces it: origin and
 * path, a query and a fragment only as `?…` and `#…` (they routinely carry
 * tokens), and a scheme with no origin (`data:`, `javascript:`), whose path
 * is a whole file or script, as `scheme:…`. A relative link resolves against
 * the document's URL. The web engine's own copy is `originAndPath` in
 * `packages/web/src/in-page/read-semantics.ts`: a change to what either hides
 * belongs in both. They differ in one place on purpose: this one shows a
 * `file:` path, since an Electron app's own pages are local files.
 */
function originAndPath(value: string, base: string | undefined): string {
  const elided = (query: boolean, fragment: boolean): string => `${query ? '?…' : ''}${fragment ? '#…' : ''}`;
  try {
    const url = new URL(value, base);
    const rest = `${url.pathname}${elided(url.search !== '', url.hash !== '')}`;
    if (url.protocol === 'blob:') {
      const inner = URL.canParse(url.pathname) ? new URL(url.pathname) : null;
      return inner === null || inner.origin === 'null' ? 'blob:…' : `blob:${inner.origin}${inner.pathname}${elided(url.search !== '', url.hash !== '')}`;
    }
    if (url.origin !== 'null') return `${url.origin}${rest}`;
    // A local page's links are files beside it: the path says where one goes, as the web shows it.
    if (url.protocol === 'mailto:' || url.protocol === 'tel:' || url.protocol === 'file:') return `${url.protocol}${url.protocol === 'file:' ? '//' : ''}${rest}`;
    return `${url.protocol}…`;
  } catch {
    const [beforeFragment = '', ...fragment] = value.split('#');
    const [path = '', ...query] = beforeFragment.split('?');
    return `${path}${elided(query.join('?') !== '', fragment.join('#') !== '')}`;
  }
}

/**
 * The attributes a read shows. Whole, as the web engine keeps them: the
 * harness redacts an attribute by whole values only, so a cut here could
 * leave the start of a secret behind; it bounds what it renders after
 * redaction.
 */
function shownAttributes(facts: DomFacts, policy: ProjectionPolicy, baseUrl: string | undefined): Record<string, string> {
  const shown: Record<string, string> = {};
  const secure = isSecure(facts);
  for (const [key, value] of Object.entries(facts.attributes)) {
    if (secure && key === 'value') continue;
    if (policy.attributes !== null && !policy.attributes.has(key) && !key.startsWith('aria-')) continue;
    shown[key] = policy.redactHref && key === 'href' ? originAndPath(value, baseUrl) : value;
  }
  return shown;
}

/** The elements a `disabled` attribute disables. */
const NATIVE_CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP', 'FIELDSET']);

function statesOf(node: AXNode | undefined, facts: DomFacts | undefined, role: string): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  if (isSecure(facts)) states['secure'] = true;
  for (const { name, value } of node?.properties ?? []) {
    if (AX_STATES.has(name)) states[name] = value.value === true || value.value === 'true';
  }
  // An element the accessibility tree leaves out (a control with `hidden`) still has the state its own DOM gives it.
  if (node === undefined && facts !== undefined) {
    if (NATIVE_CONTROLS.has(facts.nodeName)) states['disabled'] = 'disabled' in facts.attributes;
    if (isCheckable(facts)) states['checked'] = facts.checked;
  }
  const readOnly = readOnlyOf(node, facts, role);
  if (readOnly !== undefined) states['readonly'] = readOnly;
  return states;
}

/** The fields of a contract node an element's own facts decide; its name, box, and text come from the tree around it. */
export interface ElementFields {
  readonly states: Record<string, boolean>;
  readonly testId?: string;
  readonly inputPurpose?: SemanticNode['inputPurpose'];
  readonly level?: number;
  /** Whole: the projection bounds it. */
  readonly value?: string;
  readonly attributes?: Record<string, string>;
}

export interface FieldContext {
  readonly policy: ProjectionPolicy;
  readonly testIdAttribute: string;
  /** The document's URL, which a relative link resolves against. */
  readonly baseUrl: string | undefined;
}

/** Reads an element's fields. `node` is undefined for an element the accessibility tree leaves out. */
export function elementFields(node: AXNode | undefined, facts: DomFacts | undefined, role: string, context: FieldContext): ElementFields {
  const testId = facts?.attributes[context.testIdAttribute.toLowerCase()];
  const inputPurpose = facts === undefined ? undefined : inputPurposeOf(facts);
  const level = levelOf(role, facts);
  const value = valueOf(node, facts, role, context.policy);
  const attributes = facts === undefined ? {} : shownAttributes(facts, context.policy, context.baseUrl);
  return {
    states: statesOf(node, facts, role),
    ...(testId === undefined ? {} : { testId }),
    ...(inputPurpose === undefined ? {} : { inputPurpose }),
    ...(level === undefined ? {} : { level }),
    ...(value === undefined ? {} : { value }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
  };
}
