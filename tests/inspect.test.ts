import { describe, expect, it } from "vitest";
import { inspectElement, formatInspection } from "../src/core/cli/fish-inspect";
import { laidOutDocument, authoredCoordinates } from "../src/core/layout-report";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { syncDocumentBindings } from "../src/core/interactions/style-ops";

/**
 * `inspect` is a reader, not a rule: these cases pin the four questions it exists
 * to answer — where the node actually is, what it effectively wears, who placed
 * it, and what may be written on it.
 */

const prepare = (raw: unknown) => {
  const { document } = normalizeDesignDocument(raw);
  return laidOutDocument(syncDocumentBindings(document), raw).document;
};

const page = (children: unknown[]) => ({
  version: "0.1",
  pages: [{ id: "page", name: "Page", canvas: { width: 900, height: 900 }, children }]
});

const capsule = (dot: Record<string, unknown> = {}) =>
  page([
    {
      id: "capsule",
      type: "frame",
      x: 16,
      y: 16,
      width: 87,
      height: 32,
      display: "flex",
      "align-items": "center",
      children: [{ id: "dot", type: "rect", width: 3, height: 3, ...dot }]
    }
  ]);

describe("where the node actually is", () => {
  it("reports the box the flow gave it, not the coordinates the file wrote", () => {
    const raw = capsule({ x: 16, y: 14 });
    const found = inspectElement(prepare(raw), "dot", { authored: authoredCoordinates(raw) })!;
    expect(found.box.local).toEqual({ x: 0, y: 14.5, width: 3, height: 3 });
    expect(found.flow).toMatchObject({ parentId: "capsule", mode: "flex", absolute: false });
    expect(found.flow?.ignored).toEqual({ x: 16, y: 14 });
  });

  it("says nothing about ignored coordinates when the flow agrees with the file", () => {
    const raw = capsule({ x: 0, y: 14.5 });
    expect(inspectElement(prepare(raw), "dot", { authored: authoredCoordinates(raw) })?.flow?.ignored).toBeUndefined();
  });

  it("marks an absolute child as out of the flow", () => {
    const raw = capsule({ position: "absolute", x: 40, y: 6 });
    const found = inspectElement(prepare(raw), "dot")!;
    expect(found.flow?.absolute).toBe(true);
    expect(found.box.local.x).toBe(40);
  });

  it("answers null for an id the document does not hold", () => {
    expect(inspectElement(prepare(capsule()), "nope")).toBeNull();
  });
});

describe("what it effectively wears", () => {
  it("resolves a text's size and tracking to the numbers the renderer uses", () => {
    const found = inspectElement(
      prepare(
        page([
          {
            id: "t",
            type: "text",
            x: 0,
            y: 0,
            width: 200,
            height: 40,
            content: "Hello",
            "font-family": "Inter, sans-serif",
            "font-size": "20px",
            "line-height": "24px",
            "letter-spacing": "0.5px"
          }
        ])
      ),
      "t"
    )!;
    expect(found.text).toMatchObject({ fontSize: 20, lineHeight: 24, letterSpacing: 0.5 });
    expect(found.box.sizing).toEqual({ width: "fixed", height: "fixed" });
  });

  it("names the token a fill came from", () => {
    const found = inspectElement(
      prepare({
        version: "0.1",
        tokens: [{ id: "tok_ink", type: "color", name: "color/ink", value: "#F2F4F6" }],
        pages: [
          {
            id: "page",
            name: "Page",
            canvas: { width: 100, height: 100 },
            children: [
              { id: "r", type: "rect", x: 0, y: 0, width: 10, height: 10, fills: [{ type: "solid", color: "#F2F4F6", tokenId: "tok_ink" }] }
            ]
          }
        ]
      }),
      "r"
    )!;
    expect(found.paints[0].toLowerCase()).toContain("#f2f4f6");
    expect(found.paints[0]).toContain("color/ink");
  });
});

describe("what may be written on it", () => {
  const withButton = (overrides: unknown[]) =>
    page([
      {
        id: "btn",
        name: "Button",
        type: "component",
        x: 0,
        y: 0,
        width: 120,
        height: 40,
        children: [
          { id: "label", type: "text", x: 10, y: 10, width: 100, height: 20, content: "Buy" },
          { id: "plate", type: "rect", x: 0, y: 0, width: 120, height: 40 }
        ]
      },
      { id: "inst", type: "instance", componentId: "btn", x: 20, y: 80, width: 120, height: 40, overrides }
    ]);

  it("lists the master's slots with the properties each one accepts", () => {
    const found = inspectElement(prepare(withButton([])), "inst")!;
    expect(found.instance?.masterName).toBe("Button");
    const label = found.instance?.slots.find((s) => s.id === "label");
    const plate = found.instance?.slots.find((s) => s.id === "plate");
    expect(label?.properties).toContain("content");
    expect(plate?.properties).toContain("fills");
    // `content` on a rect has no write branch, so it must not be offered.
    expect(plate?.properties).not.toContain("content");
    expect(found.instance?.slotsTotal).toBe(2);
  });

  it("counts the overrides that can never apply and says why", () => {
    const found = inspectElement(
      prepare(
        withButton([
          { targetId: "label", property: "content", value: "Buy now" },
          { targetId: "ghost", property: "content", value: "x" }
        ])
      ),
      "inst"
    )!;
    expect(found.instance?.overrides.total).toBe(2);
    expect(found.instance?.overrides.applies).toBe(1);
    expect(found.instance?.overrides.problems[0]).toContain("ghost");
  });
});

describe("a node inside an instance", () => {
  it("answers for the resolved clone and names the override that would change it", () => {
    const found = inspectElement(
      prepare(
        page([
          {
            id: "btn",
            type: "component",
            x: 0,
            y: 0,
            width: 120,
            height: 40,
            children: [{ id: "label", type: "text", x: 10, y: 10, width: 100, height: 20, content: "Buy" }]
          },
          { id: "inst", type: "instance", componentId: "btn", x: 20, y: 80, width: 120, height: 40 }
        ])
      ),
      "inst_label"
    )!;
    expect(found.derived).toEqual({ masterId: "label", instanceId: "inst" });
    expect(found.parents[0].id).toBe("inst");
    expect(found.box.local).toEqual({ x: 10, y: 10, width: 100, height: 20 });
  });
});

describe("the report a person reads", () => {
  it("prints the ignored coordinates beside the box that replaced them", () => {
    const raw = capsule({ x: 16, y: 14 });
    const found = inspectElement(prepare(raw), "dot", { authored: authoredCoordinates(raw) })!;
    const text = formatInspection(found);
    expect(text).toContain("dot · rect");
    expect(text).toContain("3×3 at (0, 14.5)");
    expect(text).toContain("x/y (16, 14) in the file ignored");
  });
});
