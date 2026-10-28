import { describe, expect, it } from "vitest";
import { COLOR_PANEL_WIDTH, placeColorPanel, type PanelDecision } from "../src/ui/color-panel/placement";

const box = (left: number, top: number, width = 20, height = 20) =>
  ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON() {}
  }) as DOMRect;

const anchorAt = (rect: DOMRect, host: DOMRect | null = null) =>
  ({
    getBoundingClientRect: () => rect,
    closest: () => (host ? { getBoundingClientRect: () => host } : null)
  }) as unknown as HTMLElement;

const bodyOf = (height: number) => ({ scrollHeight: height, offsetHeight: height }) as unknown as HTMLElement;

const VIEWPORT = { width: 1600, height: 1000 };

const place = (args: {
  anchor: HTMLElement;
  height?: number;
  kind?: "solid" | "linear-gradient" | "image";
  isImage?: boolean;
  previous?: PanelDecision | null;
  viewport?: { width: number; height: number };
}) =>
  placeColorPanel({
    anchor: args.anchor,
    panel: bodyOf(args.height ?? 500),
    kind: args.kind ?? "solid",
    isImage: args.isImage ?? false,
    previous: args.previous ?? null,
    viewport: args.viewport ?? VIEWPORT
  });

describe("color panel placement", () => {
  it("sits to the left of the swatch, one gap away", () => {
    const placed = place({ anchor: anchorAt(box(600, 400)) });
    expect(placed.left).toBe(600 - COLOR_PANEL_WIDTH - 10);
  });

  it("flips to the right of the swatch when the left side would leave the viewport", () => {
    const placed = place({ anchor: anchorAt(box(100, 400)) });
    expect(placed.left).toBe(100 + 20 + 10);
  });

  it("clears the host panel rather than the swatch inside it", () => {
    const placed = place({ anchor: anchorAt(box(600, 400), box(500, 300, 260, 400)) });
    expect(placed.left).toBe(500 - COLOR_PANEL_WIDTH - 10);
  });

  it("stays inside the viewport even when there is no room on either side", () => {
    const placed = place({ anchor: anchorAt(box(0, 400)), viewport: { width: 200, height: 800 } });
    expect(placed.left).toBe(8);
  });

  it("keeps the panel below a swatch with room under it", () => {
    const placed = place({ anchor: anchorAt(box(600, 100)), height: 500 });
    expect(placed.decision.side).toBe("below");
    expect(placed.top).toBe(100);
    expect(placed.maxHeight).toBeNull();
  });

  it("flips above a swatch near the bottom, and pins its bottom to the swatch", () => {
    const placed = place({ anchor: anchorAt(box(600, 900)), height: 500 });
    expect(placed.decision.side).toBe("above");
    expect(placed.top).toBe(900 - 500);
  });

  it("caps the body and scrolls in place when neither side can show it whole", () => {
    const placed = place({ anchor: anchorAt(box(600, 600)), height: 1200 });
    expect(placed.top).toBe(8);
    expect(placed.maxHeight).toBe(972);
  });

  it("keeps the cap for an image body even when the body would fit", () => {
    const placed = place({ anchor: anchorAt(box(600, 100)), height: 300, kind: "image", isImage: true });
    expect(placed.maxHeight).toBe(880);
  });

  it("does not re-decide a side it already chose for this swatch and kind", () => {
    const anchor = anchorAt(box(600, 400));
    const first = place({ anchor, height: 500 });
    const grown = place({ anchor, height: 900, previous: first.decision });
    expect(grown.decision).toBe(first.decision);
    expect(grown.top).toBe(first.top);
  });

  it("re-decides when the kind changes, because a taller body needs the roomier side", () => {
    const anchor = anchorAt(box(600, 500));
    const solid = place({ anchor, height: 300 });
    const gradient = place({ anchor, height: 700, kind: "linear-gradient", previous: solid.decision });
    expect(solid.decision.side).toBe("below");
    expect(gradient.decision.side).toBe("above");
  });
});
