import { describe, expect, it } from "vitest";
import {
  ComponentElement,
  DesignDocument,
  DesignElement,
  DesignStyle,
  FrameElement,
  InstanceElement,
  TextElement,
  getActivePage
} from "../src/core/dsl/types";
import { propagateMasterSize, resolveInstanceBox, resolveInstanceTheme } from "../src/core/interactions/instance-inherit";
import { resolveInstanceContent, resolveInstanceChildren } from "../src/core/interactions/instance-resolve";
import { scaleElementsToSize, scaleSelectionInDocument, scalableAxes } from "../src/core/interactions/scale-ops";
import { detachInstance, hasAnythingToReset, resetInstanceOverrides } from "../src/core/interactions/component-ops";
import { normalizeDesignDocument } from "../src/core/dsl/normalize";
import { layoutOf, withLayout } from "../src/core/dsl/layout-flat";
import { relayoutDocumentTree } from "../src/core/compile";
import { resolveTextSizing } from "../src/core/layout/text-sizing";
import type { StyleTables } from "../src/core/interactions/style-tables";

/**
 * The three failures this file grades are one model failing three ways: an
 * instance is a PROJECTION of its master, so the master's mode, its geometry and
 * its type sizes are all things the instance inherits — and a scale has to be a
 * property of the projection rather than a copy of the master's numbers.
 */

const tables: StyleTables = {
  tokens: [
    { id: "tok_paper", name: "paper", type: "color", value: "#FFFFFF", modes: { dark: "#161618" } },
    { id: "tok_ink", name: "ink", type: "color", value: "#161614", modes: { dark: "#F2F0EA" } }
  ],
  styles: [
    {
      id: "st_display",
      name: "Display",
      styleType: "text",
      style: { fontFamily: "Inter", fontSize: 44, lineHeight: "48px" }
    } satisfies DesignStyle
  ]
};

/**
 * A master that is authored in dark under a light document, exactly as the demo
 * page is: the mode lives on the container, and every colour in it is a token.
 */
function darkMaster(): ComponentElement {
  return {
    id: "cmp/page",
    type: "component",
    name: "Page",
    x: 0,
    y: 0,
    width: 400,
    height: 800,
    themeMode: "dark",
    fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_paper" }],
    borderRadius: 52,
    strokes: [{ color: "#161614", width: 2, tokenId: "tok_ink" }],
    effects: [{ type: "drop-shadow", color: "#00000026", offset: { x: 0, y: 2 }, blur: 8, enabled: true }],
    children: [
      {
        id: "headline",
        type: "text",
        x: 32,
        y: 48,
        width: 320,
        height: 96,
        content: "Space,\nshaped by light.",
        textStyleId: "st_display",
        style: { fontFamily: "Inter", fontSize: 44, lineHeight: "48px", color: "#161614" },
        fills: [{ type: "solid", color: "#161614", tokenId: "tok_ink" }]
      } satisfies TextElement,
      {
        id: "card",
        type: "frame",
        x: 32,
        y: 200,
        width: 336,
        height: 200,
        borderRadius: 24,
        padding: 24,
        fills: [{ type: "solid", color: "#FFFFFF", tokenId: "tok_paper" }],
        children: []
      } satisfies FrameElement
    ]
  };
}

function instanceOf(componentId: string, extra: Partial<InstanceElement> = {}): InstanceElement {
  return { id: "inst/page", type: "instance", componentId, x: 500, y: 0, width: 400, height: 800, ...extra };
}

const documentOf = (elements: DesignElement[]): DesignDocument =>
  ({
    version: "0.1",
    id: "doc",
    name: "doc",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 1000, height: 1000, background: "#FFFFFF" },
    activePageId: "p1",
    pages: [{ id: "p1", name: "Page 1", canvas: { width: 1000, height: 1000, background: "#FFFFFF" }, children: elements }],
    tokens: [...tables.tokens],
    styles: [...tables.styles]
  }) as unknown as DesignDocument;

