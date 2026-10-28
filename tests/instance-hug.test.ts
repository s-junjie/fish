import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect } from "vitest";
import { relayoutDocumentTree } from "../src/core/compile";
import { resolveAxis, withAxisMode } from "../src/core/geometry/resolve-axis";
import { instanceSizeResolver } from "../src/core/interactions/instance-size";
import { createInstanceFromComponent, resetInstanceOverrides } from "../src/core/interactions/component-ops";
import { propagateMasterSize } from "../src/core/interactions/instance-inherit";
import { sizeModeOptions } from "../src/ui/size-modes";
import { DesignDocument, DesignElement, FrameElement, InstanceElement, SizeMode } from "../src/core/dsl/types";

/**
 * An instance stores the box it was authored with and is resolved to what the
 * master lays out into at render time. Those are the same box only when the
 * master is fixed-size, and a tag is not: it is sized by its own label. The
 * layout pass reads `child.width` off the document, so without a resolver the
 * parent placed siblings against the authored width and a hugging instance was
 * painted on top of them.
 */
const text = (id: string, content: string): DesignElement =>
  ({
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 11,
    content,
    sizing: { width: "max-content", height: "fit-content" },
    style: { fontFamily: "Inter, sans-serif", fontSize: 8, fontWeight: 500, color: "#F2F2F2" }
  }) as DesignElement;

const tagMaster: DesignElement = {
  id: "cmp/Tag",
  type: "component",
  name: "Tag",
  x: 0,
  y: 0,
  width: 60,
  height: 20,
  borderRadius: 8,
  sizing: { width: "max-content", height: "fit-content" },
  ...flattenLayout({ mode: "flex", direction: "row", align: "center", padding: [0, 8, 0, 8] }),
  // Per-instance text comes from a `content` OVERRIDE on the master's own text
  // layer, which is what replaced the named `Label` text property. Written out in
  // full rather than through a helper because these tests care about the RESOLVED
  // width, and the override is what makes each instance resolve to a different one.
  children: [text("tag-label", "Tag")]
} as DesignElement;

const instance = (id: string, label: string): DesignElement =>
  ({
    id,
    type: "instance",
    componentId: "cmp/Tag",
    x: 0,
    y: 0,
    width: 60,
    height: 20,
    overrides: [{ targetId: "tag-label", property: "content", value: label }]
  }) as DesignElement;

const row = (children: DesignElement[]): FrameElement =>
  ({
    id: "row",
    type: "frame",
    x: 0,
    y: 0,
    width: 300,
    height: 40,
    sizing: { height: "fit-content" },
    ...flattenLayout({ mode: "flex", direction: "row", gap: 6, wrap: "wrap" }),
    children
  }) as FrameElement;

const CANVAS = { width: 400, height: 400, unit: "px" as const, background: { type: "solid" as const, color: "#fff" } };

const find = (opts: ReturnType<typeof sizeModeOptions>, mode: SizeMode) =>
  opts.find((o) => o.mode === mode)!;

const docOf = (elements: DesignElement[]): DesignDocument => ({
  id: "hug",
  version: "0.1",
  name: "hug",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  canvas: CANVAS,
  pages: [{ id: "p1", name: "P1", canvas: CANVAS, children: [tagMaster, ...elements] }],
  activePageId: "p1"
});

