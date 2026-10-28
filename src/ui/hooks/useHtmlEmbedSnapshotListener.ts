import { useEffect } from "preact/hooks";
import { DesignDocument, updateActivePageElements, getActivePage, HtmlEmbedElement, AssetRef } from "../../core/dsl/types";
import { createId } from "../../core/id";

/**
 * Listens for snapshot messages from embedded HTML iframes and binds captured
 * poster images to the document asset table.
 *
 * The only sender is the injected helper reporting a settled load, so the id on
 * the message is what binds the frame that drew to the layer that owns it. An
 * anonymous message (the headless import path injects without an id) resolves to
 * no layer and is dropped — that capture belongs to its own caller.
 */
export function useHtmlEmbedSnapshotListener(
  docRef: { current: DesignDocument },
  commitSnapshot: (doc: DesignDocument) => void
) {
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type !== "fish:snapshot-response" && e.data.type !== "fish:snapshot-ready") return;
      const { id, dataUrl } = e.data;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;

      const curDoc = docRef.current;
      const activePage = getActivePage(curDoc);
      let targetEl: HtmlEmbedElement | undefined;
      if (id) {
        targetEl = activePage.children.find((el): el is HtmlEmbedElement => el.id === id && el.type === "html");
      }
      if (!targetEl) return;

      const assetId = targetEl.posterAssetId || createId("asset");
      const posterAsset: AssetRef = {
        id: assetId,
        name: `${targetEl.name || "HTML"} Poster`,
        uri: dataUrl,
        width: targetEl.width,
        height: targetEl.height
      };

      const updatedElements = activePage.children.map((el) =>
        el.id === targetEl!.id ? { ...el, posterAssetId: assetId } : el
      );

      const existingAssets = (curDoc.assets || []).filter((a) => a.id !== assetId);
      const nextDoc: DesignDocument = {
        ...updateActivePageElements(curDoc, updatedElements),
        assets: [...existingAssets, posterAsset]
      };
      commitSnapshot(nextDoc);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [docRef, commitSnapshot]);
}
