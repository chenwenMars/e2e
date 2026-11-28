/**
 * The DevTools protocol calls on a window's nodes: the ones that run
 * `in-page/` functions in the engine's isolated world, and the DOM snapshot.
 */

import { TestError } from '@e2e-dev/core/engine';
import type { Session } from './cdp/connection.ts';
import { stale } from './errors.ts';
import { activeUnder, nodeOp, queryAll, type NodeOps } from './in-page/node-ops.ts';
import { thrown, WORLD_NAME, type PageTarget } from './page.ts';
import { DomSnapshot, SNAPSHOT_STYLES } from './snapshot.ts';

const NODE_OP = nodeOp.toString();
const ACTIVE_UNDER = activeUnder.toString();

let objectGroups = 0;

/** A DevTools object group of one call's own: releasing it frees that call's handles and never another's still in use. */
function newObjectGroup(): string {
  objectGroups += 1;
  return `${WORLD_NAME}${objectGroups}`;
}

/** One DOM snapshot of a window's main document, indexed, with the document's title. */
export interface DocumentSnapshot {
  readonly dom: DomSnapshot;
  readonly title: string;
}

export class DevTools {
  /** Runs `work` in the window's isolated world with an object group of its own, released when the call ends. */
  private async inWorld<T>(page: PageTarget, work: (session: Session, contextId: number, group: string) => Promise<T>): Promise<T> {
    const { session } = page;
    const contextId = await page.world();
    const group = newObjectGroup();
    try {
      return await work(session, contextId, group);
    } finally {
      await session.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    }
  }

  /**
   * Runs one of `NodeOps` on a node in the isolated world and returns its
   * JSON result. The node is resolved fresh from its backend id, so a node
   * the document dropped fails as stale.
   */
  callOn<K extends keyof NodeOps>(page: PageTarget, backendNodeId: number, name: K, ...args: Parameters<NodeOps[K]>): Promise<ReturnType<NodeOps[K]>> {
    return this.inWorld(page, async (session, executionContextId, objectGroup) => {
      const { object } = await session.send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup });
      if (object.objectId === undefined) throw stale(`node ${backendNodeId} is no longer in the window`);
      const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: NODE_OP,
        arguments: [{ objectId: object.objectId }, { value: name }, { value: args }],
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails !== undefined) throw new Error(thrown(exceptionDetails));
      return result.value;
    });
  }

  /**
   * Whether the element with keyboard focus takes typed text. Page script
   * stops at the host of a closed shadow root; the DevTools protocol reaches
   * into one, so the walk goes on inside until it finds the focused element.
   */
  focusedTakesText(page: PageTarget): Promise<boolean> {
    return this.inWorld(page, async (session, executionContextId, objectGroup) => {
      const focusedUnder = async (objectId: string): Promise<string | undefined> =>
        (await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: ACTIVE_UNDER, arguments: [{ objectId }], objectGroup })).result.objectId;
      const { result: document } = await session.send('Runtime.evaluate', { expression: 'document', contextId: executionContextId, objectGroup });
      const first = document.objectId === undefined ? undefined : await focusedUnder(document.objectId);
      if (first === undefined) return false;
      let active: string = first;
      for (;;) {
        const { node } = await session.send('DOM.describeNode', { objectId: active, depth: 1, pierce: true });
        const closed = node.shadowRoots?.find((root) => root.shadowRootType === 'closed');
        if (closed === undefined) break;
        const { object: root } = await session.send('DOM.resolveNode', { backendNodeId: closed.backendNodeId, executionContextId, objectGroup });
        // Nothing focused inside: the host itself has focus.
        const inner: string | undefined = root.objectId === undefined ? undefined : await focusedUnder(root.objectId);
        if (inner === undefined) break;
        active = inner;
      }
      const { result } = await session.send('Runtime.callFunctionOn', {
        objectId: active,
        functionDeclaration: NODE_OP,
        arguments: [{ objectId: active }, { value: 'takesText' satisfies keyof NodeOps }, { value: [] }],
        returnByValue: true,
      });
      return result.value === true;
    });
  }

  /**
   * The backend ids of the elements a CSS selector matches in the window's
   * document and in each open shadow root (`queryAll`), run in the isolated
   * world.
   */
  querySelectorAll(page: PageTarget, selector: string): Promise<ReadonlySet<number>> {
    return this.inWorld(page, async (session, contextId, objectGroup) => {
      const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression: `(${queryAll.toString()})(${JSON.stringify(selector)})`, contextId, objectGroup });
      if (exceptionDetails !== undefined) throw new TestError('INVALID_LOCATOR', `${JSON.stringify(selector)} is not a CSS selector: ${thrown(exceptionDetails).split('\n')[0]}`);
      if (result.objectId === undefined) return new Set<number>();
      const { result: entries } = await session.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
      // One round trip per match, sent together: a broad selector on a long list is read on every poll of an expect.
      const described = await Promise.all(
        entries.flatMap((entry) => (/^\d+$/.test(entry.name) && entry.value?.objectId !== undefined ? [session.send('DOM.describeNode', { objectId: entry.value.objectId })] : [])),
      );
      return new Set(described.map(({ node }) => node.backendNodeId));
    });
  }

  /** One DOM snapshot of the window's main document, the only place one is captured; undefined while it has none. */
  async snapshot(page: PageTarget): Promise<DocumentSnapshot | undefined> {
    const { documents, strings } = await page.session.send('DOMSnapshot.captureSnapshot', { computedStyles: [...SNAPSHOT_STYLES] });
    const document = documents[0];
    return document === undefined ? undefined : { dom: new DomSnapshot(document, strings), title: strings[document.title] ?? '' };
  }
}
