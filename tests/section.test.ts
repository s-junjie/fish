import { describe, it, expect } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { LATEST_DOCUMENT_VERSION } from "../src/core/dsl/version";
import { isSectionElement } from "../src/core/geometry/tree-ops";
import { reparentRefusal } from "../src/core/geometry/tree-reparent";
import { commitCreatedShape } from "../src/ui/hooks/canvas-gestures/shape-creation";
import { isSlideHost } from "../src/core/dsl/slide";
import { presentationFrames } from "../src/core/presentation/frames";
import { findThumbnailTargetFrame } from "../src/core/thumbnail-target";
import type { DesignDocument, DesignElement } from "../src/core/dsl/types";

/**
 * A section is a named region of the page — a frame with `section: true`. It is
 * a CONTAINER (children in its own coordinates, moves and resizes with them) and
 * not a SCREEN: it does not lay out, clip or present. Those three refusals are
 * the whole difference, and each is reported rather than silently dropped.
 */

const canvas = {
  width: 1200,
  height: 800,
  unit: "px" as const,
  background: { type: "solid" as const, color: "#101010" }
};

function read(children: unknown[]) {
  return normalizeDesignDocument(
    {
      version: LATEST_DOCUMENT_VERSION,
      canvas,
      pages: [{ id: "p", name: "P", canvas, children }],
      activePageId: "p"
    },
    { preserveUnknown: true }
  );
}

const box = { x: 0, y: 0, width: 400, height: 300 };

describe("the flag survives a load", () => {
  it("keeps `section` on a frame and reports nothing", () => {
    const { document, repairs } = read([
      { id: "s", type: "frame", name: "Onboarding", section: true, ...box }
    ]);
    const el = document.pages[0].children[0];
    expect(el).toMatchObject({ type: "frame", section: true, name: "Onboarding" });
    expect(repairs).toEqual([]);
  });

  it("is a frame in every structural sense, children in its own coordinates", () => {
    const { document } = read([
      {
        id: "s",
        type: "frame",
        name: "Onboarding",
        section: true,
        ...box,
        children: [{ id: "card", type: "rect", x: 24, y: 40, width: 120, height: 80 }]
      }
    ]);
    const el = document.pages[0].children[0];
    expect(el.type).toBe("frame");
    expect((el as any).children[0]).toMatchObject({ id: "card", x: 24, y: 40 });
  });
});

describe("a section is a region, not a screen", () => {
  it("drops auto layout with a repair", () => {
    const { document, repairs } = read([
      { id: "s", type: "frame", section: true, display: "flex", "flex-direction": "column", gap: 8, ...box }
    ]);
    const el = document.pages[0].children[0] as any;
    expect(el.display).toBeUndefined();
    expect(el.gap).toBeUndefined();
    expect(repairs.some((r) => /no auto layout/.test(r.message))).toBe(true);
  });

  it("drops clipping with a repair", () => {
    const { document, repairs } = read([
      { id: "s", type: "frame", section: true, overflow: "hidden", ...box }
    ]);
    const el = document.pages[0].children[0] as any;
    expect(el.overflow).toBeUndefined();
    expect(repairs.some((r) => /never clips/.test(r.message))).toBe(true);
  });

  it("drops a slide with a repair, and never presents as one", () => {
    const { document, repairs } = read([
      { id: "s", type: "frame", section: true, slide: { transition: "dissolve" }, ...box },
      { id: "board", type: "frame", name: "Board", ...box }
    ]);
    const section = document.pages[0].children[0] as any;
    expect(section.slide).toBeUndefined();
    expect(repairs.some((r) => /does not present/.test(r.message))).toBe(true);
    expect(presentationFrames(document).map((f) => f.id)).toEqual(["board"]);
  });

  it("is not a slide host even when it carries a slide", () => {
    const section = { type: "frame", section: true } as DesignElement;
    expect(isSectionElement(section)).toBe(true);
    expect(isSlideHost(section)).toBe(false);
    expect(isSlideHost({ type: "frame" } as DesignElement)).toBe(true);
  });
});

describe("only a frame has a region to name", () => {
  it("refuses the flag on a shape and says why", () => {
    const { document, repairs } = read([{ id: "r", type: "rect", section: true, ...box }]);
    expect((document.pages[0].children[0] as any).section).toBeUndefined();
    expect(repairs.some((r) => /only a frame can be a section/.test(r.message))).toBe(true);
  });

  it("refuses it on a component, which paints a definition rather than a region", () => {
    const { document, repairs } = read([{ id: "c", type: "component", section: true, ...box }]);
    expect((document.pages[0].children[0] as any).section).toBeUndefined();
    expect(repairs.some((r) => /only a frame can be a section/.test(r.message))).toBe(true);
  });
});

