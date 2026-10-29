import { useCallback } from "preact/hooks";
import { AssetRef, DesignDocument, DesignElement, getActivePage, updateActivePageElements } from "../../core/dsl/types";
import { loadImageFromFile, loadImageFromUrl, embedExternalAsset, isSvg } from "../../core/interactions/image-loader";
import { loadVideoFromFile, loadVideoFromUrl, embedExternalVideoAsset, createVideoElement, isVideoAsset, isVideoFile } from "../../core/interactions/video-loader";
import { loadHtmlFromEmbedCode, loadHtmlFromFile, loadHtmlFromUrl } from "../../core/interactions/html-embed-loader";
import { captureHeadlessSnapshot } from "../../core/interactions/html-embed-snapshot";
import { createId } from "../../core/id";
import { createInstanceFromComponent } from "../../core/interactions/component-ops";
import { findMasterComponent } from "../../core/interactions/component-inventory";
import { findSwapTargetAtPoint, swapInstanceComponent, swapNestedInstance, swapRefusal } from "../../core/interactions/component-swap";
import { createImageFillElement } from "../../core/dsl/image-fill";
import { OFFICIAL_PROVIDERS } from "../../core/plugins";
import { insertRemoteImage } from "../../core/plugins/remote-image";
import { t } from "../../i18n";
import type { AssetInsertPayload, AssetInsertResult } from "../../core/plugins/types";

interface AssetInsertionOptions {
  docRef: { current: DesignDocument };
  commitSnapshot: (doc: DesignDocument) => void;
  select: (ids: Set<string>) => void;
  showHint?: (message: string) => void;
  /**
   * Top-left of a `size` box at the centre of what the user can see. Every
   * insert the user did not aim — a click in the panel, a plugin's pick —
   * lands through this, so nothing is filed at a coordinate the current view
   * does not show. The element supplies its own size, which is why the size is
   * an argument: an icon and a full-bleed photo do not centre alike.
   */
  dropTopLeft: (size: { width: number; height: number }) => { x: number; y: number };
  /**
   * Where an SVG file goes. `image/*` covers `.svg`, so this door takes SVG
   * files too — but as a picture they land as one rect with an image fill,
   * uneditable, which is not what inserting an icon means. The host passes the
   * vector importer; anything without one keeps the old behaviour rather than
   * losing the file.
   */
  importVectorFile?: (file: File | Blob) => unknown;
}

/**
 * The three ways an asset becomes an element: a file off disk, a click in the
 * assets panel, and a payload dragged in from another document.
 *
 * They share a placement rule and a "select what you just made" rule, and they
 * differ only in how the element is produced — which is why they live together
 * rather than as three handlers on the host.
 */
