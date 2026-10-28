import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import { ellipseToPathData } from "../src/core/compile";
import { ellipseToVectorPath } from "../src/core/geometry/path-convert";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { EllipseElement } from "../src/core/dsl/types";

/** The document alone: these cases do not grade the repairs. */
const normalized = (doc: unknown) => normalizeDesignDocument(doc).document;

const makeEllipse = (over: Partial<EllipseElement> = {}): EllipseElement => ({
  id: "e1",
  type: "ellipse",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...over
});

const CANVAS = { width: 800, height: 600, unit: "px", background: { type: "solid", color: "#141414" } };

const docWith = (element: Record<string, unknown>) => ({
  version: "0.2",
  id: "doc",
  name: "t",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  canvas: CANVAS,
  pages: [{ id: "page_1", name: "Page 1", canvas: CANVAS, children: [element] }],
  activePageId: "page_1",
  elements: [element]
});

describe("ellipse sweep / innerRadius geometry", () => {
  it("leaves a full ellipse byte-identical to the pre-sweep output", () => {
    const legacy = "M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 Z";
    expect(ellipseToPathData(makeEllipse())).toBe(legacy);
    expect(ellipseToPathData(makeEllipse({ sweep: 360 }))).toBe(legacy);
    expect(ellipseToPathData(makeEllipse({ sweep: 360, innerRadius: 0 }))).toBe(legacy);
  });

  it("closes a partial sweep as a wedge through the centre", () => {
    expect(ellipseToPathData(makeEllipse({ sweep: 90 }))).toBe(
      "M 50 0 A 50 50 0 0 1 100 50 L 50 50 Z"
    );
  });

  it("sets the large-arc flag past a half turn", () => {
    expect(ellipseToPathData(makeEllipse({ sweep: 270 }))).toContain("A 50 50 0 1 1");
  });

  it("carves a ring for a full turn when innerRadius is set", () => {
    const d = ellipseToPathData(makeEllipse({ innerRadius: 0.5 }));
    expect(d).toContain("M 75 50");
    expect(d).toContain("A 25 25 0 1 0 25 50");
    expect(d).toContain("A 25 25 0 1 0 75 50");
  });

  it("emits a ring segment as outer arc, radial, reversed inner arc, close", () => {
    expect(ellipseToPathData(makeEllipse({ sweep: 90, innerRadius: 0.5 }))).toBe(
      "M 50 0 A 50 50 0 0 1 100 50 L 75 50 A 25 25 0 0 0 50 25 Z"
    );
  });

  it("returns nothing for a zero sweep and clamps out-of-range input", () => {
    expect(ellipseToPathData(makeEllipse({ sweep: 0 }))).toBe("");
    expect(ellipseToPathData(makeEllipse({ sweep: -30 }))).toBe("");
    expect(ellipseToPathData(makeEllipse({ sweep: 900 }))).toBe(
      ellipseToPathData(makeEllipse({ sweep: 360 }))
    );
    expect(ellipseToPathData(makeEllipse({ innerRadius: 5 }))).toBe(
      ellipseToPathData(makeEllipse({ innerRadius: 0.99 }))
    );
  });

  it("survives a degenerate box", () => {
    expect(ellipseToPathData(makeEllipse({ width: 0 }))).toBe("");
    expect(ellipseToPathData(makeEllipse({ height: 0 }))).toBe("");
  });

  it("shares one implementation with the convert-to-path command", () => {
    const el = makeEllipse({ sweep: 120, innerRadius: 0.4 });
    expect(ellipseToVectorPath(el)).toBe(ellipseToPathData(el));
  });
});

