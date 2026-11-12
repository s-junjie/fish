import { describe, expect, it } from "vitest";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { validateTokenRefs } from "../src/core/validate-tokens";
import { getActivePage } from "../src/core/dsl/document-ops";
import type {
  DesignDocument,
  DesignElement,
  DesignStyle,
  FrameElement,
  LayoutGuide,
  LayoutGuideStyle
} from "../src/core/dsl/types";
import { bindLayoutGuideStyle, removeStyleFromDoc } from "../src/core/interactions/style-ops";
import { countStyleUses } from "../src/core/interactions/token-ops";
import { buildClipboardPayload, parseClipboardPayload } from "../src/core/interactions/clipboard-payload";
import { remintFragment } from "../src/core/interactions/clipboard-fragment";

/**
 * A frame's ruler is a BINDING: `layoutGuideStyleId` names the style and
 * `layoutGuides` beside it is the materialised value, exactly as `fillStyleId`
 * and `fills` pair. That makes the id load-bearing — it is the only thing that
 * lets an edit of the style reach the frame — so every reader that walks the
 * other four style ids has to walk this one too, and a load that drops it turns
 * a live binding into a detached ruler with no repair and no visible change.
 *
 * The cases below are the five readers, one per `it`.
 */

const GUIDE: LayoutGuide = { kind: "columns", count: 4, gutter: 16 };

const canvas = { width: 400, height: 300, unit: "px" as const, background: { type: "solid" as const, color: "#FFFFFF" } };

const guideStyle: LayoutGuideStyle = {
  id: "style_guide_1",
  name: "4 columns",
  styleType: "layoutGuide",
  guides: [GUIDE]
};

const makeDoc = (children: DesignElement[], styles: DesignStyle[] = [guideStyle]): DesignDocument =>
  ({
    version: "0.1",
    id: "doc_guide",
    name: "Guides",
    canvas,
    pages: [{ id: "page_1", name: "Page 1", canvas, children }],
    activePageId: "page_1",
    styles,
    tokens: []
  }) as unknown as DesignDocument;

const boundFrame = (): FrameElement =>
  bindLayoutGuideStyle(
    { id: "card", type: "frame", x: 0, y: 0, width: 200, height: 100, children: [] } as FrameElement,
    guideStyle
  ) as FrameElement;

const pageFrame = (doc: DesignDocument): Record<string, any> =>
  getActivePage(doc).children[0] as unknown as Record<string, any>;

describe("layoutGuideStyleId survives a load", () => {
  it("keeps the binding and the guides it materialises", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "0.1",
      name: "Guides",
      canvas,
      pages: [{ id: "page_1", name: "Page 1", children: [boundFrame()] }],
      styles: [guideStyle]
    } as unknown as Record<string, unknown>);

    const frame = pageFrame(document);
    expect(frame.layoutGuideStyleId).toBe("style_guide_1");
    expect(frame.layoutGuides).toEqual([GUIDE]);
    // No repair: the key is one the file declares, so a drop here was silent by
    // construction — which is what made it a P0 rather than a typo.
    expect(repairs.filter((r) => r.path.includes("layoutGuideStyleId"))).toEqual([]);
  });

  it("reads the kebab spelling the schema also publishes", () => {
    const { document } = normalizeDesignDocument({
      version: "0.1",
      name: "Guides",
      canvas,
      pages: [{ id: "page_1", children: [{ id: "card", type: "frame", width: 100, height: 100, "layout-guide-style-id": "style_guide_1", "layout-guides": [GUIDE] }] }],
      styles: [guideStyle]
    } as unknown as Record<string, unknown>);

    expect(pageFrame(document).layoutGuideStyleId).toBe("style_guide_1");
    expect(pageFrame(document)["layout-guide-style-id"]).toBeUndefined();
  });

  it("does not bind a component set, whose box is fitted on load", () => {
    const { document, repairs } = normalizeDesignDocument({
      version: "0.1",
      name: "Guides",
      canvas,
      pages: [{ id: "page_1", children: [{ id: "set", type: "componentSet", width: 100, height: 100, layoutGuideStyleId: "style_guide_1", children: [] }] }],
      styles: [guideStyle]
    } as unknown as Record<string, unknown>);

    expect(pageFrame(document).layoutGuideStyleId).toBeUndefined();
    expect(repairs.some((r) => r.path.endsWith("/layoutGuideStyleId"))).toBe(true);
  });
});

describe("the style's own readers see the binding", () => {
  it("deleting the style unbinds the frame and keeps the ruler", () => {
    const after = removeStyleFromDoc(makeDoc([boundFrame()] as DesignElement[]), guideStyle.id);
    const frame = pageFrame(after);
    expect(frame.layoutGuideStyleId).toBeUndefined();
    expect(frame.layoutGuides).toEqual([GUIDE]);
    expect(after.styles).toEqual([]);
  });

  it("counts a bound frame as a use, so the delete confirmation is honest", () => {
    expect(countStyleUses(makeDoc([boundFrame()] as DesignElement[]), guideStyle.id)).toBe(1);
  });

  it("reports a binding nothing backs", () => {
    const refs = validateTokenRefs(makeDoc([boundFrame()] as DesignElement[], []));
    const hit = refs.find((d) => d.message.includes("style_guide_1"));
    expect(hit?.level).toBe("warning");
    expect(hit?.message).toContain("layoutGuideStyleId");
  });

  it("agrees with the shared field list rather than a local copy", () => {
    // The defect was five hand-written lists; a sixth field added to one of them
    // is the same bug again. Both readers are asked the same question here, so a
    // divergence fails rather than passing quietly.
    const doc = makeDoc([boundFrame()] as DesignElement[]);
    expect(validateTokenRefs(doc).length).toBe(0);
    expect(countStyleUses(doc, guideStyle.id)).toBe(1);
  });
});

describe("a bound frame travels with its style", () => {
  it("carries the style across a copy and re-points the binding at the copy", () => {
    const source = makeDoc([boundFrame()] as DesignElement[]);
    const payload = parseClipboardPayload(
      buildClipboardPayload(source, getActivePage(source).children, "clip_1")
    );
    expect(payload?.styles.map((s) => s.id)).toEqual([guideStyle.id]);

    const destination = makeDoc([] as DesignElement[], []);
    const fragment = remintFragment(destination, payload!);
    const pasted = fragment.sources[0] as Record<string, any>;
    expect(pasted.layoutGuideStyleId).toBe(fragment.styles[0].id);
    expect(pasted.layoutGuideStyleId).not.toBe(guideStyle.id);
    expect(pasted.layoutGuides).toEqual([GUIDE]);
  });
});
