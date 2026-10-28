export interface Pt {
  x: number;
  y: number;
}

export type EditableSegment =
  | { kind: "line"; a: number; b: number; /** synthetic closepath: serialize emits Z instead of geometry */ z?: true; /** real segment whose end coincides with the subpath start: serialize emits geometry then Z */ zc?: true }
  | { kind: "quad"; a: number; b: number; c: Pt; zc?: true }
  | { kind: "cubic"; a: number; b: number; ca: Pt; cb: Pt; zc?: true };

export interface EditablePath {
  /** `m` marks an anchor that begins a new subpath (a moveto, not a lineto). */
  anchors: Array<Pt & { m?: true }>;
  segments: EditableSegment[];
  /** Whether the LAST subpath is closed (a trailing Z applies). */
  closed: boolean;
}

const EPS = 1e-6;

interface Token {
  cmd: string;
  nums: number[];
}

function tokenize(d: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const len = d.length;
  let current: Token | null = null;

  const skipSep = () => {
    while (i < len && (d[i] === " " || d[i] === ",")) i++;
  };
  const readNum = (): number | null => {
    skipSep();
    const m = /^[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m || !m[0]) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  };
  // Arc large-arc/sweep flags are single digits that may be written without
  // separators ("a2 2 0 0112.67 19" = laf 0, sf 1, x 12.67, y 19), so they must
  // be read one character at a time.
  const readFlag = (): number | null => {
    skipSep();
    const ch = d[i];
    if (ch === "0" || ch === "1") {
      i++;
      return Number(ch);
    }
    return null;
  };

  while (i < len) {
    skipSep();
    if (i >= len) break;
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      current = { cmd: ch, nums: [] };
      tokens.push(current);
      i++;
      continue;
    }
    if (!current) return null;
    const up = current.cmd.toUpperCase();
    if (up === "A") {
      const slot = current.nums.length % 7;
      if (slot === 3 || slot === 4) {
        const flag = readFlag();
        if (flag === null) return null;
        current.nums.push(flag);
        continue;
      }
    }
    const n = readNum();
    if (n === null) return null;
    current.nums.push(n);
  }
  return tokens;
}

