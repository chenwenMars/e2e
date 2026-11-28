/**
 * Reading a window and finding nodes in it: one accessibility tree and one
 * DOM snapshot of the same document, projected by `tree.ts`, and locator
 * expressions resolved over the projection.
 */

import { expressionSelectors, resolveExpression, type EngineSnapshot, type LocatorExpression, type SemanticNode } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { stale } from './errors.ts';
import type { AXNode } from './fields.ts';
import type { DomSnapshot } from './snapshot.ts';
import { projectTree, type ProjectionMode, type WindowGeometry } from './tree.ts';
import { nodeId, ROOT_ID, type AppWindow } from './windows.ts';

/** One window's raw read: the accessibility tree, the DOM snapshot of the same document, and its geometry. */
export interface RawRead {
  readonly window: AppWindow;
  readonly ax: readonly AXNode[];
  readonly dom: DomSnapshot;
  readonly geometry: WindowGeometry;
  /** Which of the page's documents was read. */
  readonly generation: number;
  readonly title: string;
  readonly url: string;
}

/** What a projection reads beside the window itself. */
export interface ProjectionContext {
  readonly testIdAttribute: string;
  /** The app's open windows, for the snapshot's tabs. */
  readonly open: readonly AppWindow[];
}

/** Reads the window: its accessibility tree and a DOM snapshot of the same document, with the geometry joining them. */
export async function readWindow(devtools: DevTools, window: AppWindow): Promise<RawRead> {
  const { session } = window.page;
  const { generation } = window.page;
  // Its three parts may come from either side of a navigation: only a read of one document is a read.
  const [{ nodes }, snapshot, metrics] = await inDocument(window, generation, () =>
    Promise.all([session.send('Accessibility.getFullAXTree'), devtools.snapshot(window.page), session.send('Page.getLayoutMetrics')]),
  );
  const css = metrics.cssLayoutViewport;
  const device = metrics.layoutViewport;
  if (snapshot === undefined) throw stale('the window has no document yet');
  return {
    window,
    ax: nodes,
    dom: snapshot.dom,
    generation,
    geometry: {
      scale: css.clientWidth > 0 ? device.clientWidth / css.clientWidth : 1,
      scrollX: metrics.cssVisualViewport.pageX,
      scrollY: metrics.cssVisualViewport.pageY,
      width: metrics.cssVisualViewport.clientWidth,
      height: metrics.cssVisualViewport.clientHeight,
    },
    title: snapshot.title,
    url: window.page.url(),
  };
}

/**
 * Runs a read that belongs to one document of the window, the one of
 * `generation`. A navigation under it makes the read stale whether it then
 * answers, with parts of two documents, or fails, in whatever way the
 * document going away made it fail: the caller reads again.
 */
export async function inDocument<T>(window: AppWindow, generation: number, read: () => Promise<T>): Promise<T> {
  const moved = (): boolean => window.page.generation !== generation;
  let result: T;
  try {
    result = await read();
  } catch (cause) {
    if (moved()) throw stale('the window loaded another document while it was read', cause);
    throw cause;
  }
  if (moved()) throw stale('the window loaded another document while it was read');
  return result;
}

/** Projects a read into the snapshot the harness receives; `keep` holds elements a selector matched, kept where the tree leaves them out. */
export function projectRead(raw: RawRead, mode: ProjectionMode, context: ProjectionContext, keep?: ReadonlySet<number>): EngineSnapshot {
  const projection = projectTree(raw.ax, raw.dom, raw.geometry, {
    mode,
    ...(keep === undefined ? {} : { keep }),
    testIdAttribute: context.testIdAttribute,
    idOf: (backendNodeId) => nodeId(raw.window, raw.generation, backendNodeId),
    rootId: ROOT_ID,
    baseUrl: raw.url,
    ...(raw.title === '' ? {} : { title: raw.title }),
  });
  const active = context.open.indexOf(raw.window);
  return {
    location: raw.url,
    root: projection.root,
    viewport: { width: raw.geometry.width, height: raw.geometry.height },
    ...(projection.truncated ? { truncated: true } : {}),
    ...(context.open.length > 1 && active >= 0 ? { tabs: { count: context.open.length, active } } : {}),
  };
}

/**
 * Resolves a locator expression in a read window. `resolveExpression` takes
 * the selector answer synchronously, so every selector in the expression is
 * queried first; the elements they match stay in the tree even where
 * Chromium's tree leaves them out.
 */
export async function locateIn(devtools: DevTools, raw: RawRead, expression: LocatorExpression, context: ProjectionContext): Promise<readonly SemanticNode[]> {
  const { window } = raw;
  const selected = new Map<string, ReadonlySet<number>>();
  await inDocument(window, raw.generation, async () => {
    for (const selector of expressionSelectors(expression)) selected.set(selector, await devtools.querySelectorAll(window.page, selector));
  });
  const keep = new Set([...selected.values()].flatMap((ids) => [...ids]));
  const { root } = projectRead(raw, 'node', context, keep);
  // The hook answers in document order, as `querySelectorAll` does; `aria-owns` can put the tree in another one.
  const domOrder = new Map([...keep].map((backendNodeId) => [nodeId(window, raw.generation, backendNodeId), raw.dom.element(backendNodeId)?.index]));
  const position = (node: SemanticNode): number => domOrder.get(node.ref.id) ?? Number.MAX_SAFE_INTEGER;
  return resolveExpression(expression, [root], {
    // The tree carries every element's text, so a text query reads it alone, as web() does.
    textQuery: 'text',
    selector: (selector, candidates) => {
      const ids = new Set([...(selected.get(selector) ?? [])].map((backendNodeId) => nodeId(window, raw.generation, backendNodeId)));
      return candidates.filter((node) => ids.has(node.ref.id)).toSorted((a, b) => position(a) - position(b));
    },
  });
}
