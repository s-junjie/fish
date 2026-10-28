import { flattenLayout } from "../src/core/dsl/layout-flat";
import { describe, it, expect, afterEach } from "vitest";
import { relayoutDocumentTree, applyAutoLayout } from "../src/core/compile";
import { clearAmbientChildSizeResolver } from "../src/core/layout/context";
import { EditorStore } from "../src/core/store/editor-store";
import { instanceSizeResolver } from "../src/core/interactions/instance-size";
import { DesignDocument, DesignElement, FrameElement } from "../src/core/dsl/types";

/**
 * A `ChildSizeResolver` answers "how big does this child really paint", and only
 * the caller knows: the masters live on the document. `applyAutoLayout` had 26
 * call sites and the two inside the tree passes were the only ones that passed
 * one, so the auto-layout inspector section, the gestures and `stack-resize` all
 * measured a hugging instance by its authored width — the overlap
 * `LESSONS §71` records, still reachable through the front door.
 *
 * The store now publishes the resolver once per commit. These tests pin the two
 * halves of that: the direct call and the full-tree call agree, and neither
 * overlaps the sibling.
 */

const CANVAS = { width: 400, height: 400, unit: "px" as const, background: { type: "solid" as const, color: "#fff" } };

const tagMaster: DesignElement = {
  id: "cmp/Tag",
  type: "component",
  name: "Tag",
  x: 0,
  y: 0,
  width: 60,
  height: 20,
  sizing: { width: "max-content", height: "fit-content" },
  ...flattenLayout({ mode: "flex", direction: "row", align: "center", padding: [0, 8, 0, 8] }),
  // Per-instance text comes from a `content` OVERRIDE on the master's own text
  // layer, which is what replaced the named `Label` text property. Written out in
  // full rather than through a helper because these tests care about the RESOLVED
  // width, and the override is what makes each instance resolve to a different one.
  children: [
    {
      id: "tag-label",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 11,
      content: "Tag",
      sizing: { width: "max-content", height: "fit-content" },
      style: { fontFamily: "Inter, sans-serif", fontSize: 8, fontWeight: 500 }
    } as DesignElement
  ]
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

const docOf = (elements: DesignElement[], master: DesignElement = tagMaster): DesignDocument => ({
  id: "hug",
  version: "0.1",
  name: "hug",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  canvas: CANVAS,
  pages: [{ id: "p1", name: "P1", canvas: CANVAS, children: [master, ...elements] }],
  activePageId: "p1"
});

/** The same master with a larger label: the one number that differs between two docs. */
const bigTagMaster = (() => {
  const label = (tagMaster as { children: Array<DesignElement & { style?: object }> }).children[0];
  return {
    ...tagMaster,
    children: [{ ...label, style: { ...label.style, fontSize: 24 } }]
  } as DesignElement;
})();

const geometry = (el: DesignElement) => [el.x, el.y, el.width, el.height];

afterEach(() => clearAmbientChildSizeResolver());

describe("a hugging instance is measured the same way on every path", () => {
  it("the inspector path and the store path produce identical geometry", () => {
    const doc = docOf([row([instance("a", "A much longer label"), instance("b", "Another much longer label")])]);
    const frame = doc.pages![0].children[1] as FrameElement;

    // A store is alive, so the ambient resolver is published — this is the
    // state every editor call runs in.
    new EditorStore(doc);

    const direct = applyAutoLayout(frame);
    const full = relayoutDocumentTree([frame])[0] as FrameElement;
    const explicit = relayoutDocumentTree([frame], instanceSizeResolver(doc))[0] as FrameElement;

    expect(geometry(direct)).toEqual(geometry(full));
    expect(geometry(direct)).toEqual(geometry(explicit));
    direct.children!.forEach((child, i) => {
      expect(geometry(child)).toEqual(geometry(full.children![i]));
    });
  });

  it("no sibling is painted on top of another", () => {
    const doc = docOf([row([instance("a", "A much longer label"), instance("b", "Another much longer label")])]);
    const frame = doc.pages![0].children[1] as FrameElement;
    new EditorStore(doc);

    const laid = relayoutDocumentTree([frame])[0] as FrameElement;
    const [a, b] = laid.children!;
    // Each pill is placed where the previous one ends, measured by the box it
    // actually paints. Against the authored 60 the second sat at 66 while the
    // first painted to 107.2 — a 41px overlap.
    expect(a.x + a.width + 6).toBeCloseTo(b.x, 5);
    expect(a.width).toBeGreaterThan(60);
    expect(b.width).toBeGreaterThan(60);
  });
  it("an explicit resolver still wins over the published one", () => {
    const doc = docOf([row([instance("a", "A much longer label")])]);
    const frame = doc.pages![0].children[1] as FrameElement;
    new EditorStore(doc);

    // A caller that means a different document states so: a resolver answering
    // a fixed box must win over the store's.
    const fixed = () => ({ width: 60, height: 20 });
    const pinned = relayoutDocumentTree([frame], fixed)[0] as FrameElement;
    expect(pinned.children![0].width).toBe(60);
  });

  it("falls back to the authored width when no document is publishing one", () => {
    // Headless import and the tests that never open a store: the pre-existing
    // behaviour, and the one a caller with its own resolver opts into.
    const doc = docOf([row([instance("a", "A much longer label")])]);
    const frame = doc.pages![0].children[1] as FrameElement;
    const bare = relayoutDocumentTree([frame])[0] as FrameElement;
    expect(bare.children![0].width).toBe(60);
  });
});

describe("the published resolver follows what is on screen", () => {
  it("measures against the viewed document, and back again on exit", () => {
    const live = docOf([row([instance("a", "A much longer label")])]);
    const view = docOf([row([instance("a", "A much longer label")])], bigTagMaster);
    const frame = live.pages![0].children[1] as FrameElement;

    const store = new EditorStore(live);
    const underLive = relayoutDocumentTree([frame])[0] as FrameElement;

    // A version on screen whose master is drawn larger: an instance measured
    // against the LIVE master here would hug to a width the canvas is not
    // painting, which is the silent half of a read-only mode.
    store.setViewDoc(view);
    const underView = relayoutDocumentTree([frame])[0] as FrameElement;
    const explicitView = relayoutDocumentTree([frame], instanceSizeResolver(view))[0] as FrameElement;
    expect(underView.children![0].width).not.toEqual(underLive.children![0].width);
    expect(geometry(underView)).toEqual(geometry(explicitView));

    store.setViewDoc(null);
    const backToLive = relayoutDocumentTree([frame])[0] as FrameElement;
    expect(geometry(backToLive)).toEqual(geometry(underLive));
  });
});
