/**
 * `scrollTo` against a real page: which container a screen and a node
 * scroll, the edges of both axes in either writing direction, smooth-scroll
 * CSS, shadow roots, content that grows at the end, and the cases where
 * nothing scrolls.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EngineError, type EngineHandle, type NodeRef, type ScrollEdge } from '@e2e-dev/core/engine';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../../src/closed-shadow.ts';
import { web } from '../../src/index.ts';
import { scrollToEdge } from '../../src/scroll-to.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
});

const ROWS = Array.from({ length: 60 }, (_, index) => `<p style="height: 40px; margin: 0">Row ${index + 1}</p>`).join('');

/** Scrolls the screen, or the node `selector` names, to `edge` within `timeoutMs`. */
function scroll(edge: ScrollEdge, selector?: string, timeoutMs = 2_000): Promise<void> {
  const operation = { timeoutMs, signal: new AbortController().signal };
  return scrollToEdge(page, selector === undefined ? undefined : { kind: 'locator', locator: page.locator(selector) }, edge, operation);
}

/** The offsets of the page and of the element `selector` names. */
function offsets(selector?: string): Promise<{ top: number; left: number; maxTop: number; maxLeft: number }> {
  return page.evaluate((query) => {
    const element = query === undefined ? document.scrollingElement! : document.querySelector(query)!;
    return {
      top: element.scrollTop,
      left: element.scrollLeft,
      maxTop: element.scrollHeight - element.clientHeight,
      maxLeft: element.scrollWidth - element.clientWidth,
    };
  }, selector);
}