export function parsePathData(d: string): EditablePath | null {
  if (!d || !d.trim()) return null;
  const tokens = tokenize(d);
  if (!tokens || tokens.length === 0) return null;

  const anchors: Array<Pt & { m?: true }> = [];
  const segments: EditableSegment[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let startPt: Pt = { x: 0, y: 0 };
  let lastSubpathClosed = false;
  // Reflection state for smooth S/T commands; cleared by M/Z per the SVG spec.
  let lastCubicCb: Pt | null = null;
  let lastQuadC: Pt | null = null;
  const reflect = (p: Pt, about: Pt): Pt => ({ x: 2 * about.x - p.x, y: 2 * about.y - p.y });

  const addAnchor = (p: Pt, moveTo = false): number => {
    anchors.push(moveTo ? { x: p.x, y: p.y, m: true } : { x: p.x, y: p.y });
    return anchors.length - 1;
  };
  let subpathStartIdx = 0;

  for (let tIdx = 0; tIdx < tokens.length; tIdx++) {
    const { cmd, nums } = tokens[tIdx];
    const isRel = cmd === cmd.toLowerCase() && cmd !== "z" && cmd !== "Z";
    const upper = cmd.toUpperCase();

    switch (upper) {
      case "M": {
        if (nums.length < 2) return null;
        cur = isRel ? { x: cur.x + nums[0], y: cur.y + nums[1] } : { x: nums[0], y: nums[1] };
        startPt = { ...cur };
        subpathStartIdx = addAnchor(cur, anchors.length > 0);
        lastSubpathClosed = false;
        lastCubicCb = null;
        lastQuadC = null;

        for (let i = 2; i + 1 < nums.length; i += 2) {
          const next = isRel ? { x: cur.x + nums[i], y: cur.y + nums[i + 1] } : { x: nums[i], y: nums[i + 1] };
          const a = anchors.length - 1;
          const b = addAnchor(next);
          segments.push({ kind: "line", a, b });
          cur = next;
        }
        break;
      }

      case "L": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const next = isRel ? { x: cur.x + nums[i], y: cur.y + nums[i + 1] } : { x: nums[i], y: nums[i + 1] };
          const a = anchors.length - 1;
          const b = addAnchor(next);
          segments.push({ kind: "line", a, b });
          cur = next;
        }
        break;
      }

      case "H": {
        for (const n of nums) {
          const next = { x: isRel ? cur.x + n : n, y: cur.y };
          const a = anchors.length - 1;
          const b = addAnchor(next);
          segments.push({ kind: "line", a, b });
          cur = next;
        }
        break;
      }

      case "V": {
        for (const n of nums) {
          const next = { x: cur.x, y: isRel ? cur.y + n : n };
          const a = anchors.length - 1;
          const b = addAnchor(next);
          segments.push({ kind: "line", a, b });
          cur = next;
        }
        break;
      }

      case "C": {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const ca = isRel ? { x: cur.x + nums[i], y: cur.y + nums[i + 1] } : { x: nums[i], y: nums[i + 1] };
          const cb = isRel ? { x: cur.x + nums[i + 2], y: cur.y + nums[i + 3] } : { x: nums[i + 2], y: nums[i + 3] };
          const dest = isRel ? { x: cur.x + nums[i + 4], y: cur.y + nums[i + 5] } : { x: nums[i + 4], y: nums[i + 5] };
          const a = anchors.length - 1;
          const b = addAnchor(dest);
          segments.push({ kind: "cubic", a, b, ca, cb });
          cur = dest;
          lastCubicCb = cb;
          lastQuadC = null;
        }
        break;
      }

      case "S": {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const cb = isRel ? { x: cur.x + nums[i], y: cur.y + nums[i + 1] } : { x: nums[i], y: nums[i + 1] };
          const dest = isRel ? { x: cur.x + nums[i + 2], y: cur.y + nums[i + 3] } : { x: nums[i + 2], y: nums[i + 3] };
          const ca = lastCubicCb ? reflect(lastCubicCb, cur) : { ...cur };
          const a = anchors.length - 1;
          const b = addAnchor(dest);
          segments.push({ kind: "cubic", a, b, ca, cb });
          cur = dest;
          lastCubicCb = cb;
          lastQuadC = null;
        }
        break;
      }

      case "Q": {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const c = isRel ? { x: cur.x + nums[i], y: cur.y + nums[i + 1] } : { x: nums[i], y: nums[i + 1] };
          const dest = isRel ? { x: cur.x + nums[i + 2], y: cur.y + nums[i + 3] } : { x: nums[i + 2], y: nums[i + 3] };
          const a = anchors.length - 1;
          const b = addAnchor(dest);
          segments.push({ kind: "quad", a, b, c });
          cur = dest;
          lastQuadC = c;
          lastCubicCb = null;
        }
        break;
      }

      case "T": {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const dest = isRel ? { x: cur.x + nums[i], y: cur.y + nums[i + 1] } : { x: nums[i], y: nums[i + 1] };
          const c: Pt = lastQuadC ? reflect(lastQuadC, cur) : { ...cur };
          const a = anchors.length - 1;
          const b = addAnchor(dest);
          segments.push({ kind: "quad", a, b, c });
          cur = dest;
          lastQuadC = c;
          lastCubicCb = null;
        }
        break;
      }

      case "A": {
        for (let i = 0; i + 6 < nums.length; i += 7) {
          const rx = nums[i];
          const ry = nums[i + 1];
          const rot = nums[i + 2];
          const laf = nums[i + 3];
          const sf = nums[i + 4];
          const dest = isRel ? { x: cur.x + nums[i + 5], y: cur.y + nums[i + 6] } : { x: nums[i + 5], y: nums[i + 6] };
          for (const c of arcToCubics(cur, rx, ry, rot, laf, sf, dest)) {
            const a = anchors.length - 1;
            const b = addAnchor(c.dest);
            segments.push({ kind: "cubic", a, b, ca: c.ca, cb: c.cb });
          }
          cur = dest;
          lastCubicCb = null;
          lastQuadC = null;
        }
        break;
      }

      case "Z": {
        lastSubpathClosed = true;
        lastCubicCb = null;
        lastQuadC = null;
        if (anchors.length > 1) {
          const lastIdx = anchors.length - 1;
          const first = anchors[subpathStartIdx];
          const last = anchors[lastIdx];
          if (Math.abs(last.x - first.x) <= EPS && Math.abs(last.y - first.y) <= EPS) {
            // The final anchor duplicates the subpath start: drop it and mark
            // the incoming real segment so serialize closes with Z after it.
            anchors.pop();
            segments.forEach((s) => {
              if (s.b === lastIdx) {
                s.b = subpathStartIdx;
                s.zc = true;
              }
            });
          } else if (Math.abs(cur.x - first.x) > EPS || Math.abs(cur.y - first.y) > EPS) {
            segments.push({ kind: "line", a: anchors.length - 1, b: subpathStartIdx, z: true });
          }
        }
        cur = { ...startPt };
        break;
      }

      default:
        break;
    }
  }

  // `closed` means the last subpath is closed, so a trailing Z in serialize
  // never wrongly welds an open final subpath (e.g. box's inner lines).
  return { anchors, segments, closed: lastSubpathClosed };
}

