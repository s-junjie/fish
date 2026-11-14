import { useEffect, useRef } from "preact/hooks";
import { ComponentElement, DesignDocument, DesignElement, InstanceElement } from "../../core/dsl/types";
import { getActivePage, updateActivePageElements } from "../../core/dsl/document-ops";
import {
  computeParentOrigin,
  findElementById,
  findParentById,
  flattenElements,
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
  parseClipboardPayload,
  type FishClipboardPayload
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

interface FileClipboard {
  elements: DesignElement[];
  cut: boolean;
  origins: Map<string, { x: number; y: number }>;
}

const ZERO_ORIGIN = { x: 0, y: 0 };

interface UseEditorCommandsOptions {
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  primarySelected: DesignElement | null;
  docRef: { current: DesignDocument };
  commitSnapshot: (newDoc: DesignDocument) => void;
  setHintMessage?: (msg: string) => void;
  onPngCopyProgress?: (busy: boolean) => void;
  visibleWorldRect?: () => Rect;
  canvasContainerRef: { current: HTMLDivElement | null };
  onImportFigmaExport?: (text: string) => Promise<void> | void;
  onImportHtmlClip?: (
    text: string,
    placement?: {
      viewport?: { x: number; y: number; width: number; height: number };
      containerId?: string | null;
    }
  ) => Promise<void> | void;
}

export function useEditorCommands({
  selectedIds,
  setSelectedIds,
  primarySelected,
  docRef,
  commitSnapshot,
  setHintMessage = () => { },
  onPngCopyProgress,
  visibleWorldRect,
  canvasContainerRef,
  onImportFigmaExport,
  onImportHtmlClip
}: UseEditorCommandsOptions) {
  const clipboardRef = useRef<FileClipboard>({ elements: [], cut: false, origins: new Map() });
  const lastCopyId = useRef<string | null>(null);
  const duplicateRef = useRef<{ cloneId: string; anchor: { x: number; y: number }; delta: { x: number; y: number } } | null>(null);
  // OS clipboards often strip PNG pHYs DPI metadata; match by true pixel size with a timestamp bound.
  const lastPngCopyRef = useRef<{ width: number; height: number; scale: number; at: number } | null>(null);
  const pngCopyInFlightRef = useRef(false);

  // Read synchronously by command predicates during context-menu render, before effects flush.
  const liveSelection = useRef({ ids: selectedIds, primary: primarySelected });
  liveSelection.current = { ids: selectedIds, primary: primarySelected };

  const liveOpts = useRef({
    commitSnapshot,
    setHintMessage,
    onPngCopyProgress,
    visibleWorldRect,
    onImportFigmaExport,
    onImportHtmlClip
  });
  liveOpts.current = {
    commitSnapshot,
    setHintMessage,
    onPngCopyProgress,
    visibleWorldRect,
    onImportFigmaExport,
    onImportHtmlClip
  };

  useEffect(() => {
    const activeEls = () => getActivePage(docRef.current).children;
    const collectSources = () => collectTopMostSelected(activeEls(), liveSelection.current.ids);
    const collectCopyUnits = () => collectCopySources(docRef.current, activeEls(), liveSelection.current.ids);
    const refuseDerivedEdit = () =>
      refuseDerivedSelection(docRef.current, liveSelection.current.ids, liveOpts.current.setHintMessage);

    const relayoutParents = (elements: DesignElement[], pastedIds: string[]): DesignElement[] => {
      const hasLayoutParent = pastedIds.some((id) => {
        const parent = findParentById(elements, id);
        return Boolean(parent && layoutOf(parent));
      });
      return hasLayoutParent ? relayoutDocumentTree(elements) : elements;
    };

    const holdRemovedMasters = (base: DesignDocument, ids: Set<string>) => {
      const elements = getActivePage(base).children;
      const flat = flattenElements(elements);
      let orphans = 0;
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
      if (orphans > 0) liveOpts.current.setHintMessage(t("component.masterRemoved", { n: orphans }));
    };

    const deleteSelection = () => {
      const selIds = liveSelection.current.ids;
      if (selIds.size === 0) return;
      // Nodes inside an instance belong to its master; hide them as overrides instead of deleting.
      const hidden = overrideDerivedNodes(docRef.current, selIds, (el) => ({
        ...el,
        visible: false
      }));
      const hiddenIds = new Set(hidden?.applied ?? []);
      const rest = new Set([...selIds].filter((id) => !hiddenIds.has(id)));
      const base = hidden ? hidden.doc : docRef.current;
      if (rest.size === 0) {
        if (!hidden) return;
        liveOpts.current.commitSnapshot(base);
        setSelectedIds(new Set());
        duplicateRef.current = null;
        return;
      }
      if (refuseDerivedEdit()) return;
      const ids = editableIds(getActivePage(base).children, rest);
      if (ids.size === 0) return;
      holdRemovedMasters(base, ids);
      liveOpts.current.commitSnapshot(
        updateActivePageElements(base, removeElementsWithRelayout(getActivePage(base).children, ids))
      );
      setSelectedIds(new Set());
      duplicateRef.current = null;
    };

    const viewportRect = (): Rect =>
    liveOpts.current.visibleWorldRect?.() ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };

    const getMediaPaste = () =>
      createPasteMedia({
        docRef,
        selectedIds: liveSelection.current.ids,
        setSelectedIds,
        commitSnapshot: liveOpts.current.commitSnapshot,
        setHintMessage: liveOpts.current.setHintMessage,
        viewportRect,
        lastPngCopyRef
      });

    const pasteClipboard = () => {
      const { elements: sources, cut, origins } = clipboardRef.current;
      if (sources.length === 0) return;

      const active = activeEls();
      const selIds = liveSelection.current.ids;
      const placement = resolvePastePlacement(active, sources, selIds);

      // Cut keeps original ids so instances stay linked to their master; repeat pastes fall through to copy.
      if (cut && idsAvailable(active, sources)) {
        const placed = sources.map((s) => {
          const origin = origins.get(s.id);
          if (!origin) return s;
          const copy = { ...s };
          translateTreeInPlace(copy, origin.x - s.x, origin.y - s.y);
          return copy;
        });
        const target = placement.kind === "into" ? placement.containerIds[0] ?? null : null;
        const moved = insertVerbatim(active, placed, target);
        for (const id of moved.ids) releaseMaster(id);
        liveOpts.current.commitSnapshot(
          updateActivePageElements(docRef.current, relayoutParents(moved.elements, moved.ids))
        );
        setSelectedIds(new Set(moved.ids));
        duplicateRef.current = null;
        return;
      }

      let nextElements: DesignElement[];
      let newIds: string[];
      let selected: string[];

      if (placement.kind === "into") {
        let currentTree = active;
        const allNewIds: string[] = [];
        const allRootIds: string[] = [];
        for (const containerId of placement.containerIds) {
          const result = insertClonesIntoContainer(currentTree, sources, containerId, { viewport: viewportRect() });
          currentTree = result.elements;
          allNewIds.push(...result.newIds);
          allRootIds.push(...result.rootIdBySource.values());
        }
        nextElements = currentTree;
        newIds = allNewIds;
        selected = allRootIds;
      } else if (placement.kind === "onto-canvas") {
        const result = insertClonesAtRoot(active, sources, offsetCenteringSourcesIn(sources, viewportRect()));
        nextElements = result.elements;
        newIds = result.newIds;
        selected = [...result.rootIdBySource.values()];
      } else {
        const existing = findElementById(active, sources[0].id);
        const result = insertClones(active, sources, existing ? { x: 20, y: 20 } : { x: 0, y: 0 });
        nextElements = result.elements;
        newIds = result.newIds;
        selected = [...result.rootIdBySource.values()];
      }

      liveOpts.current.commitSnapshot(
        updateActivePageElements(docRef.current, relayoutParents(nextElements, newIds))
      );
      setSelectedIds(new Set(selected));
      duplicateRef.current = null;
    };

    const applyPastedPayload = (payload: FishClipboardPayload) => {
      const current = docRef.current;
      const fragment = remintFragment(current, payload);
      const { doc: nextDoc, newIds, carriedMasters } = pasteFragmentIntoDoc(
        current,
        fragment,
        Array.from(liveSelection.current.ids),
        { viewport: viewportRect() }
      );
      liveOpts.current.commitSnapshot(nextDoc);
      setSelectedIds(new Set(newIds));
      duplicateRef.current = null;
      if (carriedMasters > 0) {
        liveOpts.current.setHintMessage(t("clipboard.importedMasters", { n: carriedMasters }));
      }
    };

    // Cmd+V is intentionally not intercepted on keydown so native `paste` fires with clipboard media.
    const handlePaste = async (e: ClipboardEvent) => {
      // Field paste handlers may detach `e.target` during re-render; check `defaultPrevented` first.
      if (e.defaultPrevented) return;
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
              const mediaPaste = getMediaPaste();
              if (isVideoFile(file)) await mediaPaste.pasteVideoFile(file);
              else await mediaPaste.pasteImageFile(file);
              return;
            }
          }
        }
      }

      const text = e.clipboardData?.getData?.("text/plain") ?? "";
      const trimmed = text.trim();

      const oversize = refuseClipboardText(text);
      if (oversize) {
        e.preventDefault();
        e.stopPropagation();
        liveOpts.current.setHintMessage(describeImportRefusal(oversize));
        return;
      }

      const payload = parseClipboardPayload(text);
      if (payload) {
        e.preventDefault();
        e.stopPropagation();
        const overTree = refuseElementTree(payload.elements);
        if (overTree) {
          liveOpts.current.setHintMessage(describeImportRefusal(overTree));
          return;
        }
        if (payload.clipId === lastCopyId.current && clipboardRef.current.elements.length > 0) {
          pasteClipboard();
          return;
        }
        applyPastedPayload(payload);
        return;
      }

      const dslClip = parseDslClipboardText(text);
      if (dslClip) {
        e.preventDefault();
        e.stopPropagation();
        const overTree = refuseElementTree(dslClip.elements);
        if (overTree) {
          liveOpts.current.setHintMessage(describeImportRefusal(overTree));
          return;
        }
          applyPastedPayload({
            tag: "fish-clipboard@2",
            clipId: dslClip.clipId,
          elements: dslClip.elements,
          masters: (dslClip.masters || []) as any[],
          assets: (dslClip.assets || []).map((a) => ({ ...a })),
          styles: (dslClip.styles || []).map((s) => ({ ...s }))
      });
  return;
}

