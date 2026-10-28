/**
 * The noise every irregular profile is built from.
 *
 * Determinism is the reason this exists at all: `mulberry32` runs from a seed
 * that lives in the document, so the same break draws on canvas, in an export
 * and on the next machine. `Math.random` anywhere here would make undo, export
 * and collaboration disagree about a shape the user can see.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 1-D value-noise lattice, smoothstep-interpolated. */
export function lattice(seed: number): (x: number) => number {
  const r = mulberry32(seed);
  const v = Array.from({ length: 2048 }, r);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = v[((i % 2048) + 2048) % 2048];
    const b = v[(((i + 1) % 2048) + 2048) % 2048];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

/** Sharp-crested ridge transform in [-0.5, 0.5]: turns rounded value-noise hills
 *  into crisp vector fracture corners and V-notches. */
export function ridge(v: number): number {
  return 0.5 - Math.abs(v - 0.5) * 2;
}