/**
 * Converts one SVG elliptical arc (endpoint parameterization) into cubic
 * Bézier segments (max 90° each), so the editable path model — which only
 * knows line/quad/cubic — can represent arcs. The two candidate centers from
 * F.6.5 are both computed and the one matching laf/sf is selected directly,
 * which avoids angle-sign-convention traps in the y-down frame.
 */
function arcToCubics(
  from: Pt,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  laf: number,
  sf: number,
  to: Pt
): Array<{ ca: Pt; cb: Pt; dest: Pt }> {
  if (Math.abs(from.x - to.x) < EPS && Math.abs(from.y - to.y) < EPS) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < EPS || ry < EPS) return [{ ca: { ...from }, cb: { ...to }, dest: to }];

  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const denom = rx2 * y1p * y1p + ry2 * x1p * x1p;
  if (denom === 0) return [];
  const co = Math.sqrt(Math.max(0, (rx2 * ry2 - denom) / denom));

  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const offX = (co * rx * y1p) / ry;
  const offY = (-co * ry * x1p) / rx;

  let cx = 0;
  let cy = 0;
  let dTheta = 0;
  for (const sigma of [1, -1]) {
    cx = mx + sigma * offX;
    cy = my + sigma * offY;
    const a1 = Math.atan2((from.y - cy) / ry, (from.x - cx) / rx);
    const a2 = Math.atan2((to.y - cy) / ry, (to.x - cx) / rx);
    let d = a2 - a1;
    if (sf === 1 && d < 0) d += 2 * Math.PI;
    if (sf === 0 && d > 0) d -= 2 * Math.PI;
    dTheta = d;
    // Both candidates yield complementary sweeps; take the one whose span
    // matches the large-arc request (co=0 semicircle matches either).
    if (Math.abs(d) > Math.PI === (laf === 1)) break;
  }

  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / n;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: Array<{ ca: Pt; cb: Pt; dest: Pt }> = [];
  let theta = Math.atan2((from.y - cy) / ry, (from.x - cx) / rx);
  for (let k = 0; k < n; k++) {
    const th2 = theta + delta;
    const pt = (th: number) => ({
      x: cx + rx * Math.cos(th) * cosP - ry * Math.sin(th) * sinP,
      y: cy + rx * Math.cos(th) * sinP + ry * Math.sin(th) * cosP
    });
    const deriv = (th: number) => ({
      x: -rx * Math.sin(th) * cosP - ry * Math.cos(th) * sinP,
      y: -rx * Math.sin(th) * sinP + ry * Math.cos(th) * cosP
    });
    const p1 = pt(theta);
    const p2 = pt(th2);
    const d1 = deriv(theta);
    const d2 = deriv(th2);
    out.push({
      ca: { x: p1.x + t * d1.x, y: p1.y + t * d1.y },
      cb: { x: p2.x - t * d2.x, y: p2.y - t * d2.y },
      dest: p2
    });
    theta = th2;
  }
  // Snap the final destination exactly so rounding never drifts the endpoint.
  if (out.length > 0) out[out.length - 1].dest = { ...to };
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Serializes an EditablePath back to standard SVG path data string.
 * Anchors flagged `m` begin a new subpath and emit a moveto.
 */