const read = (doc: DesignDocument, id: string): DesignElement => {
  const walk = (list: DesignElement[]): DesignElement | undefined => {
    for (const el of list) {
      if (el.id === id) return el;
      const kids = (el as FrameElement).children;
      if (kids) {
        const hit = walk(kids);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const found = walk(getActivePage(doc).children);
  if (!found) throw new Error(`not found: ${id}`);
  return found;
};

const fillColor = (el: DesignElement | undefined): string | undefined =>
  (el as { fills?: { color?: string }[] })?.fills?.[0]?.color;

/**
 * Problem 1. A page authored in dark under a light document keeps its mode when
 * it is projected — as an instance, and therefore in every node under it.
 */
describe("an instance inherits its master's theme mode", () => {
  it("answers with the master's mode when it declares none of its own", () => {
    expect(resolveInstanceTheme(instanceOf("cmp/page"), darkMaster(), "light")).toBe("dark");
  });

  it("lets an explicit mode on the instance win, and falls back to the ancestor's", () => {
    expect(resolveInstanceTheme(instanceOf("cmp/page", { themeMode: "light" }), darkMaster(), "dark")).toBe("light");
    expect(resolveInstanceTheme(instanceOf("cmp/page"), { ...darkMaster(), themeMode: undefined }, "light")).toBe("light");
  });

  it("materialises the master's subtree in that mode, not the document's", () => {
    const master = darkMaster();
    const instance = instanceOf("cmp/page");
    const theme = resolveInstanceTheme(instance, master, "light");
    const content = resolveInstanceContent(instance, master, { theme, tables });
    const headline = content.children.find((el) => el.id.endsWith("headline"))!;
    expect(fillColor(headline as DesignElement), "the headline is ink-on-dark, not ink-on-light").toBe("#F2F0EA");
  });

  it("paints its own box in the same mode its children were resolved in", () => {
    const master = darkMaster();
    const instance = instanceOf("cmp/page");
    const theme = resolveInstanceTheme(instance, master, "light");
    const box = resolveInstanceBox(instance, master, undefined, { theme, tables });
    expect(fillColor(box as unknown as DesignElement), "outer box").toBe("#161618");
  });

  it("detaching writes the resolved mode down, so the artwork cannot change sides", () => {
    const master = darkMaster();
    const doc = documentOf([master, instanceOf("cmp/page")]);
    const { frame } = detachInstance(doc, "inst/page");
    expect(frame?.themeMode).toBe("dark");
  });
});

/**
 * Problem 2. An instance stores no children, so a scale has nowhere to write the
 * contents except the factor itself. These assert the CONTENTS, because a box-only
 * assertion passed while the instance rendered as a plain resize.
 */
describe("scaling an instance scales what is inside it", () => {
  const scaled = (factor: number) => {
    const master = darkMaster();
    const doc = documentOf([master, instanceOf("cmp/page")]);
    const out = scaleSelectionInDocument(doc, new Set(["inst/page"]), factor);
    const instance = read(out.doc, "inst/page") as InstanceElement;
    return { doc: out.doc, instance, master, out };
  };

  it("records the factor and the box it produced", () => {
    const { instance } = scaled(0.5);
    expect(instance.instanceScale).toEqual({ x: 0.5, y: 0.5 });
    expect([instance.width, instance.height]).toEqual([200, 400]);
  });

  it("leaves the master at 1x", () => {
    const { master, doc } = scaled(0.5);
    const stored = read(doc, "cmp/page") as ComponentElement;
    expect([stored.width, stored.height]).toEqual([master.width, master.height]);
    expect((stored.children[0] as TextElement).style.fontSize).toBe(44);
  });

  it("scales the children's type, coordinates and corner radii through the factor", () => {
    const { instance, master, doc } = scaled(0.5);
    const children = resolveInstanceChildren(instance, read(doc, "cmp/page") as ComponentElement);
    const headline = children.find((el) => el.id.endsWith("headline")) as TextElement;
    const card = children.find((el) => el.id.endsWith("card")) as FrameElement;
    expect(headline.style.fontSize, "44px type in a half-size box").toBe(22);
    expect([headline.x, headline.y, headline.width], "the type block moved with the box").toEqual([16, 24, 160]);
    expect([card.width, card.height], "siblings").toEqual([168, 100]);
    expect(card.borderRadius, "radius travels with the box").toBe(12);
    // The master is the baseline, never the thing written to.
    expect((master.children[0] as TextElement).style.fontSize).toBe(44);
  });

  it("scales the inherited chrome of the instance's own box", () => {
    const { instance, master, doc } = scaled(0.5);
    const box = resolveInstanceBox(instance, read(doc, "cmp/page") as ComponentElement);
    expect(box.borderRadius, "radius inherited at 1x").toBe(26);
    expect(box.strokes[0].width, "stroke width inherited at 1x").toBe(1);
    expect((box.effects[0] as { blur: number }).blur, "shadow blur inherited at 1x").toBe(4);
  });

  it("lets the Scale tool reach an instance of a hugging master", () => {
    // Both axes engine-owned was the old reading of "there is no box here to
    // write", which refused every chip and every icon button in a design system.
    const master: ComponentElement = { ...darkMaster(), sizing: { width: "fit-content", height: "fit-content" } };
    const instance = instanceOf("cmp/page", { sizing: { width: "fit-content", height: "fit-content" } });
    const out = scaleSelectionInDocument(documentOf([master, instance]), new Set(["inst/page"]), 2);
    expect(out.refusal, "a hugging instance is still a box the scale owns").toBeUndefined();
    expect((read(out.doc, "inst/page") as InstanceElement).instanceScale).toEqual({ x: 2, y: 2 });
  });

  it("keeps tracking the master through the factor when the master is resized", () => {
    const { instance, doc } = scaled(0.5);
    const shrunk: DesignDocument = {
      ...doc,
      pages: doc.pages.map((page) => ({
        ...page,
        children: page.children.map((el) =>
          el.id === "cmp/page" ? ({ ...(el as ComponentElement), width: 200, height: 400 } as ComponentElement) : el
        )
      }))
    };
    const next = propagateMasterSize(doc, shrunk);
    const inst = read(next, "inst/page") as InstanceElement;
    expect([inst.width, inst.height], "new master × the instance's own factor").toEqual([100, 200]);
    expect(inst.instanceScale, "and the factor is untouched").toEqual({ x: 0.5, y: 0.5 });
  });

  it("scales an instance NESTED inside the master, so its icon stays centred", () => {
    // The bug's second half: a 44×44 round button shrank to 34×34 while its glyph
    // stayed 24×24 at (13, 13) — pinned near the centre of a box that was no longer
    // there. The nested instance has to carry the factor like any other child.
    const icon: ComponentElement = {
      id: "cmp/icon",
      type: "component",
      name: "Icon",
      x: 0,
      y: 0,
      width: 44,
      height: 44,
      children: [
        { id: "glyph", type: "rect", x: 10, y: 10, width: 24, height: 24, fills: [{ type: "solid", color: "#161614" }] }
      ]
    };
    const screen: ComponentElement = {
      ...darkMaster(),
      children: [instanceOf("cmp/icon", { id: "btn", x: 13, y: 13, width: 44, height: 44 })]
    };
    const out = scaleSelectionInDocument(
      documentOf([icon, screen, instanceOf("cmp/page")]),
      new Set(["cmp/page"]),
      0.5
    );
    const scaledScreen = read(out.doc, "cmp/page") as ComponentElement;
    const btn = scaledScreen.children[0] as InstanceElement;
    expect([btn.x, btn.y, btn.width, btn.height], "the button followed the master").toEqual([6.5, 6.5, 22, 22]);
    expect(btn.instanceScale, "and carries the factor for its own contents").toEqual({ x: 0.5, y: 0.5 });

    const glyph = resolveInstanceChildren(btn, icon)[0];
    expect([glyph.x, glyph.y, glyph.width, glyph.height], "the glyph scales inside the button").toEqual([5, 5, 12, 12]);
  });
});

/**
 * Problem 3. Scaling a MASTER rewrote its numbers but left the shared styles
 * pointing at the 1x originals, so the master looked right and its instance — the
 * one renderer that re-materialises styles — came back with 1x type in a scaled box.
 */
describe("scaling a master unbinds the styles it has made stale", () => {
  const scaledMaster = (factor: number) => {
    const doc = documentOf([darkMaster(), instanceOf("cmp/page")]);
    const out = scaleSelectionInDocument(doc, new Set(["cmp/page"]), factor);
    return { doc: out.doc, master: read(out.doc, "cmp/page") as ComponentElement };
  };

  it("drops the text style whose size the scale has replaced", () => {
    const { master } = scaledMaster(0.78);
    const headline = master.children[0] as TextElement;
    expect(headline.textStyleId, "a 34.32px text is no longer `st_display`").toBeUndefined();
    expect(headline.style.fontSize).toBe(34.32);
  });

  it("renders the instance's type at the master's scaled size, not the style's 1x size", () => {
    const { doc, master } = scaledMaster(0.78);
    const instance = instanceOf("cmp/page", { width: 312, height: 624 });
    const theme = resolveInstanceTheme(instance, master, "light");
    const content = resolveInstanceContent(instance, master, { theme, tables });
    const headline = content.children.find((el) => el.id.endsWith("headline")) as TextElement;
    // The regression: `syncDualStorage` used to put 44px back here, which folded
    // this two-line headline into three inside a 250px box and overlapped the body.
    expect(headline.style.fontSize).toBe(34.32);
  });

  it("keeps the colour bindings, so a scaled component still answers the theme", () => {
    const { master } = scaledMaster(0.78);
    const headline = master.children[0] as TextElement;
    expect((headline.fills?.[0] as { tokenId?: string }).tokenId, "a material is not a measurement").toBe("tok_ink");
    expect(master.themeMode).toBe("dark");
  });
});

/**
 * A factor that does not survive the save is a factor the next load paints as a
 * plain resize — and Reset has to be able to give it back.
 */
describe("the factor is part of the document, and Reset gives it back", () => {
  const raw = (instance: Record<string, unknown>) => ({
    version: "0.1",
    id: "doc",
    name: "doc",
    createdAt: "",
    updatedAt: "",
    canvas: { width: 1000, height: 1000, background: "#FFFFFF" },
    activePageId: "p1",
    pages: [
      {
        id: "p1",
        name: "Page 1",
        canvas: { width: 1000, height: 1000, background: "#FFFFFF" },
        children: [instance]
      }
    ]
  });

  const normalized = (instance: Record<string, unknown>): InstanceElement =>
    normalizeDesignDocument(raw(instance)).document.pages[0].children[0] as InstanceElement;

  it("reads both spellings, and writes 1:1 as absent", () => {
    expect(normalized({ id: "i", type: "instance", componentId: "c", instanceScale: { x: 0.5, y: 0.75 } }).instanceScale).toEqual({
      x: 0.5,
      y: 0.75
    });
    expect(normalized({ id: "i", type: "instance", componentId: "c", "instance-scale": { x: 2, y: 2 } }).instanceScale).toEqual({
      x: 2,
      y: 2
    });
    expect(normalized({ id: "i", type: "instance", componentId: "c", instanceScale: { x: 1, y: 1 } }).instanceScale).toBeUndefined();
    expect(normalized({ id: "i", type: "instance", componentId: "c", instanceScale: { x: 0, y: 1 } }).instanceScale).toBeUndefined();
  });

  it("is cleared by Reset, along with the box it produced", () => {
    const master: ComponentElement = { ...darkMaster(), id: "c" };
    const inst = instanceOf("c", { instanceScale: { x: 0.5, y: 0.5 }, width: 200, height: 400 });
    expect(hasAnythingToReset(inst, master), "Reset is offered for a scaled instance").toBe(true);
    const reset = resetInstanceOverrides(inst, master);
    expect(reset.instanceScale).toBeUndefined();
    expect([reset.width, reset.height], "back to the master's box").toEqual([400, 800]);
  });
});

/**
 * The four edges a review found around the factor: the canvas has its own copies
 * of the "which axis may move" rule, and detaching has to hand a scaled subtree
 * over at the size it was painted.
 */
describe("the canvas gesture and detach agree with the model", () => {
  it("lets the Scale tool pull both axes of a hugging instance, and neither of a fill one", () => {
    const hug = instanceOf("cmp/page", { sizing: { width: "fit-content", height: "fit-content" } });
    expect(scalableAxes(hug, null), "both axes are the factor's to write").toEqual({ x: true, y: true });

    const parent = withLayout(
      { id: "row", type: "frame", x: 0, y: 0, width: 400, height: 100, children: [] } as FrameElement,
      { mode: "flex", direction: "row", gap: 8, padding: 0 }
    );
    const filled = instanceOf("cmp/page", { sizing: { width: "fill", height: "fixed" } });
    expect(scalableAxes(filled, parent), "a fill width is the parent's to give").toEqual({ x: false, y: true });
  });

  it("does not cut the instance off from its master when the CANVAS drags it", () => {
    // The gesture path writes no `sizeOverride`, which is what a resize writes.
    // A pinned instance is one `propagateMasterSize` stops updating, so pinning
    // here would freeze this instance at the size its master happened to have.
    const master = darkMaster();
    const instance = instanceOf("cmp/page");
    const scaled = scaleElementsToSize(
      [master, instance],
      new Set(["inst/page"]),
      { width: 200, height: 400 },
      { x: 0, y: 0 }
    );
    const live = relayoutDocumentTree(scaled).find((el) => el.id === "inst/page") as InstanceElement;
    expect(live.sizeOverride, "a scale is not a hand-set box").toBeUndefined();
    expect(live.instanceScale).toEqual({ x: 0.5, y: 0.5 });
  });

  it("detaches a scaled instance at its own proportions, with its children already materialised", () => {
    const master: ComponentElement = withLayout(
      { ...darkMaster(), id: "cmp/page" },
      { mode: "flex", direction: "column", gap: 8, padding: 24 }
    );
    const instance = instanceOf("cmp/page", { instanceScale: { x: 0.5, y: 0.5 }, width: 200, height: 400 });
    const doc = documentOf([master, instance]);

    const { frame } = detachInstance(doc, "inst/page");
    const layout = layoutOf(frame!)!;
    expect([layout.padding, layout.gap], "the recipe the scaled children were laid out by").toEqual([12, 4]);

    // The doc is light and the master says dark, so an unmaterialised child would
    // come back ink-on-light — the same flip, one detach later.
    const headline = (frame!.children || []).find((el) => el.id.endsWith("headline")) as TextElement;
    expect(fillColor(headline), "resolved under the instance's inherited mode").toBe("#F2F0EA");
    expect(headline.style.fontSize, "and at the scaled size").toBe(22);
    expect(frame!.themeMode, "and the frame carries the mode it was resolved under").toBe("dark");
  });

  it("detaches an unscaled instance with the master's recipe untouched", () => {
    const master: ComponentElement = withLayout(
      { ...darkMaster(), id: "cmp/page" },
      { mode: "flex", direction: "column", gap: 8, padding: 24 }
    );
    const doc = documentOf([master, instanceOf("cmp/page")]);
    const { frame } = detachInstance(doc, "inst/page");
    expect([layoutOf(frame!)!.padding, layoutOf(frame!)!.gap]).toEqual([24, 8]);
  });
});

/**
 * A factor is not a measurement.
 *
 * Scaling multiplies every box, so a `max-content` text keeps
 * `master.width × k` — a number nobody measured at that size. On a master with
 * no layout of its own nothing re-measured it either, and the box landed a
 * fraction under the glyphs it has to hold: the line that fitted at 1x broke at
 * 1.14x while the container was still wide enough. The same subtree nested as a
 * component never showed it, because that path resolves through a layout master.
 */
describe("a scaled instance measures its own contents instead of multiplying", () => {
  const textChild = (width: number): TextElement =>
    ({
      id: "headline",
      type: "text",
      name: "headline",
      x: 0,
      y: 0,
      width,
      height: 22,
      content: "Trending now",
      sizing: { width: "max-content", height: "fit-content" },
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: 600, color: "#111111" }
    }) as TextElement;

  const card = (width: number): ComponentElement => ({
    id: "cmp/card",
    type: "component",
    name: "Card",
    x: 0,
    y: 0,
    width: 400,
    height: 80,
    children: [textChild(width)] as DesignElement[]
  });

  const instanceOfCard = (scale: number): InstanceElement => ({
    id: "inst/card",
    type: "instance",
    name: "Card",
    componentId: "cmp/card",
    x: 500,
    y: 0,
    width: Math.round(400 * scale),
    height: Math.round(80 * scale),
    instanceScale: { x: scale, y: scale }
  });

  const resolvedText = (master: ComponentElement, scale: number): TextElement => {
    const inst = instanceOfCard(scale);
    const doc = documentOf([{ ...master, children: master.children }, inst]);
    const resolved = resolveInstanceContent(inst, doc.pages![0].children[0] as ComponentElement, {
      theme: "light",
      tables
    });
    return resolved.children[0] as TextElement;
  };

  it("re-measures a hug text at the scaled font instead of multiplying the stored one", () => {
    // 40 is nowhere near what "Trending now" needs: a `max-content` box is a
    // measurement's result, and a factor applied to a stale number is a box
    // nobody chose.
    const scaled = resolvedText(card(40), 1.5);
    const measured = resolveTextSizing({ ...scaled }, null).width;
    expect(scaled.width, "the resolved box IS the measurement").toBe(measured);
    expect(scaled.width, "and not 40 × 1.5").toBeGreaterThan(60);
  });
});
