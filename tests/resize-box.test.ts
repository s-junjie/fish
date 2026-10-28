import { describe, it, expect } from "vitest";
import { resolveResizeBox, ResolveResizeBoxInput } from "../src/core/geometry/resize-box";
import { ResizeHandleType } from "../src/core/geometry/snap-guides";

// 2:1, so a drag that widens by 60 and heightens by 20 asks for two DIFFERENT
// heights: 120 raw, 130 once the ratio constraint has its way. Every locked
// assertion below lives on that 10px gap — a drag whose two axes agreed would be
// satisfied by both the correct and the incorrect order of operations.
const START = { x: 600, y: 400, width: 200, height: 100 };

const drag = (handle: ResizeHandleType, localDx: number, localDy: number, over: Partial<ResolveResizeBoxInput> = {}) =>
  resolveResizeBox({
    start: START,
    localDx,
    localDy,
    handle,
    rotation: 0,
    lockW: false,
    lockH: false,
    aspectLocked: false,
    shiftKey: false,
    fromCenter: false,
    scaleMode: false,
    ...over
  });

describe("the proportion lock pins the anchored edge", () => {
  // The regression: the origin for a north drag was derived from the height the
  // pointer asked for, and the ratio constraint then REPLACED that height — so the
  // bottom edge the drag is supposed to hold still moved by 10px on every frame.
  it("derives a locked tl origin from the height the lock produced", () => {
    const box = drag("tl", -60, -20, { aspectLocked: true });
    expect(box.width).toBe(260);
    expect(box.height).toBe(130);
    expect(box.y + box.height, "bottom edge anchored").toBe(START.y + START.height);
    expect(box.x + box.width, "right edge anchored").toBe(START.x + START.width);
  });

  it("does the same for tr, which also moves the north edge", () => {
    const box = drag("tr", 60, -20, { aspectLocked: true });
    expect(box.width).toBe(260);
    expect(box.height).toBe(130);
    expect(box.y + box.height, "bottom edge anchored").toBe(START.y + START.height);
    expect(box.x, "left edge anchored").toBe(START.x);
  });

  // The control: these two derive their origin from the WIDTH alone, so the fix
  // must leave them exactly where they were.
  it("leaves bl and br, whose origin never depended on the height", () => {
    const bl = drag("bl", -60, 20, { aspectLocked: true });
    expect([bl.x + bl.width, bl.y]).toEqual([START.x + START.width, START.y]);
    const br = drag("br", 60, 20, { aspectLocked: true });
    expect([br.x, br.y]).toEqual([START.x, START.y]);
  });

  it("keeps the ratio itself", () => {
    for (const handle of ["tl", "tr", "bl", "br"] as ResizeHandleType[]) {
      const dx = handle === "tl" || handle === "bl" ? -60 : 60;
      const dy = handle === "tl" || handle === "tr" ? -20 : 20;
      const box = drag(handle, dx, dy, { aspectLocked: true });
      expect(box.width / box.height, handle).toBeCloseTo(START.width / START.height, 5);
    }
  });

  // Shift is the session spelling of the same constraint, so it has to reach the
  // same corrected origin — otherwise the bug is only half-fixed and the user
  // picks which half by whether they pressed a key.
  it("treats shift as the same constraint", () => {
    const box = drag("tr", 60, -20, { shiftKey: true });
    expect(box.aspectActive).toBe(true);
    expect(box.height).toBe(130);
    expect(box.y + box.height).toBe(START.y + START.height);
  });

  it("rotates the correction with the element", () => {
    // At 90° the local frame is the world frame turned a quarter: a "north" drag
    // moves the box's world-X. The anchored edge is still the one opposite the
    // handle, so the assertion is on the origin having moved by the size delta
    // rather than on a hard-coded coordinate.
    const box = drag("tm", 0, -20, { aspectLocked: true, rotation: 90 });
    expect(box.aspectActive).toBe(false); // an edge handle is not a corner
    expect(box.height).toBe(120);
    const rotated = drag("tr", 60, -20, { aspectLocked: true, rotation: 90 });
    expect(rotated.width).toBe(260);
    expect(rotated.height).toBe(130);
    // A 90° turn sends the height's share of the origin shift onto world X, and
    // the width's onto world Y. `tr` grows its height by 30 and its width by 60,
    // so the origin moves 30 along X and none along Y (the width delta is on the
    // west side of nothing for this handle).
    expect([rotated.x, rotated.y]).toEqual([START.x + (rotated.height - START.height), START.y]);
  });
});

describe("aspectActive says which constraint owns the frame", () => {
  it("is on for a locked corner and off for an unlocked one", () => {
    expect(drag("tl", -10, -10, { aspectLocked: true }).aspectActive).toBe(true);
    expect(drag("tl", -10, -10).aspectActive).toBe(false);
  });

  // The ratio only constrains a corner. On an edge handle it changes nothing, so
  // reporting it active would switch snapping off for a drag that never had a
  // conflict with it.
  it("is off on an edge handle, where the ratio constrains nothing", () => {
    for (const handle of ["tm", "bm", "ml", "mr"] as ResizeHandleType[]) {
      expect(drag(handle, -10, -10, { aspectLocked: true }).aspectActive, handle).toBe(false);
    }
  });

  // A snap hands back a width the ratio would then have to reject, so an engine-
  // owned axis has to win over the ratio or the two constraints disagree silently.
  it("is off when either axis is engine-owned", () => {
    expect(drag("tl", -10, -10, { aspectLocked: true, lockH: true }).aspectActive).toBe(false);
    expect(drag("tl", -10, -10, { aspectLocked: true, lockW: true }).aspectActive).toBe(false);
  });
});