describe("what a document without sections says", () => {
  it("writes no `section` key back, so an untouched file round-trips byte-identical", () => {
    const { document } = read([{ id: "f", type: "frame", ...box }]);
    expect((document.pages[0].children[0] as any).section).toBeUndefined();
  });
});

describe("the tree keeps a section on the page", () => {
  const tree = [
    {
      id: "s",
      type: "frame",
      section: true,
      ...box,
      children: []
    },
    { id: "f", type: "frame", x: 500, y: 0, width: 300, height: 300, children: [] }
  ] as DesignElement[];

  it("refuses to drop it inside a frame, and says which rule refused", () => {
    expect(reparentRefusal(tree, "s", "f")).toBe("section-in-frame");
  });

  it("allows it to stay on the page, where every region belongs", () => {
    expect(reparentRefusal(tree, "s", null)).toBeNull();
  });

  it("leaves an ordinary frame free to nest", () => {
    expect(reparentRefusal(tree, "f", "s")).toBeNull();
  });
});

describe("the document cover is a screen, not a region", () => {
  it("falls back past a section to the first real frame", () => {
    const { document } = read([
      { id: "s", type: "frame", section: true, ...box },
      { id: "board", type: "frame", name: "Board", x: 600, y: 0, width: 300, height: 300 }
    ]);
    expect(findThumbnailTargetFrame(document)?.id).toBe("board");
  });
});

describe("drawing one around what is already there", () => {
  it("takes the screens it covers, re-bases them, and stays on the page", () => {
    const doc = read([
      { id: "a", type: "frame", name: "A", x: 100, y: 100, width: 120, height: 200, children: [] },
      { id: "b", type: "frame", name: "B", x: 260, y: 100, width: 120, height: 200, children: [] },
      { id: "outside", type: "frame", name: "C", x: 900, y: 100, width: 120, height: 200, children: [] }
    ]).document;

    const commits: DesignDocument[] = [];
    commitCreatedShape({
      finalGeom: { kind: "box", tool: "section", x: 60, y: 60, width: 400, height: 300 },
      dist: 120,
      docRef: { current: doc },
      commitSnapshot: (next) => commits.push(next),
      setSelectedIds: () => {},
      setActiveTool: () => {},
      startCanvasTextEdit: () => {}
    });

    expect(commits).toHaveLength(1);
    const page = commits[0].pages[0];
    const section = page.children.find((el) => isSectionElement(el)) as any;
    expect(section).toBeTruthy();
    expect(section).toMatchObject({ x: 60, y: 60, width: 400, height: 300, borderRadius: 12 });
    expect(section.children.map((c: any) => c.id).sort()).toEqual(["a", "b"]);
    // Local coordinates: the children travelled with the region.
    expect(section.children.find((c: any) => c.id === "a")).toMatchObject({ x: 40, y: 40 });
    // The frame it did not cover is still on the page, a sibling.
    expect(page.children.map((el) => el.id)).toContain("outside");
  });

  it("leaves another section where it is — a region never swallows a region", () => {
    const doc = read([
      { id: "old", type: "frame", section: true, name: "Old", x: 100, y: 100, width: 200, height: 200, children: [] },
      { id: "board", type: "frame", name: "Board", x: 320, y: 100, width: 120, height: 200, children: [] }
    ]).document;

    const commits: DesignDocument[] = [];
    commitCreatedShape({
      finalGeom: { kind: "box", tool: "section", x: 60, y: 60, width: 420, height: 300 },
      dist: 120,
      docRef: { current: doc },
      commitSnapshot: (next) => commits.push(next),
      setSelectedIds: () => {},
      setActiveTool: () => {},
      startCanvasTextEdit: () => {}
    });

    const page = commits[0].pages[0];
    const created = page.children.find((el) => isSectionElement(el) && el.id !== "old") as any;
    expect(created.children.map((c: any) => c.id)).toEqual(["board"]);
    expect(page.children.map((el) => el.id)).toContain("old");
    expect(isSectionElement(page.children.find((el) => el.id === "old")!)).toBe(true);
  });
});
