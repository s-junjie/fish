import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { applyCssSpelling } from "../src/core/dsl/css-spelling";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import {
  computeContainerScrollBounds,
  clampScrollOffset,
  canContainerScroll,
  findScrollableContainersAtPoint,
  isScrollableContainer,
  childScrollOffset
} from "../src/core/geometry/scroll-bounds";
import { computeParentOrigin, computeParentWorldMatrix } from "../src/core/geometry/tree-coords";
import { findElementAtPoint } from "../src/core/geometry/tree-hit";
import type { FrameElement, RectElement } from "../src/core/dsl/types";

describe("frame scroll capabilities", () => {
  describe("normalization & persistence", () => {
    it("normalizes overflow scroll keywords to clipContent and scrollOverflow", () => {
      const doc = normalizeDesignDocument({
        version: LATEST_DOCUMENT_VERSION,
        name: "Scroll Test",
        elements: [
          { id: "f1", type: "frame", x: 0, y: 0, width: 200, height: 200, overflow: "scroll" },
          { id: "f2", type: "frame", x: 0, y: 0, width: 200, height: 200, overflow: "scroll-y" },
          { id: "f3", type: "frame", x: 0, y: 0, width: 200, height: 200, overflow: "scroll-x" }
        ]
      }).document;

      const [f1, f2, f3] = doc.pages[0].children as FrameElement[];
      expect(f1.clipContent).toBe(true);
      expect(f1.scrollOverflow).toBe("both");

      expect(f2.clipContent).toBe(true);
      expect(f2.scrollOverflow).toBe("vertical");

      expect(f3.clipContent).toBe(true);
      expect(f3.scrollOverflow).toBe("horizontal");
    });

    it("normalizes scroll offsets and alias spellings", () => {
      const doc = normalizeDesignDocument({
        version: LATEST_DOCUMENT_VERSION,
        name: "Scroll Offsets",
        elements: [
          {
            id: "f1",
            type: "frame",
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            scrollOverflow: "both",
            scrollLeft: 42,
            scrollTop: 84
          },
          {
            id: "f2",
            type: "frame",
            x: 0,
            y: 0,
            width: 200,
            height: 200,
            scrollOverflow: "vertical",
            scrollX: -10,
            scrollY: 100
          }
        ]
      }).document;

      const [f1, f2] = doc.pages[0].children as FrameElement[];
      expect(f1.scrollX).toBe(42);
      expect(f1.scrollY).toBe(84);

      // Negative offset clamped to 0 (omitted from output)
      expect(f2.scrollX).toBeUndefined();
      expect(f2.scrollY).toBe(100);
    });

    it("round-trips CSS spelling with applyCssSpelling", () => {
      const frame: FrameElement = {
        id: "f1",
        type: "frame",
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        clipContent: true,
        scrollOverflow: "vertical",
        scrollX: 0,
        scrollY: 150,
        children: []
      };

      const doc = { pages: [{ id: "p1", children: [frame] }] };
      const spelledDoc = applyCssSpelling(doc as any) as any;
      const spelled = spelledDoc.pages[0].children[0];
      expect(spelled.overflow).toBe("scroll-y");
      expect(spelled["scroll-y"]).toBe("150px");
      expect(spelled["scroll-x"]).toBeUndefined();

      // Normalizing the spelled object round-trips correctly
      const roundTripDoc = normalizeDesignDocument({
        version: LATEST_DOCUMENT_VERSION,
        name: "Round-trip",
        elements: [spelled]
      }).document;

      const roundTripEl = roundTripDoc.pages[0].children[0] as FrameElement;
      expect(roundTripEl.clipContent).toBe(true);
      expect(roundTripEl.scrollOverflow).toBe("vertical");
      expect(roundTripEl.scrollY).toBe(150);
    });
  });

  describe("computeContainerScrollBounds & clampScrollOffset", () => {
    it("computes maximum scroll extents from child bounding boxes", () => {
      const container: FrameElement = {
        id: "c",
        type: "frame",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        padding: [10, 20, 30, 40], // top, right, bottom, left
        scrollOverflow: "both",
        children: [
          { id: "r1", type: "rect", x: 0, y: 0, width: 400, height: 100 },
          { id: "r2", type: "rect", x: 100, y: 150, width: 100, height: 250 }
        ]
      };

      // child maxX = 400 (r1: 0+400, r2: 100+100=200). With padding right 20: 420. container.width = 300.
      // maxScrollX = 420 - 300 = 120.
      // child maxY = 400 (r1: 100, r2: 150+250=400). With padding bottom 30: 430. container.height = 200.
      // maxScrollY = 430 - 200 = 230.
      const bounds = computeContainerScrollBounds(container);
      expect(bounds.maxScrollX).toBe(120);
      expect(bounds.maxScrollY).toBe(230);
    });

    it("clamps scroll offsets according to scrollOverflow mode", () => {
      const container: FrameElement = {
        id: "c",
        type: "frame",
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        scrollOverflow: "vertical",
        children: [{ id: "r", type: "rect", x: 0, y: 0, width: 500, height: 500 }]
      };

      // vertical mode ignores horizontal scroll
      const clamped = clampScrollOffset(container, 100, 150);
      expect(clamped.scrollX).toBe(0);
      expect(clamped.scrollY).toBe(150);

      // Clamps to maxScrollY (500 - 200 = 300)
      const clampedOver = clampScrollOffset(container, 0, 400);
      expect(clampedOver.scrollY).toBe(300);

      // Clamps negative to 0
      const clampedNegative = clampScrollOffset(container, 0, -50);
      expect(clampedNegative.scrollY).toBe(0);
    });

    it("canContainerScroll evaluates direction and boundary correctly", () => {
      const container: FrameElement = {
        id: "c",
        type: "frame",
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        scrollOverflow: "vertical",
        scrollY: 100,
        children: [{ id: "r", type: "rect", x: 0, y: 0, width: 200, height: 400 }]
      };
      // maxScrollY = 400 - 200 = 200. Current scrollY = 100.
      expect(canContainerScroll(container, 0, 10)).toBe(true); // scrolling down
      expect(canContainerScroll(container, 0, -10)).toBe(true); // scrolling up
      expect(canContainerScroll(container, 10, 0)).toBe(false); // horizontal not supported

      // At bottom boundary:
      const atBottom = { ...container, scrollY: 200 };
      expect(canContainerScroll(atBottom, 0, 10)).toBe(false); // cannot scroll further down
      expect(canContainerScroll(atBottom, 0, -10)).toBe(true); // can scroll up
    });
  });

  describe("tree coordinates & hit-testing with scroll offsets", () => {
    it("offsets parent origin and world matrix by scrollX and scrollY", () => {
      const child: RectElement = { id: "child", type: "rect", x: 20, y: 30, width: 50, height: 50 };
      const frame: FrameElement = {
        id: "frame",
        type: "frame",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        scrollOverflow: "both",
        scrollX: 40,
        scrollY: 60,
        children: [child]
      };

      const origin = computeParentOrigin([frame], "child");
      // origin should be frame.x - scrollX = 100 - 40 = 60, frame.y - scrollY = 100 - 60 = 40
      expect(origin.x).toBe(60);
      expect(origin.y).toBe(40);

      const worldM = computeParentWorldMatrix([frame], "child");
      expect(worldM.e).toBe(60);
      expect(worldM.f).toBe(40);
    });

    it("findElementAtPoint respects container scroll and clipping", () => {
      const child: RectElement = { id: "child", type: "rect", x: 50, y: 50, width: 100, height: 100 };
      const frame: FrameElement = {
        id: "frame",
        type: "frame",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        clipContent: true,
        scrollOverflow: "vertical",
        scrollX: 0,
        scrollY: 30,
        children: [child]
      };

      // child world position:
      // x = 100 + 50 = 150 (width 100 => 150..250)
      // y = 100 + 50 - 30 = 120 (height 100 => 120..220)
      const hit = findElementAtPoint([frame], 160, 130);
      expect(hit?.id).toBe("child");

      // Point at y = 110 (which would be within child if not scrolled) now misses child
      const hitMiss = findElementAtPoint([frame], 160, 110);
      expect(hitMiss?.id).toBe("frame");

      // Overflow child clipped outside frame
      const overflowChild: RectElement = { id: "over", type: "rect", x: 0, y: 250, width: 100, height: 100 };
      const frameClipped: FrameElement = {
        ...frame,
        scrollY: 0,
        children: [overflowChild]
      };
      // Point (150, 360) is inside overflowChild local coordinates, but outside frame (frame height 200, y: 100..300)
      const clippedHit = findElementAtPoint([frameClipped], 150, 360);
      expect(clippedHit).toBeNull();
    });

    it("findScrollableContainersAtPoint finds scrollable containers under cursor", () => {
      const inner: FrameElement = {
        id: "inner",
        type: "frame",
        x: 20,
        y: 20,
        width: 150,
        height: 150,
        scrollOverflow: "vertical",
        children: [{ id: "btn", type: "rect", x: 10, y: 10, width: 50, height: 30 }]
      };
      const outer: FrameElement = {
        id: "outer",
        type: "frame",
        x: 50,
        y: 50,
        width: 300,
        height: 300,
        scrollOverflow: "both",
        children: [inner]
      };

      // Point inside btn (world coords: 50 + 20 + 10 + 5 = 85, 50 + 20 + 10 + 5 = 85)
      const candidates = findScrollableContainersAtPoint([outer], 85, 85);
      expect(candidates.map((c) => c.id)).toEqual(["inner", "outer"]);
      expect(isScrollableContainer(inner)).toBe(true);
    });

    it("respects child constraints pins during scrolling (sticky header/footer)", () => {
      const header: RectElement = {
        id: "header",
        type: "rect",
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        constraints: { vertical: "top" }
      };
      const footer: RectElement = {
        id: "footer",
        type: "rect",
        x: 0,
        y: 160,
        width: 200,
        height: 40,
        constraints: { vertical: "bottom" }
      };
      const content: RectElement = {
        id: "content",
        type: "rect",
        x: 10,
        y: 50,
        width: 180,
        height: 500
      };
      const frame: FrameElement = {
        id: "frame",
        type: "frame",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        scrollOverflow: "vertical",
        scrollY: 80,
        children: [content, header, footer]
      };

      // Header pinned to top: origin remains frame.x, frame.y (not shifted by -scrollY)
      const headerOrigin = computeParentOrigin([frame], "header");
      expect(headerOrigin.y).toBe(100);

      // Footer pinned to bottom: origin remains frame.x, frame.y (not shifted by -scrollY)
      const footerOrigin = computeParentOrigin([frame], "footer");
      expect(footerOrigin.y).toBe(100);

      // Content has no constraints: origin shifted by -scrollY (100 - 80 = 20)
      const contentOrigin = computeParentOrigin([frame], "content");
      expect(contentOrigin.y).toBe(20);

      // findElementAtPoint:
      // Point at (150, 110) hits header at its pinned position (100..140 in world space)
      const hitHeader = findElementAtPoint([frame], 150, 110);
      expect(hitHeader?.id).toBe("header");

      // Point at (150, 280) hits footer at its pinned position (260..300 in world space)
      const hitFooter = findElementAtPoint([frame], 150, 280);
      expect(hitFooter?.id).toBe("footer");

      // Hovering anywhere inside the scrollable container finds the container
      const candidates = findScrollableContainersAtPoint([frame], 150, 110);
      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("frame");
    });

    it("evaluates scrollBehavior fixed and sticky correctly", () => {
      const fixedHeader: RectElement = {
        id: "hdr",
        type: "rect",
        x: 0,
        y: 0,
        width: 100,
        height: 30,
        scrollBehavior: "fixed"
      };
      const stickySection: RectElement = {
        id: "sticky",
        type: "rect",
        x: 0,
        y: 100,
        width: 100,
        height: 30,
        scrollBehavior: "sticky"
      };
      const normalChild: RectElement = {
        id: "normal",
        type: "rect",
        x: 0,
        y: 200,
        width: 100,
        height: 30,
        scrollBehavior: "scroll"
      };
      const container: FrameElement = {
        id: "c",
        type: "frame",
        x: 0,
        y: 0,
        width: 100,
        height: 200,
        scrollOverflow: "vertical",
        children: [fixedHeader, stickySection, normalChild]
      };

      // 1. When scrollY = 0
      expect(childScrollOffset(fixedHeader, container, 0, 0)).toEqual({ offsetX: 0, offsetY: 0 });
      expect(childScrollOffset(stickySection, container, 0, 0)).toEqual({ offsetX: 0, offsetY: 0 });
      expect(childScrollOffset(normalChild, container, 0, 0)).toEqual({ offsetX: 0, offsetY: 0 });

      // 2. When scrollY = 50 (sticky hasn't reached top yet: child.y - scrollY = 100 - 50 = 50 > 0)
      expect(childScrollOffset(fixedHeader, container, 0, 50)).toEqual({ offsetX: 0, offsetY: 0 });
      expect(childScrollOffset(stickySection, container, 0, 50)).toEqual({ offsetX: -0, offsetY: -50 });
      expect(childScrollOffset(normalChild, container, 0, 50)).toEqual({ offsetX: -0, offsetY: -50 });

      // 3. When scrollY = 100 (sticky touches top edge: 100 - 100 = 0 <= 0 -> sticks at y = 0, offsetY = -100)
      expect(childScrollOffset(stickySection, container, 0, 100)).toEqual({ offsetX: -0, offsetY: -100 });

      // 4. When scrollY = 150 (sticky stays stuck at top edge: offsetY = -100)
      expect(childScrollOffset(fixedHeader, container, 0, 150)).toEqual({ offsetX: 0, offsetY: 0 });
      expect(childScrollOffset(stickySection, container, 0, 150)).toEqual({ offsetX: -0, offsetY: -100 });
      expect(childScrollOffset(normalChild, container, 0, 150)).toEqual({ offsetX: -0, offsetY: -150 });
    });
  });
});
