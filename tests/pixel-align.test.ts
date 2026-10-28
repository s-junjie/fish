import { describe, it, expect } from "vitest";
import {
  alignFlatToDeviceGrid,
  alignStageToDeviceGrid,
  alignTreeToDeviceGrid
} from "../src/ui/canvas/pixel-align";
import { DesignElement, FrameElement, RectElement, TextElement } from "../src/core/dsl/types";

/**
 * The reported defect: a photo rect and a gradient overlay sharing the edge
 * y=292 inside a phone frame at (328, 57), at the zoom the editor happened to
 * be at. (57 + 292) * 0.8 = 279.2 — mid-pixel, so the two fills antialiased the
 * shared edge a fraction apart and the sky ghosted a one-pixel hairline.
 */
const SEAM_ZOOM = 0.8;

function rect(id: string, x: number, y: number, width: number, height: number): RectElement {
  return { id, type: "rect", x, y, width, height };
}

function frame(id: string, x: number, y: number, children: DesignElement[]): FrameElement {
  return { id, type: "frame", x, y, width: 390, height: 844, children };
}

/** Absolute document coordinates of an element, walking the frame chain. */
function absoluteY(el: DesignElement, parentY: number): number {
  return parentY + el.y;
}

/**
 * Whether a device coordinate landed on a whole pixel. The alignment is exact
 * in the reals; doubles leave ~1e-14 behind, and no rasteriser cares.
 */
function wholePixel(device: number): boolean {
  return Math.abs(device - Math.round(device)) < 1e-9;
}

