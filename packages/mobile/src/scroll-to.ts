/**
 * `scrollTo` on a device, apart from the surface: the loop that drags toward
 * an edge until a drag moves nothing, and what a container shows between drags.
 */

import { EngineError, type ScrollDirection, type ScrollEdge } from '@e2e-dev/core/engine';
import type { ProjectedNode } from './nodes.ts';
import type { Rect } from './support.ts';

/**
 * Roles left out of what a container shows: a spinner (a pull-to-refresh
 * indicator, a loading row) changes on its own, so counting it would read a
 * container at its edge as still moving.
 */
const RESTLESS_ROLES: ReadonlySet<string> = new Set(['progressbar', 'status']);

/** Most drags sent between two reads: a read costs more than a drag. */
const MAX_EDGE_DRAGS = 3;

/**
 * The direction that moves content toward `edge`, for `swipeWithin`: to reach
 * the bottom the content scrolls down, so the finger travels up. Without
 * momentum it runs from a quarter in from one side of the region to a quarter
 * in from the other, released without a hold so the content keeps going; the
 * quarter keeps the start off a sticky footer or a tab bar.
 */
export const EDGE_DIRECTION: Readonly<Record<ScrollEdge, ScrollDirection>> = { top: 'up', bottom: 'down', left: 'left', right: 'right' };

/** What the drag loop needs from the device. */
export interface EdgeDevice {
  /** Sends `count` drags toward the edge, back to back. */
  drag(count: number): Promise<void>;
  /** What the region shows after the content rests, or `undefined` for a read that left nodes out. */
  read(): Promise<string | undefined>;
  /** What is left of the input budget. */
  remainingMs(): number;
}

/**
 * Drags toward an edge until a drag leaves what the region shows unchanged,
 * starting from `before`, the first read. The first pass is one drag, since a
 * container already at its edge needs no more; one that moves gets up to
 * three per read. No pass starts that the budget cannot finish, estimated
 * from the last read and the last drags' time per drag, since the drag count
 * grows between passes. A read that left nodes out never reads as unchanged.
 */
export async function dragToEdge(device: EdgeDevice, before: string | undefined): Promise<void> {
  let last = before;
  let drags = 0;
  let readMs = 0;
  let dragMs = 0;
  for (let passes = 0; ; passes += 1) {
    const count = Math.min(passes + 1, MAX_EDGE_DRAGS);
    if (passes > 0 && device.remainingMs() < readMs + dragMs * count) {
      const reason = last === undefined
        ? `the screen was read with nodes left out (agent-device truncated it) after ${drags} drags, so the edge could not be confirmed`
        : `the content was still moving after ${drags} drags when the budget ran out`;
      throw new EngineError('OPERATION_TIMEOUT', reason, { retryable: false });
    }
    const dragStarted = Date.now();
    await device.drag(count);
    drags += count;
    const readStarted = Date.now();
    dragMs = (readStarted - dragStarted) / count;
    const after = await device.read();
    readMs = Date.now() - readStarted;
    if (after !== undefined && after === last) return;
    last = after;
  }
}

/**
 * What a region of the screen shows, as one comparable string: every node
 * whose box meets the region, by role, name, text, value, test id (pages of a
 * gallery can differ in nothing else), and box rounded to whole points. Two
 * equal signatures around a drag mean the drag moved nothing, so the
 * container is at its edge.
 */
export function regionSignature(index: readonly ProjectedNode[], region: Rect): string {
  const lines: string[] = [];
  for (const { node } of index) {
    const rect = node.rect;
    if (rect === undefined || (node.role !== undefined && RESTLESS_ROLES.has(node.role))) continue;
    if (rect.x >= region.x + region.width || rect.x + rect.width <= region.x) continue;
    if (rect.y >= region.y + region.height || rect.y + rect.height <= region.y) continue;
    const box = [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(',');
    lines.push([node.role ?? '', node.name ?? '', node.text ?? '', node.value ?? '', node.testId ?? '', box].join('\u0000'));
  }
  return lines.join('\n');
}

/** The part of `rect` on a screen of `size`; a box wholly off it has no area. */
export function clipTo(rect: Rect, size: { readonly width: number; readonly height: number }): Rect {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(size.width, rect.x + rect.width) - x),
    height: Math.max(0, Math.min(size.height, rect.y + rect.height) - y),
  };
}

/** A region cut off above `top` (the soft keyboard's edge), so a drag never starts on a key. */
export function above(region: Rect, top: number | undefined): Rect {
  if (top === undefined || top >= region.y + region.height) return region;
  return { ...region, height: Math.max(0, top - region.y) };
}