export function serializePathData(path: EditablePath): string {
  if (!path.anchors || path.anchors.length === 0) return "";
  const parts: string[] = [];
  const start = path.anchors[0];
  parts.push(`M ${r2(start.x)} ${r2(start.y)}`);

  const segCount = path.segments.length;
  for (let i = 0; i < segCount; i++) {
    const seg = path.segments[i];
    if (seg.a !== 0 && path.anchors[seg.a]?.m) {
      const a = path.anchors[seg.a];
      parts.push(`M ${r2(a.x)} ${r2(a.y)}`);
    }
    // A synthetic closepath segment is drawn by Z itself
    if (seg.kind === "line" && seg.z) {
      parts.push("Z");
      continue;
    }
    if (seg.kind === "line") {
      const b = path.anchors[seg.b];
      if (b) parts.push(`L ${r2(b.x)} ${r2(b.y)}`);
    } else if (seg.kind === "quad") {
      const b = path.anchors[seg.b];
      if (b) parts.push(`Q ${r2(seg.c.x)} ${r2(seg.c.y)} ${r2(b.x)} ${r2(b.y)}`);
    } else if (seg.kind === "cubic") {
      const b = path.anchors[seg.b];
      if (b) {
        parts.push(`C ${r2(seg.ca.x)} ${r2(seg.ca.y)} ${r2(seg.cb.x)} ${r2(seg.cb.y)} ${r2(b.x)} ${r2(b.y)}`);
      }
    }
    if (seg.zc) {
      parts.push("Z");
    }
  }

  // Trailing Z closes the last subpath, but never when its closure was already
  // emitted inline. Both spellings count: `z` is a synthetic closepath segment that
  // stands alone, `zc` marks the last real segment because the parser dropped the
  // duplicate final anchor. Checking only the first missed the second, so every
  // round trip through parse/serialize appended another Z — invisible in the
  // rendering and permanent in the document.
  const lastSeg = path.segments[segCount - 1];
  const closedInline = Boolean(lastSeg && (lastSeg.zc || (lastSeg.kind === "line" && lastSeg.z)));
  if (path.closed && !closedInline) {
    parts.push("Z");
  }

  return parts.join(" ");
}

/**
 * Moves an anchor and offsets any connected cubic/quad control handles accordingly.
 */
export function moveAnchor(path: EditablePath, anchorIdx: number, newX: number, newY: number): EditablePath {
  const old = path.anchors[anchorIdx];
  if (!old) return path;
  const dx = newX - old.x;
  const dy = newY - old.y;

  const newAnchors = path.anchors.map((p, i) =>
    i === anchorIdx ? { x: newX, y: newY, m: p.m } : p
  );
  const newSegments = path.segments.map((seg) => {
    if (seg.kind === "quad") {
      const isA = seg.a === anchorIdx;
      return isA ? { ...seg, c: { x: seg.c.x + dx, y: seg.c.y + dy } } : seg;
    } else if (seg.kind === "cubic") {
      const isA = seg.a === anchorIdx;
      const isB = seg.b === anchorIdx;
      let ca = seg.ca;
      let cb = seg.cb;
      if (isA) ca = { x: ca.x + dx, y: ca.y + dy };
      if (isB) cb = { x: cb.x + dx, y: cb.y + dy };
      return { ...seg, ca, cb };
    }
    return seg;
  });

  return { ...path, anchors: newAnchors, segments: newSegments };
}

/**
 * Computes min/max bounds of all points and control handles.
 */
