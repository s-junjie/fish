import {
  ContainerElement,
  DesignDocument,
  DesignElement,
  HtmlEmbedElement,
  TextElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import { computeParentOrigin, findElementById, isContainer, mapElements } from "../../core/geometry/tree-ops";
import { newTextInkAt } from "../../core/geometry/ink-on";
import { centerInRect } from "../../core/geometry/viewport";
import type { Rect } from "../../core/geometry/bounds";
import { relayoutDocumentTree } from "../../core/compile";
import { layoutOf } from "../../core/dsl/layout-flat";
import { createId } from "../../core/id";
import { DEFAULT_FONT_FAMILY } from "../../core/font-stack";
import { loadImageFromFile, loadImageFromUrl } from "../../core/interactions/image-loader";
import { loadVideoFromFile, loadVideoFromUrl } from "../../core/interactions/video-loader";
import { t } from "../../i18n";

/**
 * The paste that brings a NEW element into the document: an image or video from
 * the clipboard or a URL, an iframe embed, or foreign plain text. Each is the
 * same transaction — decide where it lands, put it in the tree, select it — and
 * only the step that produces the element differs.
 *
 * The in-file clipboard is not here: that is `pasteClipboard` in
 * `useEditorCommands`, which moves nodes the document already has.
 */
export interface PasteMediaContext {
  docRef: { current: DesignDocument };
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  commitSnapshot: (doc: DesignDocument) => void;
  setHintMessage: (msg: string) => void;
  /** The world rect a drop with no container to land in aims at. */
  viewportRect: () => Rect;
  /**
   * The last "copy as PNG", so a paste of that very image can land at the
   * original design size. Owned by the hook — `copySelectionAsPng` writes it and
   * the image paste consumes it — and passed in rather than imported, so the two
   * halves are visibly the same object.
   */
  lastPngCopyRef: { current: { width: number; height: number; scale: number; at: number } | null };
}

/**
 * The container a pasted element lands in: the ONE unlocked container the
 * selection names. Two of them — or none — mean the page root, because a paste
 * that had to choose between two frames would be choosing with the user's
 * element, and a locked container cannot take a child at all.
 *
 * Exported because `useEditorCommands` asks the same question for the HTML-clip
 * branch of `handlePaste`, which lands the payload through a callback rather
 * than through one of these pastes.
 */
export function resolveDropTarget(
  elements: DesignElement[],
  selectedIds: Set<string>
): ContainerElement | null {
  const containers = Array.from(selectedIds)
    .map((id) => findElementById(elements, id))
    .filter((el): el is ContainerElement => Boolean(el && isContainer(el) && !el.locked));
  return containers.length === 1 ? containers[0] : null;
}

/**
 * Where a pasted element of `size` comes to rest. Centred in the viewport when
 * nothing holds it; at the container's own origin when that container lays its
 * children out, since its slot — not a coordinate — is the answer; centred in
 * the container otherwise.
 */
function pasteDropPoint(
  target: ContainerElement | null,
  size: { width: number; height: number },
  viewport: Rect
): { x: number; y: number } {
  const centred = centerInRect(viewport, size);
  if (!target) return centred;
  if (layoutOf(target)) return { x: target.x, y: target.y };
  return {
    x: Math.round(target.x + (target.width - size.width) / 2),
    y: Math.round(target.y + (target.height - size.height) / 2)
  };
}

/** The tree with `element` in it: a child of `target`, or appended to the page. */
function insertPastedElement(
  elements: DesignElement[],
  target: ContainerElement | null,
  element: DesignElement
): DesignElement[] {
  if (!target) return [...elements, element];
  const next = mapElements(elements, (el) =>
    el.id === target.id && isContainer(el)
      ? { ...el, children: [...(el.children || []), element] }
      : el
  );
  // A child added to an auto-layout parent has to take its stack slot now: layout
  // only runs on mutation, so without this it would sit at the dropped
  // coordinate until the next unrelated edit moved it.
  return layoutOf(target) ? relayoutDocumentTree(next) : next;
}

export function createPasteMedia(ctx: PasteMediaContext) {
  const activeEls = () => getActivePage(ctx.docRef.current).children;

  const pasteImageFile = async (file: File) => {
    const activeElements = activeEls();
    const target = resolveDropTarget(activeElements, ctx.selectedIds);
    try {
      // If this pasted image is the one we just copied as PNG (matched by its
      // true pixel size, since the clipboard strips DPI metadata), re-apply the
      // 0.5x so it lands at the original design size instead of the 2x bitmap.
      let density: number | undefined;
      const hint = ctx.lastPngCopyRef.current;
      if (hint && Date.now() - hint.at < 60000) {
        try {
          const bitmap = await createImageBitmap(file);
          if (bitmap.width === hint.width && bitmap.height === hint.height) {
            density = hint.scale;
          }
          bitmap.close();
        } catch {
          // Decode failed — fall through to the normal density detection.
        }
      }
      ctx.lastPngCopyRef.current = null;

      const { asset, element: rawElement } = await loadImageFromFile(file, 0, 0, "Pasted Image", density);
      const element: DesignElement = { ...rawElement, ...pasteDropPoint(target, rawElement, ctx.viewportRect()) };
      const nextDoc = {
        ...updateActivePageElements(ctx.docRef.current, insertPastedElement(activeElements, target, element)),
        assets: [...(ctx.docRef.current.assets || []), asset]
      };
      ctx.commitSnapshot(nextDoc);
      ctx.setSelectedIds(new Set([element.id]));
    } catch (err) {
      console.error("Failed to load pasted image:", err);
    }
  };

  const pasteVideoFile = async (file: File | Blob) => {
    const activeElements = activeEls();
    const target = resolveDropTarget(activeElements, ctx.selectedIds);
    try {
      const { asset, element: rawElement } = await loadVideoFromFile(file, 0, 0);
      const element: DesignElement = { ...rawElement, ...pasteDropPoint(target, rawElement, ctx.viewportRect()) };
      const nextDoc = {
        ...updateActivePageElements(ctx.docRef.current, insertPastedElement(activeElements, target, element)),
        assets: [...(ctx.docRef.current.assets || []), asset]
      };
      ctx.commitSnapshot(nextDoc);
      ctx.setSelectedIds(new Set([element.id]));
    } catch (err) {
      console.error("Failed to load pasted video:", err);
    }
  };

  const pasteImageUrl = async (url: string) => {
    const activeElements = activeEls();
    const target = resolveDropTarget(activeElements, ctx.selectedIds);
    const { asset, element: rawElement } = await loadImageFromUrl(url, 0, 0);
    const element: DesignElement = { ...rawElement, ...pasteDropPoint(target, rawElement, ctx.viewportRect()) };
    const nextDoc = {
      ...updateActivePageElements(ctx.docRef.current, insertPastedElement(activeElements, target, element)),
      assets: [...(ctx.docRef.current.assets || []), asset]
    };
    ctx.commitSnapshot(nextDoc);
    ctx.setSelectedIds(new Set([element.id]));
  };

  const pasteVideoUrl = async (url: string) => {
    const activeElements = activeEls();
    const target = resolveDropTarget(activeElements, ctx.selectedIds);
    const { asset, element: rawElement } = await loadVideoFromUrl(url, 0, 0);
    const element: DesignElement = { ...rawElement, ...pasteDropPoint(target, rawElement, ctx.viewportRect()) };
    const nextDoc = {
      ...updateActivePageElements(ctx.docRef.current, insertPastedElement(activeElements, target, element)),
      assets: [...(ctx.docRef.current.assets || []), asset]
    };
    ctx.commitSnapshot(nextDoc);
    ctx.setSelectedIds(new Set([element.id]));
  };

  const pasteHtmlEmbed = (rawElement: HtmlEmbedElement) => {
    const activeElements = activeEls();
    const target = resolveDropTarget(activeElements, ctx.selectedIds);
    const element: HtmlEmbedElement = { ...rawElement, ...pasteDropPoint(target, rawElement, ctx.viewportRect()) };
    ctx.commitSnapshot(
      updateActivePageElements(ctx.docRef.current, insertPastedElement(activeElements, target, element))
    );
    ctx.setSelectedIds(new Set([element.id]));
    ctx.setHintMessage(t("htmlEmbed.framingNote"));
  };

  const pastePlainText = (text: string) => {
    const activeElements = activeEls();
    const target = resolveDropTarget(activeElements, ctx.selectedIds);

    // The box below is 240×40, so the drop point is that box centred. The
    // hardcoded halves this used to subtract (100, 20) left the text 20px
    // right of centre — the vertical half happened to be right.
    const box = { width: 240, height: 40 };

    // The colour goes into BOTH stores the DSL reads: `fills` is what the
    // canvas and the export paint from, and `style.color` is the field that
    // says the same thing. Writing only the latter left the fill inspector
    // showing an empty stack for text that was visibly black
    // (LESSONS_LEARNED §206).
    const dropPoint = pasteDropPoint(target, box, ctx.viewportRect());
    // `pasteDropPoint` answers in the drop target's PARENT space, and the
    // backdrop walk needs canvas space.
    const targetOrigin = target ? computeParentOrigin(activeElements, target.id) : { x: 0, y: 0 };
    const ink = newTextInkAt(ctx.docRef.current, {
      x: targetOrigin.x + dropPoint.x + box.width / 2,
      y: targetOrigin.y + dropPoint.y + box.height / 2
    });
    const element: TextElement = {
      id: createId("text"),
      type: "text",
      name: "Pasted Text",
      ...dropPoint,
      ...box,
      content: text,
      style: { fontFamily: DEFAULT_FONT_FAMILY, fontSize: 16, color: ink },
      fills: [{ type: "solid", color: ink }]
    };

    ctx.commitSnapshot(
      updateActivePageElements(ctx.docRef.current, insertPastedElement(activeElements, target, element))
    );
    ctx.setSelectedIds(new Set([element.id]));
  };

  return {
    pasteImageFile,
    pasteVideoFile,
    pasteImageUrl,
    pasteVideoUrl,
    pasteHtmlEmbed,
    pastePlainText
  };
}
