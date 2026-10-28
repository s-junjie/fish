import { describe, it, expect } from "vitest";
import { CanvasDefs } from "../src/ui/canvas/CanvasDefs";
import { PatternPaintDef } from "../src/ui/canvas/PatternPaintDef";
import type { DesignElement, PatternPaint, Stroke } from "../src/core/dsl/types";

import { defsMarkup } from "./support/defs";

const dots = (foreground: string, extra: Partial<PatternPaint> = {}): PatternPaint => ({
  type: "pattern",
  motif: "dots",
  tile: { width: 16, height: 16 },
  foreground,
  ...extra
});

const rect = (props: Partial<DesignElement>): DesignElement =>
  ({ id: "r1", type: "rect", x: 0, y: 0, width: 100, height: 100, ...props } as DesignElement);

/** The def elements the renderer would mount, as `PatternPaintDef` builds them. */
const defsFor = (el: DesignElement) =>
  defsMarkup(CanvasDefs({ allElements: [el], selectedIds: new Set() }) as any)
    .filter((n) => n.type === PatternPaintDef)
    .map((n) => PatternPaintDef(n.props)!);

describe("pattern defs", () => {
  it("emits one tile for a fill and a second, separately keyed tile for a stroke", () => {
    const stroke: Stroke = { width: 2, color: "#000000", paint: dots("#ff0000") };
    const patterns = defsFor(rect({ fills: [dots("#00ff00")], strokes: [stroke] }));
    expect(patterns.map((p) => (p as any).props.id)).toEqual(["pat_r1_0", "pat_stroke_r1_0"]);
  });

  it("a hexagonal layer's tile is twice the cell on both axes", () => {
    const [tile] = defsFor(rect({ fills: [dots("#000000", { tileType: "horizontal-hexagonal" })] }));
    expect((tile as any).props.width).toBe(32);
    expect((tile as any).props.height).toBe(32);
  });
});
