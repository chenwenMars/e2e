/**
 * The waits before an action: until the node can take it, and for a pointer
 * action the point to send it to.
 */

import { pollCondition, type Deadline, type OperationContext, type ViewportPoint } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { GONE, notActionable } from './errors.ts';
import type { NodeOps, Readiness } from './in-page/node-ops.ts';
import type { AppWindow } from './windows.ts';

/** A box in viewport CSS pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One node an action waits on: where it is, and the deadline the wait gives up at. */
export interface WaitTarget {
  readonly devtools: DevTools;
  readonly window: AppWindow;
  readonly backendNodeId: number;
  readonly operation: OperationContext;
  readonly deadline: Deadline;
}

/** The checks `waitReady` runs: the `NodeOps` that answer `Readiness`. */
type ReadinessCheck = { [K in keyof NodeOps]: ReturnType<NodeOps[K]> extends Readiness ? K : never }[keyof NodeOps];

/** Waits until a page-side check passes, for actions that need no point. Gives up with the check's last reason at the deadline. */
export async function waitReady<K extends ReadinessCheck>(target: WaitTarget, check: K, ...args: Parameters<NodeOps[K]>): Promise<void> {
  let reason = '';
  await pollCondition({
    deadline: target.deadline,
    signal: target.operation.signal,
    negated: false,
    evaluate: async () => {
      const state: Readiness = await target.devtools.callOn(target.window.page, target.backendNodeId, check, ...args);
      if (state.ok) return true;
      reason = state.reason;
      return false;
    },
    onTimeout: () => notActionable(`the element cannot take the action: ${reason}`),
  });
}

/**
 * Waits until the node can take a pointer action, then returns the point to
 * send it to: in the document, laid out with a box, enabled when `enabled`
 * asks, scrolled into view, and the topmost thing at its centre (or a label
 * for it). Gives up with the last reason at the deadline.
 */
export async function actionablePoint(target: WaitTarget, enabled: boolean): Promise<ViewportPoint> {
  const { devtools, window, backendNodeId } = target;
  const { session } = window.page;
  let reason = 'it never became actionable';
  let point: ViewportPoint | undefined;
  let covered = false;
  const probe = async (): Promise<ViewportPoint | string> => {
    const state = await devtools.callOn(window.page, backendNodeId, 'checkEnabled', enabled);
    if (!state.ok) return state.reason;
    // After a read where something covered the element, it is scrolled to the window's centre, clear of sticky chrome at an edge.
    if (covered) await devtools.callOn(window.page, backendNodeId, 'scrollIntoView');
    else await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => devtools.callOn(window.page, backendNodeId, 'scrollIntoView'));
    // A checkbox or radio a label draws has no box of its own: the click goes to the label, as on the web.
    const box = (await contentBox(target)) ?? pointBox(await devtools.callOn(window.page, backendNodeId, 'labelPoint'));
    if (box === undefined) return 'it has no box on screen (hidden, or empty)';
    // A node wider or taller than the window is clicked in the middle of the part the window shows.
    const { cssVisualViewport: viewport } = await session.send('Page.getLayoutMetrics');
    const shown = clip(box, viewport.clientWidth, viewport.clientHeight);
    if (shown === undefined) return 'it is outside the window';
    const centre = whole({ x: shown.x + shown.width / 2, y: shown.y + shown.height / 2 });
    const hit = await devtools.callOn(window.page, backendNodeId, 'hitTest', centre.x, centre.y);
    covered = !hit.ok;
    return hit.ok ? centre : hit.reason;
  };
  await pollCondition({
    deadline: target.deadline,
    signal: target.operation.signal,
    negated: false,
    evaluate: async () => {
      const found = await probe();
      if (typeof found === 'string') {
        reason = found;
        return false;
      }
      point = found;
      return true;
    },
    onTimeout: () => notActionable(`the element cannot take the action: ${reason}`),
  });
  if (point === undefined) throw notActionable(`the element cannot take the action: ${reason}`);
  return point;
}

/** The node's first content box with an area, in viewport CSS pixels; undefined when it has none. A node that is gone fails. */
export async function contentBox(target: Pick<WaitTarget, 'devtools' | 'window' | 'backendNodeId'>): Promise<Box | undefined> {
  const { session } = target.window.page;
  const { quads } = await session.send('DOM.getContentQuads', { backendNodeId: target.backendNodeId }).catch((cause: unknown) => {
    if (cause instanceof Error && GONE.test(cause.message)) throw cause;
    return { quads: [] as number[][] };
  });
  return quads.map(boxOf).find((box) => box.width * box.height > 0);
}

/** A point as the one-pixel box around it, so it clips and centres as any box does. */
function pointBox(point: ViewportPoint | null): Box | undefined {
  return point === null ? undefined : { x: point.x - 0.5, y: point.y - 0.5, width: 1, height: 1 };
}

/** Rounds a point to whole CSS pixels: Chromium truncates fractional pointer coordinates. */
export function whole(point: ViewportPoint): ViewportPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function boxOf(quad: readonly number[]): Box {
  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The part of a box inside a viewport of the given size, or undefined when none of it is. */
function clip(box: Box, width: number, height: number): Box | undefined {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(width, box.x + box.width);
  const bottom = Math.min(height, box.y + box.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}
