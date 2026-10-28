import { describe, it, expect } from "vitest";
import {
  makeProjector,
  makeInverseProjector,
  warpProjective,
  type TiltParams
} from "../src/core/export-tilt";

describe("export-tilt projective warp", () => {
  it("inverts makeProjector exactly across tilt angles and perspective distances", () => {
    const cases: Array<[number, number, number]> = [
      [25, -30, 800],
      [-15, 40, 500],
      [0, 35, 600],
      [30, 0, 400],
      [42, 38, 900],
      [-35, -25, 650]
    ];

    const bx = 120;
    const by = 240;
    const bw = 600;
    const bh = 400;

    for (const [rx, ry, d] of cases) {
      const t: TiltParams = {
        ax: (rx * Math.PI) / 180,
        ay: (ry * Math.PI) / 180,
        d
      };
      const project = makeProjector(bx, by, bw, bh, t);
      const unproject = makeInverseProjector(bx, by, bw, bh, t);

      const samples: Array<[number, number]> = [
        [bx, by],
        [bx + bw, by],
        [bx + bw, by + bh],
        [bx, by + bh],
        [bx + bw / 2, by + bh / 2],
        [bx + 137.25, by + 289.75]
      ];

      for (const [x, y] of samples) {
        const [xp, yp] = project(x, y);
        const [xr, yr] = unproject(xp, yp);
        expect(Math.hypot(xr - x, yr - y)).toBeLessThan(1e-9);
      }
    }
  });

  it("warps a 2x tilted surface with zero internal seams or alpha drops", () => {
    const bx = 100;
    const by = 80;
    const bw = 320;
    const bh = 240;
    const pad = 8;
    const k = 2;
    const tilt: TiltParams = {
      ax: (18 * Math.PI) / 180,
      ay: (-28 * Math.PI) / 180,
      d: 700
    };

    const pl = bx - pad;
    const pt = by - pad;
    const fw = bw + pad * 2;
    const fh = bh + pad * 2;
    const srcW = fw * k;
    const srcH = fh * k;

    // Fill the element box [bx, bx+bw] x [by, by+bh] with a smooth opaque gradient
    const srcPixels = new Uint8ClampedArray(srcW * srcH * 4);
    for (let sy = pad * k; sy < (pad + bh) * k; sy++) {
      for (let sx = pad * k; sx < (pad + bw) * k; sx++) {
        const idx = (sy * srcW + sx) * 4;
        srcPixels[idx] = Math.round(((sx - pad * k) / (bw * k)) * 200) + 30;
        srcPixels[idx + 1] = Math.round(((sy - pad * k) / (bh * k)) * 180) + 40;
        srcPixels[idx + 2] = 160;
        srcPixels[idx + 3] = 255;
      }
    }

    const project = makeProjector(bx, by, bw, bh, tilt);
    const unproject = makeInverseProjector(bx, by, bw, bh, tilt);
    const corners = [
      project(pl, pt),
      project(pl + fw, pt),
      project(pl + fw, pt + fh),
      project(pl, pt + fh)
    ];
    const minX = Math.min(...corners.map((p) => p[0]));
    const maxX = Math.max(...corners.map((p) => p[0]));
    const minY = Math.min(...corners.map((p) => p[1]));
    const maxY = Math.max(...corners.map((p) => p[1]));
    const ox = Math.floor(minX * k) / k;
    const oy = Math.floor(minY * k) / k;
    const outW = Math.ceil(maxX * k) - Math.floor(minX * k);
    const outH = Math.ceil(maxY * k) - Math.floor(minY * k);

    const outPixels = new Uint8ClampedArray(outW * outH * 4);
    const t0 = performance.now();
    warpProjective(srcPixels, srcW, srcH, outPixels, outW, outH, {
      bx,
      by,
      bw,
      bh,
      pl,
      pt,
      ox,
      oy,
      k,
      tilt
    });
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(100);

    // Check every pixel strictly inside the projected element quad (2px margin inside edge)
    let interiorCount = 0;
    let alphaDrops = 0;
    let maxStepDelta = 0;
    for (let py = 1; py < outH - 1; py++) {
      for (let px = 1; px < outW - 1; px++) {
        const xp = ox + (px + 0.5) / k;
        const yp = oy + (py + 0.5) / k;
        const [x, y] = unproject(xp, yp);
        if (x > bx + 2 && x < bx + bw - 2 && y > by + 2 && y < by + bh - 2) {
          interiorCount++;
          const idx = (py * outW + px) * 4;
          if (outPixels[idx + 3] !== 255) alphaDrops++;

          const rightIdx = (py * outW + (px + 1)) * 4;
          if (outPixels[rightIdx + 3] === 255) {
            const dr = Math.abs(outPixels[idx] - outPixels[rightIdx]);
            const dg = Math.abs(outPixels[idx + 1] - outPixels[rightIdx + 1]);
            if (dr > maxStepDelta) maxStepDelta = dr;
            if (dg > maxStepDelta) maxStepDelta = dg;
          }
        }
      }
    }
    expect(interiorCount).toBeGreaterThan(50000);
    expect(alphaDrops).toBe(0);
    expect(maxStepDelta).toBeLessThanOrEqual(3);
  });

  it("preserves pure RGB colour on antialiased edges against transparent pixels", () => {
    const bx = 0;
    const by = 0;
    const bw = 80;
    const bh = 80;
    const pad = 8;
    const k = 2;
    const tilt: TiltParams = {
      ax: (20 * Math.PI) / 180,
      ay: (25 * Math.PI) / 180,
      d: 600
    };

    const pl = bx - pad;
    const pt = by - pad;
    const fw = bw + pad * 2;
    const fh = bh + pad * 2;
    const srcW = fw * k;
    const srcH = fh * k;

    // Pure white shape (#FFFFFF) surrounded by transparent black (0, 0, 0, 0)
    const srcPixels = new Uint8ClampedArray(srcW * srcH * 4);
    for (let sy = pad * k; sy < (pad + bh) * k; sy++) {
      for (let sx = pad * k; sx < (pad + bw) * k; sx++) {
        const idx = (sy * srcW + sx) * 4;
        srcPixels[idx] = 255;
        srcPixels[idx + 1] = 255;
        srcPixels[idx + 2] = 255;
        srcPixels[idx + 3] = 255;
      }
    }

    const outW = srcW;
    const outH = srcH;
    const outPixels = new Uint8ClampedArray(outW * outH * 4);
    warpProjective(srcPixels, srcW, srcH, outPixels, outW, outH, {
      bx,
      by,
      bw,
      bh,
      pl,
      pt,
      ox: pl,
      oy: pt,
      k,
      tilt
    });

    let edgePixels = 0;
    let nonWhiteEdges = 0;
    for (let i = 0; i < outW * outH; i++) {
      const a = outPixels[i * 4 + 3];
      if (a > 0 && a < 255) {
        edgePixels++;
        if (
          outPixels[i * 4] !== 255 ||
          outPixels[i * 4 + 1] !== 255 ||
          outPixels[i * 4 + 2] !== 255
        ) {
          nonWhiteEdges++;
        }
      }
    }
    expect(edgePixels).toBeGreaterThan(50);
    expect(nonWhiteEdges).toBe(0);
  });
});
