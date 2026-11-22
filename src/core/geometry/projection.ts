export interface TiltParams {
  ax: number; // radians, about X
  ay: number; // radians, about Y
  d: number; // viewing distance px
}

/**
 * The projection the tilt wrapper paints, pivot at the box centre. Validated
 * against Chromium's own `perspective() rotateX() rotateY()` composition to
 * 0.1px (corner markers, measured): rotateY first, then rotateX, then the
 * perspective divide with `w = 1 - z/d`.
 */
export function makeProjector(bx: number, by: number, bw: number, bh: number, t: TiltParams) {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const cosY = Math.cos(t.ay);
  const sinY = Math.sin(t.ay);
  const cosX = Math.cos(t.ax);
  const sinX = Math.sin(t.ax);
  return (x: number, y: number): [number, number] => {
    const lx = x - cx;
    const ly = y - cy;
    const x1 = lx * cosY;
    const z1 = -lx * sinY;
    const y1 = ly * cosX - z1 * sinX;
    const z2 = ly * sinX + z1 * cosX;
    const denom = t.d - z2;
    if (denom < 1) return [NaN, NaN];
    const s = t.d / denom;
    return [cx + x1 * s, cy + y1 * s];
  };
}

/**
 * Exact closed-form inverse of `makeProjector` (adjugate of the lower-triangular
 * 3x3 homography `H = P(d) * Rx(ax) * Ry(ay)`). Maps a projected point `(xp, yp)`
 * back to its flat parent-space point `(x, y)`.
 */
export function makeInverseProjector(bx: number, by: number, bw: number, bh: number, t: TiltParams) {
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const cosY = Math.cos(t.ay);
  const sinY = Math.sin(t.ay);
  const cosX = Math.cos(t.ax);
  const sinX = Math.sin(t.ax);
  const det = cosX * cosY;
  if (Math.abs(det) < 1e-9) return (): [number, number] => [NaN, NaN];
  const pu = cosX / det;
  const qu = (-sinY * sinX) / det;
  const qv = cosY / det;
  const wu = -sinY / (t.d * det);
  const wv = (cosY * sinX) / (t.d * det);
  const minW = 1 / t.d;
  return (xp: number, yp: number): [number, number] => {
    const u = xp - cx;
    const v = yp - cy;
    const w = 1 + wu * u + wv * v;
    if (w < minW) return [NaN, NaN];
    const invW = 1 / w;
    return [cx + pu * u * invW, cy + (qu * u + qv * v) * invW];
  };
}
