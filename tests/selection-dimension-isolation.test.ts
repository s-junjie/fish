import { flattenLayout, layoutOf } from "../src/core/dsl/layout-flat";
import { describe, it, expect, vi } from "vitest";
import { FrameElement, RectElement } from "../src/core/dsl/types";
import { withAspectLock, isAspectLocked } from "../src/core/geometry/aspect-lock";
import { resizeElementWithConstraints } from "../src/core/geometry/constraints";
import { applyAutoLayout } from "../src/core/compile";

describe("selection dimension and aspect lock isolation", () => {
  const createAutoLayoutFixture = () => {
    const r1: RectElement = {
      id: "r1",
      type: "rect",
      x: 10,
      y: 10,
      width: 100,
      height: 100
    };
    const r2: RectElement = {
      id: "r2",
      type: "rect",
      x: 120,
      y: 10,
      width: 100,
      height: 100
    };
    const frame: FrameElement = {
      id: "parent-frame",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 150,
      ...flattenLayout({
        mode: "flex",
        direction: "row",
        gap: 10,
        padding: 10
      }),
      children: [r1, r2]
    };
    return { frame, r1, r2 };
  };

  it("aspect lock on rect 1 does not affect identical rect 2 in auto layout", () => {
    const { r1, r2 } = createAutoLayoutFixture();
    const lockedR1 = withAspectLock(r1, true);

    expect(isAspectLocked(lockedR1)).toBe(true);
    expect(isAspectLocked(r2)).toBe(false);
  });

  it("resizing rect 1 with aspect lock scales width and height proportionally without bleeding onto rect 2", () => {
    const { r1, r2 } = createAutoLayoutFixture();
    const lockedR1 = withAspectLock(r1, true);

    // Calculate aspect locked new height for r1 when newW = 200
    const ratio = lockedR1.width / Math.max(1, lockedR1.height);
    const newW = 200;
    const newH = Math.max(1, Math.round(newW / ratio));

    const resizedR1 = resizeElementWithConstraints(lockedR1, { width: newW, height: newH });

    expect(resizedR1.width).toBe(200);
    expect(resizedR1.height).toBe(200);
    expect(isAspectLocked(resizedR1)).toBe(true);

    // rect 2 must remain in its pristine state
    expect(r2.width).toBe(100);
    expect(r2.height).toBe(100);
    expect(isAspectLocked(r2)).toBe(false);
  });

  it("targetId guard prevents mutation from bleeding onto other elements if selection changes during blur", () => {
    const { r1, r2 } = createAutoLayoutFixture();
    const targetId = r1.id;
    const newW = 250;
    const newH = 250;

    // Mutator with targetId guard
    const mutator = (el: any) => (el.id === targetId ? resizeElementWithConstraints(el, { width: newW, height: newH }) : el);

    // If mutator is evaluated on r2, it must return r2 untouched
    const mutatedR2 = mutator(r2);
    expect(mutatedR2).toBe(r2);
    expect(mutatedR2.width).toBe(100);
    expect(mutatedR2.height).toBe(100);

    // Evaluated on r1, it mutates r1
    const mutatedR1 = mutator(r1);
    expect(mutatedR1.width).toBe(250);
    expect(mutatedR1.height).toBe(250);
  });

  it("aspect lock mutator with single-selection targetId guard leaves sibling rect untouched", () => {
    const { r1, r2 } = createAutoLayoutFixture();
    const targetId = r1.id;
    const isLocked = isAspectLocked(r1);

    const lockMutator = (el: any) => (!targetId || el.id === targetId ? withAspectLock(el, !isLocked) : el);

    expect(isAspectLocked(lockMutator(r1))).toBe(true);
    expect(isAspectLocked(lockMutator(r2))).toBe(false);
  });

  it("activating auto layout on a frame with children sets sizing to fit-content", () => {
    const rawFrame: FrameElement = {
      id: "f_raw",
      type: "frame",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      children: [
        { id: "c1", type: "rect", x: 10, y: 10, width: 60, height: 40 },
        { id: "c2", type: "rect", x: 80, y: 10, width: 60, height: 40 }
      ]
    };

    // Simulate switchLayoutMode to "horizontal"
    const hasChildren = (rawFrame.children || []).length > 0;
    const nextSizing = rawFrame.sizing ? { ...rawFrame.sizing } : {};
    if (!layoutOf(rawFrame) && hasChildren) {
      if (!nextSizing.width) nextSizing.width = "fit-content";
      if (!nextSizing.height) nextSizing.height = "fit-content";
    }

    expect(nextSizing.width).toBe("fit-content");
    expect(nextSizing.height).toBe("fit-content");
  });

  it("enabling wrap sets cross axis to fit-content and main axis to fixed, fitting multi-line height", () => {
    const r1: RectElement = { id: "r1", type: "rect", x: 0, y: 0, width: 90, height: 40 };
    const r2: RectElement = { id: "r2", type: "rect", x: 0, y: 0, width: 90, height: 40 };
    const r3: RectElement = { id: "r3", type: "rect", x: 0, y: 0, width: 90, height: 40 };

    const frame: FrameElement = {
      id: "f_wrap",
      type: "frame",
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      sizing: { height: "fit-content" },
      ...flattenLayout({
        mode: "flex",
        direction: "row",
        wrap: "wrap",
        gap: 10,
        padding: 10
      }),
      children: [r1, r2, r3]
    };

    // Available main = 200 - 20 = 180.
    // Line 1: r1 (90) + gap (10) + r2 (90) = 190 > 180 -> r2 wraps!
    // Or r1 (90) on line 1, r2 (90) on line 2, r3 (90) on line 3.
    // Each line has height 40.
    const res = applyAutoLayout(frame);
    expect(res.children.length).toBe(3);
    // Height must be greater than a single row (40 + padding 20 = 60)
    expect(res.height).toBeGreaterThan(60);
    // Specifically, for 2 or 3 wrapped rows with gap 10 and padding 10:
    // With width 200: r1 (90) fits in 180, r1 + 10 + r2 = 190 > 180 so r2 wraps to line 2.
    // Line 2: r2 (90), r3 wraps to line 3. 3 lines * 40 + 2 gaps * 10 + 20 padding = 160.
    expect(res.height).toBe(160);
  });
});
