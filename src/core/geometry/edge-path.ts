export interface Point {
  x: number;
  y: number;
}

export function pt(n: number): string {
  return n.toFixed(2);
}

/** Catmull-Rom through every point, emitted as cubic Béziers. `tension = 1/10`
 *  keeps vector facets and stepped corners crisp without sharp mitre spikes;
 *  `0` collapses each cubic onto its own chord, which is how a zigzag stays a
 *  polyline. */
export function curveD(pts: Point[], tension = 1 / 10): string {
  if (pts.length === 0) return "";
  let d = `M ${pt(pts[0].x)} ${pt(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    d +=
      ` C ${pt(p1.x + (p2.x - p0.x) * tension)} ${pt(p1.y + (p2.y - p0.y) * tension)}` +
      ` ${pt(p2.x - (p3.x - p1.x) * tension)} ${pt(p2.y - (p3.y - p1.y) * tension)}` +
      ` ${pt(p2.x)} ${pt(p2.y)}`;
  }
  return d;
}

/** A closed band between two point runs; `inner` follows the seam while `outer`
 *  traces a stepped contour back to the start. Both runs must close themselves
 *  when the seam is a loop — an open pair would leave one segment unbanded. */
export function bandD(inner: Point[], outer: Point[]): string {
  const back = outer.slice().reverse();
  const first = curveD(inner, 1 / 10);
  const tail = curveD(back, 1 / 11);
  const at = tail.indexOf("C");
  return `${first} L ${pt(back[0].x)} ${pt(back[0].y)} ${at >= 0 ? tail.slice(at) : ""} Z`;
}

/** A box as a closed subpath — the paper a `cut` keeps and the outline a hole
 *  is knocked out of. */
export function boxD(x: number, y: number, w: number, h: number): string {
  return `M ${pt(x)} ${pt(y)} L ${pt(x + w)} ${pt(y)} L ${pt(x + w)} ${pt(y + h)} L ${pt(x)} ${pt(y + h)} Z`;
}