describe("pixel-align", () => {
  describe("alignTreeToDeviceGrid", () => {
    it("puts a shared edge of two stacked fills on one whole pixel", () => {
      const photo = rect("photo", 0, 292, 390, 552);
      const overlay = rect("overlay", 0, 292, 390, 210);
      const tree = [frame("phone", 328, 57, [photo, overlay])];

      const aligned = alignTreeToDeviceGrid(tree, SEAM_ZOOM);

      const phone = aligned[0] as FrameElement;
      const [aPhoto, aOverlay] = phone.children as RectElement[];
      // Both children describe the same edge, so both must land on the same
      // pixel — and that pixel must be a whole one at this zoom.
      expect(aPhoto.y).toBe(aOverlay.y);
      const edge = absoluteY(aPhoto, phone.y) * SEAM_ZOOM;
      expect(wholePixel(edge)).toBe(true);
      // Half a pixel of movement, no more.
      expect(Math.abs(aPhoto.y - 292)).toBeLessThanOrEqual(0.5 / SEAM_ZOOM);
    });

    it("aligns in absolute space, not per level", () => {
      // 292 inside a frame at 57 is 349 on the page; 349 * 0.8 = 279.2.
      // Snapping the child's local 292 on its own (292 * 0.8 = 233.6 -> 233.75)
      // while the frame snaps to 45 would leave 278.75 — still mid-pixel.
      const tree = [frame("phone", 328, 57, [rect("photo", 0, 292, 390, 552)])];

      const aligned = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      const phone = aligned[0] as FrameElement;
      const photo = phone.children[0] as RectElement;

      const absTop = (phone.y + photo.y) * SEAM_ZOOM;
      const absBottom = (phone.y + photo.y + photo.height) * SEAM_ZOOM;
      expect(wholePixel(absTop)).toBe(true);
      expect(wholePixel(absBottom)).toBe(true);
    });

    it("keeps coincident edges coincident after snapping", () => {
      // A tile grid: four rects edge to edge. Whatever the zoom, neighbours
      // must not open a sub-pixel gap between them.
      const tiles = [
        rect("t1", 0, 0, 100, 100),
        rect("t2", 100, 0, 100, 100),
        rect("t3", 0, 100, 100, 100),
        rect("t4", 100, 100, 100, 100)
      ];
      for (const zoom of [0.37, 0.8, 1.33, 2.5]) {
        const aligned = alignTreeToDeviceGrid(tiles, zoom) as RectElement[];
        const byId = new Map(aligned.map((t) => [t.id, t]));
        const t1 = byId.get("t1")!;
        const t2 = byId.get("t2")!;
        const t3 = byId.get("t3")!;
        expect(t1.x + t1.width).toBe(t2.x);
        expect(t1.y + t1.height).toBe(t3.y);
      }
    });

    it("is the identity at an integer zoom", () => {
      const tree = [frame("phone", 328, 57, [rect("photo", 0, 292, 390, 552)])];
      expect(alignTreeToDeviceGrid(tree, 1)).toBe(tree);
      expect(alignTreeToDeviceGrid(tree, 2)).toBe(tree);
    });

    it("hands back the same array when nothing moved", () => {
      // Integer geometry at a zoom where every edge already lands whole.
      const tree = [frame("phone", 100, 50, [rect("photo", 0, 100, 200, 200)])];
      expect(alignTreeToDeviceGrid(tree, 0.5)).toBe(tree);
    });

    it("returns a stable array for the same inputs", () => {
      const tree = [frame("phone", 328, 57, [rect("photo", 0, 292, 390, 552)])];
      const first = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      const second = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      expect(second).toBe(first);
    });

    it("keeps an untouched sibling's snapped object across a drag commit", () => {
      // A drag replaces the page array and the elements on the path to the one
      // being dragged. Everything else is the same object it was last frame and
      // must come back as the same SNAPPED object — a fresh `{...el, y: 292.5}`
      // fails every node memo even though the element did not move.
      const sibling = rect("sky", 0, 292, 390, 210);
      const commit = (hero: DesignElement): DesignElement[] => [
        frame("phone", 328, 57, [hero, sibling])
      ];

      const first = alignTreeToDeviceGrid(commit(rect("hero", 0, 13, 390, 200)), SEAM_ZOOM);
      const second = alignTreeToDeviceGrid(commit(rect("hero", 0, 53, 390, 200)), SEAM_ZOOM);

      const before = (first[0] as FrameElement).children[1];
      const after = (second[0] as FrameElement).children[1];
      expect(before).not.toBe(sibling);
      expect(after).toBe(before);
    });

    it("re-aligns when the zoom changes", () => {
      const tree = [frame("phone", 328, 57, [rect("photo", 0, 292, 390, 552)])];
      const at08 = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      const at06 = alignTreeToDeviceGrid(tree, 0.6);
      expect(at06).not.toBe(at08);
      const phone = at06[0] as FrameElement;
      const photo = phone.children[0] as RectElement;
      const edge = (phone.y + photo.y) * 0.6;
      expect(wholePixel(edge)).toBe(true);
    });

    it("snaps a text box's position but never its size", () => {
      const text: TextElement = {
        id: "caption",
        type: "text",
        x: 65,
        y: 264,
        width: 260,
        height: 40,
        content: "A field guide to the buildings\nworth a detour.",
        style: { fontFamily: "Avenir Next", fontSize: 12.5, color: "#6e6d66" }
      };
      const tree = [frame("phone", 328, 57, [text])];

      const aligned = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      const phone = aligned[0] as FrameElement;
      const caption = phone.children[0] as TextElement;

      expect(caption.width).toBe(260);
      expect(caption.height).toBe(40);
      expect(wholePixel((phone.y + caption.y) * SEAM_ZOOM)).toBe(true);
    });

    it("leaves instance and component subtrees untouched", () => {
      // A master's children are painted through InstanceNode, which never sees
      // this pass, and `<defs>` reads the same tree — so the children keep
      // their geometry exactly, object for object. The master itself is not
      // exempt: it sits on the canvas like any other element.
      const inner = rect("inner", 10, 10, 50, 50);
      const master = {
        id: "master",
        type: "component",
        x: 13,
        y: 29,
        width: 70,
        height: 70,
        children: [inner]
      } as DesignElement;
      const tree = [frame("phone", 328, 57, [master])];

      const aligned = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      const phone = aligned[0] as FrameElement;
      const aMaster = phone.children[0] as FrameElement;

      // The master moved (13, 29 inside the frame lands mid-pixel at 0.8)...
      expect(aMaster).not.toBe(master);
      expect(aMaster.x).not.toBe(13);
      // ...and its child did not, not even by identity.
      expect(aMaster.children[0]).toBe(inner);
    });

    it("does not walk into a rotated frame's children", () => {
      const inner = rect("inner", 10, 10, 50, 50);
      const rotated = { ...frame("spin", 100, 100, [inner]), rotation: 30 };
      const tree = [rotated];

      const aligned = alignTreeToDeviceGrid(tree, SEAM_ZOOM);
      const spin = aligned[0] as FrameElement;

      expect(spin.children[0]).toBe(inner);
    });
  });

  describe("alignFlatToDeviceGrid", () => {
    it("agrees with the tree alignment on every shared element", () => {
      const photo = rect("photo", 0, 292, 390, 552);
      const overlay = rect("overlay", 0, 292, 390, 210);
      const phone = frame("phone", 328, 57, [photo, overlay]);
      const flat: DesignElement[] = [phone, photo, overlay];

      const alignedTree = alignTreeToDeviceGrid([phone], SEAM_ZOOM);
      const alignedFlat = alignFlatToDeviceGrid(flat, SEAM_ZOOM);

      const treePhone = alignedTree[0] as FrameElement;
      const flatPhone = alignedFlat.find((el) => el.id === "phone") as FrameElement;
      const treePhoto = treePhone.children[0] as RectElement;
      const flatPhoto = alignedFlat.find((el) => el.id === "photo") as RectElement;

      expect(flatPhoto.y).toBe(treePhoto.y);
      expect(flatPhoto.height).toBe(treePhoto.height);
      expect(flatPhone.y).toBe(treePhone.y);
    });

    it("preserves the list's shape and ids", () => {
      const photo = rect("photo", 0, 292, 390, 552);
      const phone = frame("phone", 328, 57, [photo]);
      const flat: DesignElement[] = [phone, photo];

      const aligned = alignFlatToDeviceGrid(flat, SEAM_ZOOM);

      expect(aligned).toHaveLength(2);
      expect(aligned.map((el) => el.id)).toEqual(["phone", "photo"]);
    });

    it("is the identity at an integer zoom", () => {
      const photo = rect("photo", 0, 292, 390, 552);
      const flat: DesignElement[] = [frame("phone", 328, 57, [photo]), photo];
      expect(alignFlatToDeviceGrid(flat, 1)).toBe(flat);
    });

    it("puts every painted edge on a whole pixel", () => {
      const photo = rect("photo", 0, 292, 390, 552);
      const caption: TextElement = {
        id: "caption",
        type: "text",
        x: 45,
        y: 264,
        width: 300,
        height: 22,
        content: "Architecture, curated.",
        style: { fontFamily: "Avenir Next", fontSize: 16, color: "#161614" }
      };
      const phone = frame("phone", 328, 57, [photo, caption]);
      const flat: DesignElement[] = [phone, photo, caption];

      const aligned = alignFlatToDeviceGrid(flat, SEAM_ZOOM);
      const aPhone = aligned.find((el) => el.id === "phone")!;
      const aPhoto = aligned.find((el) => el.id === "photo")!;

      expect(wholePixel((aPhone.y + aPhoto.y) * SEAM_ZOOM)).toBe(true);
      expect(wholePixel((aPhone.y + aPhoto.y + aPhoto.height) * SEAM_ZOOM)).toBe(true);
      expect(wholePixel((aPhone.x + aPhoto.x + aPhoto.width) * SEAM_ZOOM)).toBe(true);
    });

    it("hands the renderer and <defs> the same object for one element", () => {
      // The two halves are what a clip path and the content it clips are built
      // from, so "they agree" has to be a fact about the data, not about two
      // call sites happening to compute the same numbers.
      const photo = rect("photo", 0, 292, 390, 552);
      const phone = frame("phone", 328, 57, [photo]);
      const flat: DesignElement[] = [phone, photo];

      const staged = alignStageToDeviceGrid([phone], flat, SEAM_ZOOM);
      const fromTree = (staged.tree[0] as FrameElement).children.find((el) => el.id === "photo")!;
      const fromFlat = staged.flat.find((el) => el.id === "photo")!;

      expect(fromTree).toBe(fromFlat);
      expect(fromTree).not.toBe(photo);
      expect(fromTree.y).toBe(alignFlatToDeviceGrid(flat, SEAM_ZOOM).find((el) => el.id === "photo")!.y);
    });

    it("leaves both halves untouched at 1:1", () => {
      const photo = rect("photo", 0, 292, 390, 552);
      const phone = frame("phone", 328, 57, [photo]);
      const flat: DesignElement[] = [phone, photo];
      const staged = alignStageToDeviceGrid([phone], flat, 1);
      expect(staged.tree).toEqual([phone]);
      expect(staged.flat).toBe(flat);
    });
  });
});