export function computePathBounds(path: EditablePath): { minX: number; minY: number; maxX: number; maxY: number } {
  if (path.anchors.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const update = (p: Pt) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };

  path.anchors.forEach(update);
  path.segments.forEach((s) => {
    if (s.kind === "cubic") {
      update(s.ca);
      update(s.cb);
    } else if (s.kind === "quad") {
      update(s.c);
    }
  });

  return { minX, minY, maxX, maxY };
}

/**
 * Normalizes an EditablePath so its top-left origin is at (0, 0),
 * and returns the offset and dimensions.
 */
export function normalizePathOrigin(path: EditablePath): {
  normalized: EditablePath;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
} {
  const bounds = computePathBounds(path);
  const offsetX = bounds.minX;
  const offsetY = bounds.minY;
  const width = Math.max(1, Math.round((bounds.maxX - bounds.minX) * 100) / 100);
  const height = Math.max(1, Math.round((bounds.maxY - bounds.minY) * 100) / 100);

  const shiftPt = (p: Pt & { m?: true }) => ({ x: r2(p.x - offsetX), y: r2(p.y - offsetY), m: p.m });

  const normalized: EditablePath = {
    closed: path.closed,
    anchors: path.anchors.map(shiftPt),
    segments: path.segments.map((s) => {
      if (s.kind === "line") return s;
      if (s.kind === "quad") return { ...s, c: shiftPt(s.c) };
      return { ...s, ca: shiftPt(s.ca), cb: shiftPt(s.cb) };
    })
  };

  return { normalized, offsetX, offsetY, width, height };
}

/**
 * Removes an anchor point and reconnects adjacent segments.
 */
export function removeAnchor(path: EditablePath, anchorIdx: number): EditablePath {
  if (anchorIdx < 0 || anchorIdx >= path.anchors.length) return path;
  if (path.anchors.length <= 2) {
    return { anchors: [], segments: [], closed: false };
  }

  const inSegIdx = path.segments.findIndex((s) => s.b === anchorIdx);
  const outSegIdx = path.segments.findIndex((s) => s.a === anchorIdx);

  const newSegments: EditableSegment[] = [];

  if (inSegIdx !== -1 && outSegIdx !== -1 && inSegIdx !== outSegIdx) {
    const inSeg = path.segments[inSegIdx];
    const outSeg = path.segments[outSegIdx];
    const newSeg: EditableSegment = { kind: "line", a: inSeg.a, b: outSeg.b };
    for (let i = 0; i < path.segments.length; i++) {
      if (i === inSegIdx) {
        newSegments.push(newSeg);
      } else if (i === outSegIdx) {
        continue;
      } else {
        newSegments.push(path.segments[i]);
      }
    }
  } else {
    for (let i = 0; i < path.segments.length; i++) {
      if (i !== inSegIdx && i !== outSegIdx) {
        newSegments.push(path.segments[i]);
      }
    }
  }

  const newAnchors = path.anchors.filter((_, i) => i !== anchorIdx);
  const reindexedSegments = newSegments.map((s) => ({
    ...s,
    a: s.a > anchorIdx ? s.a - 1 : s.a,
    b: s.b > anchorIdx ? s.b - 1 : s.b
  }));

  return { ...path, anchors: newAnchors, segments: reindexedSegments };
}


export type MirrorMode = "none" | "angle" | "all";

export function getAnchorMirrorMode(path: EditablePath, anchorIdx: number): MirrorMode {
  const p = path.anchors[anchorIdx];
  if (!p) return "none";

  const inSeg = path.segments.find((s) => s.b === anchorIdx);
  const outSeg = path.segments.find((s) => s.a === anchorIdx);

  const hin = inSeg && inSeg.kind === "cubic" ? inSeg.cb : null;
  const hout = outSeg && outSeg.kind === "cubic" ? outSeg.ca : null;

  if (!hin || !hout) return "none";

  const v1 = { x: hout.x - p.x, y: hout.y - p.y };
  const v2 = { x: hin.x - p.x, y: hin.y - p.y };
  const l1 = Math.hypot(v1.x, v1.y);
  const l2 = Math.hypot(v2.x, v2.y);

  if (l1 < 0.1 || l2 < 0.1) return "none";

  const dot = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
  if (dot < -0.96) {
    if (Math.abs(l1 - l2) < 2) {
      return "all";
    }
    return "angle";
  }
  return "none";
}

