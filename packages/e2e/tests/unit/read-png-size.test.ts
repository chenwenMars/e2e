/** `readPngSize`, the header read every engine reports a capture's size with. */

import { describe, expect, it } from 'vitest';
import { readPngSize } from '@e2e-dev/core/lib/engine/index';

/** A 2x2 PNG; only its header matters here. */
const PNG_2X2 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWP4z8DAwMgABYNKAAAeAAHUL6H5AAAAAElFTkSuQmCC'),
  (character) => character.charCodeAt(0),
);

describe('readPngSize', () => {
  it('reads the size out of the header', () => {
    expect(readPngSize(PNG_2X2)).toEqual({ width: 2, height: 2 });
  });

  it('reads it from a view into a larger buffer', () => {
    const padded = new Uint8Array(PNG_2X2.byteLength + 8);
    padded.set(PNG_2X2, 8);
    expect(readPngSize(padded.subarray(8))).toEqual({ width: 2, height: 2 });
  });

  it('returns undefined for truncated bytes, other data, and a zero size', () => {
    expect(readPngSize(PNG_2X2.slice(0, 20))).toBeUndefined();
    expect(readPngSize(new Uint8Array(64))).toBeUndefined();
    const empty = PNG_2X2.slice();
    new DataView(empty.buffer).setUint32(16, 0);
    expect(readPngSize(empty)).toBeUndefined();
  });
});