describe("an instance of a hugging master hugs, and its parent knows", () => {
  it("resolves each instance to its own label rather than the authored width", () => {
    const doc = docOf([row([instance("a", "Short"), instance("b", "A much longer label")])]);
    const resolve = instanceSizeResolver(doc);
    const kids = (doc.pages![0].children[1] as FrameElement).children!;
    const short = resolve(kids[0] as InstanceElement);
    const long = resolve(kids[1] as InstanceElement);
    expect(short!.width).toBeLessThan(long!.width);
    // 16px of horizontal padding on each of the two edges.
    expect(long!.width - short!.width).toBeGreaterThan(20);
  });

  it("places siblings by the resolved width, so none of them overlap", () => {
    const doc = docOf([row([instance("a", "Short"), instance("b", "A much longer label")])]);
    const laid = relayoutDocumentTree([doc.pages![0].children[1]], instanceSizeResolver(doc))[0] as FrameElement;
    const [a, b] = laid.children!;
    const resolve = instanceSizeResolver(doc);
    const short = resolve(a as InstanceElement)!;
    const long = resolve(b as InstanceElement)!;
    // The second one starts where the first one ends, plus the gap — only true
    // if the row used the RESOLVED width. Against the stored 60 it would sit at
    // 66, under a 46px pill, and the two would overlap.
    expect(a.x + (a as InstanceElement).width + 6).toBeCloseTo(b.x, 5);
    expect((a as InstanceElement).width).toBe(short.width);
    expect(b.x).toBeLessThan(long.width); // the short one really is shorter
  });

  it("still pins the box when the instance hand-set it", () => {
    const pinned = { ...instance("a", "A much longer label"), width: 90, sizeOverride: true } as InstanceElement;
    const doc = docOf([row([pinned])]);
    const laid = relayoutDocumentTree([doc.pages![0].children[1]], instanceSizeResolver(doc))[0] as FrameElement;
    // 90 is narrower than the label needs, and that is the point of the flag.
    expect(instanceSizeResolver(doc)(laid.children![0] as InstanceElement)!.width).toBe(90);
  });

  it("leaves a fixed-size master alone", () => {
    // No `sizing` on the master: nothing hugs, so the authored 60 is the answer
    // even though the label is much wider.
    const fixed = { ...tagMaster, sizing: undefined } as DesignElement;
    const canvas = { width: 400, height: 400, unit: "px" as const, background: { type: "solid" as const, color: "#fff" } };
    const elements: DesignElement[] = [fixed, row([instance("a", "A much longer label")])];
    const doc: DesignDocument = {
      id: "hug",
      version: "0.1",
      name: "hug",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      canvas,
      pages: [{ id: "p1", name: "P1", canvas, children: elements }],
      activePageId: "p1",
      elements
    };
    const rowEl = elements[1] as FrameElement;
    expect(instanceSizeResolver(doc)(rowEl.children![0] as InstanceElement)!.width).toBe(60);
  });

  it("leaves the axis hug declared on the instance's master, not on the instance", () => {
    // The number an instance paints comes from the master's recipe, so the master's
    // own declaration is the one that has to resolve — the instance copies it and
    // may then override it per axis.
    expect(resolveAxis(tagMaster, null, "width")).toBe("max-content");
  });
});

/**
 * The DECLARATION side. Above, the hug was a thing only the master could hold: an
 * instance's `sizing` was written and then read back as `fixed`, so the size menu
 * greyed Fit out with "this element type has no content to size from" and the
 * panel contradicted the canvas on a tag that was plainly hugging. An instance is
 * measured through its master (`ChildSizeResolver`), so it can carry the same
 * declaration — and pin one axis at a time, which is what `sizeOverride` is for.
 */
