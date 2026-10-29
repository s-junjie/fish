import { useEffect, useRef } from "preact/hooks";
import {
  ComponentElement,
  ContainerElement,
  DesignDocument,
  DesignElement,
  HtmlEmbedElement,
  InstanceElement,
  TextElement,
  getActivePage,
  updateActivePageElements
} from "../../core/dsl/types";
import {
  computeParentOrigin,
  findElementById,
  findParentById,
  flattenElements,
  isContainer,
  mapElements,
  selectableSiblingIds
} from "../../core/geometry/tree-ops";
import { elementAABB } from "../../core/geometry/element-bounds";
import type { Rect } from "../../core/geometry/bounds";
import { editableIds } from "../../core/geometry/lock";
import { relayoutDocumentTree } from "../../core/compile";
import { layoutOf } from "../../core/dsl/layout-flat";
import { createId } from "../../core/id";
import { isImageUrl } from "../../core/interactions/image-loader";
import { isVideoUrl, isVideoFile } from "../../core/interactions/video-loader";
import { loadHtmlFromEmbedCode, loadHtmlFromUrl, parseEmbedCode } from "../../core/interactions/html-embed-loader";
import { isFrameableUrl } from "../../core/dsl/html-source";
import { isFigmaExportText } from "../../core/import/figma-export";
import { isHtmlClipText } from "../../core/import/html-clip";
import { createComponentFromElement, detachInstance } from "../../core/interactions/component-ops";
import { canCreateComponentHere } from "../../core/interactions/component-inventory";
import { overrideDerivedNodes } from "../../core/interactions/instance-overrides";
import { isStoredNode, hasStoredSelection } from "../../core/interactions/instance-resolve";
import {
  applyCopiedStyleTo,
  copyStyleFrom,
  pasteStyleTargets,
  styleClipboard
} from "../../core/interactions/style-clipboard";
import { holdMaster, releaseMaster } from "../../core/interactions/detached-masters";
import {
  collectCopySources,
  collectTopMostSelected,
  idsAvailable,
  insertClones,
  insertClonesAtRoot,
  insertClonesIntoContainer,
  insertVerbatim,
  offsetCenteringSourcesIn,
  removeElementsWithRelayout,
  resolvePastePlacement,
  translateTreeInPlace
} from "../../core/interactions/clipboard";
import {
  buildClipboardPayload,
  parseClipboardPayload
} from "../../core/interactions/clipboard-payload";
import {
  pasteFragmentIntoDoc,
  remintFragment
} from "../../core/interactions/clipboard-fragment";
import { parseDslClipboardText } from "../../core/interactions/clipboard-dsl";
import {
  describeImportRefusal,
  refuseClipboardText,
  refuseElementTree
} from "../../core/import/import-limits";
import { registerEditorCommand } from "../commands/editor-commands";
import { exportCanvasAsBlob, withPngDensity } from "../../core/export";
import { exportBounds } from "../inspector/export-bounds";
import { refuseDerivedEdit as refuseDerivedSelection } from "./selection-guards";
import { t } from "../../i18n";
import { createPasteMedia, resolveDropTarget } from "./paste-media";

/**
 * The in-file clipboard.
 *
 * `cut` is the whole difference between the two pastes, and it is not a detail:
 * a copy mints fresh ids, a cut has to keep them. A main component is addressed
 * by id from anywhere in the file, so a cut that re-minted its id would leave
 * every instance in the document naming a master that no longer exists — the
 * exact breakage the cut gesture is supposed to avoid.
 *
 * `origins` records where each source sat on the canvas when it was cut, because
 * a source's own `x` / `y` are parent-relative and mean nothing once the source
 * is out of its parent and back at the page root.
 */
interface FileClipboard {
  elements: DesignElement[];
  cut: boolean;
  origins: Map<string, { x: number; y: number }>;
}

/** What a source already at canvas coordinates owes its parent: nothing. */
const ZERO_ORIGIN = { x: 0, y: 0 };

