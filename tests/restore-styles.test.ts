import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../src/core/persistence/backend";
import { createTimelineStore } from "../src/core/persistence/timeline";
import { createAssetStore } from "../src/core/persistence/assets";
import { createRecoveryStore } from "../src/core/persistence/recovery";
import { AutosaveController } from "../src/core/persistence/autosave-controller";
import { EditorStore } from "../src/core/store/editor-store";
import type { DesignDocument, DesignElement, DesignStyle, Effect, TextElement } from "../src/core/dsl/types";
import { getActivePage } from "../src/core/dsl/types";
import { topPaint } from "../src/core/dsl/paint-stack";
import { normalizeDesignDocument } from "../src/core/dsl/normalize/document";
import { bindTextStyle, createTextStyle, updateStyleInDoc } from "../src/core/interactions/style-ops";

const SHADOW: Effect = {
  type: "drop-shadow",
  color: "#00000080",
  offset: { x: 0, y: 4 },
  blur: 8,
  enabled: true
};

const STYLES: DesignStyle[] = [
  { id: "style_fx", name: "shadow2", styleType: "effect", effects: [SHADOW] }
];

function makeDoc(withStyles: boolean, name = "d"): DesignDocument {
  return {
    fileId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
        children: [{ id: "r1", type: "rect", x: 0, y: 0, width: 10, height: 10 }]
      }
    ],
    activePageId: "page_1",
    ...(withStyles ? { styles: JSON.parse(JSON.stringify(STYLES)) } : {})
  } as unknown as DesignDocument;
}

function makeHarness(extra: Record<string, unknown> = {}) {
  const backend = new MemoryBackend();
  const store = new EditorStore(makeDoc(true));
  const controller = new AutosaveController({
    getDoc: () => store.getDoc(),
    subscribe: (cb: (doc: DesignDocument) => void) => store.subscribe(cb),
    recovery: createRecoveryStore(backend),
    assets: createAssetStore(backend),
    timeline: createTimelineStore(backend),
    historySubscribe: (cb: (doc: DesignDocument) => void) => store.onHistory(cb),
    applyDoc: (doc: DesignDocument) => store.commit(doc),
    fileId: () => "fish_test",
    mergeWindowMs: 0,
    ...extra
  } as never);
  return { store, controller, backend };
}

describe("version restore carries document styles", () => {
  it("restore brings the version's styles back", async () => {
    const { store, controller } = makeHarness();
    await controller.commitVersion({ named: true, label: "with styles" });

    store.commit(makeDoc(false, "styles removed"));
    expect(store.getDoc().styles).toBeUndefined();

    const versions = await controller.listVersions();
    const target = versions.find((v) => v.label === "with styles")!;
    await controller.restoreVersion(target.id);

    expect(store.getDoc().styles?.map((s) => s.id)).toEqual(["style_fx"]);
  });

  it("styles added then removed inside the merge window stay restorable", async () => {
    // The regression: auto versions used to be OVERWRITTEN within the 5-minute
    // merge window, so the only version silently slid forward to the
    // style-less state and Restore restored nothing. Versions are now born
    // once and the window only throttles new ones.
    const { store, controller } = makeHarness({ mergeWindowMs: 5 * 60 * 1000 });
    controller.enable();
    store.commit(makeDoc(true, "styles added"));
    await new Promise((r) => setTimeout(r, 1000)); // version timer is 800ms

    store.commit(makeDoc(false, "styles removed"));
    await new Promise((r) => setTimeout(r, 1000));
    controller.disable();

    const versions = await controller.listVersions();
    expect(versions).toHaveLength(1);
    await controller.restoreVersion(versions[0].id);
    expect(store.getDoc().styles?.map((s) => s.id)).toEqual(["style_fx"]);
  });
});

/**
 * What the eye sees on a text node: the top fill, and NOTHING ELSE.
 *
 * It used to fall back to `style.color`, which is the field an author writes a
 * colour in rather than a second paint store — the fallback is what painted a
 * text whose stack said `[]` (LESSONS_LEARNED §206).
 */
function renderedTextColor(el: DesignElement | undefined): string | undefined {
  if (!el || el.type !== "text") return undefined;
  const top = topPaint(el.fills);
  return top?.type === "solid" ? top.color : undefined;
}

function textDoc(overrides: Record<string, unknown>, styles: unknown[]): DesignDocument {
  return {
    fileId: "fish_test",
    id: "doc_x",
    version: "0.1",
    name: "text colours",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        canvas: { width: 100, height: 100, unit: "px", background: { type: "solid", color: "#000" } },
        children: [overrides.element as DesignElement]
      }
    ],
    activePageId: "page_1",
    styles
  } as unknown as DesignDocument;
}