if (isFigmaExportText(text)) {
  e.preventDefault();
  e.stopPropagation();
  await liveOpts.current.onImportFigmaExport?.(text);
  return;
}

const embed = parseEmbedCode(trimmed);
if (embed) {
  e.preventDefault();
  e.stopPropagation();
  try {
    getMediaPaste().pasteHtmlEmbed(loadHtmlFromEmbedCode(trimmed, 0, 0));
    return;
  } catch (err) {
    console.warn("Failed to parse iframe embed code:", err);
  }
}

  const htmlClip = isHtmlClipText(text)
    ? text
    : (() => {
      const htmlData = e.clipboardData?.getData?.("text/html");
      return htmlData && isHtmlClipText(htmlData) ? htmlData : null;
    })();
  if (htmlClip) {
    e.preventDefault();
    e.stopPropagation();
      const targetContainer = resolveDropTarget(activeEls(), liveSelection.current.ids);
      await liveOpts.current.onImportHtmlClip?.(htmlClip, {
        viewport: viewportRect(),
        containerId: targetContainer ? targetContainer.id : null
      });
      return;
    }

    if (trimmed) {
      const mediaPaste = getMediaPaste();
      if (isVideoUrl(trimmed)) {
        e.preventDefault();
        e.stopPropagation();
        try {
          await mediaPaste.pasteVideoUrl(trimmed);
          return;
        } catch {
          // fall through
        }
      }
      if (isImageUrl(trimmed)) {
        e.preventDefault();
        e.stopPropagation();
        try {
          await mediaPaste.pasteImageUrl(trimmed);
          return;
        } catch {
          // fall through
        }
      }
      if (isFrameableUrl(trimmed)) {
        e.preventDefault();
        e.stopPropagation();
        try {
          mediaPaste.pasteHtmlEmbed(loadHtmlFromUrl(trimmed, 0, 0));
          return;
        } catch {
          // fall through
        }
      }
    }

    if (clipboardRef.current.elements.length > 0 && !trimmed) {
      e.preventDefault();
      e.stopPropagation();
      pasteClipboard();
      return;
    }

    if (trimmed) {
      e.preventDefault();
      e.stopPropagation();
      getMediaPaste().pastePlainText(text);
    }
  };

  const copySelection = async (remove: boolean) => {
    const sources = collectCopyUnits();
    if (sources.length === 0) return;
    const elements = activeEls();
    const origins = new Map<string, { x: number; y: number }>();
    for (const src of sources) {
      // Resolved clones are already re-based to canvas coordinates; stored nodes need parent origin.
      const parent = isStoredNode(docRef.current, src.id) ? computeParentOrigin(elements, src.id) : ZERO_ORIGIN;
      origins.set(src.id, { x: src.x + parent.x, y: src.y + parent.y });
    }
    clipboardRef.current = { elements: sources, cut: remove, origins };
    const clipId = createId("clip");
    lastCopyId.current = clipId;
    try {
      await navigator.clipboard?.writeText(buildClipboardPayload(docRef.current, sources, clipId));
    } catch {
      // In-memory clipboard still covers same-file paste when system clipboard is unavailable.
    }
    if (remove) deleteSelection();
  };

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
    liveOpts.current.onPngCopyProgress?.(true);
    try {
      const rawBlob = await exportCanvasAsBlob(docRef.current, container, {
        scale,
        bounds,
        allowedElementIds: allowedIds
      });
      const blob = await withPngDensity(rawBlob, scale);
      lastPngCopyRef.current = {
        width: Math.max(1, Math.round(bounds.width * scale)),
        height: Math.max(1, Math.round(bounds.height * scale)),
        scale,
        at: Date.now()
      };

      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        liveOpts.current.setHintMessage(t("clipboard.copyImageUnsupported"));
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      liveOpts.current.setHintMessage(t("clipboard.copyImageDone"));
    } catch (err) {
      console.error("Copy as PNG failed", err);
      liveOpts.current.setHintMessage(t("clipboard.copyImageFailed"));
    } finally {
      pngCopyInFlightRef.current = false;
      liveOpts.current.onPngCopyProgress?.(false);
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

    const { elements, newIds, rootIdBySource } = insertClones(activeEls(), sources, offset);
    const laidOut = relayoutParents(elements, newIds);
    liveOpts.current.commitSnapshot(updateActivePageElements(docRef.current, laidOut));
    const cloneIds = [...rootIdBySource.values()];
    setSelectedIds(new Set(cloneIds));

    duplicateRef.current =
      cloneIds.length === 1
        ? (() => {
          const created = findElementById(laidOut, cloneIds[0]);
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

  const copyStyleSelection = () => {
    const copied = copyStyleFrom(liveSelection.current.primary);
    if (!copied) {
      liveOpts.current.setHintMessage(t("styleClipboard.nothingToCopy"));
      return;
    }
    styleClipboard.write(copied);
  };

  const pasteStyleSelection = () => {
    const copied = styleClipboard.read();
    if (!copied) {
      liveOpts.current.setHintMessage(t("styleClipboard.nothingToPaste"));
      return;
    }
    const next = applyCopiedStyleTo(docRef.current, activeEls(), liveSelection.current.ids, copied);
    if (next) liveOpts.current.commitSnapshot(next);
  };

  const createComponentFromSelection = () => {
      const primary = liveSelection.current.primary;
      if (!primary) return;
      if (!canCreateComponentHere(getActivePage(docRef.current).children, primary)) {
        liveOpts.current.setHintMessage(t("component.nestedMaster"));
        return;
      }
      const { doc: nextDoc, component, hoisted } = createComponentFromElement(docRef.current, primary.id);
      if (!component) return;
      liveOpts.current.commitSnapshot(nextDoc);
      setSelectedIds(new Set([component.id]));
      if (hoisted.length > 0) liveOpts.current.setHintMessage(t("component.hoistedMaster"));
    };

    const detachSelectionInstance = () => {
      const primary = liveSelection.current.primary;
      if (primary?.type !== "instance") return;
      const { doc: nextDoc, frame } = detachInstance(docRef.current, primary.id);
      if (!frame) return;
      liveOpts.current.commitSnapshot(nextDoc);
      setSelectedIds(new Set([frame.id]));
    };

    const editableLive = () => editableIds(activeEls(), liveSelection.current.ids);
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
          const { stored, derived } = pasteStyleTargets(docRef.current, activeEls(), liveSelection.current.ids);
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
          return el?.type === "instance" && isStoredNode(docRef.current, el.id);
        }
      })
    ];

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
      for (const off of unregister) off();
    };
}, [docRef, setSelectedIds, canvasContainerRef]);
}
