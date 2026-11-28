/** PNG header reading for engines that report a capture's size. */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `IHDR`, the chunk type every PNG starts with. */
const IHDR = 0x49484452;

/**
 * Reads a PNG's pixel size from its header; undefined for bytes that are not
 * a PNG, or one too short to hold the size.
 *
 * The size reported with a screenshot must be the size of the bytes the
 * model receives: every coordinate it returns is relative to it, so a
 * viewport size that disagrees with the capture moves every point. PNG puts
 * `IHDR` first, so the width and height are at fixed offsets and no decoder
 * is needed.
 */
export function readPngSize(data: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (data.byteLength < 24) return undefined;
  for (const [offset, byte] of PNG_SIGNATURE.entries()) {
    if (data[offset] !== byte) return undefined;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(12) !== IHDR) return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}