describe("an instance carries its own hug declaration", () => {
  it("offers Fit on an instance's width instead of refusing it", () => {
    const opts = sizeModeOptions(instance("a", "Tag"), row([]), "width");
    expect(find(opts, "fit-content").effective).toBe(true);
    expect(find(opts, "max-content").effective).toBe(true);
  });

  it("sizes the instance by its master's content once it declares fit-content", () => {
    const hugging = withAxisMode(instance("a", "A much longer label"), "width", "fit-content") as InstanceElement;
    const doc = docOf([row([hugging])]);
    expect(resolveAxis(hugging, null, "width")).toBe("fit-content");
    // The authored box is 60 and the label needs far more than that.
    expect(hugging.width).toBe(60);
    expect(instanceSizeResolver(doc)(hugging)!.width).toBeGreaterThan(90);
  });

  it("pins one axis to Fixed and leaves the other hugging", () => {
    const hugging = withAxisMode(instance("a", "A much longer label"), "width", "fit-content") as InstanceElement;
    const pinned = withAxisMode(hugging, "width", "fixed") as InstanceElement;
    // Dropping the field is not enough: an absent `sizing` on an instance means
    // "inherit the master", so Fixed has to be WRITTEN and raise `sizeOverride`,
    // or it reads back as the master's own mode one resolve later.
    expect(pinned.sizing).toEqual({ width: "fixed" });
    expect(pinned.sizeOverride).toBe(true);
    expect(resolveAxis(pinned, null, "width")).toBe("fixed");
    expect(instanceSizeResolver(docOf([row([pinned])]))(pinned)!.width).toBe(60);
  });

  it("pins a plain layer's one axis and leaves the other", () => {
    const hugging = withAxisMode({ ...(tagMaster as FrameElement) }, "width", "max-content");
    const pinned = withAxisMode(hugging, "width", "fixed") as FrameElement;
    // Only the width is pinned, and nothing raises `sizeOverride` — a frame has no
    // master to fall back to.
    expect(pinned.sizing).toEqual({ width: "fixed", height: "fit-content" });
    expect((pinned as { sizeOverride?: true }).sizeOverride).toBeUndefined();
  });

  it("mints an instance already declaring what its master declares", () => {
    const doc = docOf([]);
    const { doc: next, instance: inst } = createInstanceFromComponent(doc, "cmp/Tag", { x: 0, y: 0 });
    expect(inst!.sizing).toEqual(tagMaster.sizing);
    expect(resolveAxis(inst!, null, "width")).toBe("max-content");
    expect(next.pages![0].children).toContain(inst!);
  });

  it("re-points the instances when the master switches to a hug", () => {
    const before = docOf([row([instance("a", "Tag")])]);
    const laidOut = relayoutDocumentTree(before.pages![0].children, instanceSizeResolver(before));
    const huggingMaster = { ...(tagMaster as FrameElement), sizing: { width: "fit-content" as const, height: "fit-content" as const } };
    const after = { ...before, pages: [{ ...before.pages![0], children: laidOut.map((el) => (el.id === "cmp/Tag" ? huggingMaster : el)) }] };

    const next = propagateMasterSize(before, after);
    const inst = (next.pages![0].children[1] as FrameElement).children![0] as InstanceElement;
    expect(inst.sizing).toEqual({ width: "fit-content", height: "fit-content" });
  });

  it("leaves an axis the instance declared for itself", () => {
    // The master says max-content on width; the instance says fit-content. The
    // instance's answer must survive the propagation, and the axis it never spoke
    // about must still come from the master.
    const declared = withAxisMode(instance("a", "Tag"), "width", "fit-content") as InstanceElement;
    const before = docOf([row([declared])]);
    const laidOut = relayoutDocumentTree(before.pages![0].children, instanceSizeResolver(before));
    const after = {
      ...before,
      pages: [{ ...before.pages![0], children: laidOut.map((el) => (el.id === "cmp/Tag" ? { ...(el as FrameElement), width: 200 } : el)) }]
    };
    const next = propagateMasterSize(before, after);
    const inst = (next.pages![0].children[1] as FrameElement).children![0] as InstanceElement;
    // Width is the instance's (the master says max-content there), height is the
    // master's, which the instance never spoke about.
    expect(inst.sizing?.width).toBe("fit-content");
    expect(inst.sizing?.height).toBe((tagMaster as FrameElement).sizing!.height);
  });

  it("gives the sizing back on Reset, so the master governs again", () => {
    const pinned = {
      ...(instance("a", "Tag") as InstanceElement),
      sizing: { width: "fit-content" as const },
      sizeOverride: true as const
    };
    const reset = resetInstanceOverrides(pinned, tagMaster as never);
    expect(reset.sizing).toBeUndefined();
    expect(reset.sizeOverride).toBeUndefined();
  });
});
