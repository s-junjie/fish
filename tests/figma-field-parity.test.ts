/**
 * One document per field whose name the two APIs spell differently.
 *
 * `figma-plugin-export.test.ts` diffs the two doors over a file captured from a
 * real design, which is the right way to hold the invariant — and which is also
 * why it held while four of these were broken: that file has no polygon, no
 * dashed stroke, no independent corner radii, no glass and no image filters, so
 * both doors agreed on all of them by agreeing on nothing.
 *
 * Every node here exists because it is a shape the captured file does not
 * contain, and every assertion is about a value that reaches the document rather
 * than about a gap report. REST-only fields (glass) are stated the way REST
 * would state them; the shim renames its way back.
 */

import { describe, expect, it } from "vitest";
import { importFigmaFile } from "../src/core/import/figma-import";
import { parseFigmaExport } from "../src/core/import/figma-export";
import { resolveDynamicLineHeight } from "../src/core/compile";
import type { FigmaFileResponse } from "../src/core/import/figma-types";
import type { DesignElement } from "../src/core/dsl/types";
import { layoutOf } from "../src/core/dsl/layout-flat";
import { loadCollect } from "./helpers/figma-plugin-runtime";
import { toPluginGroups } from "./helpers/figma-plugin-nodes";

const collect = loadCollect();

const IMAGE_URI = "data:image/png;base64,AAAA";

function file(children: unknown[]): FigmaFileResponse {
  return {
    name: "Shapes",
    lastModified: "2024-01-01T00:00:00Z",
    thumbnailUrl: "",
    version: "1",
    role: "owner",
    editorType: "figma",
    linkAccess: "view",
    document: {
      id: "9:9",
      name: "Shapes",
      type: "DOCUMENT",
      children: [{ id: "9:10", name: "Page 1", type: "CANVAS", children }]
    }
  } as unknown as FigmaFileResponse;
}

/** Both doors, on the same document. */
async function both(children: unknown[]) {
  const images = { "hash-1": IMAGE_URI };
  const rest = await importFigmaFile(file(children), { imageFills: images });
  const groups = toPluginGroups(file(children) as unknown as Record<string, unknown>);
  const parsed = parseFigmaExport(collect.buildExport(groups.groups, { ...groups.meta, images }));
  const plugin = await importFigmaFile(parsed.document, { imageFills: parsed.imageFills });
  return { rest, plugin, elements: rest.pages[0].children };
}

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function byId(elements: DesignElement[], id: string): any {
  let found: any;
  (function walk(list: DesignElement[]): void {
    for (const el of list) {
      if (el.id === id) found = el;
      const children = (el as { children?: DesignElement[] }).children;
      if (children) walk(children);
    }
  })(elements);
  return found;
}

/** Asset ids are minted per import, so they cannot be compared directly. */
const withoutAssetIds = (elements: unknown): unknown =>
  JSON.parse(JSON.stringify(elements, (key, value) => (key === "assetId" ? "<asset>" : value)));

/** A node at the canvas origin, so another node's absolute position is readable. */
const ANCHOR = { id: "0:0", name: "Anchor", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 10, 10), fills: [] };

const dashedStroke = {
  type: "SOLID",
  color: { r: 1, g: 0, b: 0 },
  blendMode: "NORMAL",
  opacity: 1,
  visible: true
};

