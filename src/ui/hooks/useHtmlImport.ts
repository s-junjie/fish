import { useCallback, useRef, useState } from "preact/hooks";
import { DesignDocument, DesignElement, Page, getActivePage, updateActivePageElements } from "../../core/dsl/types";
import { collectDescendantIds, findElementById, isContainer, mapElements } from "../../core/geometry/tree-ops";
import { relayoutDocumentTree } from "../../core/compile";
import { layoutOf } from "../../core/dsl/layout-flat";
import { createId } from "../../core/id";
import { importHtmlDocument } from "../../core/import/html-import";
import { parseHtmlClip } from "../../core/import/html-clip";
import { withImportedDesignSystem } from "../../core/import/imported-tokens";
import {
  attachMissingAssets,
  indexFolder,
  matchAsset,
  readFolderImage,
  type FolderFile,
  type ResolvedAsset
} from "../../core/import/html-asset-folder";
import type { MissingAsset } from "../../core/import/html-types";
import { t } from "../../i18n";

export interface HtmlImportProgress {
  name: string;
  stage: "mount" | "assets" | "measure" | "build";
  percent?: number;
  onCancel: () => void;
}

/** Bitmaps an import asked for and could not read, waiting for a folder. */
export interface PendingAssets {
  /** The name of the import they belong to, for the notice's wording. */
  name: string;
  /** What the import produced, so the notice can stand in for the summary toast. */
  elements: number;
  missing: MissingAsset[];
}

interface UseHtmlImportOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  select: (ids: Set<string>) => void;
  showHint?: (message: string) => void;
  setPan: (pan: { x: number; y: number }) => void;
  setZoom: (zoom: number) => void;
}

const MIN_ZOOM = 0.05;

/**
 * Turning a `.html` file or clipboard clip into native elements on the active page.
 */
