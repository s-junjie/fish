import { describe, it, expect } from "vitest";
import { getActivePage } from "../src/core/dsl/types";
import type {
  ComponentElement,
  DesignDocument,
  DesignElement,
  DesignToken,
  InstanceElement,
  TextElement
} from "../src/core/dsl/types";
import {
  commitInstanceOverrides,
  resolveInstanceChildren,
  resolveInstanceContent,
  resolveInstanceSelection
} from "../src/core/interactions/instance-resolve";
import { findMasterComponent } from "../src/core/interactions/component-inventory";
import { swapNestedInstance } from "../src/core/interactions/component-swap";
import { applySpanStyleToRange } from "../src/core/interactions/text-spans";

/**
 * The override surface of an instance child beyond plain paint: the run styles of
 * a text, the mode its subtree materialises in, the numeric tokens it follows, and
 * what survives a nested instance being swapped for another variant.
 *
 * Each of these was a control the panel offered and the engine dropped — a range
 * edit that diffed to nothing, a mode menu that threw the derived-child lock, a
 * swap that deleted the overrides it had just been given.
 */

const canvas = {
  width: 1200,
  height: 800,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#101010" }
};

const docOf = (elements: DesignElement[], extra: Partial<DesignDocument> = {}): DesignDocument => ({
  version: "0.1",
  id: "doc",
  name: "Doc",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  canvas,
  pages: [{ id: "page_1", name: "Page 1", canvas, children: elements }],
  activePageId: "page_1",
  elements,
  ...extra
});

const outerInst = (doc: DesignDocument) =>
  getActivePage(doc).children.find((el) => el.id === "cardInst") as InstanceElement;

const resolvedChild = (doc: DesignDocument, derivedId: string) => {
  const outer = outerInst(doc);
  const card = findMasterComponent(doc, outer.componentId)!;
  return resolveInstanceChildren(outer, card).find((el) => el.id === derivedId);
};

describe("a text inside an instance owns its runs", () => {
  const master = (): ComponentElement => ({
    id: "card",
    type: "component",
    name: "CARD",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    children: [
      {
        id: "label",
        type: "text",
        name: "label",
        x: 10,
        y: 10,
        width: 180,
        height: 24,
        content: "Buy now",
        style: { fontFamily: "Inter", fontSize: 14, color: "#FFFFFF" },
        spans: [{ text: "Buy", style: { fontWeight: 700 } }, { text: " now" }]
      } as TextElement
    ]
  });
  const cardInst = (): InstanceElement => ({
    id: "cardInst",
    type: "instance",
    name: "CARD",
    componentId: "card",
    x: 300,
    y: 0,
    width: 200,
    height: 80
  });
  const doc = () => docOf([master(), cardInst()]);

  it("stores a range edit as a `spans` override, not on the master", () => {
    const start = doc();
    const sel = resolveInstanceSelection(start, "cardInst_label")!;
    const next = commitInstanceOverrides(start, [sel], (el) =>
      applySpanStyleToRange(el as TextElement, { start: 4, end: 7 }, { color: "#FF0000" })
    )!;
    const overrides = outerInst(next).overrides || [];
    expect(overrides.map((o) => o.property)).toEqual(["spans"]);
    expect(overrides[0].targetId).toBe("label");
  });

  it("paints the runs it stored", () => {
    const start = doc();
    const sel = resolveInstanceSelection(start, "cardInst_label")!;
    const next = commitInstanceOverrides(start, [sel], (el) =>
      applySpanStyleToRange(el as TextElement, { start: 4, end: 7 }, { color: "#FF0000" })
    )!;
    const painted = resolvedChild(next, "cardInst_label") as TextElement;
    const red = painted.spans!.filter((s) => s.style?.color === "#FF0000");
    expect(red.map((s) => s.text).join("")).toBe("now");
    // The run the master declared is still there where the edit did not reach.
    expect(painted.spans![0].style?.fontWeight).toBe(700);
    // …and the master itself is untouched.
    expect((getActivePage(next).children[0] as ComponentElement).children[0]).toEqual(
      (getActivePage(start).children[0] as ComponentElement).children[0]
    );
  });

  it("clearing the runs is a stored change, not a dropped field", () => {
    const start = doc();
    const sel = resolveInstanceSelection(start, "cardInst_label")!;
    const next = commitInstanceOverrides(start, [sel], (el) => {
      const updated = { ...(el as TextElement) };
      delete updated.spans;
      return updated;
    })!;
    expect(outerInst(next).overrides).toEqual([
      { targetId: "label", property: "spans", value: undefined }
    ]);
    expect((resolvedChild(next, "cardInst_label") as TextElement).spans).toBeUndefined();
  });
});

