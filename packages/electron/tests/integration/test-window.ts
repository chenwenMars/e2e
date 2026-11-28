/**
 * One hidden Electron window for the integration tests, started and reached
 * the way the engine does it: the binary spawned with the DevTools pipe, and
 * its page target attached.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ElectronProcess } from '../../src/launcher.ts';
import { PageTarget } from '../../src/page.ts';
import { electronBinary, launchEnvironment } from './electron-binary.ts';

const MAIN = `
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => new BrowserWindow({ show: false, width: 800, height: 600 }).loadURL('about:blank'));
app.on('window-all-closed', () => app.quit());
`;

export interface TestWindow {
  readonly page: PageTarget;
  /** Replaces the window's document with `html`. */
  setContent(html: string): Promise<void>;
  /** Runs a self-contained function in the page's own world, with a JSON argument. */
  inPage<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  /** The backend id of the first element `selector` matches. */
  element(selector: string): Promise<number>;
  /** An element's box in the viewport. */
  box(selector: string): Promise<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number }>;
  inputValue(selector: string): Promise<string>;
  close(): Promise<void>;
}

export async function openTestWindow(): Promise<TestWindow> {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-electron-test-'));
  writeFileSync(path.join(directory, 'main.js'), MAIN);
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'test-window', main: 'main.js' }));
  const app = new ElectronProcess({ executable: electronBinary(), args: [`--user-data-dir=${path.join(directory, 'data')}`, directory], cwd: directory, env: launchEnvironment() });
  const { root } = app.browser;

  const page = await new Promise<PageTarget>((resolve, reject) => {
    void app.exited.then(() => reject(new Error(`Electron exited before it opened a window:\n${app.stderrTail(10).join('\n')}`)));
    root.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type !== 'page') return;
      void (async () => {
        const { sessionId } = await root.send('Target.attachToTarget', { targetId: targetInfo.targetId, flatten: true });
        const target = new PageTarget(targetInfo.targetId, app.browser.session(sessionId), targetInfo.url);
        await target.session.send('Page.enable');
        await target.session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        resolve(target);
      })().catch(reject);
    });
    root.send('Target.setDiscoverTargets', { discover: true }).catch(reject);
  });
  const { session } = page;

  const inPage = async <R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> => {
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as R;
  };

  return {
    page,
    inPage,
    async setContent(html) {
      const { frameTree } = await session.send('Page.getFrameTree');
      await session.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
      page.documentChanged();
    },
    async element(selector) {
      const { result } = await session.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
      if (result.objectId === undefined) throw new Error(`no element matches ${selector}`);
      const { node } = await session.send('DOM.describeNode', { objectId: result.objectId });
      return node.backendNodeId;
    },
    box: (selector) =>
      inPage((query: string) => {
        const { x, y, width, height } = document.querySelector(query)!.getBoundingClientRect();
        return { x, y, width, height };
      }, selector),
    inputValue: (selector) => inPage((query: string) => (document.querySelector(query) as HTMLInputElement).value, selector),
    async close() {
      app.killNow();
      await app.exited;
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