describe("ellipse sweep normalization", () => {
  const base = { id: "e1", type: "ellipse", x: 0, y: 0, width: 100, height: 100 };

  it("keeps sweep and innerRadius through a normalize round-trip", () => {
    const out = normalized(docWith({ ...base, sweep: 120, innerRadius: 0.4 }));
    const el = getActivePage(out).children[0] as EllipseElement;
    expect(el.sweep).toBe(120);
    expect(el.innerRadius).toBe(0.4);
  });

  it("clamps out-of-range values", () => {
    const out = normalized(docWith({ ...base, sweep: 999, innerRadius: 3 }));
    const el = getActivePage(out).children[0] as EllipseElement;
    expect(el.sweep).toBe(360);
    expect(el.innerRadius).toBe(0.99);
  });

  it("accepts numeric strings", () => {
    const out = normalized(docWith({ ...base, sweep: "120deg", innerRadius: "0.4" }));
    const el = getActivePage(out).children[0] as EllipseElement;
    expect(el.sweep).toBe(120);
    expect(el.innerRadius).toBe(0.4);
  });

  it("does not add the keys to a document that never set them", () => {
    const out = normalized(docWith(base));
    const el = getActivePage(out).children[0];
    expect("sweep" in el).toBe(false);
    expect("innerRadius" in el).toBe(false);
    expect("startAngle" in el).toBe(false);
    expect("gap" in el).toBe(false);
  });

  it("keeps startAngle and gap through a normalize round-trip", () => {
    const out = normalized(docWith({ ...base, startAngle: 45, gap: 12 }));
    const el = getActivePage(out).children[0] as EllipseElement;
    expect(el.startAngle).toBe(45);
    expect(el.gap).toBe(12);
  });
});

describe("ellipse startAngle / gap geometry", () => {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const at = (r: number, deg: number) => {
    const t = (deg * Math.PI) / 180;
    return { x: r2(50 + r * Math.sin(t)), y: r2(50 - r * Math.cos(t)) };
  };

  it("leaves the default output byte-identical", () => {
    const legacy = "M 50 0 A 50 50 0 1 1 50 100 A 50 50 0 1 1 50 0 Z";
    expect(ellipseToPathData(makeEllipse({ startAngle: 0, gap: 0 }))).toBe(legacy);
    expect(ellipseToPathData(makeEllipse({ startAngle: 360 }))).toBe(legacy);
  });

  it("rotates the wedge by startAngle", () => {
    const d = ellipseToPathData(makeEllipse({ sweep: 90, startAngle: 90 }));
    const s = at(50, 90);
    const e = at(50, 180);
    expect(d).toBe(`M ${s.x} ${s.y} A 50 50 0 0 1 ${e.x} ${e.y} L 50 50 Z`);
    expect(d).toBe("M 100 50 A 50 50 0 0 1 50 100 L 50 50 Z");
  });

  it("trims both ends of the sweep by half the gap", () => {
    const d = ellipseToPathData(makeEllipse({ sweep: 90, gap: 10 }));
    const s = at(50, 5);
    const e = at(50, 85);
    expect(d).toBe(`M ${s.x} ${s.y} A 50 50 0 0 1 ${e.x} ${e.y} L 50 50 Z`);
    expect(d).not.toBe(ellipseToPathData(makeEllipse({ sweep: 90 })));
  });

  it("turns a full turn into a seamed arc once a gap is set", () => {
    const seamed = ellipseToPathData(makeEllipse({ gap: 20 }));
    expect(seamed).not.toBe(ellipseToPathData(makeEllipse()));
    expect(seamed).toContain("A 50 50 0 1 1");
    expect(seamed).toContain("L 50 50 Z");
  });

  it("returns nothing when the gap eats the whole sweep", () => {
    expect(ellipseToPathData(makeEllipse({ sweep: 10, gap: 10 }))).toBe("");
    expect(ellipseToPathData(makeEllipse({ sweep: 10, gap: 40 }))).toBe("");
  });

  it("clamps startAngle and gap", () => {
    expect(ellipseToPathData(makeEllipse({ startAngle: 720 }))).toBe(
      ellipseToPathData(makeEllipse({ startAngle: 360 }))
    );
    expect(ellipseToPathData(makeEllipse({ sweep: 360, gap: 900 }))).toBe(
      ellipseToPathData(makeEllipse({ sweep: 360, gap: 180 }))
    );
  });

  it("applies startAngle and gap to a ring segment", () => {
    const d = ellipseToPathData(
      makeEllipse({ sweep: 120, startAngle: 120, innerRadius: 0.5, gap: 20 })
    );
    const os = at(50, 130);
    const oe = at(50, 230);
    const ie = at(25, 230);
    const is = at(25, 130);
    expect(d).toBe(
      `M ${os.x} ${os.y} A 50 50 0 0 1 ${oe.x} ${oe.y} L ${ie.x} ${ie.y} A 25 25 0 0 0 ${is.x} ${is.y} Z`
    );
  });
});