describe('scrollTo on the screen', () => {
  it('scrolls the page to its bottom and back to its top', async () => {
    await page.setContent(ROWS);
    await scroll('bottom');
    const bottom = await offsets();
    expect(bottom.maxTop).toBeGreaterThan(0);
    expect(bottom.top).toBe(bottom.maxTop);
    await scroll('top');
    expect((await offsets()).top).toBe(0);
  });

  it('scrolls the pane under the viewport center when the page itself does not scroll', async () => {
    await page.setContent(`
      <body style="margin: 0; overflow: hidden">
        <header style="height: 60px">Shell</header>
        <main id="pane" style="height: 540px; overflow-y: auto">${ROWS}</main>
      </body>`);
    await scroll('bottom');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('scrolls the page, not a pane that happens to sit under the center', async () => {
    await page.setContent(`<div style="height: 250px"></div><div id="pane" style="height: 200px; overflow-y: auto">${ROWS}</div>${ROWS}`);
    await scroll('bottom');
    const root = await offsets();
    expect(root.top).toBe(root.maxTop);
    expect((await offsets('#pane')).top).toBe(0);
  });

  it('lands at once under scroll-behavior: smooth', async () => {
    await page.setContent(`<style>html { scroll-behavior: smooth }</style>${ROWS}`);
    await scroll('bottom');
    const root = await offsets();
    expect(root.top).toBe(root.maxTop);
  });

  it.each(['open', 'closed'] as const)('reaches a pane inside a %s shadow root at the center', async (mode) => {
    // A navigation, not setContent: init scripts, the closed-root registry among them, run on a new document only.
    await page.goto(`data:text/html,${encodeURIComponent('<body style="margin: 0; overflow: hidden"><div id="host"></div></body>')}`);
    await page.evaluate(([rows, shadowMode]) => {
      const root = document.getElementById('host')!.attachShadow({ mode: shadowMode });
      root.innerHTML = `<div id="pane" style="height: 600px; overflow-y: auto">${rows}</div>`;
      (window as unknown as { pane: Element }).pane = root.getElementById('pane')!;
    }, [ROWS, mode] as const);
    await scroll('bottom');
    const pane = await page.evaluate(() => {
      const element = (window as unknown as { pane: Element }).pane;
      return { top: element.scrollTop, maxTop: element.scrollHeight - element.clientHeight };
    });
    expect(pane.maxTop).toBeGreaterThan(0);
    expect(pane.top).toBe(pane.maxTop);
  });

  it('resolves with nothing scrolled when the page is shorter than the viewport', async () => {
    await page.setContent('<p>Short</p>');
    await scroll('bottom');
    expect((await offsets()).top).toBe(0);
  });

  it('leaves a page locked with overflow: hidden alone', async () => {
    await page.setContent(`<body style="overflow: hidden">${ROWS}</body>`);
    await scroll('bottom');
    expect((await offsets()).top).toBe(0);
  });

  it('follows content that grows at the bottom until it stops growing', async () => {
    await page.setContent(`<div id="feed">${ROWS}</div>
      <script>
        let batches = 0;
        addEventListener('scroll', () => {
          if (batches < 3 && innerHeight + scrollY >= document.body.scrollHeight - 1) {
            batches += 1;
            document.getElementById('feed').insertAdjacentHTML('beforeend', '<p style="height: 400px">Batch ' + batches + '</p>');
          }
        });
      </script>`);
    await scroll('bottom');
    const bottom = await offsets();
    expect(await page.locator('text=Batch 3').count()).toBe(1);
    expect(bottom.top).toBe(bottom.maxTop);
  });

  it('gives up with OPERATION_TIMEOUT when the content never stops growing', async () => {
    await page.setContent(`${ROWS}
      <script>
        addEventListener('scroll', () => document.body.insertAdjacentHTML('beforeend', '<p style="height: 400px">More</p>'));
      </script>`);
    const failure = await scroll('bottom', undefined, 400).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringContaining('more content kept loading at the bottom edge') });
  });

  it('reports the budget, not a Playwright timeout, when the page is busy as the budget ends', async () => {
    // Each scroll adds content, then blocks the page for 300 ms right after the jump reads (a frame
    // callback queued after the jump's own), so the next jump waits on the main thread as the budget ends.
    await page.setContent(`${ROWS}
      <script>
        addEventListener('scroll', () => {
          document.body.insertAdjacentHTML('beforeend', '<p style="height: 400px">More</p>');
          requestAnimationFrame(() => setTimeout(() => { const end = Date.now() + 300; while (Date.now() < end); }, 0));
        });
      </script>`);
    const failure = await scroll('bottom', undefined, 400).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(EngineError);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringContaining('more content kept loading at the bottom edge') });
  });

  it('finishes while the page clock is paused, whose timers never fire', async () => {
    await page.clock.install();
    await page.setContent(ROWS);
    await page.clock.pauseAt(Date.now() + 60_000);
    await scroll('bottom');
    const bottom = await offsets();
    expect(bottom.top).toBe(bottom.maxTop);
  });

  it('follows a feed that loads from an IntersectionObserver on a sentinel row', async () => {
    // The observer runs after the frame a jump waits for, so only a jump that moves nothing may end the scroll.
    await page.setContent(`<!doctype html><body style="margin: 0"><div id="feed">${ROWS}</div><div id="sentinel" style="height: 1px"></div>
      <script>
        let batches = 0;
        const sentinel = document.getElementById('sentinel');
        const observer = new IntersectionObserver((entries) => {
          if (batches < 3 && entries.some((entry) => entry.isIntersecting)) {
            batches += 1;
            document.getElementById('feed').insertAdjacentHTML('beforeend', '<p style="height: 400px; margin: 0">Batch ' + batches + '</p>');
            // Observe again, as feed libraries do, so the next visit reports afresh.
            observer.unobserve(sentinel);
            observer.observe(sentinel);
          }
        });
        observer.observe(sentinel);
      </script></body>`);
    await scroll('bottom');
    const bottom = await offsets();
    expect(await page.locator('text=Batch 3').count()).toBe(1);
    expect(bottom.top).toBe(bottom.maxTop);
  });
});