describe("an unlocked resize is untouched by the ratio machinery", () => {
  it("follows the pointer on both axes", () => {
    expect(drag("tl", -60, -20)).toMatchObject({ width: 260, height: 120 });
    expect(drag("br", 60, 20)).toMatchObject({ width: 260, height: 120 });
  });

  it("anchors the opposite corner, as a corner drag always has", () => {
    const tl = drag("tl", -60, -20);
    expect([tl.x + tl.width, tl.y + tl.height]).toEqual([START.x + START.width, START.y + START.height]);
    const br = drag("br", 60, 20);
    expect([br.x, br.y]).toEqual([START.x, START.y]);
  });

  it("leaves the position to the anchor under the Scale tool", () => {
    // The anchor is the scale operation's own job; deriving an origin here too
    // would fight it.
    expect(drag("tl", -60, -20, { scaleMode: true })).toMatchObject({ x: START.x, y: START.y, width: 260 });
  });

  it("refuses to write an engine-owned axis", () => {
    expect(drag("tl", -60, -20, { lockW: true }).width).toBe(START.width);
    expect(drag("tl", -60, -20, { lockH: true }).height).toBe(START.height);
  });

  it("floors a degenerate edge at 10px", () => {
    expect(drag("br", -500, -500).width).toBe(10);
    expect(drag("br", -500, -500).height).toBe(10);
  });
});

// Alt/Option is the mirror of invariant 1: the edge opposite the handle is
// RELEASED and the centre is pinned. Both edges travel, so the size moves twice
// as far and the origin by half of it.
describe("Alt/Option resizes about the centre", () => {
  const centreOf = (box: { x: number; y: number; width: number; height: number }) => [
    box.x + box.width / 2,
    box.y + box.height / 2
  ];
  const START_CENTRE = [START.x + START.width / 2, START.y + START.height / 2];

  it("doubles the size change, on both axes of a corner", () => {
    expect(drag("br", 60, 20, { fromCenter: true })).toMatchObject({ width: 320, height: 140 });
    expect(drag("tl", -60, -20, { fromCenter: true })).toMatchObject({ width: 320, height: 140 });
  });

  it("holds the centre still, which is the whole statement", () => {
    for (const handle of ["tl", "tr", "br", "bl"] as ResizeHandleType[]) {
      const dx = handle === "tl" || handle === "bl" ? -60 : 60;
      const dy = handle === "tl" || handle === "tr" ? -20 : 20;
      expect(centreOf(drag(handle, dx, dy, { fromCenter: true })), handle).toEqual(START_CENTRE);
    }
  });

  it("grows both sides of an edge handle, and only on that axis", () => {
    // `mr` moves the width alone, so the centre holds on both axes while the
    // height is left exactly as it was.
    const mr = drag("mr", 30, 0, { fromCenter: true });
    expect(mr).toMatchObject({ width: 260, height: START.height });
    expect(centreOf(mr)).toEqual(START_CENTRE);
    const tm = drag("tm", 0, -30, { fromCenter: true });
    expect(tm).toMatchObject({ width: START.width, height: 160 });
    expect(centreOf(tm)).toEqual(START_CENTRE);
  });

  it("composes with shift: the ratio holds AND the centre holds", () => {
    const box = drag("br", 60, 20, { fromCenter: true, shiftKey: true });
    expect(box.aspectActive).toBe(true);
    expect(box.width).toBe(320);
    // The ratio rewrites the height, so it is the LOCKED one the origin is
    // derived from — 320/2 rather than the 140 the pointer asked for.
    expect(box.height).toBe(160);
    expect(centreOf(box)).toEqual(START_CENTRE);
  });

  it("keeps the centre when the element's own proportion lock is on", () => {
    const box = drag("tr", 60, -20, { fromCenter: true, aspectLocked: true });
    expect(box.width).toBe(320);
    expect(box.height).toBe(160);
    expect(centreOf(box)).toEqual(START_CENTRE);
  });

  it("moves the origin along the element's own axes when it is rotated", () => {
    // A quarter turn sends the width's share onto world Y and the height's onto
    // world X — the same rotation the pinned-edge path uses, so a centre-anchored
    // drag of a rotated layer cannot drift.
    const box = drag("br", 60, 20, { fromCenter: true, rotation: 90 });
    expect(box.width).toBe(320);
    expect(box.height).toBe(140);
    // localDx = -60 (width grew by 120), localDy = -20: x' = -localDy, y' = +localDx.
    expect([box.x, box.y]).toEqual([START.x + 20, START.y - 60]);
  });

  it("is ignored under the Scale tool, whose anchor the panel owns", () => {
    expect(drag("br", 60, 20, { fromCenter: true, scaleMode: true })).toMatchObject({
      x: START.x,
      y: START.y,
      width: 260
    });
  });

  it("leaves an engine-owned axis alone, centre or not", () => {
    expect(drag("br", 60, 20, { fromCenter: true, lockW: true })).toMatchObject({
      width: START.width,
      height: 140
    });
    expect(drag("br", 60, 20, { fromCenter: true, lockH: true })).toMatchObject({
      width: 320,
      height: START.height
    });
  });
});