export function setAnchorMirrorMode(
  path: EditablePath,
  anchorIdx: number,
  mode: MirrorMode
): EditablePath {
  const p = path.anchors[anchorIdx];
  if (!p) return path;

  const inSegIdx = path.segments.findIndex((s) => s.b === anchorIdx);
  const outSegIdx = path.segments.findIndex((s) => s.a === anchorIdx);
  const defaultOffset = 30;

  if (mode === "none") {
    if (getAnchorMirrorMode(path, anchorIdx) === "none") return path;
    const nextSegments = path.segments.map((s) => ({ ...s }));
    const openAngle = (25 * Math.PI) / 180;
    const kink = (h: Pt) => {
      const len = Math.hypot(h.x - p.x, h.y - p.y) || defaultOffset;
      const base = Math.atan2(h.y - p.y, h.x - p.x);
      return { x: r2(p.x + Math.cos(base + openAngle) * len), y: r2(p.y + Math.sin(base + openAngle) * len) };
    };
    const inSeg = inSegIdx !== -1 ? nextSegments[inSegIdx] : null;
    const outSeg = outSegIdx !== -1 ? nextSegments[outSegIdx] : null;
    if (inSeg && inSeg.kind === "cubic") inSeg.cb = kink(inSeg.cb);
    else if (outSeg && outSeg.kind === "cubic") outSeg.ca = kink(outSeg.ca);
    else return path;
    return { ...path, segments: nextSegments };
  }

  const nextSegments = [...path.segments];
  let hout = outSegIdx !== -1 && nextSegments[outSegIdx].kind === "cubic"
    ? (nextSegments[outSegIdx] as any).ca
    : null;
  let hin = inSegIdx !== -1 && nextSegments[inSegIdx].kind === "cubic"
    ? (nextSegments[inSegIdx] as any).cb
    : null;

  if (outSegIdx !== -1 && nextSegments[outSegIdx].kind !== "cubic") {
    const s = nextSegments[outSegIdx];
    const bPt = path.anchors[s.b];
    hout = { x: p.x + defaultOffset, y: p.y };
    nextSegments[outSegIdx] = {
      kind: "cubic",
      a: s.a,
      b: s.b,
      ca: hout,
      cb: { x: bPt.x - defaultOffset, y: bPt.y }
    };
  }

  if (inSegIdx !== -1 && nextSegments[inSegIdx].kind !== "cubic") {
    const s = nextSegments[inSegIdx];
    const aPt = path.anchors[s.a];
    hin = { x: p.x - defaultOffset, y: p.y };
    nextSegments[inSegIdx] = {
      kind: "cubic",
      a: s.a,
      b: s.b,
      ca: { x: aPt.x + defaultOffset, y: aPt.y },
      cb: hin
    };
  }

  if (hout && hin) {
    const v = { x: hout.x - p.x, y: hout.y - p.y };
    let lenOut = Math.hypot(v.x, v.y);
    let lenIn = Math.hypot(hin.x - p.x, hin.y - p.y);
    if (lenOut < 1) lenOut = defaultOffset;
    if (lenIn < 1) lenIn = defaultOffset;

    const angle = Math.atan2(v.y, v.x);

    if (mode === "all") {
      const avgLen = (lenOut + lenIn) / 2 || defaultOffset;
      const newHout = { x: r2(p.x + Math.cos(angle) * avgLen), y: r2(p.y + Math.sin(angle) * avgLen) };
      const newHin = { x: r2(p.x - Math.cos(angle) * avgLen), y: r2(p.y - Math.sin(angle) * avgLen) };
      if (outSegIdx !== -1) (nextSegments[outSegIdx] as any).ca = newHout;
      if (inSegIdx !== -1) (nextSegments[inSegIdx] as any).cb = newHin;
    } else if (mode === "angle") {
      let lenIn2 = lenIn;
      if (Math.abs(lenOut - lenIn2) < 2) {
        lenIn2 = lenOut * 0.65;
      }
      const newHin = { x: r2(p.x - Math.cos(angle) * lenIn2), y: r2(p.y - Math.sin(angle) * lenIn2) };
      if (inSegIdx !== -1) (nextSegments[inSegIdx] as any).cb = newHin;
    }
  }

  return { ...path, segments: nextSegments };
}