describe('scrollTo out of budget', () => {
  it('says the budget ran out, not that content kept loading, on a static page with too little budget', async () => {
    await page.setContent(ROWS);
    const failure = await scroll('bottom', undefined, 40).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'the budget ran out before the first jump toward the bottom edge' });
    expect((await offsets()).top).toBe(0);
  });

  it('jumps nowhere when the step is cancelled while the page is busy', async () => {
    // The page blocks its main thread, so the container lookup answers only after the cancel.
    await page.setContent(ROWS);
    await page.evaluate(() => void setTimeout(() => { const end = Date.now() + 400; while (Date.now() < end); }, 0));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const failure = await scrollToEdge(page, undefined, 'bottom', { timeoutMs: 2_000, signal: controller.signal }).catch((cause: unknown) => cause);
    expect(failure).toBeDefined();
    expect((await offsets()).top).toBe(0);
  });

  it('fails a node that leaves the page as stale, and leaves the page where it was', async () => {
    // The pane replaces itself on its first scroll, so the next jump finds it gone.
    await page.setContent(`<div id="pane" style="height: 300px; overflow-y: auto">${ROWS}</div>${ROWS}
      <script>
        document.getElementById('pane').addEventListener('scroll', (event) => event.target.replaceWith(event.target.cloneNode(true)), { once: true });
      </script>`);
    const pane = await page.$('#pane');
    const failure = await scrollToEdge(page, { kind: 'element', element: pane! }, 'bottom', { timeoutMs: 2_000, signal: new AbortController().signal })
      .catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect((await offsets()).top).toBe(0);
  });

  it('says the budget ran out, not stale, when the located pane left and the page stayed busy past the budget', async () => {
    // The pane removes itself, and the located row with it, on its first scroll; then the page blocks past the
    // budget right after that jump reads, so the next jump finds the pane gone with no budget left to find it again.
    await page.setContent(`<!doctype html><body style="margin: 0"><div id="pane" style="height: 100vh; overflow-y: auto"><p id="first">Row 0</p>${ROWS}</div>
      <script>
        document.getElementById('pane').addEventListener('scroll', (event) => {
          event.target.remove();
          requestAnimationFrame(() => setTimeout(() => { const end = Date.now() + 1_000; while (Date.now() < end); }, 0));
        }, { once: true });
      </script></body>`);
    const failure = await scroll('bottom', '#first', 800).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', message: 'the budget ran out after 1 jump, before a jump confirmed the bottom edge' });
  });

  it('fails as stale when the located node is gone and the container left with it', async () => {
    await page.setContent(`<div id="pane" style="height: 300px; overflow-y: auto">${ROWS}</div>
      <script>
        document.getElementById('pane').addEventListener('scroll', (event) => event.target.remove(), { once: true });
      </script>`);
    const failure = await scroll('bottom', '#pane', 1_000).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });
});

describe('scrollTo through the engine', () => {
  let server: Server;
  let origin: string;
  let artifactsDir: string;
  let engine: EngineHandle;
  const ENDLESS = `<!doctype html><div data-testid="feed">${ROWS}</div>
    <script>addEventListener('scroll', () => document.body.insertAdjacentHTML('beforeend', '<p style="height: 400px">More</p>'));</script>`;
  const operation = (timeoutMs = 1_000) => ({ signal: new AbortController().signal, timeoutMs, runId: 'run-scroll', attemptId: 'scroll', origin: 'test' as const });

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(ENDLESS);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-scroll-to-'));
    engine = web();
    await engine.init!({
      runId: 'run-scroll', targetName: 'web', projectRoot: process.cwd(), app: { site: '127.0.0.1' }, env: {},
      headed: false, workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'scroll', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
  });

  afterAll(async () => {
    const cleanup = { signal: new AbortController().signal, timeoutMs: 10_000 };
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it.each(['screen', 'locator'] as const)('keeps the reason an endless feed ran out of budget on the %s form', async (form) => {
    await engine.session!.open!(`${origin}/`, operation(10_000));
    const { root } = await engine.observe!(operation(10_000));
    const ref = form === 'screen'
      ? root.ref
      : (await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'feed', exact: true } } }, operation(10_000)))[0]!.ref;
    const failure = await engine.perform!(ref as NodeRef, { kind: 'scrollTo', edge: 'bottom' }, operation()).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringContaining('more content kept loading at the bottom edge') });
  });
});

