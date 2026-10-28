/**
 * Block Mosaic (Pixelate) rendering engine.
 */

export interface MosaicOptions {
  blockSize: number; // 2 to 64
}

export function applyMosaic(
  imgData: ImageData,
  blockSize = 12
): ImageData {
  const size = Math.max(2, Math.round(blockSize));
  const { width, height, data } = imgData;

  for (let by = 0; by < height; by += size) {
    for (let bx = 0; bx < width; bx += size) {
      const bw = Math.min(size, width - bx);
      const bh = Math.min(size, height - by);

      const cx = bx + Math.floor(bw / 2);
      const cy = by + Math.floor(bh / 2);
      const centerIdx = (cy * width + cx) * 4;
      const r = data[centerIdx];
      const g = data[centerIdx + 1];
      const b = data[centerIdx + 2];
      const a = data[centerIdx + 3];

      for (let y = by; y < by + bh; y++) {
        for (let x = bx; x < bx + bw; x++) {
          const idx = (y * width + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = a;
        }
      }
    }
  }
  return imgData;
}

export function renderMosaic(
  ctx: CanvasRenderingContext2D,
  imgData: ImageData,
  opts: MosaicOptions
) {
  const processed = applyMosaic(imgData, opts.blockSize);
  ctx.putImageData(processed, 0, 0);
}