/**
 * Scales all anchors and control handles in an EditablePath by sx and sy.
 */
export function scalePathData(path: EditablePath, sx: number, sy: number): EditablePath {
  const scalePt = (p: Pt & { m?: true }) => ({
    x: Math.round(p.x * sx * 100) / 100,
    y: Math.round(p.y * sy * 100) / 100,
    m: p.m
  });

  return {
    closed: path.closed,
    anchors: path.anchors.map(scalePt),
    segments: path.segments.map((s) => {
      if (s.kind === "line") return s;
      if (s.kind === "quad") return { ...s, c: scalePt(s.c) };
      return { ...s, ca: scalePt(s.ca), cb: scalePt(s.cb) };
    })
  };
}

/**
 * The same geometry traversed the other way round.
 *
 * Text on a path hangs its glyphs to the LEFT of the direction of travel, so
 * reversing a path is what moves a run from one side of it to the other — which
 * is the whole of `TextElement.onPath.side`. Reversing the *string* alongside it
 * is what keeps the run readable: the two cancel, and the glyphs stay upright in
 * the original reading order.
 *
 * Refuses anything it cannot reverse faithfully. The chain test is structural
 * rather than a flag test on purpose: `m` marks the anchor before a segment that
 * starts a subpath, which is not the same thing as "this is a subpath start", so
 * `M 0 0 L 10 0 M 20 20 L 30 20` reports one `m` for two subpaths. Segments that
 * do not hand off to each other are the honest signal, and returning the input
 * untouched beats emitting a path that interleaves two subpaths.
 */
export function reversePathData(d: string): string | null {
  const path = parsePathData(d);
  if (!path) return null;
  const n = path.anchors.length;
  const segs = path.segments;
  if (n < 2 || segs.length === 0) return null;

  for (let i = 0; i < segs.length; i++) {
    if (segs[i].a !== (i === 0 ? 0 : segs[i - 1].b)) return null;
  }

  // A closed path returns to anchor 0, so its segments are a cycle and the
  // reversal has to keep that: anchor 0 stays put and the rest walk backwards.
  // An open one is a chain, so it starts from the other end instead.
  const isCycle = path.closed || segs[segs.length - 1].b === 0;
  if (isCycle && segs.length !== n) return null;
  if (!isCycle && segs.length !== n - 1) return null;

  const newIdx = isCycle ? (i: number) => ((n - i) % n + n) % n : (i: number) => n - 1 - i;
  const reversedAnchors = path.anchors.map((_, i) => ({ ...path.anchors[newIdx(i)] }));

  const reversedSegments: EditableSegment[] = [];
  for (let j = segs.length - 1; j >= 0; j--) {
    const seg = segs[j];
    // The reversed segment runs from the old end of j to the old start of j.
    const a = newIdx(seg.b);
    const b = newIdx(seg.a);
    // `z` / `zc` are dropped rather than carried: both mark an edge whose END is
    // the subpath start, which after reversal is the FIRST edge, and the
    // serializer would then close the subpath before drawing anything. `closed`
    // puts the trailing Z back where it belongs.
    if (seg.kind === "line") reversedSegments.push({ kind: "line", a, b });
    else if (seg.kind === "quad") reversedSegments.push({ kind: "quad", a, b, c: seg.c });
    else reversedSegments.push({ kind: "cubic", a, b, ca: seg.cb, cb: seg.ca });
  }
  if (reversedAnchors[0].m) delete reversedAnchors[0].m;
  return serializePathData({ anchors: reversedAnchors, segments: reversedSegments, closed: isCycle });
}