interface UseEditorCommandsOptions {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  /** Announces a refused edit. */
  setHintMessage?: (msg: string) => void;
  /**
   * Signals the span of a "copy as PNG" export: true while the selection is
   * rasterizing, false once the clipboard write settles either way. The export
   * can take seconds on a large selection — without the signal the only
   * feedback is the cursor doing nothing.
   */
  onPngCopyProgress?: (busy: boolean) => void;
  /**
   * The world rect the user can see, for the drop point of a paste with no
   * container to land in. A function rather than a zoom and a pan, because the
   * box that matters is the unobstructed canvas — the part no panel covers —
   * and only the viewport hook can measure that.
   */
  visibleWorldRect?: () => Rect;
  /** The live canvas element, the raster source for "copy as PNG". */
  canvasContainerRef: { current: HTMLDivElement | null };
  /**
   * Lands a FISH Figma export that arrived on the clipboard.
   *
   * Text rather than a `File`, because that is what a paste is; wrapping it is
   * the caller's job, so this hook never learns how an import is packaged.
   */
  onImportFigmaExport?: (text: string) => Promise<void> | void;
  /** Lands an HTML clip payload copied from the FISH Chrome extension or tools. */
  onImportHtmlClip?: (
    text: string,
    placement?: {
      viewport?: { x: number; y: number; width: number; height: number };
      containerId?: string | null;
    }
  ) => Promise<void> | void;
}

/**
 * Every command that changes the document through the clipboard or the selection:
 * copy, cut, paste, duplicate, delete, copy/paste properties, create component and
 * detach instance.
 *
 * They live together because they are one subsystem — one undo boundary each, one
 * clipboard, one "editable part of the selection" rule — and because they have two
 * entry points (the keyboard and the context menu) that must not drift. Each is
 * registered in the command registry, which is what lets the menu AND the keyboard
 * handler in `useShortcuts` reach them by name: neither holds a second
 * implementation, and a shortcut that is disabled (an empty selection, a locked
 * layer) is a no-op in both places for the same reason.
 */