describe('scrollTo on a node', () => {
  const PANE = `<div id="pane" style="height: 300px; overflow-y: auto">${ROWS}</div>${ROWS}`;

  it('scrolls the node itself, not the page around it', async () => {
    await page.setContent(PANE);
    await scroll('bottom', '#pane');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('scrolls the nearest ancestor that scrolls when the node does not', async () => {
    await page.setContent(PANE);
    await scroll('bottom', '#pane p:first-child');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
  });

  it('scrolls the page from a node when the body\'s overflow belongs to the viewport, not the body itself', async () => {
    // Standards mode, where the root is the scrolling element: the body reports overflow-y auto and room to scroll, yet does not scroll.
    await page.setContent(`<!doctype html><style>html, body { height: 100% } body { overflow-x: hidden }</style><p id="first">Row 0</p>${ROWS}`);
    await scroll('bottom', '#first');
    const root = await offsets();
    expect(root.maxTop).toBeGreaterThan(0);
    expect(root.top).toBe(root.maxTop);
  });

  it.each([
    ['ltr', 'right'],
    ['ltr', 'left'],
    ['rtl', 'right'],
    ['rtl', 'left'],
  ] as const)('reaches the %s carousel\'s %s edge', async (dir, edge) => {
    const cards = Array.from({ length: 20 }, (_, index) => `<span style="display: inline-block; width: 200px">Card ${index + 1}</span>`).join('');
    await page.setContent(`<div id="carousel" dir="${dir}" style="width: 400px; overflow-x: auto; white-space: nowrap">${cards}</div>`);
    // Start in the middle so either edge is a move.
    await page.locator('#carousel').evaluate((element) => {
      element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2 * (getComputedStyle(element).direction === 'rtl' ? -1 : 1);
    });
    await scroll(edge, '#carousel');
    const carousel = await offsets('#carousel');
    // In right-to-left, the start is offset 0 at the right and the offsets run negative to the left.
    const expected = dir === 'ltr' ? (edge === 'left' ? 0 : carousel.maxLeft) : edge === 'right' ? 0 : -carousel.maxLeft;
    expect(Math.abs(carousel.left - expected)).toBeLessThanOrEqual(1);
  });

  it('scrolls the frame\'s own page from a node inside an iframe, and leaves the outer page alone', async () => {
    await page.setContent(`<iframe id="frame" style="height: 300px; width: 400px" srcdoc="${ROWS.replaceAll('"', '&quot;')}"></iframe>${ROWS}`);
    const inner = page.frameLocator('#frame').locator('p').first();
    await inner.waitFor();
    await scrollToEdge(page, { kind: 'locator', locator: inner }, 'bottom', { timeoutMs: 2_000, signal: new AbortController().signal });
    const frame = await page.frameLocator('#frame').locator(':root').evaluate((root) => ({ top: root.scrollTop, maxTop: root.scrollHeight - root.clientHeight }));
    expect(frame.maxTop).toBeGreaterThan(0);
    expect(frame.top).toBe(frame.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it.each(['open', 'closed'] as const)('walks from a slotted node up through its slot to the pane in a %s shadow root', async (mode) => {
    // A navigation, not setContent: init scripts, the closed-root registry among them, run on a new document only.
    await page.goto(`data:text/html,${encodeURIComponent(`<div id="host">${ROWS}</div>`)}`);
    await page.evaluate((shadowMode) => {
      const root = document.getElementById('host')!.attachShadow({ mode: shadowMode });
      root.innerHTML = '<div id="pane" style="height: 300px; overflow-y: auto"><slot></slot></div>';
      (window as unknown as { pane: Element }).pane = root.getElementById('pane')!;
    }, mode);
    await scroll('bottom', '#host p:first-child');
    const pane = await page.evaluate(() => {
      const element = (window as unknown as { pane: Element }).pane;
      return { top: element.scrollTop, maxTop: element.scrollHeight - element.clientHeight };
    });
    expect(pane.maxTop).toBeGreaterThan(0);
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('keeps the container when the located row unmounts while the list grows', async () => {
    await page.setContent(`<div id="pane" style="height: 300px; overflow-y: auto"><p id="row" style="height: 40px; margin: 0">Row</p>${ROWS}</div>
      <script>
        let batches = 0;
        const pane = document.getElementById('pane');
        pane.addEventListener('scroll', () => {
          if (batches < 3 && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1) {
            batches += 1;
            document.getElementById('row')?.remove();
            pane.insertAdjacentHTML('beforeend', '<p style="height: 400px; margin: 0">Batch ' + batches + '</p>');
          }
        });
      </script>`);
    await scroll('bottom', '#row');
    const pane = await offsets('#pane');
    expect(await page.locator('text=Batch 3').count()).toBe(1);
    expect(pane.top).toBe(pane.maxTop);
  });

  it.each([
    ['body', 'contain: paint'],
    ['body', 'contain: layout'],
    ['body', 'contain: size'],
    ['body', 'contain: inline-size'],
    ['body', 'contain: style'],
    ['body', 'container-type: inline-size'],
    ['body', 'container-type: size'],
    ['body', 'container-type: anchored'],
    ['html', 'container-type: anchored'],
    ['body', 'container-type: scroll-state anchored'],
    ['html', 'contain: layout'],
  ])('scrolls a body whose overflow stays its own under %s { %s }, from a node and from the screen', async (on, style) => {
    const content = (form: string) => `<!doctype html><html style="${on === 'html' ? style : ''}">`
      + `<body style="margin: 0; height: 100vh; overflow: auto; ${on === 'body' ? style : ''}"><p id="first">Row 0 ${form}</p>${ROWS}</body></html>`;
    for (const form of ['node', 'screen'] as const) {
      await page.setContent(content(form));
      await scroll('bottom', form === 'node' ? '#first' : undefined);
      const body = await offsets('body');
      expect(body.maxTop, form).toBeGreaterThan(0);
      expect(body.top, form).toBe(body.maxTop);
      expect((await offsets()).top, form).toBe(0);
    }
  });

  it.each(['html', 'body'])('scrolls the page, not the body, under %s { container-type: scroll-state }, which applies no containment', async (on) => {
    const style = 'container-type: scroll-state';
    const content = (form: string) => `<!doctype html><html style="height: 100%; ${on === 'html' ? style : ''}">`
      + `<body style="margin: 0; height: 100%; overflow-y: auto; ${on === 'body' ? style : ''}"><p id="first">Row 0 ${form}</p>${ROWS}</body></html>`;
    for (const form of ['node', 'screen'] as const) {
      await page.setContent(content(form));
      await scroll('bottom', form === 'node' ? '#first' : undefined);
      const root = await offsets();
      expect(root.maxTop, form).toBeGreaterThan(0);
      expect(root.top, form).toBe(root.maxTop);
    }
  });

  it('walks out of a shadow root to its host when the page replaced the global ShadowRoot', async () => {
    await page.setContent(`<div id="pane" style="height: 300px; overflow-y: auto"><div id="host"></div>${ROWS}</div>${ROWS}
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p id="start">Start</p>';
        window.ShadowRoot = function ShadowRoot() {};
      </script>`);
    await scroll('bottom', '#start');
    const pane = await offsets('#pane');
    expect(pane.top).toBe(pane.maxTop);
    expect((await offsets()).top).toBe(0);
  });

  it('finishes for a node in a cross-origin iframe out of view, which renders no frames', async () => {
    const inner = `<div id="pane" style="height: 300px; overflow-y: auto">${ROWS}</div>`;
    await page.setContent(`<div style="height: 2000px"></div><iframe id="frame" style="height: 400px; width: 400px" src="data:text/html,${encodeURIComponent(inner)}"></iframe>`);
    const pane = page.frameLocator('#frame').locator('#pane');
    await pane.waitFor();
    const done = scrollToEdge(page, { kind: 'locator', locator: pane }, 'bottom', { timeoutMs: 2_000, signal: new AbortController().signal }).then(() => 'resolved');
    const outcome = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve('pending'), 1_500))]);
    expect(outcome).toBe('resolved');
    const offsetsInFrame = await pane.evaluate((element) => ({ top: element.scrollTop, maxTop: element.scrollHeight - element.clientHeight }));
    expect(offsetsInFrame.top).toBe(offsetsInFrame.maxTop);
  });

  it('waits for a node that is not visible yet, then scrolls it', async () => {
    await page.setContent(`<div id="pane" style="display: none; height: 300px; overflow-y: auto">${ROWS}</div>
      <script>setTimeout(() => { document.getElementById('pane').style.display = 'block'; }, 200);</script>`);
    await scroll('bottom', '#pane');
    const pane = await offsets('#pane');
    expect(pane.maxTop).toBeGreaterThan(0);
    expect(pane.top).toBe(pane.maxTop);
  });
});