describe("restore carries text colour", () => {
  // The regression: `normalizeElement` had no `case "text"` branch for the fill
  // stack, so every load / restore / edit threw `fills` away. A text whose
  // colour came from a bound style kept its `*StyleId` marker — the inspector
  // still read as bound — but fell back to the `style.color` default (white),
  // and only re-picking the style in the picker put the colour back.
  it("a text bound to a paint style keeps its colour across a restore", async () => {
    const paint = { id: "style_paint", name: "Blue", styleType: "paint", paints: [{ type: "solid", color: "#3366FF" }] };
    const bound = {
      id: "t1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 24,
      content: "hello",
      fillStyleId: "style_paint",
      fills: [{ type: "solid", color: "#3366FF" }],
      style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
    };

    const { store, controller } = makeHarness();
    store.commit(textDoc({ element: bound }, [paint]));
    await controller.commitVersion({ named: true, label: "blue text" });

    store.commit(textDoc({ element: { ...bound, fills: [{ type: "solid", color: "#FF0000" }] } }, [paint]));
    await controller.restoreVersion((await controller.listVersions()).find((v) => v.label === "blue text")!.id);

    const restored = getActivePage(store.getDoc()).children[0];
    expect(renderedTextColor(restored)).toBe("#3366FF");
    expect((restored as TextElement).fillStyleId).toBe("style_paint");
  });

  it("a text style carries no ink: binding leaves the layer's fills alone", () => {
    // Colour is paint. A text style is type, so binding one must not repaint the
    // layer — the ink stays whatever the layer's fill stack says (or a paint
    // style bound there), which is the one source the fill inspector edits.
    const style = createTextStyle("Red", { fontFamily: "Inter", fontSize: 16, color: "#FF0000" });
    expect("color" in style.style, "a text style kept a colour").toBe(false);

    const bound = bindTextStyle(
      {
        id: "t1",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 24,
        content: "hello",
        fills: [{ type: "solid", color: "#FFFFFF" }],
        style: { fontFamily: "Inter", fontSize: 16, color: "#FFFFFF" }
      },
      style
    );

    expect(renderedTextColor(bound)).toBe("#FFFFFF");

    // And the binding survives the round trip, marker included.
    const restored = getActivePage(normalizeDesignDocument(textDoc({ element: bound }, [style]), {
      preserveUnknown: true
    }).document).children[0];
    expect(renderedTextColor(restored)).toBe("#FFFFFF");
    expect((restored as TextElement).textStyleId).toBe(style.id);
  });

  it("editing a bound text style moves the type and not the ink", () => {
    const style = createTextStyle("Red", { fontFamily: "Inter", fontSize: 16, color: "#FF0000" });
    const doc = textDoc(
      {
        element: bindTextStyle(
          {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 24,
            content: "hi",
            fills: [{ type: "solid", color: "#FFFFFF" }]
          } as TextElement,
          style
        )
      },
      [style]
    );

    const edited = updateStyleInDoc(doc, { ...style, style: { ...style.style, fontSize: 32 } });
    const el = getActivePage(edited).children[0] as TextElement;
    expect(el.style?.fontSize).toBe(32);
    expect(renderedTextColor(el)).toBe("#FFFFFF");
    expect(topPaint(el.fills)).toMatchObject({ type: "solid", color: "#FFFFFF" });
  });

  it("a text with NO fill key gets its style.color materialised as a fill", () => {
    const el = getActivePage(normalizeDesignDocument(
      textDoc(
        {
          element: {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 24,
            content: "hello",
            style: { fontFamily: "Inter", fontSize: 16, color: "#ABCDEF" }
          }
        },
        []
      ),
      { preserveUnknown: true }
    ).document).children[0];

    // Text colour is authored as `style.color`; materialising it keeps the fill
    // inspector pointed at the same value instead of showing nothing. The
    // MISSING key is the only way to say "no opinion" — see the test below.
    expect(renderedTextColor(el)).toBe("#ABCDEF");
    expect(topPaint(el.fills)).toMatchObject({ type: "solid", color: "#ABCDEF" });
  });

  /**
   * `fills: []` is a DECISION, not a missing colour.
   *
   * The materialise branch read `!topPaint(fills)` — truthiness of the paint it
   * had just built — so an explicitly emptied stack looked exactly like an
   * absent one and `style.color` was written back over it. Every text the author
   * had hidden came back black, and because `normalizeTextStyle` defaults the
   * colour to `#000000` it did so for a text with no colour written either.
   */
  it("an explicitly empty fill stack paints nothing", () => {
    const empty = getActivePage(normalizeDesignDocument(
      textDoc(
        {
          element: {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 24,
            content: "hello",
            fills: [],
            style: { fontFamily: "Inter", fontSize: 16, color: "#ABCDEF" }
          }
        },
        []
      ),
      { preserveUnknown: true }
    ).document).children[0];

    expect(empty.fills).toEqual([]);
    expect(topPaint(empty.fills)).toBeUndefined();
    expect(renderedTextColor(empty)).toBeUndefined();
  });

  it("a solid top fill is what style.color reports", () => {
    const el = getActivePage(normalizeDesignDocument(
      textDoc(
        {
          element: {
            id: "t1",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 24,
            content: "hello",
            fills: [{ type: "solid", color: "#00FF00" }],
            style: { fontFamily: "Inter", fontSize: 16, color: "#ABCDEF" }
          }
        },
        []
      ),
      { preserveUnknown: true }
    ).document).children[0] as TextElement;

    // The stack is what the eye sees, so the colour field must not disagree with
    // it — the fill inspector and the text-style binding both read that field.
    expect(el.style?.color).toBe("#00FF00");
  });
});