export function useHtmlImport({
  docRef,
  commitSnapshot,
  select,
  showHint,
  setPan,
  setZoom
}: UseHtmlImportOptions) {
  const busyRef = useRef(false);
  const [importProgress, setImportProgress] = useState<HtmlImportProgress | null>(null);
  const [pendingAssets, setPendingAssets] = useState<PendingAssets | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const importHtmlFile = useCallback(
    async (file: File | Blob) => {
      if (busyRef.current) {
        showHint?.(t("htmlImport.alreadyImporting"));
        return;
      }
      busyRef.current = true;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const text = await file.text();
        if (controller.signal.aborted) return;
        if (!text.trim()) throw new Error(t("htmlImport.emptyFile"));

        const name = ((file as File).name || "").replace(/\.[^/.]+$/, "").trim() || t("htmlImport.untitled");
        const cancel = () => {
          controller.abort();
          setImportProgress(null);
          busyRef.current = false;
          showHint?.(t("htmlImport.cancelled"));
        };
        setImportProgress({
          name,
          stage: "mount",
          percent: 15,
          onCancel: cancel
        });

        const result = await importHtmlDocument(text, {
          rootName: name,
          viewportWidth: Math.max(320, window.innerWidth),
          viewportHeight: Math.max(320, window.innerHeight),
          styles: docRef.current.styles ?? [],
          tokens: docRef.current.tokens ?? [],
          takenIds: documentIds(docRef.current),
          signal: controller.signal,
          onProgress: (stage, percent) => {
            if (controller.signal.aborted) return;
            setImportProgress((p) => (p ? { ...p, stage, percent } : null));
          }
        });

        if (controller.signal.aborted) return;

        const current = docRef.current;
        const activePage = getActivePage(current);
        const root = result.elements[0];
        let placedElements = result.elements;

        const nextElements = [...activePage.children, ...placedElements];
        commitSnapshot({
          ...updateActivePageElements(current, nextElements),
          ...withImportedDesignSystem(current, result.tokens),
          ...(result.assets.length > 0
            ? { assets: [...(current.assets || []), ...result.assets] }
            : {})
        });
        select(new Set(placedElements.map((el) => el.id)));
        focusOn({ ...activePage, children: placedElements }, setPan, setZoom);

        const { elementCount, downgraded, unmapped, styleBindings, tokensCreated } = result.report;
        const message =
          downgraded.length > 0
            ? t("htmlImport.donePartial", { n: elementCount, name, k: downgraded.length })
            : t("htmlImport.done", { n: elementCount, name });
        const notes = [
          tokensCreated > 0 ? t("htmlImport.tokenNote", { n: tokensCreated }) : "",
          styleBindings > 0 ? t("htmlImport.boundNote", { n: styleBindings }) : "",
          unmapped.length > 0 ? t("htmlImport.unmappedNote", { n: unmapped.length }) : ""
        ].filter(Boolean);
        const summary = notes.length > 0 ? `${message} · ${notes.join(" · ")}` : message;
        if (result.missing.length > 0) {
          // One banner, not two: the notice says what arrived AND what is
          // missing, so the summary toast would only repeat it.
          setPendingAssets({ name, elements: elementCount, missing: result.missing });
        } else {
          showHint?.(summary);
        }
        if (unmapped.length > 0) {
          console.groupCollapsed(`HTML import: ${unmapped.length} unmapped propert${unmapped.length === 1 ? "y" : "ies"}`);
          for (const gap of unmapped) console.info(`${gap.path} — ${gap.property}: ${gap.value}`);
          console.groupEnd();
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || controller.signal.aborted) {
          showHint?.(t("htmlImport.cancelled"));
          return;
        }
        console.error("Failed to import HTML document:", err);
        showHint?.(
          err instanceof Error && err.message
            ? t("htmlImport.failedWithError", { error: err.message })
            : t("htmlImport.failed")
        );
      } finally {
        setImportProgress(null);
        busyRef.current = false;
        abortControllerRef.current = null;
      }
    },
    [docRef, commitSnapshot, select, showHint, setPan, setZoom]
  );

  const importHtmlClip = useCallback(
    async (
      payloadText: string,
      placement?: {
        viewport?: { x: number; y: number; width: number; height: number };
        containerId?: string | null;
      }
    ) => {
      if (busyRef.current) {
        showHint?.(t("htmlImport.alreadyImporting"));
        return;
      }
      busyRef.current = true;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      try {
        const { html, title, mode } = parseHtmlClip(payloadText);
        if (controller.signal.aborted) return;
        if (!html.trim()) throw new Error(t("htmlImport.emptyFile"));

        const cancel = () => {
          controller.abort();
          setImportProgress(null);
          busyRef.current = false;
          showHint?.(t("htmlImport.cancelled"));
        };
        setImportProgress({
          name: title,
          stage: "mount",
          percent: 15,
          onCancel: cancel
        });

        const result = await importHtmlDocument(html, {
          rootName: title,
          viewportWidth: Math.max(320, window.innerWidth),
          viewportHeight: Math.max(320, window.innerHeight),
          styles: docRef.current.styles ?? [],
          tokens: docRef.current.tokens ?? [],
          takenIds: documentIds(docRef.current),
          signal: controller.signal,
          onProgress: (stage, percent) => {
            if (controller.signal.aborted) return;
            setImportProgress((p) => (p ? { ...p, stage, percent } : null));
          }
        });

        if (controller.signal.aborted) return;

        const current = docRef.current;
        const activePage = getActivePage(current);
        const root = result.elements[0];
        let placedElements = result.elements;
        if (root && placement?.viewport) {
          const vp = placement.viewport;
          const targetX = Math.round(vp.x + Math.max(0, (vp.width - root.width) / 2));
          const targetY = Math.round(vp.y + Math.max(0, (vp.height - root.height) / 2));
          const dx = targetX - root.x;
          const dy = targetY - root.y;
          placedElements = result.elements.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy }));
        }

        let nextElements: DesignElement[];
        const targetContainerId = placement?.containerId;
        const targetContainer = targetContainerId
          ? findElementById(activePage.children, targetContainerId)
          : null;

        if (targetContainer && isContainer(targetContainer) && mode === "element") {
          nextElements = mapElements(activePage.children, (el) => {
            if (el.id === targetContainer.id && isContainer(el)) {
              return {
                ...el,
                children: [...(el.children || []), ...placedElements]
              };
            }
            return el;
          });
          if (layoutOf(targetContainer)) {
            nextElements = relayoutDocumentTree(nextElements);
          }
        } else {
          nextElements = [...activePage.children, ...placedElements];
        }

        commitSnapshot({
          ...updateActivePageElements(current, nextElements),
          ...withImportedDesignSystem(current, result.tokens),
          ...(result.assets.length > 0 ? { assets: [...(current.assets || []), ...result.assets] } : {})
        });
        select(new Set(placedElements.map((el) => el.id)));

        const { elementCount, downgraded, unmapped, styleBindings, tokensCreated } = result.report;
        const message =
          downgraded.length > 0
            ? t("htmlImport.donePartial", { n: elementCount, name: title, k: downgraded.length })
            : t("htmlImport.done", { n: elementCount, name: title });
        const notes = [
          tokensCreated > 0 ? t("htmlImport.tokenNote", { n: tokensCreated }) : "",
          styleBindings > 0 ? t("htmlImport.boundNote", { n: styleBindings }) : "",
          unmapped.length > 0 ? t("htmlImport.unmappedNote", { n: unmapped.length }) : ""
        ].filter(Boolean);
        const summary = notes.length > 0 ? `${message} · ${notes.join(" · ")}` : message;
        if (result.missing.length > 0) {
          setPendingAssets({ name: title, elements: elementCount, missing: result.missing });
        } else {
          showHint?.(summary);
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError" || controller.signal.aborted) {
          showHint?.(t("htmlImport.cancelled"));
          return;
        }
        console.error("Failed to import HTML clip:", err);
        showHint?.(
          err instanceof Error && err.message
            ? t("htmlImport.failedWithError", { error: err.message })
            : t("htmlImport.failed")
        );
      } finally {
        setImportProgress(null);
        busyRef.current = false;
        abortControllerRef.current = null;
      }
    },
    [docRef, commitSnapshot, select, showHint, setPan, setZoom]
  );

  /**
   * Fill in the bitmaps the import could not read, from a folder the user picks.
   *
   * Only the files a missing URL actually matches are read, and only the paint
   * is written — the elements keep their position, their edits and their ids, so
   * this is not a second import. A folder that matches nothing leaves the notice
   * up rather than closing the door: the user may simply have picked the wrong
   * level of the tree.
   */
  const attachAssetFolder = useCallback(
    async (files: FileList | readonly File[]) => {
      const pending = pendingAssets;
      if (!pending || busyRef.current) return;
      busyRef.current = true;
      try {
        const entries: FolderFile[] = Array.from(files).map((file) => ({
          path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
          file
        }));
        if (entries.length === 0) return;
        const index = indexFolder(entries);
        const folder = entries[0].path.includes("/") ? entries[0].path.split("/")[0] : t("htmlImport.assetsFolder");

        const resolved: ResolvedAsset[] = [];
        for (const url of new Set(pending.missing.map((entry) => entry.url))) {
          const file = matchAsset(url, index);
          if (!file) continue;
          const bytes = await readFolderImage(file);
          if (!bytes) continue;
          resolved.push({ url, name: file.name, ...bytes });
        }

        if (resolved.length === 0) {
          showHint?.(t("htmlImport.assetsNoMatch", { name: folder }));
          return;
        }

        const applied = attachMissingAssets(docRef.current, pending.missing, resolved);
        commitSnapshot(applied.doc);
        const left = applied.remaining.length;
        showHint?.(
          left > 0
            ? t("htmlImport.assetsAttachedPartial", { n: applied.attached, name: folder, k: left })
            : t("htmlImport.assetsAttached", { n: applied.attached, name: folder })
        );
        setPendingAssets(left > 0 ? { ...pending, missing: applied.remaining } : null);
      } finally {
        busyRef.current = false;
      }
    },
    [pendingAssets, docRef, commitSnapshot, showHint]
  );

  const dismissPendingAssets = useCallback(() => setPendingAssets(null), []);

  return { importHtmlFile, importHtmlClip, importProgress, pendingAssets, attachAssetFolder, dismissPendingAssets };
}