describe("a container inside an instance owns its mode and bindings", () => {
  const tokens: DesignToken[] = [
    { id: "tok_surface", type: "color", name: "Surface", value: "#FFFFFF", modes: { dark: "#111111" } },
    { id: "tok_radius", type: "number", name: "Radius", value: 4, category: "radius", modes: { dark: 12 } }
  ];

  const master = (): ComponentElement => ({
    id: "card",
    type: "component",
    name: "CARD",
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    children: [
      {
        id: "panel",
        type: "frame",
        name: "panel",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        children: [],
        fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_surface" }]
      }
    ]
  });
  const cardInst = (): InstanceElement => ({
    id: "cardInst",
    type: "instance",
    name: "CARD",
    componentId: "card",
    x: 300,
    y: 0,
    width: 200,
    height: 80
  });
  const doc = () => docOf([master(), cardInst()], { tokens });
  const options = { theme: "light", tables: { tokens, styles: [] } };

  const resolveWith = (d: DesignDocument) => {
    const outer = outerInst(d);
    const card = findMasterComponent(d, outer.componentId)!;
    return resolveInstanceContent(outer, card, options);
  };

  it("materialises a token-bound fill in the mode the override names", () => {
    const start = doc();
    const sel = resolveInstanceSelection(start, "cardInst_panel")!;
    const next = commitInstanceOverrides(start, [sel], (el) => ({ ...el, themeMode: "dark" }))!;

    // Light first, as the control: the master's own mode is what the page uses.
    expect((resolveWith(start).children[0].fills![0] as { color: string }).color).toBe("#FFFFFF");

    const painted = resolveWith(next).children[0];
    expect((painted.fills![0] as { color: string }).color).toBe("#111111");
  });

  it("materialises a numeric token the override binds, in the instance's mode", () => {
    const start = doc();
    const sel = resolveInstanceSelection(start, "cardInst_panel")!;
    const next = commitInstanceOverrides(start, [sel], (el) => ({
      ...el,
      tokenBindings: { borderRadius: "tok_radius" }
    }))!;
    const painted = resolveWith(next).children[0] as { borderRadius?: unknown };
    expect(painted.borderRadius).toBe(4);
  });

  it("keeps the binding per key, so a second one does not drop the first", () => {
    const start = doc();
    const sel = resolveInstanceSelection(start, "cardInst_panel")!;
    const first = commitInstanceOverrides(start, [sel], (el) => ({
      ...el,
      tokenBindings: { borderRadius: "tok_radius" }
    }))!;
    const selAgain = resolveInstanceSelection(first, "cardInst_panel")!;
    const second = commitInstanceOverrides(first, [selAgain], (el) => ({
      ...el,
      tokenBindings: { ...(el.tokenBindings || {}), gap: "tok_gap" }
    }))!;
    expect(outerInst(second).overrides).toEqual([
      { targetId: "panel", property: "tokenBindings", value: { borderRadius: "tok_radius", gap: "tok_gap" } }
    ]);
  });
});

describe("swapping a nested instance keeps the overrides inside it", () => {
  const icon = (id: string, labelId: string, content: string): ComponentElement => ({
    id,
    type: "component",
    name: id,
    x: 0,
    y: 400,
    width: 80,
    height: 24,
    children: [
      {
        id: labelId,
        type: "text",
        name: "caption",
        x: 0,
        y: 0,
        width: 80,
        height: 24,
        content,
        style: { fontFamily: "Inter", fontSize: 12, color: "#FFFFFF" }
      } as TextElement
    ]
  });

  const card = (): ComponentElement => ({
    id: "card",
    type: "component",
    name: "CARD",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    children: [
      { id: "iconInst", type: "instance", name: "iconInst", componentId: "icon_a", x: 8, y: 8, width: 80, height: 24 }
    ]
  });
  const cardInst = (): InstanceElement => ({
    id: "cardInst",
    type: "instance",
    name: "CARD",
    componentId: "card",
    x: 300,
    y: 0,
    width: 200,
    height: 100
  });

  const docWith = (contentB: string, overrides: InstanceElement["overrides"]) =>
    docOf([
      card(),
      icon("icon_a", "a_caption", "OK"),
      icon("icon_b", "b_caption", contentB),
      { ...cardInst(), overrides }
    ] as DesignElement[]);

  it("re-points the tail at the new master's layer of the same name", () => {
    const next = swapNestedInstance(
      docWith("OK", [{ targetId: "iconInst/a_caption", property: "content", value: "Send" }]),
      "cardInst_iconInst",
      "icon_b"
    )!;
    expect(outerInst(next).overrides).toEqual([
      { targetId: "iconInst/b_caption", property: "content", value: "Send" },
      { targetId: "iconInst", property: "componentId", value: "icon_b" }
    ]);
  });

  it("paints the kept override on the new variant", () => {
    const next = swapNestedInstance(
      docWith("OK", [{ targetId: "iconInst/a_caption", property: "content", value: "Send" }]),
      "cardInst_iconInst",
      "icon_b"
    )!;
    const nested = resolvedChild(next, "cardInst_iconInst") as InstanceElement;
    const painted = resolveInstanceChildren(nested, findMasterComponent(next, "icon_b")!)[0] as TextElement;
    expect(painted.content).toBe("Send");
  });

  it("drops it when the new master started from another value", () => {
    const next = swapNestedInstance(
      docWith("Cancel", [{ targetId: "iconInst/a_caption", property: "content", value: "Send" }]),
      "cardInst_iconInst",
      "icon_b"
    )!;
    // The change was made against "OK"; applying it over "Cancel" would claim the
    // user edited a base they never saw.
    expect(outerInst(next).overrides).toEqual([
      { targetId: "iconInst", property: "componentId", value: "icon_b" }
    ]);
  });

  it("leaves the overrides of other nodes alone", () => {
    const next = swapNestedInstance(
      docWith("OK", [
        { targetId: "iconInst", property: "visible", value: false },
        { targetId: "iconInst/a_caption", property: "content", value: "Send" }
      ]),
      "cardInst_iconInst",
      "icon_b"
    )!;
    expect(outerInst(next).overrides).toContainEqual({ targetId: "iconInst", property: "visible", value: false });
  });
});