export function useEditorCommands({
  selectedIds,
  setSelectedIds,
  primarySelected,
  docRef,
  commitSnapshot,
  setHintMessage = () => {},
  onPngCopyProgress,
  visibleWorldRect,
  canvasContainerRef,
  onImportFigmaExport,
  onImportHtmlClip
}: UseEditorCommandsOptions) {
  const clipboardRef = useRef<FileClipboard>({ elements: [], cut: false, origins: new Map() });
  // Marks the most recent copy made in this file. A pasted payload whose clipId
  // matches means same-file, so the in-memory clipboard — which keeps
  // component/instance links the system payload had to flatten — wins.
  const lastCopyId = useRef<string | null>(null);
  // Smart duplicate: remembers the last clone so a repeated Cmd+D re-applies
  // the offset the user dialled in by moving the previous copy.
  const duplicateRef = useRef<{ cloneId: string; anchor: { x: number; y: number }; delta: { x: number; y: number } } | null>(null);
  // Remembers the last "copy as PNG" so a paste of that very image can land at
  // the original design size. We cannot trust the OS clipboard to carry DPI
  // metadata (macOS/Chromium re-encode PNGs and drop the pHYs chunk), so we
  // match by the image's true pixel dimensions instead. `at` bounds how long
  // the hint stays trustworthy: any other copy replaces the clipboard, so an
  // old hint that happens to share dimensions with an unrelated image would
  // otherwise mis-fire.
  const lastPngCopyRef = useRef<{ width: number; height: number; scale: number; at: number } | null>(null);
  // One export at a time: a second ⇧⌘C fired while the first is still
  // rasterizing would race it for the same clipboard write and show two
  // progress spinners for one image.
  const pngCopyInFlightRef = useRef(false);

  /**
   * The selection as of THIS render, for the command registry's availability
   * predicates. Those are read while a context menu renders — the same commit in
   * which a right-click changes the selection — whereas the effect that registers
   * them only runs after that commit. A predicate closing over `selectedIds` would
   * therefore answer for the selection the user just left: a right-click onto a
   * locked layer showed Cut and Delete as available because the previous
   * selection was editable. The `run` side needs no such treatment: a click
   * happens a commit later, by which time the effect has re-registered.
   */
  const liveSelection = useRef({ ids: selectedIds, primary: primarySelected });
  liveSelection.current = { ids: selectedIds, primary: primarySelected };

  useEffect(() => {
    const activeEls = () => getActivePage(docRef.current).children;
    /** The tree walk, for a command that only ever writes stored nodes — Duplicate. */
    const collectSources = () => collectTopMostSelected(activeEls(), selectedIds);
    /**
     * The units Copy carries — the same walk, plus a resolved clone for every
     * selected layer that lives inside an instance. See `collectCopySources`.
     */
    const collectCopyUnits = () => collectCopySources(docRef.current, activeEls(), selectedIds);

    const refuseDerivedEdit = () => refuseDerivedSelection(docRef.current, selectedIds, setHintMessage);

    // A clone landing in an auto-layout parent must take its stack slot now,
    // not on the next unrelated mutation (layout only runs on mutation).
    const relayoutParents = (elements: DesignElement[], pastedIds: string[]): DesignElement[] => {
      const hasLayoutParent = pastedIds.some((id) => {
        const parent = findParentById(elements, id);
        return Boolean(parent && layoutOf(parent));
      });
      if (!hasLayoutParent) return elements;
      return relayoutDocumentTree(elements);
    };

    const deleteSelection = () => {
      if (selectedIds.size === 0) return;
      // A node inside an instance is not the document's to delete — it is the
      // master's, and every other instance still shows it. Delete does the one
      // thing that is expressible: hide it here, as an override.
      const hidden = overrideDerivedNodes(docRef.current, selectedIds, (el) => ({
        ...el,
        visible: false
      }));
      const hiddenIds = new Set(hidden?.applied ?? []);
      const rest = new Set([...selectedIds].filter((id) => !hiddenIds.has(id)));
      const base = hidden ? hidden.doc : docRef.current;
      if (rest.size === 0) {
        if (!hidden) {
          // Nothing left to hide and nothing to delete: the selection is made
          // of instance internals that are already in the state Delete would
          // put them in. Staying quiet is the point — "you cannot delete this"
          // is the warning this replaced.
          return;
        }
        commitSnapshot(base);
        setSelectedIds(new Set());
        duplicateRef.current = null;
        return;
      }
      if (refuseDerivedEdit()) return;
      const ids = editableIds(getActivePage(base).children, rest);
      if (ids.size === 0) return;
      holdRemovedMasters(base, ids);
      commitSnapshot(
        updateActivePageElements(base, removeElementsWithRelayout(getActivePage(base).children, ids))
      );
      setSelectedIds(new Set());
      duplicateRef.current = null;
    };

    /**
     * Taking a main component out of the document is the one edit that can empty
     * every instance of it, since an instance has no children of its own. So the
     * definition is held in memory for the session (the renderer falls back to it)
     * and the user is told how many instances were affected — a cut heals on
     * paste, and a delete stays visible rather than quietly blanking layers.
     */
    const holdRemovedMasters = (base: DesignDocument, ids: Set<string>) => {
      const elements = getActivePage(base).children;
      const flat = flattenElements(elements);
      let orphans = 0;
      // A set counts its members. Deleting the node takes every variant in it with
      // it, and each is a definition some instance resolves against — so a delete
      // that only looked at the ids it was handed would blank those instances with
      // neither the fallback nor the warning that makes a real delete visible.
      const definitionsOf = (id: string): ComponentElement[] => {
        const el = findElementById(elements, id);
        if (el?.type === "component") return [el];
        if (el?.type === "componentSet") {
          return (el.children || []).filter((c) => c.type === "component") as ComponentElement[];
        }
        return [];
      };
      for (const id of ids) {
        for (const comp of definitionsOf(id)) {
          orphans += flat.filter(
            (other) => other.type === "instance" && (other as InstanceElement).componentId === comp.id
          ).length;
          if (orphans > 0) holdMaster(comp);
        }
      }
      if (orphans > 0) setHintMessage?.(t("component.masterRemoved", { n: orphans }));
    };

    // The world rect a paste with no container to land in aims for. Every paste
    // path derives its drop point from this one expression so an image, a
    // pasted subtree and a dropped text all arrive in the same spot. The view
    // supplies it; a caller with no canvas wired up (a headless test) gets the
    // window at 1:1 rather than a crash.
    const viewportRect = (): Rect =>
      visibleWorldRect?.() ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

    const mediaPaste = createPasteMedia({
      docRef,
      selectedIds,
      setSelectedIds,
      commitSnapshot,
      setHintMessage,
      viewportRect,
      lastPngCopyRef
    });

    const pasteClipboard = () => {
      const { elements: sources, cut, origins } = clipboardRef.current;
      if (sources.length === 0) return;

      const active = activeEls();
      const placement = resolvePastePlacement(active, sources, selectedIds);

      // A cut comes back under its own ids, so a main component pasted back
      // re-links every instance still pointing at it. A second paste of the same
      // cut finds the ids taken and falls through to the copy path, which is what
      // a repeat paste has to do anyway.
      if (cut && idsAvailable(active, sources)) {
        // Each source returns to the canvas spot it was cut from, which is a
        // per-source delta: a selection can span two frames sitting at different
        // offsets, and their local origins mean different things.
        const placed = sources.map((s) => {
          const origin = origins.get(s.id);
          if (!origin) return s;
          const copy = { ...s };
          translateTreeInPlace(copy, origin.x - s.x, origin.y - s.y);
          return copy;
        });
        const target = placement.kind === "into" ? placement.containerIds[0] ?? null : null;
        const moved = insertVerbatim(active, placed, target);
        // The document answers for these ids again, so the held copy is dead weight.
        for (const id of moved.ids) releaseMaster(id);
        commitSnapshot(updateActivePageElements(docRef.current, relayoutParents(moved.elements, moved.ids)));
        setSelectedIds(new Set(moved.ids));
        duplicateRef.current = null;
        return;
      }

      let nextElements: DesignElement[];
      let newIds: string[];

      if (placement.kind === "into") {
        let currentTree = active;
        const allNewIds: string[] = [];
        for (const containerId of placement.containerIds) {
          const result = insertClonesIntoContainer(currentTree, sources, containerId, { viewport: viewportRect() });
          currentTree = result.elements;
          allNewIds.push(...result.newIds);
        }
        nextElements = currentTree;
        newIds = allNewIds;
      } else if (placement.kind === "onto-canvas") {
        const result = insertClonesAtRoot(active, sources, offsetCenteringSourcesIn(sources, viewportRect()));
        nextElements = result.elements;
        newIds = result.newIds;
      } else {
        const firstSrc = sources[0];
        const existing = findElementById(active, firstSrc.id);
        const offset = existing ? { x: 20, y: 20 } : { x: 0, y: 0 };
        const result = insertClones(active, sources, offset);
        nextElements = result.elements;
        newIds = result.newIds;
      }

      commitSnapshot(updateActivePageElements(docRef.current, relayoutParents(nextElements, newIds)));
      setSelectedIds(new Set(newIds));
      duplicateRef.current = null;
    };

    // The single paste entry: images from any app, cross-file FISH payloads, a
    // Figma export copied in the plugin, iframe embed snippets, webpage URLs,
    // foreign plain text, and the in-memory clipboard as the same-file fallback.
    // Cmd+V is deliberately NOT intercepted in the keydown handler — a
    // preventDefault there would suppress this event entirely (the old bug
    // that made image pasting unreachable).
    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) {
        return;
      }

      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
            const file = item.getAsFile();
            if (file) {
              e.preventDefault();
              e.stopPropagation();
              if (isVideoFile(file)) {
                await mediaPaste.pasteVideoFile(file);
              } else {
                await mediaPaste.pasteImageFile(file);
              }
              return;
            }
          }
        }
      }

      const text = e.clipboardData?.getData?.("text/plain") ?? "";
      const trimmed = text.trim();

      // Refused before anything reads it. Every branch below parses the whole
      // string — `JSON.parse` for ours and Figma's, the DOM for a foreign clip —
      // and that work is synchronous: past this budget the tab stops responding
      // with no cancel and nothing to point at.
      const oversize = refuseClipboardText(text);
      if (oversize) {
        e.preventDefault();
        e.stopPropagation();
        setHintMessage(describeImportRefusal(oversize));
        return;
      }

      const payload = parseClipboardPayload(text);
      if (payload) {
        e.preventDefault();
        e.stopPropagation();
        // Depth and layer count are checked on the parsed tree as well: a string
        // can be a legal size and still nest deeper than any recursive walk here
        // can take.
        const overTree = refuseElementTree(payload.elements);
        if (overTree) {
          setHintMessage(describeImportRefusal(overTree));
          return;
        }
        if (payload.clipId === lastCopyId.current && clipboardRef.current.elements.length > 0) {
          pasteClipboard();
          return;
        }
        const current = docRef.current;
        const fragment = remintFragment(current, payload);
        const { doc: nextDoc, newIds, carriedMasters } = pasteFragmentIntoDoc(
          current,
          fragment,
          Array.from(selectedIds),
          { viewport: viewportRect() }
        );
        commitSnapshot(nextDoc);
        setSelectedIds(new Set(newIds));
        duplicateRef.current = null;
        if (carriedMasters > 0) {
          setHintMessage(t("clipboard.importedMasters", { n: carriedMasters }));
        }
        return;
      }

      // Foreign text that is a valid FISH DSL JSON (DesignDocument, DesignElement[], or single DesignElement)
      const dslClip = parseDslClipboardText(text);
      if (dslClip) {
        e.preventDefault();
        e.stopPropagation();
        // Same budget as a `fish-clipboard@2` payload: this door is reachable from
        // any text editor, so the string can be assembled by hand.
        const overTree = refuseElementTree(dslClip.elements);
        if (overTree) {
          setHintMessage(describeImportRefusal(overTree));
          return;
        }
        const current = docRef.current;
        const payload = {
          tag: "fish-clipboard@2",
          clipId: dslClip.clipId,
          elements: dslClip.elements,
          masters: (dslClip.masters || []) as any[],
          assets: (dslClip.assets || []).map((a) => ({ ...a })),
          styles: (dslClip.styles || []).map((s) => ({ ...s }))
        };
        const fragment = remintFragment(current, payload);
        const { doc: nextDoc, newIds, carriedMasters } = pasteFragmentIntoDoc(
          current,
          fragment,
          Array.from(selectedIds),
          { viewport: viewportRect() }
        );
        commitSnapshot(nextDoc);
        setSelectedIds(new Set(newIds));
        duplicateRef.current = null;
        if (carriedMasters > 0) {
          setHintMessage(t("clipboard.importedMasters", { n: carriedMasters }));
        }
        return;
      }

      // A FISH Figma export, copied in the plugin rather than saved as a file.
      // The clipboard carries the single-file envelope — the same JSON the
      // picker reads — so a paste takes the SAME door as a dropped zip, with no
      // second importer to drift from the first.
      if (isFigmaExportText(text)) {
        e.preventDefault();
        e.stopPropagation();
        await onImportFigmaExport?.(text);
        return;
      }

      // An iframe embed snippet (e.g. from YouTube, Figma, CodeSandbox)
      const embed = parseEmbedCode(trimmed);
      if (embed) {
        e.preventDefault();
        e.stopPropagation();
        try {
          mediaPaste.pasteHtmlEmbed(loadHtmlFromEmbedCode(trimmed, 0, 0));
          return;
        } catch (err) {
          console.warn("Failed to parse iframe embed code:", err);
        }
      }

      const activeElsList = getActivePage(docRef.current).children;
      const targetContainer = resolveDropTarget(activeElsList, selectedIds);

      // An HTML clip copied from the FISH Chrome extension, devtools, or web markup
      if (isHtmlClipText(text)) {
        e.preventDefault();
        e.stopPropagation();
        await onImportHtmlClip?.(text, {
          viewport: viewportRect(),
          containerId: targetContainer ? targetContainer.id : null
        });
        return;
      }

      const htmlData = e.clipboardData?.getData?.("text/html");
      if (htmlData && isHtmlClipText(htmlData)) {
        e.preventDefault();
        e.stopPropagation();
        await onImportHtmlClip?.(htmlData, {
          viewport: viewportRect(),
          containerId: targetContainer ? targetContainer.id : null
        });
        return;
      }

      // Direct URL pasting: videos, images, or frameable HTML web pages
      if (trimmed) {
        if (isVideoUrl(trimmed)) {
          e.preventDefault();
          e.stopPropagation();
          try {
            await mediaPaste.pasteVideoUrl(trimmed);
            return;
          } catch {
            // fall back
          }
        }
        if (isImageUrl(trimmed)) {
          e.preventDefault();
          e.stopPropagation();
          try {
            await mediaPaste.pasteImageUrl(trimmed);
            return;
          } catch {
            // fall back
          }
        }
        if (isFrameableUrl(trimmed)) {
          e.preventDefault();
          e.stopPropagation();
          try {
            mediaPaste.pasteHtmlEmbed(loadHtmlFromUrl(trimmed, 0, 0));
            return;
          } catch {
            // fall back
          }
        }
      }

      // In-memory clipboard fallback: applies when system clipboard has no text
      // or matches the internal copy that was not written out
      if (clipboardRef.current.elements.length > 0 && !trimmed) {
        e.preventDefault();
        e.stopPropagation();
        pasteClipboard();
        return;
      }

      if (trimmed) {
        e.preventDefault();
        e.stopPropagation();
        mediaPaste.pastePlainText(text);
      }
    };

    const copySelection = async (remove: boolean) => {
      const sources = collectCopyUnits();
      if (sources.length === 0) return;
      // Where each source is on the canvas right now. Only a cut needs it (the
      // source is about to lose its parent, and with it the meaning of its own
      // local x/y), but recording it unconditionally keeps the two paths reading
      // the same shape.
      const elements = activeEls();
      const origins = new Map<string, { x: number; y: number }>();
      for (const src of sources) {
        // A stored node sits at its parent's origin plus its own x/y. A resolved
        // clone was already re-based to the position it is PAINTED at, so its own
        // x/y IS the canvas position there and an origin would count it twice.
        const parent = isStoredNode(docRef.current, src.id) ? computeParentOrigin(elements, src.id) : ZERO_ORIGIN;
        origins.set(src.id, { x: src.x + parent.x, y: src.y + parent.y });
      }
      clipboardRef.current = { elements: sources, cut: remove, origins };
      const clipId = createId("clip");
      lastCopyId.current = clipId;
      try {
        await navigator.clipboard?.writeText(buildClipboardPayload(docRef.current, sources, clipId));
      } catch {
        // system clipboard unavailable — the in-memory clipboard still covers this file
      }
      if (remove) deleteSelection();
    };

    /**
     * "Copy as PNG": the selection, rasterized to a bitmap and written to the
     * system clipboard as an image.
     *
     * Same export the Export panel runs for a selection — `allowedElementIds`
     * keeps just the selected subtrees and `bounds` crops to their union — so
     * what lands on the clipboard is exactly what the download would have been.
     * A selection is exempt from canvas culling, so the live SVG always holds
     * every selected node and no off-screen mirror is needed.
     *
     * The units come from the same resolver Copy uses, so a layer inside an
     * instance is offered the command for real rather than greyed: `bounds` is
     * measured by id and the clone's own coordinates never enter the crop.
     */
    const copySelectionAsPng = async (scale = 2) => {
      if (pngCopyInFlightRef.current) return;
      const ids = liveSelection.current.ids;
      if (ids.size === 0) return;
      const container = canvasContainerRef.current;
      if (!container) return;

      const sources = collectCopySources(docRef.current, activeEls(), ids);
      if (sources.length === 0) return;

      const allowedIds = new Set<string>();
      for (const el of sources) {
        for (const descendant of flattenElements([el])) allowedIds.add(descendant.id);
      }
      const bounds = exportBounds(docRef.current, sources);

      pngCopyInFlightRef.current = true;
      onPngCopyProgress?.(true);
      try {
        const rawBlob = await exportCanvasAsBlob(docRef.current, container, {
          scale,
          bounds,
          allowedElementIds: allowedIds
        });
        // Stamp the export scale into the PNG's DPI so apps that honour it
        // (and file-based paste) divide by it. The live paste path cannot rely
        // on this surviving the clipboard round-trip, so we also remember the
        // true pixel size below.
        const blob = await withPngDensity(rawBlob, scale);

        // Remember the image's exact pixel dimensions so the matching paste can
        // re-apply the 0.5x (a 2x copy lands at the original design size).
        lastPngCopyRef.current = {
          width: Math.max(1, Math.round(bounds.width * scale)),
          height: Math.max(1, Math.round(bounds.height * scale)),
          scale,
          at: Date.now()
        };

        if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
          setHintMessage(t("clipboard.copyImageUnsupported"));
          return;
        }
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        setHintMessage(t("clipboard.copyImageDone"));
      } catch (err) {
        console.error("Copy as PNG failed", err);
        setHintMessage(t("clipboard.copyImageFailed"));
      } finally {
        pngCopyInFlightRef.current = false;
        onPngCopyProgress?.(false);
      }
    };

    const duplicateSelection = () => {
      const sources = collectSources();
      if (sources.length === 0) return;

      let offset = { x: 0, y: 0 };
      const prev = duplicateRef.current;
      if (prev && sources.length === 1 && sources[0].id === prev.cloneId) {
        const box = elementAABB(sources[0]);
        const moved = { x: box.x - prev.anchor.x, y: box.y - prev.anchor.y };
        offset = moved.x !== 0 || moved.y !== 0 ? moved : prev.delta;
      }

      const { elements, newIds } = insertClones(activeEls(), sources, offset);
      const laidOut = relayoutParents(elements, newIds);
      commitSnapshot(updateActivePageElements(docRef.current, laidOut));
      setSelectedIds(new Set(newIds));

      duplicateRef.current =
        newIds.length === 1
          ? (() => {
              const created = findElementById(laidOut, newIds[0]);
              if (!created) return null;
              const box = elementAABB(created);
              return {
                cloneId: created.id,
                anchor: { x: box.x, y: box.y },
                delta: offset
              };
            })()
          : null;
    };

    /**
     * Figma's "copy / paste properties" (`Cmd+Alt+C` / `Cmd+Alt+V`): the paint,
     * not the layer. One source feeds the clipboard, and every target in the
     * selection receives it — including a layer only the canvas paints inside an
     * instance, whose share of the payload lands as overrides on its instance.
     * `applyCopiedStyleTo` carries the whole transaction; see it for the split.
     */
    const copyStyleSelection = () => {
      const copied = copyStyleFrom(primarySelected);
      if (!copied) {
        setHintMessage(t("styleClipboard.nothingToCopy"));
        return;
      }
      styleClipboard.write(copied);
    };

    const pasteStyleSelection = () => {
      const copied = styleClipboard.read();
      if (!copied) {
        setHintMessage(t("styleClipboard.nothingToPaste"));
        return;
      }
      const next = applyCopiedStyleTo(docRef.current, activeEls(), selectedIds, copied);
      if (next) commitSnapshot(next);
    };

    /**
     * The component pair, lifted out of the two shortcut branches below so the
     * context menu drives exactly the same transaction and the same hints.
     */
    const createComponentFromSelection = () => {
      if (!primarySelected) return;
      if (!canCreateComponentHere(getActivePage(docRef.current).children, primarySelected)) {
        // The tree refuses a definition inside another definition; the command
        // says so rather than looking broken.
        setHintMessage(t("component.nestedMaster"));
        return;
      }
      const { doc: nextDoc, component, hoisted } = createComponentFromElement(docRef.current, primarySelected.id);
      if (!component) return;
      commitSnapshot(nextDoc);
      setSelectedIds(new Set([component.id]));
      if (hoisted.length > 0) setHintMessage(t("component.hoistedMaster"));
    };

    const detachSelectionInstance = () => {
      if (primarySelected?.type !== "instance") return;
      const { doc: nextDoc, frame } = detachInstance(docRef.current, primarySelected.id);
      if (!frame) return;
      commitSnapshot(nextDoc);
      setSelectedIds(new Set([frame.id]));
    };

    // The context menu drives the same commands, so it never holds a second
    // implementation. Re-registered on every effect run to see the current
    // selection, unregistered on cleanup so a disabled entry greys out instead of
    // firing a stale closure. Every `enabled` reads the live selection: it is asked
    // while the menu renders, a commit before this effect runs again.
    const editableLive = () => editableIds(activeEls(), liveSelection.current.ids);
    /**
     * The part of the selection a structural command can write back: its editable
     * nodes, and only when the tree stores one of them.
     *
     * `editableLive` cannot answer that alone — `editableIds` keeps an id with no
     * element behind it, because a resolved clone of a layer inside an instance is
     * still draggable through its override path. Read as "editable", it made Cut
     * and Duplicate report themselves available on such a selection while the tree
     * walk found no source to carry, so the menu row closed and did nothing.
     *
     * Delete is the exception and still asks `editableLive`: hiding a node the
     * document does not own IS expressible, as an override on the instance.
     */
    const writableLive = () =>
      hasStoredSelection(docRef.current, liveSelection.current.ids) ? editableLive() : new Set<string>();
    const unregister = [
      registerEditorCommand("copy", {
        run: () => void copySelection(false),
        enabled: () => liveSelection.current.ids.size > 0
      }),
      registerEditorCommand("copyAsPng", {
        run: (arg) => void copySelectionAsPng(arg?.scale ?? 2),
        enabled: () => liveSelection.current.ids.size > 0
      }),
      // Copy reads a locked layer fine; cut, duplicate and delete are structural
      // edits, and a lock forbids those — so the menu greys them out instead of
      // offering a command that would do nothing.
      registerEditorCommand("cut", {
        run: () => void copySelection(true),
        enabled: () => writableLive().size > 0
      }),
      registerEditorCommand("paste", {
        run: () => void pasteClipboard(),
        enabled: () => clipboardRef.current.elements.length > 0
      }),
      registerEditorCommand("duplicate", {
        run: duplicateSelection,
        enabled: () => writableLive().size > 0
      }),
      registerEditorCommand("delete", {
        run: deleteSelection,
        enabled: () => editableLive().size > 0
      }),
      // ⌘A takes the level the selection already sits on — a child of a frame
      // selects the frame's children, a page root selects the page roots — so the
      // predicate reads the LIVE selection like every other one here.
      registerEditorCommand("selectAll", {
        run: () => setSelectedIds(new Set(selectableSiblingIds(activeEls(), liveSelection.current.ids))),
        enabled: () => selectableSiblingIds(activeEls(), liveSelection.current.ids).length > 0
      }),
      registerEditorCommand("copyStyle", {
        run: copyStyleSelection,
        enabled: () => liveSelection.current.ids.size > 0
      }),
      registerEditorCommand("pasteStyle", {
        run: pasteStyleSelection,
        enabled: () => {
          if (!styleClipboard.has()) return false;
          const { stored, derived } = pasteStyleTargets(docRef.current, activeEls(), selectedIds);
          return stored.size > 0 || derived.length > 0;
        }
      }),
      registerEditorCommand("createComponent", {
        run: createComponentFromSelection,
        enabled: () => Boolean(liveSelection.current.primary)
      }),
      registerEditorCommand("detachInstance", {
        run: detachSelectionInstance,
        enabled: () => {
          const el = liveSelection.current.primary;
          // Only an instance the tree STORES is a link it can hand over as a frame.
          // One projected inside another is a resolved clone: there is nothing to
          // replace, so the row used to be offered and then do nothing at all.
          return el?.type === "instance" && isStoredNode(docRef.current, el.id);
        }
      })
    ];

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
      for (const off of unregister) off();
    };
  }, [selectedIds, primarySelected, visibleWorldRect, commitSnapshot, setSelectedIds, canvasContainerRef]);
}
