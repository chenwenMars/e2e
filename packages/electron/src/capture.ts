/**
 * Pixels: screenshots with every password field and nested document painted
 * over, withheld when the window holds one no mask reaches.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, readPngSize, type EngineSnapshot, type ObservationPixels } from '@e2e-dev/core/engine';
import type { DevTools } from './devtools.ts';
import { pixelRatio, placeMasks, removeMasks, type MaskState } from './in-page/masks.ts';
import { viewportSize } from './in-page/node-ops.ts';
import { inDocument, type RawRead } from './locate.ts';
import type { PageTarget } from './page.ts';
import { MASKED_TAGS } from './snapshot.ts';
import type { AppWindow } from './windows.ts';

/** Everything that can hold a secure value or show another document in a screenshot: masked, or the capture is not taken. */
const MASKED_SELECTOR = ['input[type=password i]', ...MASKED_TAGS.map((tag) => tag.toLowerCase())].join(', ');

/**
 * How many password fields and nested documents in the window's document no
 * selector mask reaches; see `DomSnapshot.unmaskableCount`. Undefined when the
 * document could not be read: nothing is then known to be masked.
 */
async function unmaskable(devtools: DevTools, window: AppWindow): Promise<number | undefined> {
  return (await devtools.snapshot(window.page))?.dom.unmaskableCount();
}

const UNREAD = 'the window\'s document could not be read to check what its masks cover, so the screenshot is withheld';

/** A capture with its masks painted over, or why it is withheld; `masked` says how many regions the masks cover either way. */
type MaskedCapture = { readonly masked: number } & ({ readonly image: Buffer } | { readonly withheld: string });

function outOfReach(count: number): string {
  const plural = count === 1 ? '' : 's';
  return `the window shows ${count} password field${plural} or nested document${plural} inside a closed shadow root, which no mask reaches, so the screenshot is withheld`;
}

/**
 * The one way pixels leave a window: every password field and nested document
 * painted over, and nothing returned when one sits in a closed shadow root,
 * out of every selector's reach. `unmaskableBefore` is that count from a read
 * the caller already has. The app may render such an element while the
 * capture runs, inside a closed shadow root or beside the masks already
 * placed, so the document is read again before the pixels go out.
 */
function maskedCapture(devtools: DevTools, window: AppWindow, unmaskableBefore: number | undefined, scale: 'css' | 'device'): Promise<MaskedCapture> {
  // One capture of a page at a time: the masks are the page's, and a second capture would take the first one's away.
  const turn = (captures.get(window.page) ?? Promise.resolve()).then(() => captureUnderMasks(devtools, window, unmaskableBefore, scale));
  captures.set(window.page, turn.catch(() => undefined));
  return turn;
}

const captures = new WeakMap<PageTarget, Promise<unknown>>();

async function captureUnderMasks(devtools: DevTools, window: AppWindow, unmaskableBefore: number | undefined, scale: 'css' | 'device'): Promise<MaskedCapture> {
  const { page } = window;
  if (unmaskableBefore === undefined) return { masked: (await page.evaluate(removeMasks, MASKED_SELECTOR)).count, withheld: UNREAD };
  if (unmaskableBefore > 0) return { masked: (await page.evaluate(removeMasks, MASKED_SELECTOR)).count, withheld: outOfReach(unmaskableBefore) };
  const placed = await page.evaluate(placeMasks, MASKED_SELECTOR);
  const { count: masked } = placed;
  let image: Buffer;
  let after: MaskState | undefined;
  try {
    image = await captureViewport(window, scale);
  } finally {
    // The masks never outlive the capture, whatever became of it.
    after = await page.evaluate(removeMasks, MASKED_SELECTOR).catch(() => undefined);
  }
  // A document that navigated or reloaded under the capture took its masks with it: the image may show the new one bare.
  if (!placed.placed) return { masked, withheld: 'a mask did not cover the password field or nested document it was placed over, so the screenshot is withheld' };
  if (after?.placed !== true) return { masked, withheld: 'the masks did not last through the screenshot (the window loaded another document, or the page removed them), so the screenshot is withheld' };
  const unmaskableAfter = await unmaskable(devtools, window);
  if (unmaskableAfter === undefined) return { masked, withheld: UNREAD };
  if (unmaskableAfter > 0) return { masked, withheld: outOfReach(unmaskableAfter) };
  if (after.count > masked) {
    return { masked, withheld: 'a password field or nested document appeared while the screenshot was taken, after its masks were placed, so the screenshot is withheld' };
  }
  // A mask is painted where its element was measured: one a script moved since may show beside its mask.
  if (after.boxes !== placed.boxes) {
    return { masked, withheld: 'a password field or nested document moved while the screenshot was taken, out from under its mask, so the screenshot is withheld' };
  }
  return { masked, image };
}