/**
 * Centre the imported page in the canvas strip at a zoom that fits it.
 *
 * `screen = world * zoom + pan` is the app's own transform, so this is the same
 * arithmetic `placeMediaElement` does in reverse. Measured between the two
 * panels rather than across the window: they cover a few hundred pixels each
 * side, and centring on the window parks a wide import underneath the layer
 * tree, which is indistinguishable from an import that did nothing.
 */
function focusOn(page: Page, setPan: (pan: { x: number; y: number }) => void, setZoom: (zoom: number) => void): void {
  const frame = page.children[0];
  if (!frame) return;

  const left = document.querySelector('[data-ui-panel="left"]')?.getBoundingClientRect();
  const right = document.querySelector('[data-ui-panel="right"]')?.getBoundingClientRect();
  const x0 = left && left.width > 0 ? left.right : 0;
  const x1 = right && right.width > 0 ? right.left : window.innerWidth;
  const area =
    x1 - x0 > 120
      ? { left: x0, top: 0, width: x1 - x0, height: window.innerHeight }
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };

  const width = Math.max(1, frame.width);
  const height = Math.max(1, frame.height);
  const zoom = Math.max(MIN_ZOOM, Math.min(1, (area.width * 0.9) / width, (area.height * 0.8) / height));
  setZoom(zoom);
  setPan({
    x: Math.round(area.left + (area.width - width * zoom) / 2 - frame.x * zoom),
    y: Math.round(area.top + (area.height - height * zoom) / 2 - frame.y * zoom)
  });
}

/** Every id the document owns. Element ids are unique document-wide, not per page. */
function documentIds(doc: DesignDocument): string[] {
  return doc.pages.flatMap((page) => page.children.flatMap((el) => [el.id, ...collectDescendantIds(el)]));
}