describe("the fields the two APIs spell differently", () => {
  it("carries four independently set corner radii through both doors", async () => {
    const { rest, plugin, elements } = await both([
      {
        id: "1:1",
        name: "Box",
        type: "RECTANGLE",
        absoluteBoundingBox: box(0, 0, 200, 100),
        cornerRadius: 8,
        rectangleCornerRadii: [8, 0, 24, 40],
        fills: []
      }
    ]);
    // The plugin has four SEPARATE numbers and no `rectangleCornerRadii` at all;
    // reading the array off it found nothing and four set corners imported as
    // the flat `cornerRadius`.
    expect(byId(elements, "1_1").borderRadius).toEqual([8, 0, 24, 40]);
    expect(byId(plugin.pages[0].children, "1_1")).toEqual(byId(rest.pages[0].children, "1_1"));
  });

  it("carries a dashed stroke through both doors", async () => {
    const { rest, plugin, elements } = await both([
      {
        id: "1:2",
        name: "Dashed",
        type: "RECTANGLE",
        absoluteBoundingBox: box(0, 0, 200, 100),
        strokes: [dashedStroke],
        strokeWeight: 2,
        strokeDashes: [6, 4]
      }
    ]);
    // `strokeDashes` is REST's name; the plugin calls the same numbers
    // `dashPattern`, so a dashed stroke was arriving solid and nothing said so.
    expect(byId(elements, "1_2").strokes[0]).toMatchObject({ style: "dashed", dashArray: [6, 4] });
    expect(byId(plugin.pages[0].children, "1_2")).toEqual(byId(rest.pages[0].children, "1_2"));
  });

  it("imports a polygon through both doors", async () => {
    const d = "M 50 0 L 100 35 L 78 100 L 22 100 L 0 35 Z";
    const { rest, plugin, elements } = await both([
      {
        id: "1:3",
        name: "Hex",
        type: "REGULAR_POLYGON",
        absoluteBoundingBox: box(0, 0, 100, 100),
        size: { x: 100, y: 100 },
        fillGeometry: [{ path: d }],
        fills: []
      }
    ]);
    // The plugin spells this node `POLYGON`. It reached the app's switch
    // unmatched, fell through to the unknown-type branch and was dropped with
    // its whole page.
    expect(byId(elements, "1_3")).toMatchObject({ type: "path", d });
    expect(byId(plugin.pages[0].children, "1_3")).toEqual(byId(rest.pages[0].children, "1_3"));
  });

  it("turns a rotated line by its own angle instead of by the bound of its rotation", async () => {
    // 100 long, turned 45°: Figma reports the bound of the ROTATED segment, so
    // dx/dy read off it are the other diagonal at the wrong length.
    //
    // `rotation` is the NEGATIVE of the angle the layer turns through — Figma
    // measures counter-clockwise, the DSL's `rotate()` clockwise — so a line
    // turned 45° clockwise is `-45` on the wire and 45 in the document.
    const half = 100 / Math.SQRT2;
    const { rest, plugin, elements } = await both([
      ANCHOR,
      {
        id: "1:4",
        name: "Ruler",
        type: "LINE",
        absoluteBoundingBox: box(100 - half / 2, 100 - half / 2, half, half),
        size: { x: 100, y: 0 },
        rotation: -45,
        strokes: [dashedStroke],
        strokeWeight: 1
      }
    ]);
    const line = byId(elements, "1_4");
    const anchor = byId(elements, "0_0");
    expect(line).toMatchObject({ type: "line", dx: 100, dy: 0, rotation: 45 });
    // Its own box is centred on the bound it was cut out of, which is what puts
    // the rotation pivot where Figma's is.
    expect(round2(line.x - anchor.x + 50)).toBe(round2(100));
    expect(round2(line.y - anchor.y)).toBe(round2(100));
    expect(withoutAssetIds(byId(plugin.pages[0].children, "1_4"))).toEqual(withoutAssetIds(byId(rest.pages[0].children, "1_4")));
  });

  it("names the line direction only when the response cannot carry it", async () => {
    // No `size`: there is nothing left to read the segment from, and the bound is
    // all there is. Reported, not silently drawn the other way round.
    const half = 100 / Math.SQRT2;
    const { rest } = await both([
      ANCHOR,
      {
        id: "1:5",
        name: "Ruler",
        type: "LINE",
        absoluteBoundingBox: box(0, 0, half, half),
        rotation: -45,
        strokes: [dashedStroke],
        strokeWeight: 1
      }
    ]);
    expect(rest.report.unmapped.some((g) => g.property === "line:direction")).toBe(true);
  });

  it("keeps an image paint's blend mode, opacity and photo filters", async () => {
    const { rest, plugin, elements } = await both([
      {
        id: "1:6",
        name: "Photo",
        type: "RECTANGLE",
        absoluteBoundingBox: box(0, 0, 200, 100),
        fills: [
          {
            type: "IMAGE",
            imageRef: "hash-1",
            scaleMode: "FILL",
            blendMode: "MULTIPLY",
            opacity: 0.5,
            filters: { exposure: 0.5, contrast: -0.25, saturation: 0.5, temperature: 0.2, tint: -0.1, highlights: 0.3, shadows: -0.4 }
          }
        ]
      }
    ]);
    const paint = byId(elements, "1_6").fills[0];
    // The IMAGE branch used to return without the common block, so a picture's
    // own blend mode and opacity were dropped and the adjustment never crossed.
    expect(paint).toMatchObject({ type: "image", blendMode: "multiply", opacity: 0.5 });
    // Figma's ratios are 0..1 where the DSL's rebase from 1 (or from ±1 stops),
    // so a photo at full slider imports at full strength rather than half.
    expect(paint.adjust).toEqual({ exposure: 1, contrast: 0.75, saturation: 1.5, temperature: 0.2, tint: -0.1, highlights: 0.3, shadows: -0.4 });
    expect(withoutAssetIds(byId(plugin.pages[0].children, "1_6"))).toEqual(withoutAssetIds(byId(rest.pages[0].children, "1_6")));
  });

  it("carries Figma's glass effect in as liquid glass", async () => {
    const { rest, plugin, elements } = await both([
      {
        id: "1:7",
        name: "Panel",
        type: "RECTANGLE",
        absoluteBoundingBox: box(0, 0, 200, 100),
        cornerRadius: 24,
        fills: [],
        effects: [{ type: "GLASS", visible: true, radius: 12, depth: 24, refraction: 0.8, dispersion: 0.3, lightAngle: -40, lightIntensity: 0.5 }]
      }
    ]);
    const glass = byId(elements, "1_7").effects[0];
    expect(glass).toMatchObject({
      type: "liquid-glass",
      frost: 12,
      depth: 24,
      refraction: 80,
      dispersion: 30,
      lightAngle: -40,
      lightIntensity: 50
    });
    // `splay` has no plugin-API field yet, so it takes the DSL's own default
    // rather than being written as a made-up zero.
    expect(glass.splay).toBe(20);
    // Named as mapped, not reported as unmapped while being dropped.
    expect(rest.report.unmapped.some((g) => g.property === "effects:GLASS")).toBe(false);
    expect(byId(plugin.pages[0].children, "1_7")).toEqual(byId(rest.pages[0].children, "1_7"));
  });

  it("agrees across both doors on a whole GRID auto-layout frame", async () => {
    // The one field the two APIs genuinely spell differently is per-track sizing:
    // REST has only the CSS string, the plugin only `GridTrackSize[]`. The
    // inverse shim converts the string, so this compares two real representations
    // of the same grid rather than a value against nothing.
    const gridFrame = {
      id: "1:8",
      name: "Grid",
      type: "FRAME",
      layoutMode: "GRID",
      gridColumnCount: 3,
      gridRowCount: 2,
      gridColumnGap: 16,
      gridRowGap: 12,
      paddingTop: 8,
      paddingLeft: 8,
      gridColumnsSizing: "1fr 2fr 120px",
      gridRowsSizing: "60px 1fr",
      absoluteBoundingBox: box(0, 0, 400, 200),
      children: [
        // Flowed first child (anchors omitted = flow): column 0 is 80 wide.
        { id: "1:9", name: "A", type: "RECTANGLE", absoluteBoundingBox: box(8, 8, 80, 60), fills: [] },
        // Second row, second column, spanning the last two columns (160 + gap +
        // 120 = 296), which is what makes the track list observable.
        {
          id: "1:10",
          name: "B",
          type: "RECTANGLE",
          absoluteBoundingBox: box(104, 80, 296, 120),
          gridRowAnchorIndex: 1,
          gridColumnAnchorIndex: 1,
          gridColumnSpan: 2,
          gridRowSpan: 1,
          gridChildHorizontalAlign: "CENTER",
          gridChildVerticalAlign: "CENTER",
          fills: []
        }
      ]
    };
    const { rest, plugin, elements } = await both([gridFrame]);
    const frame = byId(elements, "1_8");
    const layout = layoutOf(frame)!;
    expect(layout.mode).toBe("grid");
    expect(layout.columnGap).toBe(16);
    expect(layout.rowGap).toBe(12);
    expect(layout.padding).toEqual([8, 0, 0, 8]);
    expect(layout.columnSizes).toEqual([{ fr: 1 }, { fr: 2 }, 120]);
    expect(layout.rowSizes).toEqual([60, { fr: 1 }]);
    // A spanning child keeps its 0-based→1-based cell on both doors.
    expect((byId(elements, "1_10") as any)["grid-area"]).toEqual({ row: 2, column: 2, columnSpan: 2 });
    // The declared geometry is the one Figma drew, so the importer reproduces it
    // rather than downgrading the container to its measured boxes.
    expect(rest.report.downgraded).toEqual([]);
    expect(rest.report.maxDelta).toBe(0);
    // The whole frame and its children agree field-for-field across both doors.
    expect(withoutAssetIds(byId(plugin.pages[0].children, "1_8"))).toEqual(withoutAssetIds(byId(rest.pages[0].children, "1_8")));
    expect(plugin.report.unmapped).toEqual(rest.report.unmapped);
  });

  it("agrees across both doors on every one of them at once", async () => {
    const nodes = [
      { id: "2:1", name: "Box", type: "RECTANGLE", absoluteBoundingBox: box(0, 0, 200, 100), cornerRadius: 8, rectangleCornerRadii: [8, 0, 24, 40], strokes: [dashedStroke], strokeWeight: 2, strokeDashes: [6, 4], fills: [] },
      { id: "2:2", name: "Hex", type: "REGULAR_POLYGON", absoluteBoundingBox: box(210, 0, 100, 100), size: { x: 100, y: 100 }, fillGeometry: [{ path: "M 50 0 L 100 35 L 78 100 L 22 100 L 0 35 Z" }], fills: [] },
      { id: "2:3", name: "Ruler", type: "LINE", absoluteBoundingBox: box(320, 0, 70.71, 70.71), size: { x: 100, y: 0 }, rotation: -45, strokes: [dashedStroke], strokeWeight: 1 },
      {
        id: "2:4",
        name: "Photo",
        type: "RECTANGLE",
        absoluteBoundingBox: box(400, 0, 200, 100),
        fills: [{ type: "IMAGE", imageRef: "hash-1", scaleMode: "FILL", blendMode: "SCREEN", filters: { saturation: 0.5 } }]
      }
    ];
    const { rest, plugin } = await both(nodes);
    expect(withoutAssetIds(plugin.pages[0].children)).toEqual(withoutAssetIds(rest.pages[0].children));
    expect(plugin.report.unmapped).toEqual(rest.report.unmapped);
  });

  it("agrees on a truncated text node, which no fixture used to cover", async () => {
    // Neither door's fixture had a TEXT node at all, so the two agreed about
    // truncation and percentage line heights by agreeing on nothing — while the
    // plugin door was dropping both: the shim carries `textTruncation` where the
    // plugin API keeps it (on the node) and `lineHeightPercent` instead of px.
    const { rest, plugin, elements } = await both([
      {
        id: "3:1",
        name: "Label",
        type: "TEXT",
        absoluteBoundingBox: box(0, 0, 200, 40),
        characters: "A long label that Figma cuts",
        textAutoResize: "TRUNCATE",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 20, lineHeightPercent: 150, maxLines: 2, textTruncation: "ENDING" },
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: true }]
      },
      {
        id: "3:2",
        name: "By px",
        type: "TEXT",
        absoluteBoundingBox: box(0, 60, 200, 40),
        characters: "Px line height",
        style: { fontFamily: "Inter", fontWeight: 400, fontSize: 20, lineHeightPx: 30 },
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: true }]
      }
    ]);
    // The unit is preserved: `PERCENT` is a share of the size, so it stays a
    // multiplier (`150%` → `1.5`) and keeps following a later font-size change,
    // while `PIXELS` stays an absolute `"30px"`.
    expect(byId(elements, "3_1").style).toMatchObject({ lineHeight: 1.5, maxLines: 2, textOverflow: "ellipsis" });
    expect(byId(elements, "3_2").style).toMatchObject({ lineHeight: "30px" });
    // The two spellings resolve to the same 20px line box; only the unit differs.
    expect(resolveDynamicLineHeight(20, byId(elements, "3_1").style.lineHeight)).toBe(
      resolveDynamicLineHeight(20, byId(elements, "3_2").style.lineHeight)
    );
    expect(plugin.report.unmapped).toEqual(rest.report.unmapped);
    expect(withoutAssetIds(plugin.pages[0].children)).toEqual(withoutAssetIds(rest.pages[0].children));
  });

  it("agrees on a turned frame, its children and a two-stroke layer", async () => {
    const { rest, plugin, elements } = await both([
      {
        id: "4:1",
        name: "Turned",
        type: "FRAME",
        // 200×100 turned 90°: the bound is 100×200, so the frame's own size can
        // only come from `size` and its children's only from their transforms.
        // `-90` is that same turn on the wire: Figma measures counter-clockwise,
        // the DSL clockwise, so the two are each other's negative.
        absoluteBoundingBox: box(100, 0, 100, 200),
        size: { x: 200, y: 100 },
        rotation: -90,
        fills: [],
        children: [
          {
            id: "4:2",
            name: "Rings",
            type: "RECTANGLE",
            absoluteBoundingBox: box(120, 20, 30, 20),
            size: { x: 20, y: 30 },
            relativeTransform: [
              [0, -1, 10],
              [1, 0, 20],
              [0, 0, 1]
            ],
            strokes: [
              { type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true },
              { type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: true }
            ],
            strokeWeight: 2,
            fills: []
          }
        ]
      }
    ]);
    const frame = byId(elements, "4_1");
    expect(frame).toMatchObject({ width: 200, height: 100, rotation: 90 });
    const child = byId(elements, "4_2");
    expect(child.strokes).toHaveLength(2);
    expect(child).toMatchObject({ x: -15, y: 15, width: 20, height: 30, rotation: 90 });
    expect(withoutAssetIds(plugin.pages[0].children)).toEqual(withoutAssetIds(rest.pages[0].children));
    expect(plugin.report.unmapped).toEqual(rest.report.unmapped);
  });
});

const round2 = (n: number): number => Math.round(n * 100) / 100;