export function useAssetInsertion({
  docRef,
  commitSnapshot,
  select,
  showHint,
  dropTopLeft,
  importVectorFile
}: AssetInsertionOptions) {
  /**
   * Drop a freshly built element on the canvas, at a point or centred on what
   * the user is looking at, and select it.
   *
   * `asset` is optional because not every media element owns one: an image and a
   * video both point at a registered asset, while an html embed carries its own
   * source and registers nothing.
   */
  const placeMediaElement = useCallback(
    (rawElement: DesignElement, worldX?: number, worldY?: number, asset?: AssetRef) => {
      const positioned =
        worldX !== undefined && worldY !== undefined
          ? { x: worldX, y: worldY }
          : dropTopLeft({ width: rawElement.width, height: rawElement.height });
      const element = { ...rawElement, ...positioned };
      const cur = getActivePage(docRef.current);
      let nextDoc = updateActivePageElements(docRef.current, [...cur.children, element]);
      if (asset) nextDoc = { ...nextDoc, assets: [...(docRef.current.assets || []), asset] };
      commitSnapshot(nextDoc);
      select(new Set([element.id]));
    },
    [dropTopLeft, docRef, commitSnapshot, select]
  );

  const insertMediaFile = async (file: File | Blob, worldX?: number, worldY?: number) => {
    try {
      // An SVG is markup this app can turn into layers, so it does not go
      // through the image door at all.
      if (isSvg(file) && importVectorFile) {
        await importVectorFile(file);
        return;
      }
      const res = isVideoFile(file)
        ? await loadVideoFromFile(file, 0, 0)
        : await loadImageFromFile(file, 0, 0);
      placeMediaElement(res.element, worldX, worldY, res.asset);
    } catch (err) {
      console.error("Failed to insert media file:", err);
    }
  };

  const insertImageFile = insertMediaFile;

  const insertVideoUrl = async (url: string, worldX?: number, worldY?: number, signal?: AbortSignal) => {
    const { asset, element: rawElement } = await loadVideoFromUrl(url, 0, 0, undefined, signal);
    if (signal?.aborted) return;
    placeMediaElement(rawElement, worldX, worldY, asset);
  };

  const insertImageUrl = async (url: string, worldX?: number, worldY?: number, signal?: AbortSignal) => {
    const { asset, element: rawElement } = await loadImageFromUrl(url, 0, 0, undefined, signal);
    if (signal?.aborted) return;
    placeMediaElement(rawElement, worldX, worldY, asset);
  };

  /**
   * An http(s) page, framed live. No asset: the element stores the URL itself.
   */
  const insertHtmlUrl = async (url: string, worldX?: number, worldY?: number) => {
    placeMediaElement(loadHtmlFromUrl(url, 0, 0), worldX, worldY);
    showHint?.(t("htmlEmbed.framingNote"));
  };

  /**
   * A local `.html`, read as text and inlined so the document stays one file.
   */
  const insertHtmlFile = async (file: File | Blob, worldX?: number, worldY?: number) => {
    try {
      const element = await loadHtmlFromFile(file, 0, 0);
      let asset: AssetRef | undefined;
      if (element.srcdoc) {
        const posterUri = await captureHeadlessSnapshot(element.srcdoc, element.width, element.height);
        if (posterUri) {
          const posterAsset: AssetRef = {
            id: createId("asset"),
            name: `${element.name || "HTML"} Poster`,
            uri: posterUri,
            width: element.width,
            height: element.height
          };
          asset = posterAsset;
          element.posterAssetId = posterAsset.id;
        }
      }
      placeMediaElement(element, worldX, worldY, asset);
    } catch (err) {
      console.error("Failed to insert HTML file:", err);
      showHint?.(err instanceof Error ? err.message : t("htmlEmbed.loadFailed"));
    }
  };

  /**
   * An embed snippet, reduced to the page it frames. Throws so the popover keeps
   * the pasted code on screen and can point at it — the same contract the URL
   * entries have.
   */
  const insertHtmlCode = async (code: string, worldX?: number, worldY?: number) => {
    placeMediaElement(loadHtmlFromEmbedCode(code, 0, 0), worldX, worldY);
  };

  // Asset-panel insert (click = viewport center, drop = pointer world coords).
  const insertAsset = useCallback(
    async (payload: AssetInsertPayload, worldX?: number, worldY?: number, swap = false) => {
      // A point the gesture gave us is exact and wins. With none, every branch
      // lands on the centre of what the user can see, sized to the element it is
      // about to make — a fixed guess at "half a card" centred a tall photo off
      // the bottom of the view instead of on it.
      const at = (size: { width: number; height: number }) =>
        worldX !== undefined && worldY !== undefined ? { x: worldX, y: worldY } : dropTopLeft(size);

      let result: AssetInsertResult | null = null;
      if (payload.componentId) {
        // Alt held, over an instance: that instance becomes this component.
        // The modifier is the whole protection — before it, ANY drop on an
        // instance swapped it, so putting a button beside a card meant losing
        // the card. The hit test descends into resolved clones, which is what
        // makes "replace the icon inside the card" reachable at all.
        if (swap && worldX !== undefined && worldY !== undefined) {
          const target = findSwapTargetAtPoint(docRef.current, worldX, worldY);
          if (target) {
            // A refusal ENDS the gesture. Falling through to the insert path put a
            // second instance on top of the one the user was pointing at, so "this
            // cannot be swapped" read as "it duplicated it".
            const refusal = swapRefusal(docRef.current, target.id, payload.componentId);
            if (refusal) {
              showHint?.(t(`component.swapRefused.${refusal}`));
              return;
            }
            const swapped =
              target.kind === "nested"
                ? swapNestedInstance(docRef.current, target.id, payload.componentId)
                : swapInstanceComponent(docRef.current, target.id, payload.componentId);
            if (swapped) {
              commitSnapshot(swapped);
              select(new Set([target.id]));
              return;
            }
            showHint?.(t("component.swapNotPossible"));
            return;
          }
        }
        // The instance copies the master's box, so the master is the size to
        // centre — measured before the clone, because after it the answer is the
        // one we are about to overwrite.
        const master = findMasterComponent(docRef.current, payload.componentId);
        const position = at({ width: master?.width ?? 0, height: master?.height ?? 0 });
        const { doc: nextDoc, instance } = createInstanceFromComponent(docRef.current, payload.componentId, position);
        if (!instance) return;
        commitSnapshot(nextDoc);
        select(new Set([instance.id]));
        return;
      }
      const provider =
        payload.providerId && payload.result
          ? OFFICIAL_PROVIDERS.find((p) => p.id === payload.providerId)
          : undefined;
      if (provider && payload.result) {
        // Built at the origin and moved after: the provider decides the box (it
        // probes the file for it), so only its answer can centre the element.
        result = await provider.insert(payload.result, { x: 0, y: 0 });
      } else if (payload.insert === "remote-image" && payload.result) {
        // A plugin-owned source is not in the host registry; the generic path
        // is the same probe-and-link insert every remote photo provider uses.
        result = await insertRemoteImage(payload.result, { x: 0, y: 0 });
      } else if (payload.assetId) {
        const asset = (docRef.current.assets || []).find((a) => a.id === payload.assetId);
        if (!asset) return;
        const w = asset.width || 300;
        const h = asset.height || 200;
        const scale = Math.min(1, 400 / Math.max(w, h));
        // An asset is one file but two elements. A video dropped through the
        // "Images" tab would otherwise become an image fill pointing at an
        // `.mp4` — a card that inserts nothing you can see.
        result = isVideoAsset(docRef.current, asset)
          ? {
              element: createVideoElement({
                name: asset.name,
                x: 0,
                y: 0,
                width: w * scale,
                height: h * scale,
                assetId: asset.id
              })
            }
          : {
              element: createImageFillElement({
                name: asset.name,
                x: 0,
                y: 0,
                width: w * scale,
                height: h * scale,
                assetId: asset.id,
                fit: "cover"
              })
            };
      }
      if (!result) return;

      const element = { ...result.element, ...at({ width: result.element.width, height: result.element.height }) };
      const cur = getActivePage(docRef.current);
      let nextDoc = updateActivePageElements(docRef.current, [...cur.children, element]);
      if (result.asset) {
        nextDoc = { ...nextDoc, assets: [...(nextDoc.assets || []), result.asset] };
      }
      commitSnapshot(nextDoc);
      select(new Set([element.id]));
    },
    [dropTopLeft, commitSnapshot, select]
  );

  const dropAssetJson = useCallback(
    (payloadJson: string, worldX: number, worldY: number, swap = false) => {
      try {
        const payload = JSON.parse(payloadJson) as AssetInsertPayload;
        insertAsset(payload, worldX, worldY, swap);
      } catch (err) {
        console.error("Invalid asset drop payload:", err);
      }
    },
    [insertAsset]
  );

  const embedAsset = useCallback(
    async (assetId: string) => {
      const asset = (docRef.current.assets || []).find((a) => a.id === assetId);
      if (!asset) return;
      const isVideo = isVideoAsset(docRef.current, asset);
      try {
        const embedded = isVideo
          ? await embedExternalVideoAsset(asset)
          : await embedExternalAsset(asset);
        const nextAssets = (docRef.current.assets || []).map((a) => (a.id === assetId ? embedded : a));
        commitSnapshot({ ...docRef.current, assets: nextAssets });
        showHint?.(isVideo ? t("layers.embedVideoSuccess") : t("layers.embedSuccess"));
      } catch (err) {
        console.error("Failed to embed external asset:", err);
        showHint?.(isVideo ? t("layers.embedVideoFailed") : t("layers.embedFailed"));
      }
    },
    [commitSnapshot, showHint]
  );

  return {
    insertImageFile,
    insertMediaFile,
    insertImageUrl,
    insertVideoUrl,
    insertHtmlUrl,
    insertHtmlFile,
    insertHtmlCode,
    insertAsset,
    dropAssetJson,
    embedAsset
  };
}