/** The window's viewport as a PNG: one image pixel per CSS pixel, or per device pixel. */
async function captureViewport(window: AppWindow, scale: 'css' | 'device'): Promise<Buffer> {
  const { page } = window;
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (scale === 'css') {
    const [{ cssVisualViewport: scrolled }, { width, height }, ratio] = await Promise.all([page.session.send('Page.getLayoutMetrics'), page.evaluate(viewportSize), page.evaluate(pixelRatio)]);
    // A clip is in the document's coordinates, so the window's is where the document is scrolled to. It is the window's
    // whole inner size, scrollbars included, as a capture with no clip is.
    if (ratio !== 1) clip = { x: scrolled.pageX, y: scrolled.pageY, width, height, scale: 1 / ratio };
  }
  const { data } = await page.captured(() => page.session.send('Page.captureScreenshot', { format: 'png', ...(clip === undefined ? {} : { clip }) }));
  return Buffer.from(data, 'base64');
}

/** Adds the pixels to an observation of a read window, or leaves them out when they are withheld. */
export async function withPixels(devtools: DevTools, raw: RawRead, snapshot: EngineSnapshot): Promise<EngineSnapshot> {
  // The pixels are of the document the snapshot describes, or the observation is taken again.
  const capture = await inDocument(raw.window, raw.generation, () => maskedCapture(devtools, raw.window, raw.dom.unmaskableCount(), 'css'));
  if ('withheld' in capture) return { ...snapshot, maskedRegionCount: capture.masked };
  const data = new Uint8Array(capture.image);
  const { width: css } = await raw.window.page.evaluate(viewportSize);
  const size = readPngSize(data);
  if (size === undefined) throw new Error('the window capture is not a PNG');
  const pixels: ObservationPixels = { data, mediaType: 'image/png', width: size.width, height: size.height, scale: css > 0 ? size.width / css : 1 };
  return { ...snapshot, pixels, maskedRegionCount: capture.masked };
}

/**
 * `app.screenshot(label)`: the window with its masks painted over, written
 * under the attempt's artifacts as `screenshots/<n>-<label>.png`. Refused
 * with `POLICY_DENIED` when the capture is withheld.
 */
export async function screenshotFile(devtools: DevTools, window: AppWindow, artifactsDir: string, name: string): Promise<string> {
  const capture = await maskedCapture(devtools, window, await unmaskable(devtools, window), 'device');
  if ('withheld' in capture) throw new ConfigurationError('POLICY_DENIED', capture.withheld);
  const relative = path.posix.join('screenshots', name);
  const absolute = path.join(artifactsDir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, capture.image);
  return relative;
}

/** A screenshot's file name: its number in the attempt and a label that cannot turn into a path (letters, digits, dashes). */
export function screenshotName(counter: number, label: string | undefined): string {
  const safe = label === undefined ? '' : label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `${String(counter).padStart(3, '0')}${safe === '' ? '' : `-${safe}`}.png`;
}
