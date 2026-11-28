import { Transformer } from '@napi-rs/image';
import { describe, expect, it } from 'vitest';
import { encodePng, windowImage } from '../../src/png.ts';

/** A capture as macOS takes it: the opaque window inside a half-transparent shadow. */
function capture(width: number, height: number, window: { x: number; y: number; width: number; height: number }): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= window.x && x < window.x + window.width && y >= window.y && y < window.y + window.height;
      const at = (y * width + x) * 4;
      data.set(inside ? [200, 200, 200, 255] : [0, 0, 0, 90], at);
    }
  }
  const png = Transformer.fromRgbaPixels(data, width, height).pngSync();
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

function pixel(image: { width: number; data: Uint8Array }, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.data.subarray(at, at + 4)];
}

describe('windowImage', () => {
  it('crops the shadow off and masks in window coordinates', () => {
    const image = windowImage(capture(30, 24, { x: 6, y: 3, width: 16, height: 10 }), { width: 16, height: 10 }, [{ x: 2, y: 2, width: 4, height: 3 }]);
    expect(image).toMatchObject({ width: 16, height: 10 });
    expect(pixel(image!, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(pixel(image!, 10, 8)).toEqual([200, 200, 200, 255]);
    expect(encodePng(image!).subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
  });

  it('takes a capture with no shadow as the window', () => {
    const image = windowImage(capture(16, 10, { x: 0, y: 0, width: 16, height: 10 }), { width: 16, height: 10 }, []);
    expect(image).toMatchObject({ width: 16, height: 10 });
  });

  it('masks a secure field wherever an outline of even width puts the window, on one side only too', () => {
    // A 108x100 opaque capture of a 100x100 window that starts 1 px in, not at the 4 px a centered outline would give.
    const width = 108;
    const height = 100;
    const data = new Uint8Array(width * height * 4);
    for (let at = 0; at < data.length; at += 4) data.set([200, 200, 200, 255], at);
    const field = { x: 10, y: 20, width: 4, height: 3 };
    for (let y = field.y; y < field.y + field.height; y += 1) {
      for (let x = field.x + 1; x < field.x + 1 + field.width; x += 1) data.set([255, 0, 0, 255], (y * width + x) * 4);
    }
    const png = Transformer.fromRgbaPixels(data, width, height).pngSync();
    const image = windowImage(new Uint8Array(png.buffer, png.byteOffset, png.byteLength), { width: 100, height: 100 }, [field]);
    expect(image).toMatchObject({ width: 100, height: 100 });
    for (let at = 0; at < image!.data.length; at += 4) expect([...image!.data.subarray(at, at + 4)]).not.toEqual([255, 0, 0, 255]);
  });

  it('withholds a capture with a border of odd width, rather than mask it in the wrong place', () => {
    const bordered = capture(13, 10, { x: 0, y: 0, width: 13, height: 10 });
    expect(windowImage(bordered, { width: 10, height: 10 }, [{ x: 7, y: 2, width: 3, height: 3 }])).toBeUndefined();
  });

  it('covers a field off by a pixel of rounding', () => {
    const image = windowImage(capture(16, 10, { x: 0, y: 0, width: 16, height: 10 }), { width: 16, height: 10 }, [{ x: 4, y: 4, width: 2, height: 2 }]);
    expect(pixel(image!, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(pixel(image!, 6, 6)).toEqual([0, 0, 0, 255]);
  });

  it('crops a window out of the outline macOS draws around it, and masks in window coordinates', () => {
    // An 844x708 capture: a 1-px transparent margin, a 1-px opaque outline, and the 840x704 window inside.
    const width = 844;
    const height = 708;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const margin = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        const outline = !margin && (x === 1 || y === 1 || x === width - 2 || y === height - 2);
        data.set(margin ? [0, 0, 0, 0] : outline ? [90, 90, 90, 255] : [200, 200, 200, 255], at);
      }
    }
    const png = Transformer.fromRgbaPixels(data, width, height).pngSync();
    const image = windowImage(new Uint8Array(png.buffer, png.byteOffset, png.byteLength), { width: 840, height: 704 }, [{ x: 100, y: 100, width: 50, height: 20 }]);
    expect(image).toMatchObject({ width: 840, height: 704 });
    // The window's own corner, not the outline.
    expect(pixel(image!, 0, 0)).toEqual([200, 200, 200, 255]);
    expect(pixel(image!, 839, 703)).toEqual([200, 200, 200, 255]);
    // The mask, in window coordinates, with its 2-px margin.
    expect(pixel(image!, 98, 98)).toEqual([0, 0, 0, 255]);
    expect(pixel(image!, 151, 121)).toEqual([0, 0, 0, 255]);
    expect(pixel(image!, 153, 123)).toEqual([200, 200, 200, 255]);
  });

  it('withholds a capture whose opaque box is larger by an odd amount, or by more than an outline, and crops the center of an even one', () => {
    // Odd: 3 px wider.
    expect(windowImage(capture(19, 12, { x: 0, y: 0, width: 19, height: 12 }), { width: 16, height: 10 }, [])).toBeUndefined();
    // Wider than any outline: 10 px on each side.
    expect(windowImage(capture(36, 10, { x: 0, y: 0, width: 36, height: 10 }), { width: 16, height: 10 }, [])).toBeUndefined();
    // Even on each axis, within an outline: the center, even where the axes differ.
    expect(windowImage(capture(18, 14, { x: 0, y: 0, width: 18, height: 14 }), { width: 16, height: 10 }, [])).toMatchObject({ width: 16, height: 10 });
  });

  it('withholds a capture whose window is not the size expected', () => {
    expect(windowImage(capture(30, 24, { x: 6, y: 3, width: 16, height: 10 }), { width: 40, height: 10 }, [])).toBeUndefined();
  });
});
